import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { execSync, spawn } from 'child_process';

// ==========================================
// CONSTANTS & CONFIGURATION
// ==========================================
const MEMORY_FILE    = path.join(process.cwd(), 'memory.json');
const USER_DATA_FILE = path.join(process.cwd(), 'user_data.json');
const OLLAMA_URL     = 'http://127.0.0.1:11434/api/chat';

// ── Model Assignment ────────────────────────────────────────────────────────
//  llama3.2:1b      → ROUTER / PROFILE EXTRACTOR  (fast, tiny, JSON-only)
//  llama3:latest    → REACTIVE / CHAT             (good general reasoning)
//  qwen2.5-coder:7b → COMPLEX CODING TASKS        (purpose-built coder, JSON-reliable)
//  qwen3-vl:8b      → VISION tasks only           (image+text, avoid for pure JSON)
//  codellama:latest → CODE REVIEW / VERIFICATION  (code-specialised)
// ──────────────────────────────────────────────────────────────────────────
const MODEL_ROUTER    = 'llama3.2:1b';        // fast classifier
const MODEL_REACTIVE  = 'llama3:latest';      // chat / quick answers
const MODEL_COMPLEX   = 'qwen2.5-coder:7b';  // plan, think, create  ← reliable JSON
const MODEL_VERIFY    = 'codellama:latest';   // read_file + verify output

let WORKSPACE_DIR = process.cwd();
let memoryHistory = [];
const DEFAULT_USER_PROFILE = {
    user_name: 'Deep Rajput',
    operating_system: 'Windows',
    preferred_programming_languages: ['javascript', 'python'],
    preferences: { theme: 'dark' },
    known_facts: []
};
let userProfile   = { ...DEFAULT_USER_PROFILE };

// ==========================================
// MEMORY
// ==========================================
function loadMemory() {
    if (fs.existsSync(MEMORY_FILE)) {
        try { memoryHistory = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8')); }
        catch { memoryHistory = []; }
    }
}
function saveMemory(role, content) {
    memoryHistory.push({ role, content });
    if (memoryHistory.length > 30) memoryHistory.shift();
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(memoryHistory, null, 2));
}
loadMemory();

// ==========================================
// USER PROFILE
// ==========================================
function loadUserProfile() {
    if (fs.existsSync(USER_DATA_FILE)) {
        try { userProfile = JSON.parse(fs.readFileSync(USER_DATA_FILE, 'utf-8')); }
        catch { /* keep defaults */ }
    }
}
function saveUserProfile(profile) {
    userProfile = profile;
    fs.writeFileSync(USER_DATA_FILE, JSON.stringify(userProfile, null, 2));
}
loadUserProfile();

// ==========================================
// READLINE INTERFACE
// ==========================================
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

// ==========================================
// OLLAMA API CALLER
// ==========================================
async function callOllama(messages, model = MODEL_REACTIVE, jsonFormat = false) {
    const payload = { model, messages, stream: false };
    if (jsonFormat) payload.format = 'json';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000); // 120s timeout
    try {
        const res = await fetch(OLLAMA_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal
        });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${res.statusText}`);
        const data = await res.json();
        return data.message?.content ?? null;
    } catch (err) {
        clearTimeout(timer);
        const cause = err.cause ? ` | Cause: ${err.cause.code ?? err.cause.message ?? err.cause}` : '';
        console.error(`❌  Ollama [${model}] unreachable: ${err.message}${cause}`);
        console.error(`    → Make sure Ollama is running: ollama serve`);
        return null;
    }
}

// ==========================================
// WORKSPACE SAFETY
// ==========================================
function resolveSafePath(target) {
    const resolved = path.resolve(WORKSPACE_DIR, target);
    if (!resolved.startsWith(path.resolve(WORKSPACE_DIR))) {
        throw new Error(`SECURITY: "${resolved}" is outside the locked workspace "${WORKSPACE_DIR}"`);
    }
    return resolved;
}

// ==========================================
// WORKSPACE SCANNER  — reads folder + file previews
// ==========================================
const EXCLUDED_DIRS = ['.git', 'node_modules', '.gemini', 'dist', 'build'];
const EXCLUDED_FILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', '.ds_store'];
const MAX_FILE_SIZE_PREVIEW = 1024 * 1024; // 1MB

function scanWorkspace(dir = WORKSPACE_DIR, depth = 0, maxDepth = 2) {
    const lines = [];
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return ['(cannot read directory)']; }

    for (const entry of entries) {
        if (entry.isDirectory() && EXCLUDED_DIRS.includes(entry.name.toLowerCase())) continue;
        if (entry.isFile() && EXCLUDED_FILES.includes(entry.name.toLowerCase())) continue;

        const indent  = '  '.repeat(depth);
        const relPath = path.relative(WORKSPACE_DIR, path.join(dir, entry.name));
        if (entry.isDirectory()) {
            lines.push(`${indent}[DIR]  ${relPath}/`);
            if (depth < maxDepth) lines.push(...scanWorkspace(path.join(dir, entry.name), depth + 1, maxDepth));
        } else {
            const sizeBytes = (() => { try { return fs.statSync(path.join(dir, entry.name)).size; } catch { return 0; } })();
            lines.push(`${indent}[FILE] ${relPath}  (${sizeBytes} bytes)`);
        }
    }
    return lines;
}

/**
 * Returns a concise workspace snapshot: file tree + first 40 lines of each file.
 * Injected into every model prompt so it knows EXACTLY what exists.
 */
function buildWorkspaceSnapshot() {
    const tree = scanWorkspace();
    let snap = `=== WORKSPACE: ${WORKSPACE_DIR} ===\nFile Tree:\n${tree.join('\n')}\n\n`;

    // Attach previews for all readable text files
    const TEXT_EXTS = ['.py','.js','.ts','.json','.md','.txt','.html','.css','.sh','.bat','.yaml','.yml','.toml','.csv','.xml','.env'];
    function previewFiles(dir, depth = 0) {
        if (depth > 2) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            if (entry.isDirectory() && EXCLUDED_DIRS.includes(entry.name.toLowerCase())) continue;
            if (entry.isFile() && EXCLUDED_FILES.includes(entry.name.toLowerCase())) continue;

            const full = path.join(dir, entry.name);
            const rel  = path.relative(WORKSPACE_DIR, full);
            if (entry.isDirectory()) { previewFiles(full, depth + 1); continue; }
            if (!TEXT_EXTS.includes(path.extname(entry.name).toLowerCase())) continue;
            try {
                const stat = fs.statSync(full);
                if (stat.size > MAX_FILE_SIZE_PREVIEW) {
                    snap += `--- FILE: ${rel} ---\n(File too large to preview: ${stat.size} bytes)\n\n`;
                    continue;
                }
                const lines  = fs.readFileSync(full, 'utf-8').split('\n');
                const preview = lines.slice(0, 40).join('\n');
                const note    = lines.length > 40 ? `\n... (${lines.length} total lines, showing first 40)` : '';
                snap += `--- FILE: ${rel} ---\n${preview}${note}\n\n`;
            } catch { /* skip unreadable */ }
        }
    }
    previewFiles(WORKSPACE_DIR);
    return snap;
}

// ==========================================
// ROBUST JSON EXTRACTOR
// ==========================================
function extractJson(text) {
    if (!text) return null;
    // Strip Qwen3 <think>...</think> blocks emitted before JSON
    let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    // Try raw parse first
    try { return JSON.parse(cleaned); } catch {}
    // Strip markdown fences
    const stripped = cleaned.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
    try { return JSON.parse(stripped); } catch {}
    // Brace-scan on original cleaned text
    let depth = 0, start = -1, inStr = false, esc = false;
    for (let i = 0; i < cleaned.length; i++) {
        const c = cleaned[i];
        if (inStr) { esc = !esc && c === '\\'; if (!esc && c === '"') inStr = false; }
        else if (c === '"') inStr = true;
        else if (c === '{') { if (start === -1) start = i; depth++; }
        else if (c === '}' && start !== -1) {
            depth--;
            if (depth === 0) {
                try { return JSON.parse(cleaned.slice(start, i + 1)); } catch { start = -1; }
            }
        }
    }
    return null;
}

// ==========================================
// TERMINAL EXECUTOR  (the core new power)
// ==========================================
const ALLOWED_PREFIXES = [
    'node ', 'python ', 'python3 ', 'pip ', 'pip3 ',
    'npm ', 'npx ', 'yarn ', 'pnpm ',
    'git ', 'ollama ', 'winget ', 'choco ', 'scoop ',
    'dir', 'ls', 'echo ', 'cat ', 'type ',
    'mkdir ', 'rmdir ', 'del ', 'copy ', 'move ',
    'curl ', 'wget ', 'powershell ', 'pwsh '
];

function isCommandAllowed(cmd) {
    const lower = cmd.trim().toLowerCase();
    return ALLOWED_PREFIXES.some(p => lower.startsWith(p));
}

/**
 * Executes a shell command and streams output to console.
 * Returns { stdout, stderr, code }.
 */
function runTerminal(command, cwd = WORKSPACE_DIR, timeoutMs = 60000) {
    console.log(`\n💻  [Terminal] Running: ${command}`);
    console.log(`    CWD: ${cwd}\n`);
    try {
        const output = execSync(command, {
            cwd,
            timeout: timeoutMs,
            encoding: 'utf-8',
            shell: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        return { stdout: output || '', stderr: '', code: 0 };
    } catch (err) {
        return {
            stdout: err.stdout?.toString() || '',
            stderr: err.stderr?.toString() || err.message,
            code: err.status ?? 1
        };
    }
}

// ==========================================
// FEATURE DATABASE
// ==========================================
const FEATURES = {
    websearch: {
        description: 'Searches Wikipedia. Params: { topic: string }',
        async execute({ topic }) {
            console.log(`[Feature: WebSearch] 🌍 Searching: ${topic}`);
            try {
                const res  = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(topic)}&utf8=&format=json`);
                const data = await res.json();
                const snips = data.query.search.slice(0, 3)
                    .map(r => `**${r.title}**: ${r.snippet.replace(/<\/?[^>]+(>|$)/g, '')}`)
                    .join('\n\n');
                return `Wikipedia results for "${topic}":\n\n${snips}`;
            } catch (e) { return `Error: ${e.message}`; }
        }
    },
    timer: {
        description: 'Sets a countdown timer. Params: { minutes: number }',
        execute({ minutes }) {
            const ms = parseFloat(minutes) * 60 * 1000;
            console.log(`[Feature: Timer] ⏱️  Timer set for ${minutes} minute(s).`);
            setTimeout(() => console.log(`\n🔔  [Timer] ${minutes} minute(s) elapsed!`), ms);
            return `Timer started for ${minutes} minute(s).`;
        }
    },
    install: {
        description: 'Installs a package. Params: { manager: "npm"|"pip"|"winget", package: string }',
        execute({ manager = 'npm', package: pkg }) {
            const cmds = {
                npm:    `npm install ${pkg}`,
                pip:    `pip install ${pkg}`,
                winget: `winget install ${pkg}`
            };
            const cmd = cmds[manager] || `npm install ${pkg}`;
            const { stdout, stderr, code } = runTerminal(cmd);
            const out = (stdout + stderr).trim();
            return code === 0 ? `✅  Installed "${pkg}" via ${manager}:\n${out}` : `❌  Install failed:\n${out}`;
        }
    },
    run_command: {
        description: 'Runs an arbitrary allowed shell command. Params: { command: string }',
        execute({ command }) {
            if (!isCommandAllowed(command)) {
                return `❌  Command not in allowlist: "${command}". Allowed prefixes: ${ALLOWED_PREFIXES.join(', ')}`;
            }
            const { stdout, stderr, code } = runTerminal(command);
            return code === 0
                ? `✅  Output:\n${(stdout || '(no output)').trim()}`
                : `❌  Error (exit ${code}):\n${(stderr || stdout || 'unknown error').trim()}`;
        }
    },
    ollama_pull: {
        description: 'Downloads an Ollama model. Params: { model: string }',
        execute({ model }) {
            console.log(`[Feature: OllamaPull] 📦  Pulling model: ${model}`);
            const { stdout, stderr, code } = runTerminal(`ollama pull ${model}`, WORKSPACE_DIR, 300000);
            return code === 0 ? `✅  Model "${model}" downloaded.` : `❌  Pull failed:\n${stderr}`;
        }
    }
};

// ==========================================
// MODEL WRAPPERS
// ==========================================
const routerModel  = (msgs, json) => callOllama(msgs, MODEL_ROUTER,   json ?? true);
const reactModel   = (msgs)       => callOllama(msgs, MODEL_REACTIVE,  false);
const complexModel = (msgs, json) => callOllama(msgs, MODEL_COMPLEX,   json ?? true);
const verifyModel  = (msgs)       => callOllama(msgs, MODEL_VERIFY,    false);

// ==========================================
// ROUTER  (THINK step)
// ==========================================
function normalizeRouterResponse(route) {
    if (!route || typeof route !== 'object') return null;

    const normalized = {};

    // Map intent summary: message_summary / message / reason / msg / summary
    normalized.message_summary = route.message_summary || route.message || route.reason || route.msg || route.summary || "interaction";

    // Map complexity: complexity / complexsity / level
    let comp = route.complexity || route.complexsity || route.level || "low";
    comp = String(comp).toLowerCase();
    if (comp.includes('low')) {
        normalized.complexity = 'low';
    } else if (comp.includes('high')) {
        normalized.complexity = 'high';
    } else {
        normalized.complexity = 'low';
    }

    // Map target model: target_model / mode / model / target
    let target = route.target_model || route.mode || route.model || route.target || "reactive";
    target = String(target).toLowerCase();
    if (target.includes('complex') || target.includes('high')) {
        normalized.target_model = 'complex';
    } else if (target.includes('terminal') || target.includes('shell') || target.includes('cmd')) {
        normalized.target_model = 'terminal';
    } else if (target.includes('feature')) {
        normalized.target_model = 'feature';
    } else {
        normalized.target_model = 'reactive';
    }

    // Map extra prompt: extra_prompt / extraPrompt / extra prompt / prompt
    normalized.extra_prompt = route.extra_prompt || route.extraPrompt || route['extra prompt'] || route.prompt || "";

    // Complexity override: complex targets must be high complexity
    if (normalized.target_model === 'complex') {
        normalized.complexity = 'high';
    }

    // Map feature metadata
    const featObj = route.feature_metadata || {};
    normalized.feature_metadata = {
        name: featObj.name || route.feature_name || null,
        params: featObj.params || route.feature_params || {}
    };

    return normalized;
}

function validateRouterResponse(route) {
    if (!route || typeof route !== 'object') return false;
    const models = ['reactive', 'complex', 'terminal', 'feature'];
    const complexities = ['low', 'high'];
    return (
        typeof route.message_summary === 'string' &&
        complexities.includes(route.complexity) &&
        models.includes(route.target_model) &&
        typeof route.extra_prompt === 'string'
    );
}

// ==========================================
// ROUTER  (THINK step)
// ==========================================
function getIndiaContext() {
    const now = new Date();
    const options = { 
        timeZone: 'Asia/Kolkata', 
        weekday: 'long', 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
        hour12: true 
    };
    const indiaDateTime = now.toLocaleString('en-IN', options);

    const month = now.getMonth();
    let season = "";
    if (month >= 2 && month <= 4) {
        season = "Summer (Hot and dry pre-monsoon season)";
    } else if (month >= 5 && month <= 8) {
        season = "Monsoon (Rainy season)";
    } else if (month >= 9 && month <= 10) {
        season = "Post-monsoon (Autumn / transition season)";
    } else {
        season = "Winter (Cool and dry season)";
    }

    return `Time & Date in India: ${indiaDateTime}\nCurrent Season in India: ${season}`;
}

// ==========================================
// FAST-TRACK PRE-ROUTER (JS, no LLM)
// ==========================================
const TOOL_VERSION_COMMANDS = {
    // Languages
    python: 'python --version',    python3: 'python3 --version',
    js: 'node --version',          javascript: 'node --version',
    typescript: 'tsc --version',   ts: 'tsc --version',
    node: 'node --version',        nodejs: 'node --version',
    ruby: 'ruby --version',        php: 'php --version',
    java: 'java --version',        go: 'go version',
    rust: 'rustc --version',       rustc: 'rustc --version',
    cargo: 'cargo --version',      gcc: 'gcc --version',
    perl: 'perl --version',        swift: 'swift --version',
    // Package managers
    npm: 'npm --version',          npx: 'npx --version',
    pip: 'pip --version',          pip3: 'pip3 --version',
    yarn: 'yarn --version',        pnpm: 'pnpm --version',
    // Tools
    git: 'git --version',          docker: 'docker --version',
    ollama: 'ollama --version',    winget: 'winget --version',
    choco: 'choco --version',      scoop: 'scoop --version',
    powershell: 'pwsh --version',  curl: 'curl --version',
    wget: 'wget --version',        agy: 'agy --version',
    antigravity: 'agy --version',
};

const NON_TOOL_FORMATS = ['json', 'xml', 'yaml', 'yml', 'csv', 'html', 'css', 'txt', 'markdown', 'md'];

function detectSystemVersionCheck(prompt) {
    const p = prompt.toLowerCase().trim();
    if (/^(hi|hello|hey|ok|okay|thanks|bye|what is|tell me about)/i.test(p)) return null;
    if (!/version|installed|available|exists?|\bdo i have\b|\bcheck\b|-v\b|--version\b|which\b|where is/i.test(p)) return null;

    for (const format of NON_TOOL_FORMATS) {
        if (new RegExp(`\\b${format}\\b`).test(p)) {
            console.log(`\n[Pre-Router] ⚡ Intercepted non-tool version check: ${format} → reactive`);
            return {
                message_summary: `non_tool_version_check{${format}}`,
                complexity: 'low',
                target_model: 'reactive',
                extra_prompt: `Explain that ${format.toUpperCase()} is a data format / markup specification, not a software tool or language runtime with an executable version.`,
                feature_metadata: { name: null, params: {} }
            };
        }
    }

    for (const [tool, cmd] of Object.entries(TOOL_VERSION_COMMANDS)) {
        if (new RegExp(`\\b${tool}\\b`).test(p)) {
            console.log(`\n[Pre-Router] \u26a1 Fast-tracked: ${tool} \u2192 terminal`);
            return { message_summary: `cmd_run{${cmd}}`, complexity: 'low', target_model: 'terminal',
                extra_prompt: `DIRECT_CMD:${cmd}`, feature_metadata: { name: null, params: {} } };
        }
    }
    return null;
}

async function antigravityRouter(prompt) {
    // ── Fast-track: bypass LLM for detectable patterns ──
    const preRoute = detectSystemVersionCheck(prompt);
    if (preRoute) {
        console.log(`\n[Router] → Target: ${preRoute.target_model.toUpperCase()} | Complexity: ${preRoute.complexity.toUpperCase()} | Intent: ${preRoute.message_summary}`);
        console.log(`[Router Extra Prompt] -> "${preRoute.extra_prompt}"\n`);
        return preRoute;
    }

    const indiaContext = getIndiaContext();

    const sys = `You are a metadata-driven orchestration router for the Aria local AI agent.
Current India Time & Season: ${indiaContext}

Output ONLY valid JSON:
{"message_summary":"...","complexity":"low"|"high","target_model":"reactive"|"complex"|"terminal"|"feature","extra_prompt":"...","feature_metadata":{"name":null|"websearch"|"timer"|"install"|"run_command"|"ollama_pull","params":{}}}

EXAMPLES:
{"input":"hi","out":{"message_summary":"greeting","complexity":"low","target_model":"reactive","extra_prompt":"Greet sir briefly, mention current India time and season.","feature_metadata":{"name":null,"params":{}}}}
{"input":"what time is it","out":{"message_summary":"time_query","complexity":"low","target_model":"reactive","extra_prompt":"Tell the user the exact current IST time in one sentence.","feature_metadata":{"name":null,"params":{}}}}
{"input":"scan my folder","out":{"message_summary":"scan_folder","complexity":"high","target_model":"complex","extra_prompt":"List all files in workspace using list_dir tool.","feature_metadata":{"name":null,"params":{}}}}
{"input":"run node server.js","out":{"message_summary":"cmd_run{node server.js}","complexity":"low","target_model":"terminal","extra_prompt":"Run: node server.js","feature_metadata":{"name":null,"params":{}}}}
{"input":"search Wikipedia for React","out":{"message_summary":"feature{websearch}","complexity":"low","target_model":"feature","extra_prompt":"","feature_metadata":{"name":"websearch","params":{"topic":"React"}}}}

RULES:
1. complex: file/folder scanning, code edits, multi-file tasks
2. terminal: run shell commands, install packages
3. reactive: greetings, general questions, simple chat — keep extra_prompt BRIEF
4. feature: matches a feature: ${Object.keys(FEATURES).join(', ')}
5. Generate specific instructions, never copy examples verbatim.

Workspace: ${scanWorkspace().slice(0, 15).join('\n')}`;

    const msgs = [{ role: 'system', content: sys }, { role: 'user', content: prompt }];
    let result = await routerModel(msgs, true);
    let normalized = normalizeRouterResponse(extractJson(result));

    if (!validateRouterResponse(normalized)) {
        console.log('⚠️  [Router] Invalid schema. Retrying...');
        normalized = normalizeRouterResponse(extractJson(await routerModel(msgs, true)));
    }
    if (!validateRouterResponse(normalized)) {
        console.log('❌  [Router] Fallback to reactive.');
        normalized = { message_summary: 'fallback', complexity: 'low', target_model: 'reactive', extra_prompt: `Answer helpfully. Be brief. User said: "${prompt}"`, feature_metadata: { name: null, params: {} } };
    }

    console.log(`\n[Router] → Target: ${normalized.target_model.toUpperCase()} | Complexity: ${normalized.complexity.toUpperCase()} | Intent: ${normalized.message_summary}`);
    console.log(`[Router Extra Prompt] -> "${normalized.extra_prompt}"\n`);
    return normalized;
}

// ==========================================
// REACTIVE MODE  (quick chat)
// ==========================================
async function handleReactive(prompt, extraPrompt, isShort = false) {
    console.log(`\n[Reactive] Using ${MODEL_REACTIVE}…`);
    const brevity = isShort ? ' Reply in 1-2 sentences max. No filler phrases.' : '';
    const instruction = extraPrompt || 'Answer the user prompt helpfully.';
    const sys = buildContextHeader(`You are Aria, a concise and friendly AI assistant.${brevity}\nInstruction: ${instruction}`);
    const msgs = [{ role:'system', content:sys }, ...recentHistory(5), { role:'user', content:prompt }];
    const reply = await reactModel(msgs);
    console.log(`\n🧠  Aria:\n${reply}\n`);
    return reply;
}

// ==========================================
// TERMINAL MODE  — plan → run → AI verify → retry loop
// Follows diagram: ai analyse → JSON command → run → check output
//   error   → re-analyse with error context → retry
//   no error → return to user
// ==========================================
async function handleTerminal(prompt, extraPrompt) {
    const MAX_ATTEMPTS = 3;
    let prevError = null;   // {command, output, hint} from last failed attempt

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {

        // ── Step 1: AI Analyse → determine command ──────────────────
        let command, cwd = WORKSPACE_DIR;

        const directCmd = attempt === 0 && extraPrompt?.startsWith('DIRECT_CMD:')
            ? extraPrompt.slice(11).trim() : null;

        if (directCmd) {
            // Pre-router already gave us the exact command — skip LLM planning
            command = directCmd;
            console.log(`\n[Terminal] ⚡ ${command}`);
        } else {
            // LLM plans the command (or re-plans after error)
            const context = prevError
                ? `Previous command failed.\nCmd: ${prevError.command}\nError: ${prevError.output}\nHint: ${prevError.hint}\nFix it for the original request: ${prompt}`
                : (extraPrompt && !extraPrompt.startsWith('DIRECT_CMD:') ? extraPrompt : prompt);

            console.log(`\n[Terminal] ${attempt > 0 ? `Re-analysing (attempt ${attempt + 1})` : 'Planning command'}…`);
            const planSys = `You are a Windows PowerShell command planner.\nOutput ONLY JSON: {"command":"exact cmd","reason":"why","cwd":"./"}\nGoal: ${context}\nWorkspace: ${scanWorkspace().slice(0,10).join('\n')}`;
            const plan = extractJson(await complexModel([
                { role: 'system', content: planSys },
                { role: 'user',   content: prompt }
            ], true));

            if (!plan?.command) {
                console.log('  Could not plan a command.');
                break;
            }
            command = plan.command;
            if (plan.cwd) cwd = path.resolve(WORKSPACE_DIR, plan.cwd);
            console.log(`  → ${command}  (${plan.reason || ''})`);
        }

        if (!isCommandAllowed(command)) {
            const ok = await ask(`Allow: ${command}? (yes/no): `);
            if (ok.toLowerCase() !== 'yes') return 'Command cancelled.';
        }

        // ── Step 2: Run on terminal ──────────────────────────────────
        const { stdout, stderr, code } = runTerminal(command, cwd);
        const rawOutput = (stdout + '\n' + stderr).trim();

        // ── Step 3: AI checks the command line output ────────────────
        console.log(`\n[Terminal] Checking output…`);
        const check = extractJson(await callOllama([
            { role: 'system', content: `You are a terminal output verifier.\nOutput ONLY JSON: {"ok":true|false,"summary":"one-line summary of output","fix":"if failed, concise fix suggestion"}\nRules:\n1. Read the command output exactly. Do not invent any build details, versions, or dates not present in the output.\n2. If the output is a single version number, state the version number accurately in the summary.\n3. Output ok:true if exit code is 0 and output is non-empty.` },
            { role: 'user',   content: `Command: ${command}\nExit code: ${code}\nOutput:\n${rawOutput || '(empty)'}` }
        ], MODEL_REACTIVE, true));

        const succeeded = check ? check.ok !== false : (code === 0 && rawOutput.length > 0);

        if (succeeded) {
            // ── No error → return to user ────────────────────────────
            const summary = check?.summary || '';
            if (summary) console.log(`✅  ${summary}`);
            console.log(`\n${rawOutput}\n`); // Print the actual terminal output
            return `\`${command}\`\n${rawOutput}`;
        }

        // ── Error → loop back with error context ─────────────────────
        const hint = check?.fix || 'Try an alternative command.';
        console.log(`\n⚠️  [Terminal] Output check failed (attempt ${attempt + 1}/${MAX_ATTEMPTS}). ${hint}`);
        prevError = { command, output: rawOutput || `exit ${code}`, hint };
    }

    return prevError
        ? `Failed after ${MAX_ATTEMPTS} attempts.\nLast command: \`${prevError.command}\`\nOutput:\n${prevError.output}`
        : 'Could not determine a working command.';
}


// ==========================================
// COMPLEX MODE  — THINK → PLAN → CREATE → CHECK loop
// ==========================================
async function handleComplex(prompt, extraPrompt) {
    console.log(`\n[Complex Mode] ${MODEL_COMPLEX} — Structured Execution Loop…`);
    console.log('  Scanning workspace first…');
    const snapshot = buildWorkspaceSnapshot();

    // Start structured trace logging
    const currentTrace = createNewTrace(prompt, { target_model: 'complex', message_summary: 'Complex task handler invoked' });

    const toolDocs = `You are ARIA — an elite autonomous AI software engineer running locally on Windows.
Workspace: ${WORKSPACE_DIR}
User: ${userProfile.user_name} | OS: ${userProfile.operating_system}
Languages: ${(userProfile.preferred_programming_languages || []).join(', ')}

Router Guidelines for this Task:
${extraPrompt || 'Plan and execute the task according to the prompt.'}

=== WORKSPACE SNAPSHOT (READ THIS FIRST) ===
${snapshot}
CRITICAL RULES ABOUT FILES:
- NEVER invent filenames. Only use files shown in the snapshot above.
- To edit an existing file, use edit_file with its EXACT name from the snapshot.
- To create a new file, use create_file.

=== CODE QUALITY STANDARDS (NON-NEGOTIABLE) ===
You write PRODUCTION-QUALITY, COMPLETE, IMPRESSIVE code. Never write skeletons or placeholders.

For WEB tasks (HTML/CSS/JS):
  - HTML: Full semantic structure, meta tags, Google Fonts, linked CSS & JS files.
  - CSS: Dark/premium theme, CSS variables, gradients, glassmorphism, animations,
         keyframes (@keyframes), hover effects, transitions, responsive @media queries.
  - JS: Particle effects or canvas animations, IntersectionObserver for scroll reveals,
        smooth scrolling, interactive elements, ripple effects on buttons, counter animations.
  - NEVER use placeholder colors like plain red/blue/green. Use curated HSL or hex palettes.
  - ALWAYS include Google Fonts (Inter, Space Grotesk, Outfit, etc.).
  - Files must be LONG and DETAILED — a minimal webpage is UNACCEPTABLE.

For PYTHON tasks:
  - Write complete, working, well-commented code.
  - Include proper imports, error handling, and docstrings.
  - Never write "# TODO" or "pass" as implementation.

For ALL tasks:
  - Write the FULL content of every file — never truncate with "..." or "etc".
  - If content is long, write it all. The JSON content field can be as large as needed.
  - Prefer many specific details over vague generalities.

=== AVAILABLE TOOLS ===
File Tools:
  {"tool":"list_dir","path":"./"}
  {"tool":"read_file","path":"filename.ext"}
  {"tool":"create_file","path":"filename.ext","content":"FULL file content here"}
  {"tool":"edit_file","path":"filename.ext","content":"FULL new file content here"}
  {"tool":"replace_lines","path":"filename.ext","start_line":1,"end_line":3,"content":"new lines"}
  {"tool":"delete_file","path":"filename.ext"}
  {"tool":"grep_search","path":"./","pattern":"search term"}

Terminal Tools:
  {"tool":"run_terminal","command":"python script.py"}
  {"tool":"run_terminal","command":"pip install requests"}
  {"tool":"run_terminal","command":"npm install express"}
  {"tool":"run_terminal","command":"node server.js"}
  {"tool":"run_terminal","command":"git init"}

Planning:
  {"tool":"create_file","path":"plan.md","content":"# Plan\n1. ..."}

Done:
  {"response":"Summary of what was completed"}

=== EXECUTION RULES ===
1. Output ONLY a single valid JSON object per turn. No markdown. No extra text.
2. FIRST action: create plan.md with your detailed Think->Plan.
3. After create_file or edit_file: ALWAYS verify with read_file.
4. Write COMPLETE file contents every time — never truncate.
5. After terminal commands: check output for errors.
6. Install missing packages with run_terminal before importing them.
7. When ALL files are created, verified, and working: output {"response":"..."}.

${buildContextHeader('')}`;

    let history = [{ role: 'system', content: toolDocs }, { role: 'user', content: prompt }];
    let loops = 30;
    let hasCritiquedPlan = false;
    let verificationAttempts = 0;
    const createdFiles = new Set();

    while (loops-- > 0) {
        const startTime = Date.now();
        const raw = await complexModel(history, true);
        if (!raw) {
            console.log('❌  Model returned nothing.');
            currentTrace.error = 'Model returned empty response';
            break;
        }

        history.push({ role: 'assistant', content: raw });

        const call = extractJson(raw);

        // Record trace step
        const traceStep = {
            timestamp: new Date().toISOString(),
            raw_response: raw,
            parsed_call: call,
            validation: null,
            execution: null,
            duration_ms: Date.now() - startTime
        };
        currentTrace.steps.push(traceStep);

        // ── Done response ──
        if (call?.response) {
            // Verify files before finalizing
            if (createdFiles.size > 0 && verificationAttempts < 2) {
                const verificationResult = await runVerificationLoop(Array.from(createdFiles), prompt, currentTrace);
                if (verificationResult.success === false) {
                    verificationAttempts++;
                    console.log(`\n🔄  [Verification Loop] Attempt ${verificationAttempts} failed. Requesting fixes.`);
                    history.push({
                        role: 'user',
                        content: `[Code Verification Failure]:\n${verificationResult.feedback}\n\nPlease revise and edit the files to correct these review comments. Make sure there are no syntax errors or incomplete code blocks.`
                    });
                    continue;
                }
            }

            console.log(`\n🧠  [Agent Done]:\n${call.response}\n`);
            currentTrace.final_response = call.response;
            writeTraceLog(currentTrace);
            return call.response;
        }

        // ── Tool call response ──
        if (call?.tool) {
            // Plan guard
            const planPath = path.join(WORKSPACE_DIR, 'plan.md');
            const isWrite = ['create_file', 'edit_file', 'replace_lines'].includes(call.tool);
            const isPlan = call.path && (call.path === 'plan.md' || call.path.endsWith('/plan.md'));

            if (isWrite && !isPlan && !fs.existsSync(planPath)) {
                console.log('\n⚠️   [Plan Guard] Must create plan.md first.');
                history.push({
                    role: 'user',
                    content: 'Rule: You must create plan.md FIRST before any other file. Output the create_file tool call for plan.md now.'
                });
                traceStep.validation = { valid: false, error: 'Plan Guard triggered: plan.md must exist' };
                continue;
            }

            // Track created files
            if (isWrite && call.path && !isPlan) {
                createdFiles.add(call.path);
            }

            // Validate the tool call parameters
            const validation = validateToolCall(call);
            traceStep.validation = validation;

            if (!validation.valid) {
                console.log(`⚠️   [Validation Failed] Tool call parameters invalid: ${validation.error}`);
                history.push({
                    role: 'user',
                    content: `[Tool Validation Error]: ${validation.error}. Please correct the parameters and output a valid tool call.`
                });
                continue;
            }

            console.log(`\n  [Tool] ${call.tool} ${call.path || call.command || ''}`);
            let toolRes = executeFileToolStructured(call);
            traceStep.execution = {
                tool: call.tool,
                success: toolRes.success,
                result: toolRes.success ? toolRes.result.slice(0, 1000) : null,
                error: toolRes.success ? null : toolRes.error
            };

            // If tool fails, enter Self-Correction Loop
            if (!toolRes.success) {
                const correctionResult = await selfCorrectToolCall(call, toolRes.error, 0);
                if (correctionResult.success) {
                    toolRes = { success: true, result: correctionResult.result };
                    traceStep.execution.corrected = true;
                    traceStep.execution.success = true;
                    traceStep.execution.result = correctionResult.result.slice(0, 1000);
                    traceStep.execution.error = null;
                    if (correctionResult.correctedCall && correctionResult.correctedCall.path && !isPlan) {
                        createdFiles.add(correctionResult.correctedCall.path);
                    }
                } else {
                    console.log(`❌  [Tool Execution Failed after correction attempts] ${toolRes.error}`);
                    history.push({
                        role: 'user',
                        content: `[Tool Execution Error]: ${correctionResult.error}. Please adjust your strategy or select a different tool.`
                    });
                    continue;
                }
            }

            // Plan Refinement Loop
            if (isPlan && isWrite && !hasCritiquedPlan) {
                currentTrace.plan = toolRes.result;
                const gaps = await refinePlanLoop(prompt, call.content ?? '', currentTrace);
                hasCritiquedPlan = true;
                if (gaps) {
                    console.log('🔄  [Plan Refinement Loop] Requesting plan updates to cover gaps...');
                    history.push({
                        role: 'user',
                        content: `[Plan Critique - Gaps Identified]:\n${gaps.map(g => `- ${g}`).join('\n')}\n\nPlease revise plan.md now using edit_file to address these gaps before working on code files.`
                    });
                    continue;
                }
            }

            console.log(`    Result: ${toolRes.result.slice(0, 300)}`);
            history.push({
                role: 'user',
                content: `[Tool Result]: ${toolRes.result}\n\n` +
                    `REMEMBER: Write FULL, COMPLETE file contents - never truncate.\n` +
                    `Proceed to the next step. Verify with read_file after every file write.\n` +
                    `When ALL files are done and verified, output {"response":"..."}`
            });

        } else {
            // Model returned plain text instead of JSON
            const stripped = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
            if (stripped.length > 10) {
                console.log(`\n  [Agent Final]:\n${stripped}\n`);
                currentTrace.final_response = stripped;
                writeTraceLog(currentTrace);
                return stripped;
            }
            history.push({ role: 'user', content: 'Output a valid JSON tool call or {"response":"done"}.' });
        }
    }

    console.log('\n⚠️   [Agent Halted] Max loops reached.');
    currentTrace.error = 'Max execution loops reached (halted)';
    writeTraceLog(currentTrace);
    return 'Task halted — reached maximum execution depth.';
}

// ==========================================
// TOOL SCHEMAS & VALIDATION
// ==========================================
const TOOL_SCHEMAS = {
    list_dir: {
        properties: { path: { type: 'string', required: false } }
    },
    read_file: {
        properties: { path: { type: 'string', required: true } }
    },
    create_file: {
        properties: {
            path: { type: 'string', required: true },
            content: { type: 'string', required: true }
        }
    },
    edit_file: {
        properties: {
            path: { type: 'string', required: true },
            content: { type: 'string', required: true }
        }
    },
    replace_lines: {
        properties: {
            path: { type: 'string', required: true },
            start_line: { type: 'number', required: true },
            end_line: { type: 'number', required: true },
            content: { type: 'string', required: true }
        }
    },
    delete_file: {
        properties: { path: { type: 'string', required: true } }
    },
    grep_search: {
        properties: {
            path: { type: 'string', required: false },
            pattern: { type: 'string', required: true }
        }
    },
    run_terminal: {
        properties: { command: { type: 'string', required: true } }
    }
};

function validateToolCall(call) {
    if (!call || typeof call !== 'object') {
        return { valid: false, error: 'Tool call must be a JSON object' };
    }
    
    if (call.response) {
        return { valid: true };
    }

    if (!call.tool) {
        return { valid: false, error: 'Missing "tool" or "response" field in tool call' };
    }

    const schema = TOOL_SCHEMAS[call.tool];
    if (!schema) {
        return { valid: false, error: `Unknown tool: "${call.tool}"` };
    }

    for (const [key, rules] of Object.entries(schema.properties)) {
        let value = call[key];
        
        if (key === 'content' && value === undefined) {
            value = call.text ?? call.code;
            if (value !== undefined) {
                call.content = value;
            }
        }

        if (rules.required && value === undefined) {
            return { valid: false, error: `Missing required parameter "${key}" for tool "${call.tool}"` };
        }

        if (value !== undefined) {
            if (rules.type === 'number') {
                const parsedVal = Number(value);
                if (isNaN(parsedVal)) {
                    return { valid: false, error: `Parameter "${key}" must be a number, got "${typeof value}"` };
                }
                call[key] = parsedVal;
            } else if (rules.type === 'string' && typeof value !== 'string') {
                return { valid: false, error: `Parameter "${key}" must be a string, got "${typeof value}"` };
            }
        }
    }

    if (call.path) {
        try {
            resolveSafePath(call.path);
        } catch (e) {
            return { valid: false, error: e.message };
        }
    }

    return { valid: true };
}

function executeFileToolStructured(call) {
    const validation = validateToolCall(call);
    if (!validation.valid) {
        return { success: false, error: `Validation Error: ${validation.error}` };
    }

    try {
        switch (call.tool) {
        case 'list_dir': {
            const p = resolveSafePath(call.path || './');
            if (!fs.existsSync(p)) return { success: false, error: `Directory "${call.path}" not found.` };
            return { success: true, result: `Contents of ${call.path}:\n` + fs.readdirSync(p).join('\n') };
        }
        case 'read_file': {
            const p = resolveSafePath(call.path);
            if (!fs.existsSync(p)) return { success: false, error: `File "${call.path}" does not exist.` };
            const content = fs.readFileSync(p, 'utf-8');
            const lines = content.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n');
            return { success: true, result: `File "${call.path}" (${content.split('\n').length} lines):\n${lines}` };
        }
        case 'create_file': {
            const p = resolveSafePath(call.path);
            fs.mkdirSync(path.dirname(p), { recursive: true });
            const txt = call.content ?? '';
            fs.writeFileSync(p, txt, 'utf-8');
            return { success: true, result: `Created "${call.path}" (${txt.split('\n').length} lines).` };
        }
        case 'edit_file': {
            const p = resolveSafePath(call.path);
            if (!fs.existsSync(p)) return { success: false, error: `File "${call.path}" does not exist.` };
            const txt = call.content ?? '';
            fs.writeFileSync(p, txt, 'utf-8');
            return { success: true, result: `Overwritten "${call.path}" (${txt.split('\n').length} lines).` };
        }
        case 'replace_lines': {
            const p = resolveSafePath(call.path);
            if (!fs.existsSync(p)) return { success: false, error: `File "${call.path}" does not exist.` };
            const arr = fs.readFileSync(p, 'utf-8').split('\n');
            const s = call.start_line - 1;
            const e = call.end_line - 1;
            if (s < 0 || e >= arr.length || s > e) {
                return { success: false, error: `Invalid range ${call.start_line}-${call.end_line} (file has ${arr.length} lines).` };
            }
            arr.splice(s, e - s + 1, ...call.content.split('\n'));
            fs.writeFileSync(p, arr.join('\n'), 'utf-8');
            return { success: true, result: `Replaced lines ${call.start_line}-${call.end_line} in "${call.path}".` };
        }
        case 'delete_file': {
            const p = resolveSafePath(call.path);
            if (!fs.existsSync(p)) return { success: false, error: `File "${call.path}" does not exist.` };
            fs.unlinkSync(p);
            return { success: true, result: `Deleted "${call.path}".` };
        }
        case 'grep_search': {
            const p = resolveSafePath(call.path || './');
            try {
                const pattern = new RegExp(call.pattern, 'i');
                const matches = [];
                function searchDir(currDir) {
                    let files;
                    try { files = fs.readdirSync(currDir, { withFileTypes: true }); } catch { return; }
                    for (const f of files) {
                        const fullPath = path.join(currDir, f.name);
                        if (f.isDirectory()) {
                            if (EXCLUDED_DIRS.includes(f.name.toLowerCase())) continue;
                            searchDir(fullPath);
                        } else {
                            if (EXCLUDED_FILES.includes(f.name.toLowerCase())) continue;
                            try {
                                const size = fs.statSync(fullPath).size;
                                if (size > 1024 * 1024) continue;
                                const lines = fs.readFileSync(fullPath, 'utf-8').split('\n');
                                for (let i = 0; i < lines.length; i++) {
                                    if (pattern.test(lines[i])) {
                                        const rel = path.relative(WORKSPACE_DIR, fullPath);
                                        matches.push(`${rel}:${i + 1}:${lines[i].trim()}`);
                                        if (matches.length >= 100) return;
                                    }
                                }
                            } catch {}
                        }
                    }
                }
                searchDir(p);
                return { success: true, result: matches.length > 0 ? `grep results:\n${matches.join('\n')}` : `No matches found for "${call.pattern}".` };
            } catch (e) {
                return { success: false, error: `Grep failed: ${e.message}` };
            }
        }
        case 'run_terminal': {
            const cmd = call.command;
            if (!isCommandAllowed(cmd)) {
                return { success: false, error: `Command "${cmd}" not in allowlist.` };
            }
            const { stdout, stderr, code } = runTerminal(cmd, WORKSPACE_DIR, 120000);
            const out = (stdout + '\n' + stderr).trim() || '(no output)';
            if (code === 0) {
                return { success: true, result: out };
            } else {
                return { success: false, error: `Exit ${code} (error):\n${out}` };
            }
        }
        default:
            return { success: false, error: `Unknown tool "${call.tool}".` };
        }
    } catch (e) {
        return { success: false, error: `Error in ${call.tool}: ${e.message}` };
    }
}

function executeFileTool(call) {
    const res = executeFileToolStructured(call);
    return res.success ? res.result : `Error: ${res.error}`;
}

// ==========================================
// STRUCTURED TRACE LOGGER
// ==========================================
const TRACE_FILE = path.join(process.cwd(), 'execution_trace.json');

function loadTraceLog() {
    if (fs.existsSync(TRACE_FILE)) {
        try { return JSON.parse(fs.readFileSync(TRACE_FILE, 'utf-8')); }
        catch { return []; }
    }
    return [];
}

function writeTraceLog(trace) {
    try {
        const traces = loadTraceLog();
        traces.push(trace);
        if (traces.length > 50) traces.shift();
        fs.writeFileSync(TRACE_FILE, JSON.stringify(traces, null, 2), 'utf-8');
    } catch (err) {
        console.error(`❌ Failed to write execution trace: ${err.message}`);
    }
}

function createNewTrace(prompt, route) {
    return {
        timestamp: new Date().toISOString(),
        prompt,
        route: {
            mode: route.mode,
            reason: route.reason,
            feature_name: route.feature_name,
            feature_params: route.feature_params
        },
        plan: null,
        plan_refinements: [],
        steps: [],
        verification: null,
        final_response: null,
        error: null
    };
}

// ==========================================
// SELF-CALLING REFLECTION LOOPS
// ==========================================
async function refinePlanLoop(prompt, planContent, currentTrace) {
    console.log('\n🔄  [Self-Refinement] Analyzing plan.md for gaps...');
    const sys = `You are an elite code plan reviewer.
Review the proposed plan.md against the user prompt.
Determine if the plan is complete, correct, and matches the requirements.
Identify any missing files, incorrect steps, or ambiguous details.
Output ONLY a JSON response:
{"approved": true|false, "reason": "why", "gaps": ["gap 1", "gap 2"]}
User prompt: "${prompt}"`;

    const msgs = [
        { role: 'system', content: sys },
        { role: 'user', content: `Proposed Plan:\n${planContent}` }
    ];
    const critiqueRaw = await routerModel(msgs, true);
    const critique = extractJson(critiqueRaw);

    if (critique) {
        currentTrace.plan_refinements.push({
            timestamp: new Date().toISOString(),
            critique,
            original_plan: planContent
        });

        if (critique.approved === false && critique.gaps && critique.gaps.length > 0) {
            console.log(`⚠️   [Self-Refinement] Plan not approved! Gaps identified: ${critique.gaps.join(', ')}`);
            return critique.gaps;
        } else {
            console.log('✅  [Self-Refinement] Plan approved!');
            return null;
        }
    }
    return null;
}

async function selfCorrectToolCall(toolCall, errorOutput, depth = 0) {
    if (depth >= 3) {
        return { success: false, error: `Self-correction max depth reached. Error: ${errorOutput}` };
    }
    console.log(`\n🔄  [Self-Correction] Level ${depth + 1} - Diagnosing tool failure: ${errorOutput.slice(0, 150)}...`);
    
    const sys = `You are a self-correcting agent supervisor.
A tool execution failed. Review the failed tool call and the error output.
Propose a corrected tool call (e.g. fixing command parameters, correcting path names, or modifying file boundaries).
Output ONLY a single valid JSON object containing the corrected tool call, or {"give_up": true, "reason": "..."}.
Failed Tool Call: ${JSON.stringify(toolCall)}
Error Output: ${errorOutput}`;

    const msgs = [
        { role: 'system', content: sys },
        { role: 'user', content: 'Provide the corrected JSON tool call now.' }
    ];
    const correctionRaw = await complexModel(msgs, true);
    const correctedCall = extractJson(correctionRaw);

    if (correctedCall) {
        if (correctedCall.give_up) {
            return { success: false, error: `Correction abandoned: ${correctedCall.reason}` };
        }
        console.log(`  [Correction attempt] Running: ${correctedCall.tool || correctedCall.command || ''}`);
        const result = executeFileToolStructured(correctedCall);
        if (result.success) {
            console.log('✅  [Self-Correction] Succeeded!');
            return { success: true, result: result.result, correctedCall };
        } else {
            return await selfCorrectToolCall(correctedCall, result.error, depth + 1);
        }
    }
    return { success: false, error: `Failed to generate correction JSON. Original error: ${errorOutput}` };
}

async function runVerificationLoop(createdFiles, prompt, currentTrace) {
    console.log('\n🔍  [Verification] Starting audit on generated files...');
    let allPassed = true;
    let feedbackItems = [];

    for (const filePath of createdFiles) {
        const review = await verifyOutput(filePath, `Verify that the code in this file matches the requirements of prompt: "${prompt}". Make sure it has no bugs, syntax errors, or placeholder implementations.`);
        if (review) {
            currentTrace.verification = currentTrace.verification || {};
            currentTrace.verification[filePath] = review;

            const isCleanSys = `Analyze this code review. If the review contains critical bugs, issues, syntax errors, or failures, output {"clean": false, "issues": ["issue 1"]}. Otherwise output {"clean": true}.`;
            const resRaw = await routerModel([{ role: 'system', content: isCleanSys }, { role: 'user', content: review }], true);
            const parsedRes = extractJson(resRaw);
            if (parsedRes && parsedRes.clean === false) {
                allPassed = false;
                feedbackItems.push(`File: ${filePath}\nIssues:\n${parsedRes.issues.join('\n')}\nReview Details:\n${review}`);
            }
        }
    }

    if (!allPassed) {
        console.log('⚠️   [Verification] Issues found during code review!');
        return { success: false, feedback: feedbackItems.join('\n\n') };
    }
    console.log('✅  [Verification] All files passed review!');
    return { success: true };
}

// ==========================================
// VERIFICATION STEP  (uses codellama)
// ==========================================
async function verifyOutput(filePath, expectedBehavior) {
    if (!fs.existsSync(path.resolve(WORKSPACE_DIR, filePath))) return null;
    const content = fs.readFileSync(path.resolve(WORKSPACE_DIR, filePath), 'utf-8');
    const sys = `You are a code reviewer. Review this file and verify it satisfies the requirement below.
Point out any bugs or improvements. Be concise.
Requirement: ${expectedBehavior}`;
    const msgs = [{ role:'system', content:sys }, { role:'user', content:`\`\`\`\n${content}\n\`\`\`` }];
    return await verifyModel(msgs);
}

// ==========================================
// AI PROFILE EXTRACTOR
// ==========================================
async function extractUserProfile(userPrompt, assistantResponse) {
    if (!assistantResponse) return;
    const sys = `Extract user profile from this conversation turn. Return ONLY valid JSON:
{
  "user_name": "string",
  "operating_system": "string",
  "preferred_programming_languages": [],
  "preferences": {},
  "known_facts": []
}
RULES:
1. Only extract concrete facts and settings related to the user's name, system, operating environment, preferences, or profile facts.
2. DO NOT extract template placeholders (e.g., '[insert current time]', 'morning/afternoon/evening', 'season context') or questions/queries asked by the user (e.g., 'what time is it').
3. Keep the user profile clean.

Current profile: ${JSON.stringify(userProfile)}`;
    const msgs = [{ role:'system', content:sys }, { role:'user', content:`User: "${userPrompt}"\nAssistant: "${assistantResponse.slice(0,500)}"` }];
    const result = await routerModel(msgs, true);
    if (!result) return;
    const parsed = extractJson(result);
    if (parsed && typeof parsed === 'object' && parsed.user_name !== undefined) {
        if (!parsed.operating_system && userProfile.operating_system) parsed.operating_system = userProfile.operating_system;
        saveUserProfile(parsed);
        console.log('✅  [Profile] Updated user_data.json');
    }
}

// ==========================================
// CONTEXT HELPERS
// ==========================================
function buildContextHeader(base) {
    let h = base ? base + '\n\n' : '';
    h += `[India Time & Season Context]:\n${getIndiaContext()}\n\n`;
    if (userProfile && Object.keys(userProfile).length > 0) {
        h += `[User Profile]: ${JSON.stringify({ name: userProfile.user_name, os: userProfile.operating_system, langs: userProfile.preferred_programming_languages, prefs: userProfile.preferences })}\n`;
    }
    if (memoryHistory.length > 0) {
        const recent = memoryHistory.slice(-6).map(m => `${m.role}: ${m.content}`).join('\n');
        h += `[Recent History]:\n${recent}\n`;
    }
    return h;
}

function recentHistory(n = 6) {
    return memoryHistory.slice(-n).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
}

// ==========================================
// MAIN LOOP
// ==========================================
async function runLoop() {
    console.log('\n' + '═'.repeat(60));
    console.log('  🚀  Aria Local Workflow AI  — Enhanced');
    console.log('═'.repeat(60));
    console.log(`  🔵  Router/Profile : ${MODEL_ROUTER}`);
    console.log(`  🟢  Reactive Chat  : ${MODEL_REACTIVE}`);
    console.log(`  🟡  Complex/Code   : ${MODEL_COMPLEX}`);
    console.log(`  🟠  Verify/Review  : ${MODEL_VERIFY}`);
    console.log(`  👁️   Vision Model   : qwen3-vl:8b  (use for image tasks)`);
    console.log('═'.repeat(60) + '\n');

    // Workspace selection
    const ws = await ask('Workspace folder (leave blank for current dir):\n> ');
    if (ws.trim()) WORKSPACE_DIR = path.resolve(ws.trim());
    if (!fs.existsSync(WORKSPACE_DIR)) fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    console.log(`\n🔒  Workspace locked: ${WORKSPACE_DIR}\n`);

    console.log('Commands: exit | /models | /profile | /clear | /run <cmd> | /install <pkg> | /pull <model>');
    console.log('─'.repeat(55) + '\n');

    const loop = async () => {
        const input = await ask('You: ');

        if (input.toLowerCase() === 'exit') { rl.close(); return; }

        // ── Built-in slash commands ──────────────────────────
        if (input.toLowerCase() === '/models') {
            const { stdout } = runTerminal('ollama list');
            console.log(`\n📦  Ollama Models:\n${stdout}\n`);
            return loop();
        }
        if (input.toLowerCase() === '/profile') {
            console.log(`\n👤  User Profile:\n${JSON.stringify(userProfile, null, 2)}\n`);
            return loop();
        }
        const lowerInput = input.trim().toLowerCase();
        const isClearCommand = 
            lowerInput === '/clear' || 
            lowerInput === '/clearprofile' ||
            lowerInput === 'clear user data' || 
            lowerInput === 'clear profile' || 
            lowerInput === 'reset profile' || 
            lowerInput === 'reset user profile' ||
            lowerInput === 'clear history' ||
            lowerInput === 'clear memory';

        if (isClearCommand) {
            memoryHistory = [];
            fs.writeFileSync(MEMORY_FILE, '[]');
            userProfile = { ...DEFAULT_USER_PROFILE };
            saveUserProfile(userProfile);
            console.log('\n🧹  Memory history and user profile have been cleared and reset to defaults.\n');
            return loop();
        }
        if (input.startsWith('/run ')) {
            const cmd = input.slice(5).trim();
            const { stdout, stderr, code } = runTerminal(cmd);
            console.log(`\n${code === 0 ? '✅' : '❌'} Exit ${code}:\n${(stdout + stderr).trim()}\n`);
            return loop();
        }
        if (input.startsWith('/install ')) {
            const pkg = input.slice(9).trim();
            const result = await FEATURES.install.execute({ manager: 'npm', package: pkg });
            console.log(`\n${result}\n`);
            return loop();
        }
        if (input.startsWith('/pull ')) {
            const model = input.slice(6).trim();
            const result = await FEATURES.ollama_pull.execute({ model });
            console.log(`\n${result}\n`);
            return loop();
        }

        saveMemory('user', input);

        // ── Route ────────────────────────────────────────────
        const route = await antigravityRouter(input);
        let reply = null;

        if (route.target_model === 'terminal') {
            reply = await handleTerminal(input, route.extra_prompt);
        } else if (route.target_model === 'complex') {
            reply = await handleComplex(input, route.extra_prompt);
        } else if (route.target_model === 'feature') {
            const featName = route.feature_metadata?.name;
            const featParams = route.feature_metadata?.params || {};
            const feat = FEATURES[featName];
            if (feat) {
                // Validate feature params
                let paramsValid = true;
                let validationErr = '';
                if (featName === 'websearch' && !featParams.topic) {
                    paramsValid = false;
                    validationErr = 'Missing parameter: topic';
                } else if (featName === 'timer' && isNaN(Number(featParams.minutes))) {
                    paramsValid = false;
                    validationErr = 'Missing or invalid parameter: minutes (must be a number)';
                } else if (featName === 'install' && !featParams.package) {
                    paramsValid = false;
                    validationErr = 'Missing parameter: package';
                } else if (featName === 'run_command' && !featParams.command) {
                    paramsValid = false;
                    validationErr = 'Missing parameter: command';
                } else if (featName === 'ollama_pull' && !featParams.model) {
                    paramsValid = false;
                    validationErr = 'Missing parameter: model';
                }
                
                if (paramsValid) {
                    const out = await feat.execute(featParams);
                    console.log(`\n✅  ${out}\n`);
                    reply = `Feature [${featName}]: ${out}`;
                } else {
                    console.log(`\n❌  Feature Validation Error: ${validationErr}\n`);
                    reply = `Error running feature [${featName}]: ${validationErr}`;
                }
            } else {
                console.log(`\n❌  Feature "${featName}" not found.\n`);
                reply = `Error: Feature "${featName}" not found.`;
            }
        } else {
            reply = await handleReactive(input, route.extra_prompt, route.complexity === 'low');
        }

        if (reply) {
            saveMemory('assistant', reply);
            extractUserProfile(input, reply); // background, don't await
        }

        loop();
    };

    loop();
}

runLoop();
