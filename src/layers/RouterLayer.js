// src/layers/RouterLayer.js
// Stage 3 — Pre-router (zero-latency JS) + LLM Router with confidence scoring + multi-intent detection

import Logger            from '../utils/Logger.js';
import { bus, AGENT_EVENTS } from '../core/EventBus.js';
import { routerModel, extractJson, MODELS } from './OutputLayer.js';
import { pluginManager } from '../plugins/PluginManager.js';

// ── Fast-track: JS version check patterns ──────────────────────────────────
const TOOL_VERSION_CMDS = {
    python: 'python --version',   python3: 'python3 --version',
    js: 'node --version',         javascript: 'node --version',
    typescript: 'tsc --version',  ts: 'tsc --version',
    node: 'node --version',       nodejs: 'node --version',
    ruby: 'ruby --version',       php: 'php --version',
    java: 'java --version',       go: 'go version',
    rust: 'rustc --version',      rustc: 'rustc --version',
    cargo: 'cargo --version',     gcc: 'gcc --version',
    perl: 'perl --version',       swift: 'swift --version',
    npm: 'npm --version',         npx: 'npx --version',
    pip: 'pip --version',         pip3: 'pip3 --version',
    yarn: 'yarn --version',       pnpm: 'pnpm --version',
    git: 'git --version',         docker: 'docker --version',
    ollama: 'ollama --version',   winget: 'winget --version',
    choco: 'choco --version',     scoop: 'scoop --version',
    powershell: 'pwsh --version', curl: 'curl --version',
    wget: 'wget --version',
};

const NON_TOOL_FORMATS = ['json', 'xml', 'yaml', 'yml', 'csv', 'html', 'css', 'txt', 'markdown', 'md'];

function detectVersionCheck(prompt) {
    const p = prompt.toLowerCase().trim();
    if (/^(hi|hello|hey|ok|okay|thanks|bye|what is|tell me about)/i.test(p)) return null;
    if (!/version|installed|available|exists?|\bdo i have\b|\bcheck\b|-v\b|--version\b|which\b|where is/i.test(p)) return null;

    for (const fmt of NON_TOOL_FORMATS) {
        if (new RegExp(`\\b${fmt}\\b`).test(p)) {
            return makeRoute('reactive', 'low', `non_tool_check{${fmt}}`,
                `Explain that ${fmt.toUpperCase()} is a data format/spec, not a software runtime with a version.`, 0.95);
        }
    }
    for (const [tool, cmd] of Object.entries(TOOL_VERSION_CMDS)) {
        if (new RegExp(`\\b${tool}\\b`).test(p)) {
            Logger.debug(`[PreRouter] Fast-track: ${tool} → terminal`);
            return makeRoute('terminal', 'low', `cmd_run{${cmd}}`, `DIRECT_CMD:${cmd}`, 0.99);
        }
    }
    return null;
}

function detectDocumentIntent(prompt) {
    const p = prompt.toLowerCase();
    const isDocKeyword = /\b(docx|pdf|doc|report|manual|handbook|guide|documentation|booklet|brief)\b/i.test(p);
    const isCreationKeyword = /\b(create|write|generate|build|make|compile)\b/i.test(p);
    if (isDocKeyword && isCreationKeyword) {
        return makeRoute('document', 'high', 'document_generation', 'Plan, structure, and generate a detailed document section by section.', 0.99);
    }
    return null;
}

function detectComplexIntent(prompt) {
    const p = prompt.toLowerCase();
    const isCoding = /\b(create|write|generate|build|code|script|download|install|make)\b/i.test(p);
    const hasTarget = /\b(file|script|code|app|component|docx|pdf|project|folder|dir|plugin|backend|frontend)\b/i.test(p);
    
    // Skip if it is a document (docx, pdf) so that detectDocumentIntent takes priority
    if (/\b(docx|pdf|doc|report|manual|handbook|guide)\b/i.test(p)) {
        return null;
    }
    
    if (isCoding && hasTarget) {
        return makeRoute('complex', 'high', 'autonomous_coding', 'Execute the user request by writing files and running necessary commands.', 0.99);
    }
    return null;
}

function detectImageIntent(prompt) {
    const p = prompt.toLowerCase();
    const isImageKeyword = /\b(image|picture|diagram|photo|illustration|drawing|concept chart)\b/i.test(p);
    const isCreationKeyword = /\b(create|write|generate|build|make|draw|compile)\b/i.test(p);
    
    // Skip if it contains docx/report keywords so document mode takes priority
    if (/\b(docx|pdf|doc|report|manual|handbook|guide)\b/i.test(p)) {
        return null;
    }
    
    if (isImageKeyword && isCreationKeyword) {
        const cleanPrompt = prompt.replace(/\b(please|can u|can you|generate|create|make|draw|compile|write|a|an)\b/gi, '').trim();
        return makeRoute('feature', 'low', 'image_generation', 'Generate a standalone image.', 0.99, 'generate_image', { prompt: cleanPrompt || prompt });
    }
    return null;
}

function detectWebSearchIntent(prompt) {
    const p = prompt.toLowerCase().trim();
    const searchRegex = /^(?:search\s+the\s+web\s+for|search\s+for|search|google|duckduckgo)\s+(.+)$/i;
    const match = p.match(searchRegex);
    if (match) {
        let topic = match[1].trim();
        Logger.debug(`[PreRouter] Fast-track websearch: "${topic}"`);
        return makeRoute('feature', 'low', 'web_search', 'Search the web for the requested topic.', 0.99, 'websearch', { topic });
    }
    return null;
}

function detectPlayMediaIntent(prompt) {
    const p = prompt.toLowerCase().trim();
    const playRegex = /^(?:play|listen\s+to|watch|stream)\s+(.+)$/i;
    const match = p.match(playRegex);
    if (match) {
        let mediaQuery = match[1].trim();
        mediaQuery = mediaQuery.replace(/\s+(please|now|for me)$/i, '').trim();
        
        let artist = '';
        let query = mediaQuery;
        const byMatch = mediaQuery.match(/(.+)\s+by\s+(.+)$/i);
        if (byMatch) {
            query = byMatch[1].trim();
            artist = byMatch[2].trim();
        }

        let type = 'music';
        if (p.startsWith('watch') || /\b(video|clip|movie)\b/i.test(p)) {
            type = 'video';
        }

        Logger.debug(`[PreRouter] Fast-track playmedia: "${query}" by "${artist}" (${type})`);
        return makeRoute('feature', 'low', 'play_media', 'Play the requested song or video.', 0.99, 'playmedia', { query, type, artist });
    }
    return null;
}

function makeRoute(mode, complexity, intent, extraPrompt, confidence = 0.75, featureName = null, featureParams = {}) {
    return { mode, complexity, intent, extraPrompt, confidence, featureName, featureParams, subTasks: [] };
}

// ── Router response normalizer ─────────────────────────────────────────────
function normalizeRouterResponse(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const normalized = {};

    normalized.intent      = raw.message_summary || raw.message || raw.reason || raw.intent || raw.summary || 'interaction';
    normalized.confidence  = typeof raw.confidence === 'number' ? Math.max(0, Math.min(1, raw.confidence)) : 0.7;

    let comp = (raw.complexity || raw.level || 'low').toString().toLowerCase();
    normalized.complexity  = comp.includes('high') ? 'high' : 'low';

    let target = (raw.target_model || raw.mode || raw.model || raw.target || 'reactive').toString().toLowerCase();
    if (target.includes('complex') || target.includes('high'))          normalized.mode = 'complex';
    else if (target.includes('document') || target.includes('docx') || target.includes('pdf')) normalized.mode = 'document';
    else if (target.includes('terminal') || target.includes('shell'))   normalized.mode = 'terminal';
    else if (target.includes('feature') || target.includes('plugin'))   normalized.mode = 'feature';
    else                                                                 normalized.mode = 'reactive';

    normalized.extraPrompt  = raw.extra_prompt || raw.extraPrompt || raw['extra prompt'] || raw.prompt || '';

    const fm = raw.feature_metadata || {};
    normalized.featureName   = fm.name  || raw.feature_name  || null;
    normalized.featureParams = fm.params || raw.feature_params || {};

    if (normalized.mode === 'complex' || normalized.mode === 'document') normalized.complexity = 'high';

    // Multi-intent: if router returns sub_tasks array
    normalized.subTasks = Array.isArray(raw.sub_tasks) ? raw.sub_tasks : [];
    
    // Automatically switch to subagent orchestration if multiple tasks exist
    if (normalized.subTasks.length > 1 && normalized.mode !== 'terminal' && normalized.mode !== 'feature') {
        normalized.mode = 'subagent';
    }

    return normalized;
}

function validateRoute(r) {
    if (!r || typeof r !== 'object') return false;
    return (
        ['reactive','complex','terminal','feature','subagent','document'].includes(r.mode) &&
        ['low','high'].includes(r.complexity) &&
        typeof r.intent === 'string'
    );
}

// ── Main LLM Router ─────────────────────────────────────────────────────────
export class RouterLayer {
    get name() { return 'RouterLayer'; }

    async process(ctx) {
        Logger.stage('RouterLayer', 'Routing prompt...');

        // 1. Pre-router — zero LLM latency
        const preRoute = detectWebSearchIntent(ctx.enrichedPrompt) || detectPlayMediaIntent(ctx.enrichedPrompt) || detectDocumentIntent(ctx.enrichedPrompt) || detectVersionCheck(ctx.enrichedPrompt) || detectComplexIntent(ctx.enrichedPrompt) || detectImageIntent(ctx.enrichedPrompt);
        if (preRoute) {
            ctx.routeDecision = preRoute;
            bus.emit(AGENT_EVENTS.PRE_ROUTER_HIT, { route: preRoute });
            this._log(preRoute);
            return;
        }

        // 2. LLM Router
        const pluginDesc  = pluginManager.getRouterDescription();
        const pluginNames = pluginManager.getNames().join(', ');

        let sys = `You are a metadata-driven JSON routing orchestrator for Aria, a local AI agent.
Output ONLY a single valid JSON object matching the schema below. No extra text, no markdown.

JSON SCHEMA:
{
  "message_summary": "brief_intent_label",
  "complexity": "low" | "high",
  "target_model": "reactive" | "complex" | "terminal" | "feature" | "document",
  "extra_prompt": "extracted topic or instruction",
  "confidence": 0.0-1.0,
  "feature_metadata": { "name": null | "${pluginNames}", "params": {} },
  "sub_tasks": []
}

PLUGINS:
${pluginDesc}

CLASSIFICATION RULES:
1. target_model:
   - "reactive" → greetings, general questions, chatting, status checks.
   - "feature" → user requests a standalone tool/plugin (e.g. "generate a picture", "search wikipedia"). Set feature_metadata.name.
   - "document" → create/generate reports, manuals, docx/pdf files.
   - "complex" → write scripts, write code files, build projects.
   - "terminal" → run terminal commands directly.
2. complexity:
   - "low" → greetings, single commands, basic questions, quick feature runs.
   - "high" → writing files, document compiling, multiple tasks.
3. sub_tasks:
   - ONLY specify non-empty sub_tasks if the user explicitly asks to perform MULTIPLE distinct tasks (e.g., "write a script AND run it"). Otherwise, keep it as [].

EXAMPLES:

User: "hi"
JSON:
{
  "message_summary": "greetings",
  "complexity": "low",
  "target_model": "reactive",
  "extra_prompt": "",
  "confidence": 1.0,
  "feature_metadata": { "name": null, "params": {} },
  "sub_tasks": []
}

User: "whats my name"
JSON:
{
  "message_summary": "name_query",
  "complexity": "low",
  "target_model": "reactive",
  "extra_prompt": "",
  "confidence": 1.0,
  "feature_metadata": { "name": null, "params": {} },
  "sub_tasks": []
}

User: "can u generate a image of a neural network"
JSON:
{
  "message_summary": "image_generation",
  "complexity": "low",
  "target_model": "feature",
  "extra_prompt": "",
  "confidence": 1.0,
  "feature_metadata": { "name": "generate_image", "params": { "prompt": "neural network diagram" } },
  "sub_tasks": []
}

User: "create a docx file on AI"
JSON:
{
  "message_summary": "document_generation",
  "complexity": "high",
  "target_model": "document",
  "extra_prompt": "AI",
  "confidence": 1.0,
  "feature_metadata": { "name": null, "params": {} },
  "sub_tasks": []
}
`;

        if (ctx.history && ctx.history.length > 0) {
            const recent = ctx.history.slice(-4).map(m => `${m.role}: ${m.content}`).join('\n');
            sys += `\n\n=== RECENT CONVERSATION HISTORY ===\n${recent}\n\nUse this history context to understand what the user is referring to (e.g. follow-up requests like "something else", "make it blue", or pronouns like "it", "that", "those").`;
        }

        const msgs  = [{ role: 'system', content: sys }, { role: 'user', content: ctx.enrichedPrompt }];

        let raw    = await routerModel(msgs, true);
        let parsed = normalizeRouterResponse(extractJson(raw));

        if (!validateRoute(parsed)) {
            Logger.warn('[RouterLayer] Invalid schema, retrying...');
            raw    = await routerModel(msgs, true);
            parsed = normalizeRouterResponse(extractJson(raw));
        }

        if (!validateRoute(parsed)) {
            Logger.warn('[RouterLayer] Fallback to reactive');
            parsed = makeRoute('reactive', 'low', 'fallback',
                `Answer helpfully. User said: "${ctx.enrichedPrompt}"`, 0.5);
        }

        // Low confidence — add clarification hint
        if (parsed.confidence < 0.6 && !parsed.extraPrompt.includes('clarify')) {
            Logger.warn(`[RouterLayer] Low confidence (${parsed.confidence.toFixed(2)}) — adding clarification hint`);
            bus.emit(AGENT_EVENTS.LOW_CONFIDENCE, { confidence: parsed.confidence, intent: parsed.intent });
        }

        ctx.routeDecision = parsed;
        this._log(parsed);
        bus.emit(AGENT_EVENTS.ROUTE_DECIDED, { route: parsed });
    }

    _log(r) {
        Logger.stage('RouterLayer',
            `→ \x1b[1m${r.mode.toUpperCase()}\x1b[0m | ${r.complexity.toUpperCase()} | intent: ${r.intent} | confidence: ${(r.confidence || 0).toFixed(2)}`
        );
        if (r.extraPrompt) Logger.debug(`[Router extraPrompt] "${r.extraPrompt}"`);
    }
}

export default RouterLayer;
