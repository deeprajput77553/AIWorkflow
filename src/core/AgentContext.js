// src/core/AgentContext.js
// The single typed context object that flows through every pipeline stage.
// Each stage enriches it in-place rather than returning bare strings.

import { randomUUID } from 'crypto';

/**
 * @typedef {Object} RouteDecision
 * @property {'reactive'|'complex'|'terminal'|'feature'} mode
 * @property {string}  model
 * @property {string}  intent
 * @property {string}  extraPrompt
 * @property {number}  confidence   0.0 – 1.0
 * @property {string|null} featureName
 * @property {Object}  featureParams
 * @property {RouteDecision[]} subTasks  for multi-intent
 */

/**
 * @typedef {Object} ExecutionResult
 * @property {string}  output
 * @property {string[]} files
 * @property {Object[]} toolCalls
 */

/**
 * @typedef {Object} ReflectionResult
 * @property {boolean} success
 * @property {string}  feedback
 * @property {number}  attempts
 */

export class AgentContext {
    constructor(rawInput = '', opts = {}) {
        this.id            = randomUUID();
        this.timestamp     = new Date().toISOString();

        // ── Input Stage ───────────────────────────────────────────────────
        this.rawInput          = rawInput;
        this.isBuiltinCommand  = false;
        this.parsedCommand     = null;   // { type, args }
        this.builtinResult     = null;

        // ── Context Stage ─────────────────────────────────────────────────
        this.enrichedPrompt    = rawInput;
        this.history           = opts.history           || [];
        this.relevantHistory   = [];
        this.userProfile       = opts.userProfile       || {};
        this.workspaceDir      = opts.workspaceDir      || process.cwd();
        this.workspaceSnapshot = opts.workspaceSnapshot || '';
        this.contextHeader     = '';
        this.indiaContext      = '';

        // ── Router Stage ──────────────────────────────────────────────────
        /** @type {RouteDecision|null} */
        this.routeDecision     = null;
        this.subTasks          = [];   // for multi-intent prompts

        // ── Execution Stage ───────────────────────────────────────────────
        /** @type {ExecutionResult|null} */
        this.executionResult   = null;
        this.createdFiles      = new Set();
        this.planExists        = false;
        this.toolCallHistory   = [];   // [{tool, params, result, ts}]

        // ── Reflection Stage ──────────────────────────────────────────────
        /** @type {ReflectionResult|null} */
        this.reflectionResult  = null;
        this.verificationAttempts = 0;

        // ── Output Stage ──────────────────────────────────────────────────
        this.finalOutput       = null;
        this.streamedTokenCount = 0;

        // ── Trace ──────────────────────────────────────────────────────────
        this.trace             = [];
        this.error             = null;
    }

    /** Append a step to the execution trace */
    addTrace(step) {
        this.trace.push({ timestamp: new Date().toISOString(), ...step });
    }

    /** Record a tool call in structured history */
    recordToolCall(tool, params, result) {
        this.toolCallHistory.push({
            ts: new Date().toISOString(),
            tool,
            params: typeof params === 'object' ? JSON.stringify(params).slice(0, 200) : String(params),
            result: String(result).slice(0, 500)
        });
    }

    /** Convert to a flat record for the trace log file */
    toTraceRecord() {
        return {
            id:           this.id,
            timestamp:    this.timestamp,
            prompt:       this.rawInput,
            route:        this.routeDecision ? {
                mode:       this.routeDecision.mode,
                intent:     this.routeDecision.intent,
                confidence: this.routeDecision.confidence
            } : null,
            toolCalls:    this.toolCallHistory,
            steps:        this.trace,
            finalOutput:  this.finalOutput,
            error:        this.error
        };
    }
}

export default AgentContext;
