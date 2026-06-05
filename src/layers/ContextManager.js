// src/layers/ContextManager.js
// Stage 2 — Semantic memory, user profile persistence, workspace snapshot caching

import fs from 'fs';
import path from 'path';
import Logger from '../utils/Logger.js';
import { bus, AGENT_EVENTS } from '../core/EventBus.js';
import { vectorStore } from '../core/VectorStore.js';

// ── File paths ──────────────────────────────────────────────────────────────
const MEMORY_FILE = path.join(process.cwd(), 'memory.json');
const USER_DATA_FILE = path.join(process.cwd(), 'user_data.json');

const DEFAULT_PROFILE = {
    user_name: 'Deep Rajput',
    operating_system: 'Windows',
    preferred_programming_languages: ['javascript', 'python'],
    preferences: { theme: 'dark' },
    known_facts: []
};

// ── Workspace scanner config ────────────────────────────────────────────────
const EXCLUDED_DIRS = ['.git', 'node_modules', '.gemini', 'dist', 'build'];
const EXCLUDED_FILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', '.ds_store'];
const TEXT_EXTS = ['.py', '.js', '.ts', '.json', '.md', '.txt', '.html', '.css',
    '.sh', '.bat', '.yaml', '.yml', '.toml', '.csv', '.xml', '.env', '.etc'];
const MAX_PREVIEW = 1_048_576; // 1 MB

// ── Snapshot cache (10 s TTL) ────────────────────────────────────────────────
const _cache = { data: null, ts: 0, dir: null };
const CACHE_TTL = 10_000;

export class ContextManager {
    constructor() {
        this._history = [];
        this._profile = { ...DEFAULT_PROFILE };
        this._load();
    }

    get name() { return 'ContextManager'; }

    // ── Persistence ──────────────────────────────────────────────────────────
    _load() {
        if (fs.existsSync(MEMORY_FILE)) {
            try { this._history = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8')); }
            catch { this._history = []; }
        }
        if (fs.existsSync(USER_DATA_FILE)) {
            try { this._profile = JSON.parse(fs.readFileSync(USER_DATA_FILE, 'utf-8')); }
            catch { /* keep defaults */ }
        }
    }

    saveMessage(role, content) {
        this._history.push({ role, content, ts: Date.now() });
        if (this._history.length > 50) this._history.shift();
        try { fs.writeFileSync(MEMORY_FILE, JSON.stringify(this._history, null, 2)); } catch { }
    }

    saveProfile(profile) {
        this._profile = profile;
        try { fs.writeFileSync(USER_DATA_FILE, JSON.stringify(profile, null, 2)); } catch { }
        bus.emit(AGENT_EVENTS.PROFILE_UPDATED, { profile });
        Logger.success('[ContextManager] user_data.json updated');
    }

    clearAll() {
        this._history = [];
        this._profile = { ...DEFAULT_PROFILE };
        try { fs.writeFileSync(MEMORY_FILE, '[]'); } catch { }
        try { fs.writeFileSync(USER_DATA_FILE, JSON.stringify(DEFAULT_PROFILE, null, 2)); } catch { }
    }

    getProfile() { return this._profile; }
    getHistory() { return this._history; }

    // ── Semantic Scoring ─────────────────────────────────────────────────────
    /**
     * Ranks messages by: recency×0.6 + keyword-overlap×0.4.
     * Returns the top-N most relevant, sorted in chronological order.
     */
    getRelevantHistory(prompt, n = 8) {
        if (!this._history.length) return [];
        
        // 1. Always keep the most recent messages for conversational flow
        const keepCount = Math.min(4, this._history.length);
        const recentMessages = this._history.slice(-keepCount);
        const recentIndices = new Set(recentMessages.map((_, i) => this._history.length - keepCount + i));
        
        // 2. Score remaining older messages semantically
        const remainingHistory = this._history.slice(0, this._history.length - keepCount);
        if (remainingHistory.length === 0) {
            return recentMessages;
        }

        const words = new Set(
            prompt.toLowerCase()
                .split(/\W+/)
                .filter(w => w.length > 3)
        );

        const scored = remainingHistory.map((msg, idx) => {
            const recency = (idx + 1) / remainingHistory.length;
            const msgWords = msg.content.toLowerCase().split(/\W+/);
            const overlap = msgWords.filter(w => words.has(w)).length;
            const kwScore = words.size > 0 ? Math.min(overlap / words.size, 1) : 0;
            return { msg, idx, score: recency * 0.6 + kwScore * 0.4 };
        });

        // 3. Take the top semantic matches from the older history
        const semanticCount = Math.max(0, n - keepCount);
        const topSemantic = scored
            .sort((a, b) => b.score - a.score)
            .slice(0, semanticCount)
            .map(s => s.msg);

        // 4. Combine and restore chronological order
        const combined = [...recentMessages, ...topSemantic];
        
        // Deduplicate in case of any duplicate refs, then sort by original index in history
        const unique = [];
        const seen = new Set();
        for (const msg of combined) {
            const originalIdx = this._history.indexOf(msg);
            if (originalIdx !== -1 && !seen.has(originalIdx)) {
                seen.add(originalIdx);
                unique.push({ msg, idx: originalIdx });
            }
        }

        return unique
            .sort((a, b) => a.idx - b.idx)
            .map(u => u.msg);
    }

    // ── Workspace Snapshot ───────────────────────────────────────────────────
    getWorkspaceSnapshot(workspaceDir) {
        const now = Date.now();
        if (_cache.data && _cache.dir === workspaceDir && (now - _cache.ts) < CACHE_TTL) {
            Logger.debug('ContextManager: snapshot cache hit');
            bus.emit(AGENT_EVENTS.SNAPSHOT_CACHED, {});
            return _cache.data;
        }
        const snap = this._buildSnapshot(workspaceDir);
        _cache.data = snap; _cache.ts = now; _cache.dir = workspaceDir;
        return snap;
    }

    invalidateSnapshot() { _cache.data = null; _cache.ts = 0; }

    _scanTree(dir, base, depth = 0, maxDepth = 2) {
        const lines = [];
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return ['(cannot read directory)']; }

        for (const e of entries) {
            if (e.isDirectory() && EXCLUDED_DIRS.includes(e.name.toLowerCase())) continue;
            if (e.isFile() && EXCLUDED_FILES.includes(e.name.toLowerCase())) continue;
            const indent = '  '.repeat(depth);
            const relPath = path.relative(base, path.join(dir, e.name));
            if (e.isDirectory()) {
                lines.push(`${indent}[DIR]  ${relPath}/`);
                if (depth < maxDepth) lines.push(...this._scanTree(path.join(dir, e.name), base, depth + 1, maxDepth));
            } else {
                const size = (() => { try { return fs.statSync(path.join(dir, e.name)).size; } catch { return 0; } })();
                lines.push(`${indent}[FILE] ${relPath}  (${size} bytes)`);
            }
        }
        return lines;
    }

    _buildSnapshot(workspaceDir) {
        const tree = this._scanTree(workspaceDir, workspaceDir);
        let snap = `=== WORKSPACE: ${workspaceDir} ===\nFile Tree:\n${tree.join('\n')}\n\n`;

        const previewDir = (dir, depth = 0) => {
            if (depth > 2) return;
            let entries;
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const e of entries) {
                if (e.isDirectory() && EXCLUDED_DIRS.includes(e.name.toLowerCase())) continue;
                if (e.isFile() && EXCLUDED_FILES.includes(e.name.toLowerCase())) continue;
                const full = path.join(dir, e.name);
                const rel = path.relative(workspaceDir, full);
                if (e.isDirectory()) { previewDir(full, depth + 1); continue; }
                if (!TEXT_EXTS.includes(path.extname(e.name).toLowerCase())) continue;
                try {
                    const stat = fs.statSync(full);
                    if (stat.size > MAX_PREVIEW) { snap += `--- FILE: ${rel} ---\n(File too large)\n\n`; continue; }
                    const lines = fs.readFileSync(full, 'utf-8').split('\n');
                    const preview = lines.slice(0, 40).join('\n');
                    const note = lines.length > 40 ? `\n... (${lines.length} lines total, showing first 40)` : '';
                    snap += `--- FILE: ${rel} ---\n${preview}${note}\n\n`;
                } catch { /* skip unreadable */ }
            }
        };
        previewDir(workspaceDir);
        return snap;
    }

    // ── India Time Context ───────────────────────────────────────────────────
    getIndiaContext() {
        const now = new Date();
        const dt = now.toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata', weekday: 'long', year: 'numeric',
            month: 'long', day: 'numeric', hour: 'numeric',
            minute: 'numeric', second: 'numeric', hour12: true
        });
        const month = now.getMonth();
        const season = month >= 2 && month <= 4 ? 'Summer (Hot and dry pre-monsoon)' :
            month >= 5 && month <= 8 ? 'Monsoon (Rainy season)' :
                month >= 9 && month <= 10 ? 'Post-monsoon (Autumn)' : 'Winter (Cool and dry)';
        return `Time & Date in India: ${dt}\nCurrent Season in India: ${season}`;
    }

    buildContextHeader(base = '') {
        let h = base ? base + '\n\n' : '';
        h += `[India Time & Season Context]:\n${this.getIndiaContext()}\n\n`;
        if (this._profile && Object.keys(this._profile).length > 0) {
            h += `[User Profile]: ${JSON.stringify({
                name: this._profile.user_name,
                os: this._profile.operating_system,
                langs: this._profile.preferred_programming_languages,
                prefs: this._profile.preferences
            })}\n`;
        }
        if (this._history.length > 0) {
            const recent = this._history.slice(-6).map(m => `${m.role}: ${m.content}`).join('\n');
            h += `[Recent History]:\n${recent}\n`;
        }
        return h;
    }

    // ── Pipeline Stage ───────────────────────────────────────────────────────
    async process(ctx) {
        Logger.stage('ContextManager', 'Building enriched context...');

        ctx.history = this._history;
        ctx.userProfile = this._profile;
        ctx.relevantHistory = this.getRelevantHistory(ctx.enrichedPrompt);
        ctx.workspaceSnapshot = this.getWorkspaceSnapshot(ctx.workspaceDir);
        ctx.indiaContext = this.getIndiaContext();
        ctx.contextHeader = this.buildContextHeader();

        // --- NATIVE RAG RETRIEVAL ---
        try {
            const results = await vectorStore.search(ctx.enrichedPrompt, 3);
            if (results && results.length > 0) {
                Logger.info(`[ContextManager] Retrieved ${results.length} chunks via RAG`);
                let ragContext = `\n\n[Retrieved Documents]:\n` +
                    `The following information was retrieved from the local knowledge base to help answer the user's query.\n` +
                    `CRITICAL RULE: You MUST cite every fact you use from this section inline at the end of the sentence using the exact format: [Source: <document_name>, Chunk <number>] (e.g. [Source: https://en.wikipedia.org/wiki/IBM, Chunk 2]). Do NOT use conversational citations like "According to the webpage...".\n`;
                results.forEach((res, i) => {
                    ragContext += `\n--- Document: ${res.metadata.source} (Chunk ${res.metadata.chunkIndex + 1}) ---\n${res.text}\n`;
                });
                ctx.contextHeader += ragContext;
            }
        } catch (err) {
            Logger.warn(`[ContextManager] RAG retrieval failed: ${err.message}`);
        }

        bus.emit(AGENT_EVENTS.CONTEXT_BUILT, {
            historySize: this._history.length,
            relevantSize: ctx.relevantHistory.length
        });

        Logger.debug(`ContextManager: ${this._history.length} messages, ${ctx.relevantHistory.length} relevant selected`);
    }
}

// Singleton export
export const contextManager = new ContextManager();
export default ContextManager;
