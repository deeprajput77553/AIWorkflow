// src/layers/ExecutionLayer.js
// Stage 4 — Reactive handler (streaming), Terminal handler (plan→run→verify→retry),
//           Complex handler (THINK→PLAN→CREATE→CHECK loop), Plugin executor, Tool executor

import fs   from 'fs';
import path from 'path';
import { execSync }  from 'child_process';

import Logger            from '../utils/Logger.js';
import { bus, AGENT_EVENTS } from '../core/EventBus.js';
import {
    callOllama, callOllamaStream, routerModel, complexModel, verifyModel,
    extractJson, MODELS
} from './OutputLayer.js';
import { pluginManager } from '../plugins/PluginManager.js';
import { contextManager } from './ContextManager.js';
import { subagentManager } from '../core/SubagentManager.js';

// ── Security: workspace path guard ─────────────────────────────────────────
export function resolveSafePath(workspaceDir, target) {
    const resolved = path.resolve(workspaceDir, target);
    if (!resolved.startsWith(path.resolve(workspaceDir))) {
        throw new Error(`SECURITY: "${resolved}" is outside the locked workspace "${workspaceDir}"`);
    }
    return resolved;
}

// ── Allowed shell command prefixes ──────────────────────────────────────────
const ALLOWED_PREFIXES = [
    'node ', 'python ', 'python3 ', 'pip ', 'pip3 ',
    'npm ', 'npx ', 'yarn ', 'pnpm ',
    'git ', 'ollama ', 'winget ', 'choco ', 'scoop ',
    'dir', 'ls', 'echo ', 'cat ', 'type ',
    'mkdir ', 'rmdir ', 'del ', 'copy ', 'move ',
    'curl ', 'wget ', 'powershell ', 'pwsh '
];

export function isCommandAllowed(cmd) {
    const lower = cmd.trim().toLowerCase();
    return ALLOWED_PREFIXES.some(p => lower.startsWith(p));
}

// ── Terminal runner ──────────────────────────────────────────────────────────
export function runTerminal(command, cwd = process.cwd(), timeoutMs = 60_000) {
    Logger.toolCall('Terminal', command);
    try {
        const output = execSync(command, {
            cwd, timeout: timeoutMs, encoding: 'utf-8',
            shell: true, stdio: ['ignore', 'pipe', 'pipe']
        });
        return { stdout: output || '', stderr: '', code: 0 };
    } catch (err) {
        return {
            stdout: err.stdout?.toString() || '',
            stderr: err.stderr?.toString() || err.message,
            code:   err.status ?? 1
        };
    }
}

// ── Tool schemas ─────────────────────────────────────────────────────────────
const TOOL_SCHEMAS = {
    list_dir:     { properties: { path: { type: 'string', required: false } } },
    read_file:    { properties: { path: { type: 'string', required: true  } } },
    create_file:  { properties: { path: { type: 'string', required: true }, content: { type: 'string', required: true } } },
    edit_file:    { properties: { path: { type: 'string', required: true }, content: { type: 'string', required: true } } },
    replace_lines:{ properties: { path: { type: 'string', required: true }, start_line: { type: 'number', required: true }, end_line: { type: 'number', required: true }, content: { type: 'string', required: true } } },
    delete_file:  { properties: { path: { type: 'string', required: true } } },
    grep_search:  { properties: { path: { type: 'string', required: false }, pattern: { type: 'string', required: true } } },
    run_terminal: { properties: { command: { type: 'string', required: true } } },
};

export function validateToolCall(call, workspaceDir) {
    if (!call || typeof call !== 'object') return { valid: false, error: 'Tool call must be a JSON object' };
    if (call.response) return { valid: true };
    if (!call.tool) return { valid: false, error: 'Missing "tool" or "response" field' };
    const schema = TOOL_SCHEMAS[call.tool];
    if (!schema) return { valid: false, error: `Unknown tool: "${call.tool}"` };
    for (const [key, rules] of Object.entries(schema.properties)) {
        let value = call[key];
        if (key === 'content' && value === undefined) {
            value = call.text ?? call.code;
            if (value !== undefined) call.content = value;
        }
        if (rules.required && value === undefined) return { valid: false, error: `Missing required param "${key}" for tool "${call.tool}"` };
        if (value !== undefined && rules.type === 'number') {
            const n = Number(value);
            if (isNaN(n)) return { valid: false, error: `"${key}" must be a number` };
            call[key] = n;
        }
    }
    if (call.path) {
        try { resolveSafePath(workspaceDir, call.path); }
        catch (e) { return { valid: false, error: e.message }; }
    }
    return { valid: true };
}

export function executeFileTool(call, workspaceDir) {
    const validation = validateToolCall(call, workspaceDir);
    if (!validation.valid) return { success: false, error: `Validation: ${validation.error}` };

    try {
        switch (call.tool) {
        case 'list_dir': {
            const p = resolveSafePath(workspaceDir, call.path || './');
            if (!fs.existsSync(p)) return { success: false, error: `Directory "${call.path}" not found.` };
            return { success: true, result: `Contents of ${call.path || '.'}:\n` + fs.readdirSync(p).join('\n') };
        }
        case 'read_file': {
            const p = resolveSafePath(workspaceDir, call.path);
            if (!fs.existsSync(p)) return { success: false, error: `File "${call.path}" does not exist.` };
            const content = fs.readFileSync(p, 'utf-8');
            const lines   = content.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n');
            return { success: true, result: `File "${call.path}" (${content.split('\n').length} lines):\n${lines}` };
        }
        case 'create_file': {
            const p = resolveSafePath(workspaceDir, call.path);
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, call.content ?? '', 'utf-8');
            contextManager.invalidateSnapshot();
            return { success: true, result: `Created "${call.path}" (${(call.content ?? '').split('\n').length} lines).` };
        }
        case 'edit_file': {
            const p = resolveSafePath(workspaceDir, call.path);
            if (!fs.existsSync(p)) return { success: false, error: `File "${call.path}" does not exist. Use create_file instead.` };
            fs.writeFileSync(p, call.content ?? '', 'utf-8');
            contextManager.invalidateSnapshot();
            return { success: true, result: `Overwritten "${call.path}" (${(call.content ?? '').split('\n').length} lines).` };
        }
        case 'replace_lines': {
            const p   = resolveSafePath(workspaceDir, call.path);
            if (!fs.existsSync(p)) return { success: false, error: `File "${call.path}" does not exist.` };
            const arr = fs.readFileSync(p, 'utf-8').split('\n');
            const s   = call.start_line - 1, e = call.end_line - 1;
            if (s < 0 || e >= arr.length || s > e) return { success: false, error: `Invalid range ${call.start_line}–${call.end_line} (file has ${arr.length} lines).` };
            arr.splice(s, e - s + 1, ...call.content.split('\n'));
            fs.writeFileSync(p, arr.join('\n'), 'utf-8');
            contextManager.invalidateSnapshot();
            return { success: true, result: `Replaced lines ${call.start_line}–${call.end_line} in "${call.path}".` };
        }
        case 'delete_file': {
            const p = resolveSafePath(workspaceDir, call.path);
            if (!fs.existsSync(p)) return { success: false, error: `File "${call.path}" does not exist.` };
            fs.unlinkSync(p);
            contextManager.invalidateSnapshot();
            return { success: true, result: `Deleted "${call.path}".` };
        }
        case 'grep_search': {
            const p = resolveSafePath(workspaceDir, call.path || './');
            const pattern = new RegExp(call.pattern, 'i');
            const matches = [];
            const EXCL_DIRS  = ['.git','node_modules','.gemini','dist','build'];
            const EXCL_FILES = ['package-lock.json','pnpm-lock.yaml','yarn.lock','.ds_store'];
            const searchDir = (currDir) => {
                let files;
                try { files = fs.readdirSync(currDir, { withFileTypes: true }); } catch { return; }
                for (const f of files) {
                    const fp = path.join(currDir, f.name);
                    if (f.isDirectory()) {
                        if (!EXCL_DIRS.includes(f.name.toLowerCase())) searchDir(fp);
                    } else {
                        if (EXCL_FILES.includes(f.name.toLowerCase())) continue;
                        try {
                            const sz = fs.statSync(fp).size;
                            if (sz > 1_048_576) continue;
                            const lines = fs.readFileSync(fp, 'utf-8').split('\n');
                            lines.forEach((l, i) => {
                                if (pattern.test(l)) {
                                    matches.push(`${path.relative(workspaceDir, fp)}:${i + 1}:${l.trim()}`);
                                }
                            });
                            if (matches.length >= 100) return;
                        } catch {}
                    }
                }
            };
            searchDir(p);
            return { success: true, result: matches.length ? `grep results:\n${matches.join('\n')}` : `No matches for "${call.pattern}".` };
        }
        case 'run_terminal': {
            if (!isCommandAllowed(call.command)) return { success: false, error: `Command "${call.command}" not in allowlist.` };
            const { stdout, stderr, code } = runTerminal(call.command, workspaceDir);
            const out = (stdout + '\n' + stderr).trim() || '(no output)';
            return code === 0 ? { success: true, result: out } : { success: false, error: `Exit ${code}:\n${out}` };
        }
        default:
            return { success: false, error: `Unknown tool "${call.tool}".` };
        }
    } catch (e) {
        return { success: false, error: `Error in ${call.tool}: ${e.message}` };
    }
}

// ── EXECUTION LAYER ──────────────────────────────────────────────────────────
export class ExecutionLayer {
    get name() { return 'ExecutionLayer'; }

    async process(ctx) {
        const route = ctx.routeDecision;
        if (!route) { ctx.error = 'No route decision'; return; }

        Logger.stage('ExecutionLayer', `Mode: ${route.mode.toUpperCase()}`);
        bus.emit(AGENT_EVENTS.EXECUTION_STARTED, { mode: route.mode });

        let output = null;

        switch (route.mode) {
        case 'reactive':
            output = await this._handleReactive(ctx);
            break;
        case 'document':
            output = await this._handleDocument(ctx);
            break;
        case 'terminal':
            output = await this._handleTerminal(ctx);
            break;
        case 'complex':
            output = await this._handleComplex(ctx);
            break;
        case 'feature':
            output = await this._handleFeature(ctx);
            break;
        case 'subagent':
            output = await this._handleSubagent(ctx);
            break;
        default:
            output = await this._handleReactive(ctx);
        }

        ctx.executionResult = { output, files: [...ctx.createdFiles] };
        ctx.finalOutput     = output;
        bus.emit(AGENT_EVENTS.EXECUTION_DONE, { mode: route.mode });
    }

    // ── REACTIVE: streaming chat ────────────────────────────────────────────
    async _handleReactive(ctx) {
        Logger.stage('Reactive', `Using ${MODELS.REACTIVE} (streaming)...`);
        const extra  = ctx.routeDecision.extraPrompt || 'Answer helpfully and concisely.';
        const brevity = ctx.routeDecision.complexity === 'low' ? ' Reply in 1–2 sentences max.' : '';
        const citationRules = `
=== MANDATORY CITATION REQUIREMENT ===
- If you use any information retrieved from '[Retrieved Documents]', you MUST cite your source inline using this exact bracket format: [Source: <document_name>, Chunk <number>] (for example: [Source: https://en.wikipedia.org/wiki/IBM, Chunk 2] or [Source: quantum_computing_overview.docx, Chunk 1]).
- You MUST append this citation directly to the end of the sentence containing the retrieved facts.
- Do not use conversational citations like "According to the webpage...". Use the brackets format [Source: ..., Chunk ...] instead.
- If the information is not in the '[Retrieved Documents]' section, do not add any citations.
`;
        const sys = `You are Aria, a concise and friendly local AI assistant.${brevity}\nInstruction: ${extra}\n${citationRules}\n\n` + ctx.contextHeader;
        
        const userPromptSuffix = ctx.enrichedPrompt + 
            `\n\n[REMINDER]: If you use the retrieved documents to answer my question, you MUST cite your source inline using the exact bracket format: [Source: <document_name>, Chunk <number>] (e.g. [Source: https://en.wikipedia.org/wiki/IBM, Chunk 1]). Do not use conversational citations like "According to the webpage...".`;

        const msgs = [
            { role: 'system', content: sys },
            ...ctx.history.slice(-5).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
            { role: 'user',   content: userPromptSuffix }
        ];

        Logger.nl();
        Logger.divider('─', 62);
        process.stdout.write(`\x1b[1m\x1b[96m🧠  Aria:\x1b[0m \x1b[93m`);

        const full = await callOllamaStream(msgs, MODELS.REACTIVE);
        process.stdout.write('\x1b[0m\n');
        Logger.nl();

        ctx.streamedTokenCount = full?.length || 0;
        return full;
    }

    // ── SUBAGENT: parallel processing ───────────────────────────────────────
    async _handleSubagent(ctx) {
        Logger.stage('Subagent', 'Orchestrating parallel tasks...');
        const tasks = ctx.routeDecision.subTasks.map((t, i) => ({
            id: `task_${i+1}`,
            prompt: `Task: ${t}\nWorkspace Snapshot:\n${ctx.workspaceSnapshot}`
        }));
        
        const results = await subagentManager.executeParallel(tasks, MODELS.COMPLEX);
        
        const combined = results.map(r => `--- Result for ${r.id} ---\n${r.error || r.result}`).join('\n\n');
        
        // Final aggregation
        Logger.stage('Subagent', 'Aggregating results...');
        const finalPrompt = `You are the master agent. Summarize the following parallel subagent results into a coherent final response for the user:\n\n${combined}`;
        
        process.stdout.write(`\n\x1b[1m\x1b[96m🧠  Aria (Aggregating):\x1b[0m \x1b[93m`);
        const finalOut = await callOllamaStream([{ role: 'user', content: finalPrompt }], MODELS.REACTIVE);
        process.stdout.write('\x1b[0m\n');
        
        return finalOut;
    }

    // ── TERMINAL: plan → run → verify → retry ──────────────────────────────
    async _handleTerminal(ctx) {
        Logger.stage('Terminal', 'plan → run → verify → retry loop');
        const MAX_ATTEMPTS = 3;
        let prevError = null;

        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            let command, cwd = ctx.workspaceDir;

            // Direct command from pre-router
            const directCmd = attempt === 0 && ctx.routeDecision.extraPrompt?.startsWith('DIRECT_CMD:')
                ? ctx.routeDecision.extraPrompt.slice(11).trim() : null;

            if (directCmd) {
                command = directCmd;
                Logger.toolCall('Terminal ⚡', command);
            } else {
                const context = prevError
                    ? `Previous command failed.\nCmd: ${prevError.command}\nError: ${prevError.output}\nHint: ${prevError.hint}\nFix it for: ${ctx.enrichedPrompt}`
                    : (ctx.routeDecision.extraPrompt && !ctx.routeDecision.extraPrompt.startsWith('DIRECT_CMD:')
                        ? ctx.routeDecision.extraPrompt : ctx.enrichedPrompt);

                Logger.stage('Terminal', attempt > 0 ? `Re-planning (attempt ${attempt + 1})...` : 'Planning command...');
                const planSys = `You are a Windows PowerShell command planner.\nOutput ONLY JSON: {"command":"exact cmd","reason":"why","cwd":"./"}\nGoal: ${context}\nWorkspace:\n${ctx.workspaceSnapshot.split('\n').slice(0,10).join('\n')}`;
                const plan = extractJson(await complexModel([
                    { role: 'system', content: planSys },
                    { role: 'user',   content: ctx.enrichedPrompt }
                ], true));

                if (!plan?.command) { Logger.warn('Could not plan a command.'); break; }
                command = plan.command;
                if (plan.cwd) cwd = path.resolve(ctx.workspaceDir, plan.cwd);
                Logger.toolCall('Terminal Plan', `${command} — ${plan.reason || ''}`);
            }

            if (!isCommandAllowed(command)) {
                Logger.warn(`Command "${command}" not in allowlist. Skipping.`);
                return `Command not allowed: "${command}"`;
            }

            const { stdout, stderr, code } = runTerminal(command, cwd);
            const rawOutput = (stdout + '\n' + stderr).trim();

            // AI checks output
            Logger.stage('Terminal', 'Verifying output...');
            const check = extractJson(await callOllama([
                { role: 'system', content: `You verify terminal output. Output ONLY JSON: {"ok":true|false,"summary":"one-line summary","fix":"if failed, concise fix suggestion"}\nRules:\n1. Read output exactly. Do not invent version numbers.\n2. ok:true if exit code 0 and output non-empty.` },
                { role: 'user',   content: `Command: ${command}\nExit code: ${code}\nOutput:\n${rawOutput || '(empty)'}` }
            ], MODELS.REACTIVE, true));

            const succeeded = check ? check.ok !== false : (code === 0 && rawOutput.length > 0);

            if (succeeded) {
                if (check?.summary) Logger.success(check.summary);
                Logger.nl();
                console.log(`\x1b[93m${rawOutput}\x1b[0m\n`);
                ctx.recordToolCall('terminal', { command }, rawOutput);
                return `\`${command}\`\n${rawOutput}`;
            }

            const hint = check?.fix || 'Try an alternative command.';
            Logger.warn(`Output check failed (attempt ${attempt + 1}/${MAX_ATTEMPTS}). ${hint}`);
            prevError = { command, output: rawOutput || `exit ${code}`, hint };
            
            // SELF-HEALING CODE EXECUTION
            if (rawOutput.includes('Error:') || rawOutput.includes('Exception:') || rawOutput.includes('Traceback')) {
                Logger.stage('Terminal', 'Self-Healing triggered: Analysing stack trace...');
                const healSys = `You are a Code Healer. The following script crashed.\nAnalyze the stack trace and fix the file using a JSON tool call (e.g. replace_lines or edit_file).\nOutput ONLY a valid JSON tool call.`;
                const healRaw = await complexModel([
                    { role: 'system', content: healSys },
                    { role: 'user', content: `Command: ${command}\nOutput/Trace:\n${rawOutput}` }
                ], true);
                
                const healCall = extractJson(healRaw);
                if (healCall && healCall.tool) {
                    Logger.toolCall(`Healer → ${healCall.tool}`, healCall.path);
                    const healRes = executeFileTool(healCall, ctx.workspaceDir);
                    if (healRes.success) {
                        Logger.success(`Self-Healing applied to ${healCall.path}. Retrying...`);
                        continue;
                    } else {
                        Logger.warn(`Self-Healing failed: ${healRes.error}`);
                    }
                }
            }
        }

        return prevError
            ? `Failed after ${MAX_ATTEMPTS} attempts.\nLast: \`${prevError.command}\`\n${prevError.output}`
            : 'Could not determine a working command.';
    }

    // ── COMPLEX: THINK → PLAN → CREATE → CHECK loop ───────────────────────
    async _handleComplex(ctx) {
        Logger.stage('Complex', `${MODELS.COMPLEX} — Structured Execution Loop`);
        const snapshot = contextManager.getWorkspaceSnapshot(ctx.workspaceDir);

        const toolDocs = `You are ARIA — an elite autonomous AI software engineer running locally on Windows.
Workspace: ${ctx.workspaceDir}
User: ${ctx.userProfile.user_name} | OS: ${ctx.userProfile.operating_system}
Languages: ${(ctx.userProfile.preferred_programming_languages || []).join(', ')}

Router Instruction:
${ctx.routeDecision.extraPrompt || 'Plan and execute the task.'}

=== WORKSPACE SNAPSHOT ===
${snapshot}

CRITICAL FILE RULES:
- NEVER invent filenames. Only use files shown in the snapshot.
- To edit an existing file: edit_file with EXACT name from snapshot.
- To create a new file: create_file.

=== CODE QUALITY (NON-NEGOTIABLE) ===
For WEB tasks: Full semantic HTML, Google Fonts, dark/premium CSS with variables/gradients/animations, interactive JS.
For PYTHON: Complete, working, well-commented code with imports and error handling.
For ALL: Write FULL content every time — never truncate with "..." or "etc".

=== CITATION RULES ===
- If you use any information retrieved from '[Retrieved Documents]', you MUST cite your source inline using this exact bracket format: [Source: <document_name>, Chunk <number>] (for example: [Source: https://en.wikipedia.org/wiki/IBM, Chunk 2] or [Source: quantum_computing_overview.docx, Chunk 1]).
- You MUST append this citation directly to the end of the sentence containing the retrieved facts.
- Do not use conversational citations like "According to the webpage...". Use the brackets format [Source: ..., Chunk ...] instead.
- If the information is not in the '[Retrieved Documents]' section, do not add any citations.

=== AVAILABLE TOOLS ===
{"tool":"list_dir","path":"./"}
{"tool":"read_file","path":"filename.ext"}
{"tool":"create_file","path":"filename.ext","content":"FULL content here"}
{"tool":"edit_file","path":"filename.ext","content":"FULL new content here"}
{"tool":"replace_lines","path":"filename.ext","start_line":1,"end_line":3,"content":"new lines"}
{"tool":"delete_file","path":"filename.ext"}
{"tool":"grep_search","path":"./","pattern":"search term"}
{"tool":"run_terminal","command":"node script.js"}

Done: {"response":"Summary of what was completed"}

=== EXECUTION RULES ===
1. Output ONLY a single valid JSON object per turn. No markdown. No extra text.
2. FIRST action: create plan.md with your detailed Think→Plan.
3. After create_file or edit_file: ALWAYS verify with read_file.
4. Write COMPLETE file contents every time — never truncate.
5. If the user asks you to write about a topic, DO NOT ask for more details. Generate the content using your own knowledge.
6. When ALL files are created, verified, and working: output {"response":"..."}.

${ctx.contextHeader}`;

        let history = [{ role: 'system', content: toolDocs }, { role: 'user', content: ctx.enrichedPrompt }];
        let loops = 30, hasCritiquedPlan = false, verificationAttempts = 0, formattingErrors = 0;

        while (loops-- > 0) {
            const raw = await complexModel(history, true);
            if (!raw) { Logger.error('Model returned empty response.'); break; }

            history.push({ role: 'assistant', content: raw });
            let call = extractJson(raw);
            
            // Map alternative keys to response if missing tool
            if (call && typeof call === 'object' && !call.tool && !call.response) {
                const vals = Object.values(call);
                const str = vals.find(v => typeof v === 'string');
                if (str) call.response = str;
            }

            // Done
            if (call?.response) {
                if (ctx.createdFiles.size > 0 && verificationAttempts < 2) {
                    const vr = await this._runVerification(ctx);
                    if (!vr.success) {
                        verificationAttempts++;
                        Logger.warn(`[Verification] Attempt ${verificationAttempts} failed — requesting fixes.`);
                        history.push({ role: 'user', content: `[Code Verification Failure]:\n${vr.feedback}\n\nPlease revise the files to correct these issues. Ensure no syntax errors or incomplete code.` });
                        continue;
                    }
                }
                Logger.stage('Complex', `Done: ${call.response}`);
                return call.response;
            }

            // Tool call
            if (call?.tool) {
                const planPath = path.join(ctx.workspaceDir, 'plan.md');
                const isWrite  = ['create_file','edit_file','replace_lines'].includes(call.tool);
                const isPlan   = call.path && (call.path === 'plan.md' || call.path.endsWith('/plan.md'));

                // Plan guard
                if (isWrite && !isPlan && !fs.existsSync(planPath)) {
                    Logger.warn('[Plan Guard] plan.md must be created first.');
                    history.push({ role: 'user', content: 'Rule: Create plan.md FIRST before any other file. Output the create_file tool call for plan.md now.' });
                    continue;
                }

                if (isWrite && call.path && !isPlan) ctx.createdFiles.add(call.path);

                const validation = validateToolCall(call, ctx.workspaceDir);
                if (!validation.valid) {
                    Logger.warn(`[Validation] ${validation.error}`);
                    history.push({ role: 'user', content: `[Tool Validation Error]: ${validation.error}. Correct the parameters.` });
                    continue;
                }

                Logger.toolCall(call.tool, call.path || call.command || '');
                bus.emit(AGENT_EVENTS.TOOL_CALLED, { tool: call.tool, path: call.path || call.command });

                let toolRes = executeFileTool(call, ctx.workspaceDir);
                ctx.recordToolCall(call.tool, { path: call.path, command: call.command }, toolRes.success ? toolRes.result : toolRes.error);

                if (!toolRes.success) {
                    // Self-correction
                    const correction = await this._selfCorrect(call, toolRes.error, ctx.workspaceDir);
                    if (correction.success) {
                        toolRes = { success: true, result: correction.result };
                        if (correction.correctedCall?.path && !isPlan) ctx.createdFiles.add(correction.correctedCall.path);
                    } else {
                        history.push({ role: 'user', content: `[Tool Error]: ${correction.error}. Adjust your strategy.` });
                        continue;
                    }
                }

                // Plan critique
                if (isPlan && isWrite && !hasCritiquedPlan) {
                    const gaps = await this._refinePlan(ctx.enrichedPrompt, call.content ?? '');
                    hasCritiquedPlan = true;
                    if (gaps) {
                        Logger.warn(`[Plan Refinement] Gaps: ${gaps.join(', ')}`);
                        history.push({ role: 'user', content: `[Plan Critique]:\n${gaps.map(g => `- ${g}`).join('\n')}\n\nRevise plan.md to address these gaps before writing code files.` });
                        continue;
                    }
                }

                Logger.debug(`Tool result: ${toolRes.result.slice(0, 300)}`);
                bus.emit(AGENT_EVENTS.TOOL_RESULT, { tool: call.tool, success: true });
                history.push({
                    role: 'user',
                    content: `[Tool Result]: ${toolRes.result}\n\nREMEMBER: Write FULL file contents. Verify with read_file after every write.\nWhen ALL files are done: output {"response":"..."}`
                });

            } else {
                const stripped = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
                
                // If the model output plain text but we've already done work, accept it
                if (ctx.createdFiles.size > 0 && stripped.length > 20) {
                    Logger.stage('Complex', 'Final (text response)');
                    return stripped;
                }

                formattingErrors++;
                if (formattingErrors >= 3) {
                    Logger.warn('[Complex] Aborting due to repeated formatting errors.');
                    return "Agent aborted: Failed to generate valid JSON tool calls.";
                }

                // Otherwise, aggressively enforce JSON
                Logger.warn('[Complex] Model output plain text instead of JSON.');
                history.push({ 
                    role: 'user', 
                    content: `CRITICAL ERROR: You output plain text instead of JSON. You MUST output ONLY a valid JSON object representing a tool call (e.g., {"tool":"run_terminal","command":"..."}) or {"response":"done"}. Do not use markdown blocks. Do not explain yourself.` 
                });
            }
        }

        Logger.warn('[Complex] Max loops reached.');
        return 'Task halted — reached maximum execution depth.';
    }

    // ── FEATURE: plugin execution ────────────────────────────────────────────
    async _handleFeature(ctx) {
        const name   = ctx.routeDecision.featureName;
        const params = ctx.routeDecision.featureParams || {};

        if (!name || !pluginManager.has(name)) {
            Logger.warn(`[Feature] Plugin "${name}" not found`);
            return await this._handleReactive(ctx);
        }

        const result = await pluginManager.execute(name, params, ctx.workspaceDir);
        Logger.success(`Plugin [${name}] → ${result.slice(0, 120)}`);
        console.log(`\n\x1b[93m${result}\x1b[0m\n`);
        ctx.recordToolCall(`plugin:${name}`, params, result);
        return `Feature [${name}]: ${result}`;
    }

    // ── Plan Refinement ──────────────────────────────────────────────────────
    async _refinePlan(prompt, planContent) {
        Logger.stage('PlanRefinement', 'Analyzing plan.md for gaps...');
        const sys = `You are an elite code plan reviewer.\nReview the plan against the user prompt.\nOutput ONLY JSON: {"approved":true|false,"reason":"why","gaps":["gap 1"]}\nUser prompt: "${prompt}"`;
        const raw = await routerModel([{ role: 'system', content: sys }, { role: 'user', content: `Plan:\n${planContent}` }], true);
        const cr  = extractJson(raw);
        if (cr?.approved === false && cr.gaps?.length > 0) {
            Logger.warn(`Plan not approved. Gaps: ${cr.gaps.join(', ')}`);
            return cr.gaps;
        }
        Logger.success('Plan approved!');
        return null;
    }

    // ── Self-Correction ──────────────────────────────────────────────────────
    async _selfCorrect(toolCall, errorOutput, workspaceDir, depth = 0) {
        if (depth >= 3) return { success: false, error: `Self-correction max depth. Error: ${errorOutput}` };
        Logger.stage('SelfCorrection', `Level ${depth + 1} — ${errorOutput.slice(0, 100)}...`);
        const sys = `You are a self-correcting agent supervisor.\nA tool failed. Propose a corrected tool call.\nOutput ONLY a single valid JSON tool call, or {"give_up":true,"reason":"..."}.\nFailed: ${JSON.stringify(toolCall)}\nError: ${errorOutput}`;
        const correctedRaw  = await complexModel([{ role: 'system', content: sys }, { role: 'user', content: 'Provide the corrected JSON tool call now.' }], true);
        const correctedCall = extractJson(correctedRaw);
        if (correctedCall?.give_up) return { success: false, error: `Correction abandoned: ${correctedCall.reason}` };
        if (correctedCall) {
            const result = executeFileTool(correctedCall, workspaceDir);
            if (result.success) { Logger.success('Self-correction succeeded!'); return { success: true, result: result.result, correctedCall }; }
            return this._selfCorrect(correctedCall, result.error, workspaceDir, depth + 1);
        }
        return { success: false, error: `Failed to generate correction JSON.` };
    }

    // ── Verification Loop ────────────────────────────────────────────────────
    async _runVerification(ctx) {
        Logger.stage('Verification', 'Auditing generated files...');
        const feedback = [];
        for (const filePath of ctx.createdFiles) {
            const full = path.resolve(ctx.workspaceDir, filePath);
            if (!fs.existsSync(full)) continue;
            const content = fs.readFileSync(full, 'utf-8');
            const sys     = `You are a code reviewer. Verify this file satisfies: "${ctx.enrichedPrompt}". Point out bugs, syntax errors, or placeholder implementations. Be concise.`;
            const review  = await verifyModel([{ role: 'system', content: sys }, { role: 'user', content: `\`\`\`\n${content}\n\`\`\`` }]);
            if (!review) continue;
            const cleanSys = `Analyze this code review. If it contains critical bugs or failures: {"clean":false,"issues":["issue 1"]}. Otherwise: {"clean":true}.`;
            const cr = extractJson(await routerModel([{ role: 'system', content: cleanSys }, { role: 'user', content: review }], true));
            if (cr?.clean === false) {
                feedback.push(`File: ${filePath}\nIssues:\n${(cr.issues || []).join('\n')}\nReview:\n${review}`);
            }
        }
        if (feedback.length) {
            Logger.warn('[Verification] Issues found!');
            bus.emit(AGENT_EVENTS.VERIFICATION_DONE, { success: false, fileCount: ctx.createdFiles.size });
            return { success: false, feedback: feedback.join('\n\n') };
        }
        Logger.success('[Verification] All files passed review!');
        bus.emit(AGENT_EVENTS.VERIFICATION_DONE, { success: true, fileCount: ctx.createdFiles.size });
        return { success: true, feedback: '' };
    }

    // ── DOCUMENT: iterative document generation and compilation ─────────────
    async _handleDocument(ctx) {
        Logger.stage('DocumentMode', 'Starting document generation workflow...');
        const prompt = ctx.enrichedPrompt;

        const promptRefinerSys = `You are a professional Prompt Engineer for FLUX image generators.
Your goal is to translate a raw diagram concept description into a highly detailed, professional, and visually stunning volumetric 3D style tech infographic for a premium report.

Follow these strict rules:
1. The style must always be: "Vibrant modern volumetric 3D infographic illustration, high-fidelity technology diagram. Sleek corporate tech design with rich details, smooth gradients, glossy reflections, and professional studio lighting."
2. The background must always be: "Clean light gray studio background, perfectly solid and neutral, no grids, no shadows."
3. The color palette: "Use a vibrant and colorful palette with glossy reflections (e.g., tech blue, emerald green, orange, purple, and red accents) to make the nodes pop."
4. Strictly NO text: "Absolutely no text labels, words, letters, signatures, or fonts. Use symbolic 3D icons to convey meaning."
5. Layout and Composition: Describe the layout symmetrically and geometrically. The nodes must be substantial, colorful, glossy spheres or round cards, containing detailed 3D icons (not blank circles).
6. Do NOT include any meta-words like "A prompt for...", "A beautiful illustration...", "Rendered in...". Output ONLY the final visual prompt text.

Example input: "A brain connected to deep learning application icons like NLP, vision, speech."
Example output: "Vibrant premium 3D infographic illustration of deep learning applications. Symmetrical technology layout on a clean light gray background. In the center, a glowing blue digital brain icon inside a glossy sphere. Connected by glowing blue data paths are five surrounding colorful 3D nodes, each node containing a detailed, clearly visible glossy icon: a blue camera lens (vision), a green speech bubble (NLP), a yellow microphone (speech), a red shopping cart (recommendations), and a purple shield (security). Bright studio lighting, smooth gradients, soft reflections, professional tech design, no text."

Output ONLY the expanded, high-quality prompt.`;

        // Read API key from .env file (either in workspace dir or project root)
        let imageApiKey = '';
        try {
            const envPaths = [
                path.join(ctx.workspaceDir, '.env'),
                path.join(process.cwd(), '.env')
            ];
            for (const envPath of envPaths) {
                if (fs.existsSync(envPath)) {
                    const envContent = fs.readFileSync(envPath, 'utf-8');
                    const match = envContent.match(/image\s*=\s*["']?(nvapi-[^"'\s]+)["']?/);
                    if (match) {
                        imageApiKey = match[1];
                        Logger.debug(`[DocumentMode] Loaded NVIDIA API key from ${envPath}`);
                        break;
                    }
                }
            }
        } catch (e) {
            Logger.warn(`Failed to read .env file: ${e.message}`);
        }
        
        // Phase 1: Planning / Section breakdown
        Logger.stage('DocumentMode', 'Analyzing document requirements and planning sections...');
        const planSys = `You are a document structure planner. Analyze the user request to create a structured document.
Decompose the requested document into logical, detailed chapters or topics.
Output ONLY a valid JSON object matching this schema:
{
  "needDetails": true,
  "reason": "Explain why details are needed",
  "filename": "suggested_filename.docx",
  "title": "A beautiful formal title for the document",
  "theme": "navy" | "emerald" | "crimson" | "minimalist",
  "topics": [
    "Chapter/Section Title 1",
    "Chapter/Section Title 2"
  ],
  "format": "docx" | "markdown"
}
Choose the theme based on the subject (e.g., emerald for biotech/nature, navy for business/finance, crimson for modern tech/cutting-edge, minimalist for clean design).
If the user's request is simple and does NOT need a detailed section-by-section breakdown (e.g. very short, simple question), set "needDetails" to false.`;

        const planRaw = await complexModel([
            { role: 'system', content: planSys },
            { role: 'user', content: prompt }
        ], true);

        let plan = extractJson(planRaw);
        if (!plan || !Array.isArray(plan.topics)) {
            Logger.warn('[DocumentMode] Failed to plan document. Using fallback structure.');
            plan = {
                needDetails: true,
                reason: "Failed to generate structured plan. Using generic fallback.",
                filename: "document.docx",
                title: "Workflow AI Document",
                theme: "navy",
                topics: ["Introduction", "Core Concepts", "Implementation Details", "Conclusion"],
                format: "docx"
            };
        }

        if (!plan.needDetails) {
            Logger.stage('DocumentMode', 'Details not required, executing reactive response...');
            return await this._handleReactive(ctx);
        }

        const format = plan.format || 'docx';
        const filename = plan.filename || (format === 'docx' ? 'document.docx' : 'document.md');
        const safeFilename = path.basename(filename); // Ensure it's just a file name in the workspace
        const targetPath = resolveSafePath(ctx.workspaceDir, safeFilename);

        Logger.success(`Planned document: ${safeFilename} (${plan.topics.length} sections)`);

        // Phase 2: Temporary Database Setup
        const dbPath = path.join(ctx.workspaceDir, 'temp_topics.json');
        const dbState = {
            originalPrompt: prompt,
            documentTitle: plan.title || prompt,
            format: format,
            filename: safeFilename,
            theme: plan.theme || 'navy',
            nvidia_api_key: imageApiKey,
            topics: plan.topics.map(t => ({ title: t, content: '', image_prompt: null, status: 'pending' })),
            completed: false
        };

        fs.writeFileSync(dbPath, JSON.stringify(dbState, null, 2), 'utf-8');

        // Phase 3: Iterative detail generation
        const total = dbState.topics.length;
        for (let i = 0; i < total; i++) {
            const topic = dbState.topics[i];
            Logger.stage('DocumentMode', `Generating section ${i + 1}/${total}: "${topic.title}"...`);

            // Previous section content for transition
            const prevContent = i > 0 ? dbState.topics[i - 1].content : '';
            const nextPrompt = `You are a professional content writer and visual designer.
Overall Document Subject: "${prompt}"
Planned topics/chapters: ${JSON.stringify(dbState.topics.map(t => t.title))}

Generate the content for the section: "${topic.title}"
${prevContent ? `Here is the end of the previous section for context/transitions:\n"${prevContent.slice(-1200)}"` : ''}

Instructions:
1. Write rich, detailed content for this section.
2. Use paragraph text, lists, and tables where appropriate.
3. Do not add page titles, introductory document headers, or concluding sections unless they are specifically part of this section.
4. Determine if a diagram, visual illustration, or concept chart would help explain the concepts in this section. If so, write a highly descriptive prompt for an image generator (like FLUX) to create a clean, professional diagram or chart.
   - ABSOLUTELY NO text labels, words, or letters in the diagram (always use simple shapes, lines, and symbolic icons instead to avoid garbled AI text).
   - Use concrete visual metaphors (e.g., a shield for security/fraud, a magnifying glass for search, a brain for processing, a speech bubble for NLP) rather than abstract flowcharts with labeled nodes.
   - Focus on style descriptors: "Vibrant modern volumetric 3D infographic illustration, high-fidelity technology diagram. Sleek corporate tech design with rich details, smooth gradients, glossy reflections, professional studio lighting, clean light gray background. No text."
   
   Examples:
   - Bad prompt: "A flowchart of deep learning applications with nodes labeled NLP, computer vision, and speech recognition connected by arrows."
   - Good prompt: "Vibrant premium 3D infographic illustration of deep learning applications. Symmetrical technology layout on a clean light gray background. In the center, a glowing blue digital brain icon inside a glossy sphere. Connected by glowing blue data paths are five surrounding colorful 3D nodes, each node containing a detailed, clearly visible glossy icon: a blue camera lens (vision), a green speech bubble (NLP), a yellow microphone (speech), a red shopping cart (recommendations), and a purple shield (security). Bright studio lighting, smooth gradients, soft reflections, professional tech design, no text."
   
5. Output ONLY valid JSON:
{
  "topic": "${topic.title}",
  "body": "detailed content paragraph(s)",
  "image_prompt": "highly detailed image generation prompt, or null if no diagram/image is needed"
}
`;

            const sectionRaw = await complexModel([
                { role: 'user', content: nextPrompt }
            ], true);

            let sectionParsed = extractJson(sectionRaw);
            let content = '';
            let imagePrompt = null;
            if (sectionParsed && sectionParsed.body) {
                content = sectionParsed.body;
                imagePrompt = sectionParsed.image_prompt || null;
            } else {
                if (sectionParsed && typeof sectionParsed === 'object') {
                    content = sectionParsed.content || sectionParsed.text || JSON.stringify(sectionParsed);
                    imagePrompt = sectionParsed.image_prompt || null;
                } else {
                    content = sectionRaw || '';
                }
            }

            // Refine the image prompt using a dedicated model query if it exists
            if (imagePrompt && imagePrompt.trim() && imagePrompt.toLowerCase() !== 'null') {
                Logger.stage('DocumentMode', `Refining image prompt for "${topic.title}"...`);
                try {
                    const refinedPrompt = await routerModel([
                        { role: 'system', content: promptRefinerSys },
                        { role: 'user', content: `Section Title: "${topic.title}"\nSection Content:\n"${content.slice(0, 1500)}"\n\nRaw Image Concept: "${imagePrompt}"` }
                    ], true);
                    if (refinedPrompt && refinedPrompt.trim()) {
                        imagePrompt = refinedPrompt.trim().replace(/^"|"$/g, '');
                        Logger.debug(`[DocumentMode] Refined image prompt: "${imagePrompt}"`);
                    }
                } catch (pe) {
                    Logger.warn(`Failed to refine image prompt: ${pe.message}`);
                }
            } else {
                imagePrompt = null;
            }

            // Update database state
            dbState.topics[i].content = content;
            dbState.topics[i].image_prompt = imagePrompt;
            dbState.topics[i].status = 'completed';
            fs.writeFileSync(dbPath, JSON.stringify(dbState, null, 2), 'utf-8');

            Logger.success(`Generated content for "${topic.title}" (${content.length} characters)`);
        }

        dbState.completed = true;
        fs.writeFileSync(dbPath, JSON.stringify(dbState, null, 2), 'utf-8');

        // Phase 4: Compilation
        Logger.stage('DocumentMode', `Compiling final document into format: ${format}...`);
        let finalContentSummary = '';

        if (format === 'docx') {
            // Check python-docx dependency
            Logger.stage('DocumentMode', 'Checking python-docx library...');
            let checkRes = runTerminal('pip show python-docx', ctx.workspaceDir);
            if (checkRes.code !== 0) {
                Logger.warn('python-docx is not installed. Installing now...');
                let installRes = runTerminal('pip install python-docx', ctx.workspaceDir);
                if (installRes.code !== 0) {
                    Logger.error(`Failed to install python-docx: ${installRes.stderr}. Falling back to markdown format.`);
                    return await this._compileMarkdownFallback(dbPath, targetPath.replace(/\.docx$/, '.md'), dbState, ctx);
                }
            }

            // Write compiler script
            const compilerScriptPath = path.join(ctx.workspaceDir, 'compile_doc.py');
            const compilerScript = `import json
import os
import re
import shutil
import urllib.request
import base64
import concurrent.futures
from html.parser import HTMLParser
from docx import Document
from docx.shared import Inches, Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import parse_xml
from docx.oxml.ns import nsdecls
from docx.enum.table import WD_TABLE_ALIGNMENT

def set_cell_shading(cell, color_hex):
    shading_xml = f'<w:shd {nsdecls("w")} w:fill="{color_hex}"/>'
    cell._tc.get_or_add_tcPr().append(parse_xml(shading_xml))

def add_p_border_bottom(p, color_hex="1A365D", size="12"):
    pPr = p._p.get_or_add_pPr()
    pBdr = parse_xml(f'<w:pBdr {nsdecls("w")}><w:bottom w:val="single" w:sz="{size}" w:space="6" w:color="{color_hex}"/></w:pBdr>')
    pPr.append(pBdr)

def style_blockquote(p, color_hex="1A365D", bg_hex="F7FAFC"):
    p.paragraph_format.left_indent = Inches(0.5)
    p.paragraph_format.right_indent = Inches(0.5)
    p.paragraph_format.space_before = Pt(8)
    p.paragraph_format.space_after = Pt(8)
    
    pPr = p._p.get_or_add_pPr()
    borders_xml = f'<w:pBdr {nsdecls("w")}><w:left w:val="single" w:sz="24" w:space="12" w:color="{color_hex}"/></w:pBdr>'
    pPr.append(parse_xml(borders_xml))
    shd_xml = f'<w:shd {nsdecls("w")} w:fill="{bg_hex}"/>'
    pPr.append(parse_xml(shd_xml))

def style_table(table, color_hex="D2D6DC", border_sz="4"):
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    tblPr = table._tbl.tblPr
    borders_xml = f'''<w:tblBorders {nsdecls("w")}>
        <w:top w:val="single" w:sz="{border_sz}" w:space="0" w:color="{color_hex}"/>
        <w:left w:val="single" w:sz="{border_sz}" w:space="0" w:color="{color_hex}"/>
        <w:bottom w:val="single" w:sz="{border_sz}" w:space="0" w:color="{color_hex}"/>
        <w:right w:val="single" w:sz="{border_sz}" w:space="0" w:color="{color_hex}"/>
        <w:insideH w:val="single" w:sz="{border_sz}" w:space="0" w:color="{color_hex}"/>
        <w:insideV w:val="single" w:sz="{border_sz}" w:space="0" w:color="{color_hex}"/>
    </w:tblBorders>'''
    tblPr.append(parse_xml(borders_xml))

def set_cell_margins(cell, top=120, bottom=120, left=160, right=160):
    tcPr = cell._tc.get_or_add_tcPr()
    tcMar = parse_xml(f'<w:tcMar {nsdecls("w")}><w:top w:w="{top}" w:type="dxa"/><w:bottom w:w="{bottom}" w:type="dxa"/><w:left w:w="{left}" w:type="dxa"/><w:right w:w="{right}" w:type="dxa"/></w:tcMar>')
    tcPr.append(tcMar)

def add_page_number(run):
    fldChar1 = parse_xml(r'<w:fldChar %s w:fldCharType="begin"/>' % nsdecls('w'))
    instrText = parse_xml(r'<w:instrText %s xml:space="preserve"> PAGE </w:instrText>' % nsdecls('w'))
    fldChar2 = parse_xml(r'<w:fldChar %s w:fldCharType="separate"/>' % nsdecls('w'))
    fldChar3 = parse_xml(r'<w:fldChar %s w:fldCharType="end"/>' % nsdecls('w'))
    run._r.append(fldChar1)
    run._r.append(instrText)
    run._r.append(fldChar2)
    run._r.append(fldChar3)

def generate_image(prompt, api_key):
    endpoints = [
        ("https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-schnell", {
            "prompt": prompt,
            "seed": 0,
            "steps": 2
        }),
        ("https://integrate.api.nvidia.com/v1/images/generations", {
            "model": "stabilityai/stable-diffusion-3.5-large",
            "prompt": prompt,
            "n": 1,
            "size": "1024x1024",
            "response_format": "b64_json"
        })
    ]
    
    for url, payload in endpoints:
        try:
            req = urllib.request.Request(
                url,
                data=json.dumps(payload).encode('utf-8'),
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Accept": "application/json",
                    "Content-Type": "application/json"
                },
                method='POST'
            )
            with urllib.request.urlopen(req, timeout=45) as response:
                if response.status == 200:
                    res_data = json.loads(response.read().decode('utf-8'))
                    artifacts = res_data.get("artifacts", [])
                    if artifacts and "base64" in artifacts[0]:
                        return base64.b64decode(artifacts[0]["base64"])
                    data_list = res_data.get("data", [])
                    if data_list:
                        b64 = data_list[0].get("b64_json")
                        if b64:
                            return base64.b64decode(b64)
        except Exception as e:
            print(f"Failed to call {url}: {e}")
            continue
    return None

def markdown_to_html(text):
    # Convert bold
    text = re.sub(r'\\*\\*(.*?)\\*\\*', r'<strong>\\1</strong>', text)
    # Convert italics
    text = re.sub(r'\\*(.*?)\\*', r'<em>\\1</em>', text)
    
    lines = text.split('\\n')
    output = []
    in_table = False
    table_lines = []
    in_list = None  # Can be 'ul', 'ol', or None
    in_blockquote = False
    in_code_block = False
    code_lines = []
    
    for line in lines:
        trimmed = line.strip()
        
        # Code block detection
        if trimmed.startswith('\`\`\`'):
            if in_list:
                output.append(f'</{in_list}>')
                in_list = None
            if in_blockquote:
                output.append('</blockquote>')
                in_blockquote = False
            if in_table:
                html_table = process_md_table(table_lines)
                output.append(html_table)
                table_lines = []
                in_table = False
                
            if not in_code_block:
                in_code_block = True
                code_lines = []
            else:
                in_code_block = False
                code_content = '\\n'.join(code_lines)
                escaped = code_content.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
                output.append(f'<pre><code>{escaped}</code></pre>')
            continue
            
        if in_code_block:
            code_lines.append(line)
            continue
            
        # Blockquote detection
        if trimmed.startswith('> '):
            if in_list:
                output.append(f'</{in_list}>')
                in_list = None
            if not in_blockquote:
                output.append('<blockquote>')
                in_blockquote = True
            content = trimmed[2:]
            output.append(f'<p>{content}</p>')
            continue
        elif in_blockquote:
            output.append('</blockquote>')
            in_blockquote = False
            
        # Table detection
        if trimmed.startswith('|') and trimmed.endswith('|'):
            if in_list:
                output.append(f'</{in_list}>')
                in_list = None
            if re.match(r'^\\|[\\s\\-\\|:]+\\|$', trimmed):
                continue
            table_lines.append(trimmed)
            in_table = True
            continue
        elif in_table:
            html_table = process_md_table(table_lines)
            output.append(html_table)
            table_lines = []
            in_table = False
            
        # Unordered list detection
        if trimmed.startswith('- ') or trimmed.startswith('* '):
            if in_list == 'ol':
                output.append('</ol>')
                in_list = None
            if not in_list:
                output.append('<ul>')
                in_list = 'ul'
            content = trimmed[2:]
            output.append(f'<li>{content}</li>')
            continue
            
        # Ordered list detection
        elif re.match(r'^\\d+\\.\\s+', trimmed):
            if in_list == 'ul':
                output.append('</ul>')
                in_list = None
            if not in_list:
                output.append('<ol>')
                in_list = 'ol'
            content = re.sub(r'^\\d+\\.\\s+', '', trimmed)
            output.append(f'<li>{content}</li>')
            continue
            
        elif in_list:
            output.append(f'</{in_list}>')
            in_list = None
            
        # Empty lines
        if not trimmed:
            output.append('<br/>')
            continue
            
        # Heading detection
        if trimmed.startswith('### '):
            output.append(f'<h3>{trimmed[4:]}</h3>')
        elif trimmed.startswith('## '):
            output.append(f'<h2>{trimmed[3:]}</h2>')
        elif trimmed.startswith('# '):
            output.append(f'<h1>{trimmed[2:]}</h1>')
        else:
            output.append(f'<p>{trimmed}</p>')
                
    if in_table:
        html_table = process_md_table(table_lines)
        output.append(html_table)
    if in_list:
        output.append(f'</{in_list}>')
    if in_blockquote:
        output.append('</blockquote>')
        
    return '\\n'.join(output)

def process_md_table(table_lines):
    html = ['<table>']
    is_header = True
    for line in table_lines:
        cells = [c.strip() for c in line.split('|')[1:-1]]
        html.append('<tr>')
        for cell in cells:
            tag = 'th' if is_header else 'td'
            html.append(f'<{tag}>{cell}</{tag}>')
        html.append('</tr>')
        is_header = False
    html.append('</table>')
    return '\\n'.join(html)

class WordHTMLParser(HTMLParser):
    def __init__(self, doc, theme):
        super().__init__()
        self.doc = doc
        self.theme = theme
        self.navy = theme["primary"]
        self.charcoal = theme["charcoal"]
        self.current_p = None
        self.bold = False
        self.italic = False
        self.in_list = False
        self.list_style = "List Bullet"
        self.in_blockquote = False
        self.in_code_block = False
        self.in_table = False
        self.table_data = []
        self.current_row = []
        self.current_cell_text = ""
        self.in_cell = False
        
    def handle_starttag(self, tag, attrs):
        if tag == 'p':
            if not self.in_table:
                self.current_p = self.doc.add_paragraph()
                self.current_p.paragraph_format.space_after = Pt(6)
                self.current_p.paragraph_format.line_spacing = 1.15
                if self.in_blockquote:
                    style_blockquote(self.current_p, color_hex=self.theme["primary_hex"], bg_hex=self.theme["bg_hex"])
        elif tag in ['strong', 'b']:
            self.bold = True
        elif tag in ['em', 'i']:
            self.italic = True
        elif tag == 'ul':
            self.in_list = True
            self.list_style = "List Bullet"
        elif tag == 'ol':
            self.in_list = True
            self.list_style = "List Number"
        elif tag == 'li':
            if not self.in_table:
                self.current_p = self.doc.add_paragraph(style=self.list_style)
                self.current_p.paragraph_format.space_after = Pt(3)
        elif tag == 'blockquote':
            self.in_blockquote = True
        elif tag == 'pre':
            self.in_code_block = True
            if not self.in_table:
                self.current_p = self.doc.add_paragraph()
                self.current_p.paragraph_format.left_indent = Inches(0.4)
                self.current_p.paragraph_format.right_indent = Inches(0.4)
                self.current_p.paragraph_format.space_before = Pt(6)
                self.current_p.paragraph_format.space_after = Pt(6)
                pPr = self.current_p._p.get_or_add_pPr()
                borders_xml = f'<w:pBdr {nsdecls("w")}><w:left w:val="single" w:sz="12" w:space="8" w:color="A0AEC0"/><w:top w:val="single" w:sz="12" w:space="8" w:color="A0AEC0"/><w:bottom w:val="single" w:sz="12" w:space="8" w:color="A0AEC0"/><w:right w:val="single" w:sz="12" w:space="8" w:color="A0AEC0"/></w:pBdr>'
                pPr.append(parse_xml(borders_xml))
                shd_xml = f'<w:shd {nsdecls("w")} w:fill="{self.theme["bg_hex"]}"/>'
                pPr.append(parse_xml(shd_xml))
        elif tag == 'code':
            self.in_code_block = True
        elif tag == 'table':
            self.in_table = True
            self.table_data = []
        elif tag == 'tr':
            self.current_row = []
        elif tag in ['td', 'th']:
            self.in_cell = True
            self.current_cell_text = ""
        elif tag in ['h1', 'h2', 'h3']:
            if not self.in_table:
                level = int(tag[1])
                self.current_p = self.doc.add_heading(level=level)
                self.current_p.paragraph_format.space_before = Pt(14)
                self.current_p.paragraph_format.space_after = Pt(4)
                self.current_p.paragraph_format.keep_with_next = True
                if level == 1:
                    add_p_border_bottom(self.current_p, color_hex=self.theme["primary_hex"])
                
    def handle_endtag(self, tag):
        if tag == 'p':
            self.current_p = None
        elif tag in ['strong', 'b']:
            self.bold = False
        elif tag in ['em', 'i']:
            self.italic = False
        elif tag in ['ul', 'ol']:
            self.in_list = False
        elif tag == 'li':
            self.current_p = None
        elif tag == 'blockquote':
            self.in_blockquote = False
            self.current_p = None
        elif tag in ['pre', 'code']:
            self.in_code_block = False
            self.current_p = None
        elif tag == 'td' or tag == 'th':
            self.current_row.append(self.current_cell_text.strip())
            self.in_cell = False
        elif tag == 'tr':
            if self.current_row:
                self.table_data.append(self.current_row)
        elif tag == 'table':
            self.in_table = False
            self.render_table(self.table_data)
        elif tag in ['h1', 'h2', 'h3']:
            self.current_p = None
            
    def handle_data(self, data):
        if self.in_cell:
            self.current_cell_text += data
        else:
            if not data.strip() and not self.in_code_block:
                return
            if not self.current_p:
                self.current_p = self.doc.add_paragraph()
                self.current_p.paragraph_format.space_after = Pt(6)
                self.current_p.paragraph_format.line_spacing = 1.15
                if self.in_blockquote:
                    style_blockquote(self.current_p, color_hex=self.theme["primary_hex"], bg_hex=self.theme["bg_hex"])
            
            run = self.current_p.add_run(data)
            if self.in_code_block:
                run.font.name = 'Consolas'
                run.font.size = Pt(9.5)
                run.font.color.rgb = self.charcoal
            else:
                run.font.name = self.theme["body_font"]
                run.font.size = Pt(11)
                run.font.color.rgb = self.charcoal
                if self.current_p.style.name.startswith('Heading'):
                    run.font.name = self.theme["heading_font"]
                    run.font.bold = True
                    if self.current_p.style.name == 'Heading 1':
                        run.font.size = Pt(18)
                        run.font.color.rgb = self.theme["primary"]
                    elif self.current_p.style.name == 'Heading 2':
                        run.font.size = Pt(14)
                        run.font.color.rgb = self.theme["secondary"]
                    elif self.current_p.style.name == 'Heading 3':
                        run.font.size = Pt(12)
                        run.font.color.rgb = self.theme["secondary"]
                else:
                    if self.bold:
                        run.font.bold = True
                    if self.italic or self.in_blockquote:
                        run.font.italic = True
                    
    def render_table(self, table_data):
        if not table_data:
            return
        num_rows = len(table_data)
        num_cols = max(len(row) for row in table_data)
        table = self.doc.add_table(rows=num_rows, cols=num_cols)
        style_table(table)
        for r_idx, row in enumerate(table_data):
            for c_idx, cell_text in enumerate(row):
                if c_idx >= num_cols:
                    continue
                cell = table.cell(r_idx, c_idx)
                set_cell_margins(cell)
                p = cell.paragraphs[0]
                p.paragraph_format.space_before = Pt(4)
                p.paragraph_format.space_after = Pt(4)
                p.paragraph_format.line_spacing = 1.0
                run = p.runs[0] if p.runs else p.add_run()
                run.text = cell_text
                if r_idx == 0:
                    set_cell_shading(cell, self.theme["primary_hex"])
                    run.font.name = self.theme["heading_font"]
                    run.font.bold = True
                    run.font.size = Pt(10.5)
                    run.font.color.rgb = RGBColor(255, 255, 255)
                else:
                    if r_idx % 2 == 1:
                        set_cell_shading(cell, self.theme["bg_hex"])
                    run.font.name = self.theme["body_font"]
                    run.font.size = Pt(10)
                    run.font.color.rgb = self.charcoal

def compile():
    # Load JSON data
    with open('temp_topics.json', 'r', encoding='utf-8') as f:
        data = json.load(f)

    api_key = data.get('nvidia_api_key', '')
    theme_name = data.get('theme', 'navy').lower()
    document_title = data.get('documentTitle', data.get('originalPrompt', 'Workflow AI Document'))
    
    # Configure themes
    themes = {
        "navy": {
            "primary": RGBColor(26, 54, 93),      # #1A365D
            "secondary": RGBColor(74, 85, 104),   # #4A5568
            "charcoal": RGBColor(45, 55, 72),     # #2D3748
            "heading_font": "Arial",
            "body_font": "Calibri",
            "primary_hex": "1A365D",
            "bg_hex": "F7FAFC"
        },
        "emerald": {
            "primary": RGBColor(6, 78, 59),       # #064E3B
            "secondary": RGBColor(77, 124, 15),   # #4D7C0F
            "charcoal": RGBColor(31, 41, 55),     # #1F2937
            "heading_font": "Georgia",
            "body_font": "Georgia",
            "primary_hex": "064E3B",
            "bg_hex": "F4FBF7"
        },
        "crimson": {
            "primary": RGBColor(127, 29, 29),     # #7F1D1D
            "secondary": RGBColor(71, 85, 105),   # #475569
            "charcoal": RGBColor(30, 41, 59),     # #1E293B
            "heading_font": "Segoe UI",
            "body_font": "Segoe UI",
            "primary_hex": "7F1D1D",
            "bg_hex": "FFF5F5"
        },
        "minimalist": {
            "primary": RGBColor(17, 24, 39),      # #111827
            "secondary": RGBColor(107, 114, 128), # #6B7280
            "charcoal": RGBColor(55, 65, 81),     # #374151
            "heading_font": "Arial",
            "body_font": "Arial",
            "primary_hex": "111827",
            "bg_hex": "F9FAFB"
        }
    }
    
    theme = themes.get(theme_name, themes["navy"])
    
    doc = Document()
    for section in doc.sections:
        section.top_margin = Inches(1)
        section.bottom_margin = Inches(1)
        section.left_margin = Inches(1)
        section.right_margin = Inches(1)
        section.different_first_page_header_footer = True

    # Configure running page header for subsequent pages
    section = doc.sections[0]
    header = section.header
    header_p = header.paragraphs[0]
    header_p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    h_run = header_p.add_run(f"{document_title} | Technical Specification")
    h_run.font.name = theme["heading_font"]
    h_run.font.size = Pt(8.5)
    h_run.font.color.rgb = theme["secondary"]

    # Configure footer with page numbers
    footer = section.footer
    footer_p = footer.paragraphs[0]
    footer_p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    f_run = footer_p.add_run("Page ")
    f_run.font.name = theme["heading_font"]
    f_run.font.size = Pt(9)
    f_run.font.color.rgb = theme["secondary"]
    add_page_number(footer_p.add_run())

    # Create folders
    os.makedirs('temp', exist_ok=True)
    os.makedirs('images', exist_ok=True)

    # 1. Cover Page
    title_p = doc.add_paragraph()
    title_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    title_p.paragraph_format.space_before = Pt(120)
    title_p.paragraph_format.space_after = Pt(18)
    
    run = title_p.add_run(document_title)
    run.font.name = theme["heading_font"]
    run.font.size = Pt(28)
    run.font.bold = True
    run.font.color.rgb = theme["primary"]
    
    line_p = doc.add_paragraph()
    line_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    line_p.paragraph_format.space_after = Pt(24)
    add_p_border_bottom(line_p, color_hex=theme["primary_hex"], size="24")
    
    meta_p = doc.add_paragraph()
    meta_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    meta_p.paragraph_format.space_after = Pt(120)
    meta_run = meta_p.add_run("A Technical Report and Specification")
    meta_run.font.name = theme["heading_font"]
    meta_run.font.size = Pt(14)
    meta_run.font.color.rgb = theme["secondary"]
    
    # Styled Executive Metadata Card
    meta_card = doc.add_paragraph()
    meta_card.paragraph_format.left_indent = Inches(1.2)
    meta_card.paragraph_format.right_indent = Inches(1.2)
    meta_card.paragraph_format.space_after = Pt(24)
    style_blockquote(meta_card, color_hex=theme["primary_hex"], bg_hex=theme["bg_hex"])
    
    m_run = meta_card.add_run("DOCUMENT INFORMATION\\n")
    m_run.font.name = theme["heading_font"]
    m_run.font.bold = True
    m_run.font.size = Pt(10)
    m_run.font.color.rgb = theme["primary"]
    
    m_info = [
        ("Prepared By: ", "Aria Local Workflow AI"),
        ("Date: ", "May 2026"),
        ("Status: ", "Final Specification"),
        ("Theme: ", f"{theme_name.capitalize()}")
    ]
    for label, val in m_info:
        l_run = meta_card.add_run(f"\\n• {label}")
        l_run.font.name = theme["heading_font"]
        l_run.font.bold = True
        l_run.font.size = Pt(9)
        l_run.font.color.rgb = theme["secondary"]
        v_run = meta_card.add_run(val)
        v_run.font.name = theme["body_font"]
        v_run.font.size = Pt(9)
        v_run.font.color.rgb = theme["charcoal"]
        
    doc.add_page_break()

    # 2. Table of Contents Page
    toc_heading = doc.add_heading(level=1)
    toc_heading.paragraph_format.space_before = Pt(18)
    toc_heading.paragraph_format.space_after = Pt(12)
    toc_heading.paragraph_format.keep_with_next = True
    trun = toc_heading.add_run("Table of Contents")
    trun.font.name = theme["heading_font"]
    trun.font.size = Pt(20)
    trun.font.bold = True
    trun.font.color.rgb = theme["primary"]
    add_p_border_bottom(toc_heading, color_hex=theme["primary_hex"], size="12")
    
    p_toc = doc.add_paragraph()
    p_toc.paragraph_format.space_after = Pt(24)
    run_toc = p_toc.add_run()
    fldChar1 = parse_xml(r'<w:fldChar %s w:fldCharType="begin"/>' % nsdecls('w'))
    instrText = parse_xml(r'<w:instrText %s xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText>' % nsdecls('w'))
    fldChar2 = parse_xml(r'<w:fldChar %s w:fldCharType="separate"/>' % nsdecls('w'))
    fldChar3 = parse_xml(r'<w:fldChar %s w:fldCharType="end"/>' % nsdecls('w'))
    run_toc._r.append(fldChar1)
    run_toc._r.append(instrText)
    run_toc._r.append(fldChar2)
    run_toc._r.append(fldChar3)
    
    doc.add_page_break()

    # 3. Parallel Image Generation Worker Threadpool
    image_results = {}
    def fetch_and_save_image(idx, topic):
        img_prompt = topic.get('image_prompt')
        if img_prompt and api_key:
            print(f"Generating diagram in parallel for section: {topic['title']}...")
            img_data = generate_image(img_prompt, api_key)
            if img_data:
                temp_img_path = f"temp/image_{idx}.png"
                final_img_path = f"images/image_{idx}.png"
                with open(temp_img_path, 'wb') as img_f:
                    img_f.write(img_data)
                return idx, temp_img_path, final_img_path
        return idx, None, None

    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
        futures = [executor.submit(fetch_and_save_image, idx, topic) for idx, topic in enumerate(data['topics'])]
        for future in concurrent.futures.as_completed(futures):
            res_idx, temp_path, final_path = future.result()
            if temp_path:
                image_results[res_idx] = (temp_path, final_path)

    # 4. Content loop
    for i, topic in enumerate(data['topics']):
        heading = doc.add_heading(level=1)
        heading.paragraph_format.space_before = Pt(18)
        heading.paragraph_format.space_after = Pt(6)
        heading.paragraph_format.keep_with_next = True
        
        hrun = heading.add_run(topic['title'])
        hrun.font.name = theme["heading_font"]
        hrun.font.size = Pt(18)
        hrun.font.bold = True
        hrun.font.color.rgb = theme["primary"]
        add_p_border_bottom(heading, color_hex=theme["primary_hex"])

        # Parse section body with WordHTMLParser
        body = topic.get('content', '')
        html_content = markdown_to_html(body)
        parser = WordHTMLParser(doc, theme)
        parser.feed(html_content)
        
        # Insert image if successfully generated in parallel
        if i in image_results:
            temp_img_path, final_img_path = image_results[i]
            # Add picture inline
            img_p = doc.add_paragraph()
            img_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            img_p.paragraph_format.space_before = Pt(12)
            img_p.paragraph_format.space_after = Pt(6)
            
            run = img_p.add_run()
            run.add_picture(temp_img_path, width=Inches(5.5))
            
            # Add caption
            cap_p = doc.add_paragraph()
            cap_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            cap_run = cap_p.add_run(f"Figure {i+1}: Illustration of {topic['title']}")
            cap_run.font.name = theme["heading_font"]
            cap_run.font.size = Pt(9.5)
            cap_run.font.italic = True
            cap_run.font.color.rgb = theme["secondary"]
            
            # Move to final images folder
            try:
                shutil.move(temp_img_path, final_img_path)
            except Exception as me:
                print(f"Failed to move image: {me}")
                
    filename = data.get('filename', 'document.docx')
    doc.save(filename)
    print("Compilation successful")

    # Clean up temp folder
    try:
        if os.path.exists('temp'):
            shutil.rmtree('temp')
    except Exception as e:
        print(f"Failed to clean up temp folder: {e}")

if __name__ == '__main__':
    compile()
`;
            fs.writeFileSync(compilerScriptPath, compilerScript, 'utf-8');

            Logger.stage('DocumentMode', 'Executing python compiler script...');
            let compileRes = runTerminal(`python compile_doc.py`, ctx.workspaceDir);
            
            if (compileRes.code !== 0) {
                Logger.warn(`Python compiler execution failed: ${compileRes.stderr}. Trying python3...`);
                let retryRes = runTerminal(`python3 compile_doc.py`, ctx.workspaceDir);
                if (retryRes.code !== 0) {
                    Logger.error(`Python3 compilation failed too: ${retryRes.stderr}. Falling back to markdown format.`);
                    try { fs.unlinkSync(compilerScriptPath); } catch {}
                    return await this._compileMarkdownFallback(dbPath, targetPath.replace(/\.docx$/, '.md'), dbState, ctx);
                }
            }

            // Cleanup
            try {
                fs.unlinkSync(dbPath);
                fs.unlinkSync(compilerScriptPath);
            } catch (err) {
                Logger.warn(`Failed to clean up temp files: ${err.message}`);
            }

            Logger.success(`Successfully compiled .docx document to: ${targetPath}`);
            
            const summaryTable = dbState.topics.map(t => `- **${t.title}** (${t.content.length} chars generated)`).join('\n');
            finalContentSummary = `### Document Generation Complete! 🎉
- **Filename**: \`${safeFilename}\`
- **Output Format**: Microsoft Word (.docx)
- **Path**: \`${targetPath}\`
- **Total Sections**: ${total}

#### Sections Generated:
${summaryTable}

The document has been formatted with custom fonts (Arial headings, Calibri body), matching margins, centered title page, and navy-charcoal corporate color styling.`;
        } else {
            finalContentSummary = await this._compileMarkdownFallback(dbPath, targetPath, dbState, ctx);
        }

        return finalContentSummary;
    }

    async _compileMarkdownFallback(dbPath, targetPath, dbState, ctx) {
        Logger.stage('DocumentMode', 'Compiling document as Markdown...');
        
        let markdown = `# ${dbState.originalPrompt}\n\n`;
        markdown += `*Generated by Aria Local Workflow AI*\n\n---\n\n`;
        
        for (const topic of dbState.topics) {
            markdown += `## ${topic.title}\n\n${topic.content}\n\n---\n\n`;
        }
        
        fs.writeFileSync(targetPath, markdown, 'utf-8');
        
        try {
            fs.unlinkSync(dbPath);
        } catch {}
        
        Logger.success(`Successfully compiled Markdown document to: ${targetPath}`);
        
        const summaryTable = dbState.topics.map(t => `- **${t.title}** (${t.content.length} chars)`).join('\n');
        return `### Document Generation Complete! 🎉
- **Filename**: \`${path.basename(targetPath)}\`
- **Output Format**: Markdown (.md) [Fallback]
- **Path**: \`${targetPath}\`
- **Total Sections**: ${dbState.topics.length}

#### Sections Generated:
${summaryTable}

You can view the full document in the workspace at \`${path.basename(targetPath)}\`.`;
    }
}

export default ExecutionLayer;
