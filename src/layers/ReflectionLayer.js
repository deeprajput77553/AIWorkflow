// src/layers/ReflectionLayer.js
// Stage 5 — Profile extraction, trace logging, memory persistence

import fs   from 'fs';
import path from 'path';

import Logger            from '../utils/Logger.js';
import { bus, AGENT_EVENTS } from '../core/EventBus.js';
import { routerModel, extractJson } from './OutputLayer.js';
import { contextManager } from './ContextManager.js';

// ── Trace file ──────────────────────────────────────────────────────────────
const TRACE_FILE = path.join(process.cwd(), 'execution_trace.json');

function loadTraces() {
    if (fs.existsSync(TRACE_FILE)) {
        try { return JSON.parse(fs.readFileSync(TRACE_FILE, 'utf-8')); }
        catch { return []; }
    }
    return [];
}

function writeTrace(record) {
    try {
        const traces = loadTraces();
        traces.push(record);
        if (traces.length > 50) traces.shift();
        fs.writeFileSync(TRACE_FILE, JSON.stringify(traces, null, 2), 'utf-8');
        Logger.debug('[ReflectionLayer] Trace written to execution_trace.json');
    } catch (err) {
        Logger.error(`[ReflectionLayer] Trace write failed: ${err.message}`);
    }
}

export class ReflectionLayer {
    get name() { return 'ReflectionLayer'; }

    async process(ctx) {
        Logger.stage('ReflectionLayer', 'Profile extraction + trace logging...');

        // 1. Write execution trace
        if (ctx.finalOutput) {
            writeTrace(ctx.toTraceRecord());
        }

        // 2. Save conversation messages to memory
        if (ctx.enrichedPrompt && !ctx.isBuiltinCommand) {
            contextManager.saveMessage('user', ctx.enrichedPrompt);
        }
        if (ctx.finalOutput) {
            contextManager.saveMessage('assistant', ctx.finalOutput);
        }

        // 3. Extract user profile facts asynchronously (don't await — background)
        if (ctx.finalOutput && ctx.enrichedPrompt && !ctx.isBuiltinCommand) {
            this._extractProfile(ctx.enrichedPrompt, ctx.finalOutput, ctx.userProfile).catch(() => {});
        }

        ctx.reflectionResult = { success: true, feedback: '', attempts: ctx.verificationAttempts };
    }

    // ── AI Profile Extractor ─────────────────────────────────────────────────
    async _extractProfile(userPrompt, assistantResponse, currentProfile) {
        const sys = `Extract user profile facts from this conversation turn. Return ONLY valid JSON:
{
  "user_name": "string",
  "operating_system": "string",
  "preferred_programming_languages": [],
  "preferences": {},
  "known_facts": []
}
RULES:
1. Only extract concrete facts about the user's name, system, env, or preferences.
2. DO NOT extract template placeholders, time/season context, or questions asked by the user.
3. Keep the profile clean and factual.
4. Preserve existing values if no new info contradicts them.

Current profile: ${JSON.stringify(currentProfile)}`;

        const msgs = [
            { role: 'system', content: sys },
            { role: 'user',   content: `User: "${userPrompt}"\nAssistant: "${assistantResponse.slice(0, 500)}"` }
        ];

        const raw    = await routerModel(msgs, true);
        if (!raw) return;
        const parsed = extractJson(raw);

        if (parsed && typeof parsed === 'object' && parsed.user_name !== undefined) {
            // Don't overwrite OS if we already know it
            if (!parsed.operating_system && currentProfile.operating_system) {
                parsed.operating_system = currentProfile.operating_system;
            }
            // Merge known_facts (dedup by text)
            const existing = new Set((currentProfile.known_facts || []).map(f => f.text || f));
            const merged   = [...(currentProfile.known_facts || [])];
            for (const fact of (parsed.known_facts || [])) {
                const key = fact.text || fact;
                if (!existing.has(key)) merged.push(fact);
            }
            parsed.known_facts = merged;

            contextManager.saveProfile(parsed);
        }
    }
}

export default ReflectionLayer;
