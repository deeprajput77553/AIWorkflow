// src/core/Pipeline.js
// Chains pipeline stages sequentially.
// Each stage gets the same AgentContext object and enriches it in-place.

import Logger from '../utils/Logger.js';
import { bus, AGENT_EVENTS } from './EventBus.js';

export class Pipeline {
    constructor() {
        this._stages = [];
    }

    /** Add a stage (must have a .process(ctx) async method) */
    use(stage) {
        this._stages.push(stage);
        return this;   // fluent chaining
    }

    /**
     * Run all stages sequentially.
     * Stages with ctx.isBuiltinCommand = true short-circuit after the input stage.
     *
     * @param {import('./AgentContext.js').AgentContext} ctx
     * @returns {Promise<import('./AgentContext.js').AgentContext>}
     */
    async run(ctx) {
        for (const stage of this._stages) {
            const stageName = stage.name || stage.constructor?.name || 'Stage';
            const t0 = Date.now();

            try {
                await stage.process(ctx);
            } catch (err) {
                Logger.error(`Pipeline stage "${stageName}" threw:`, err.message);
                ctx.error = `[${stageName}] ${err.message}`;
                bus.emit(AGENT_EVENTS.ERROR, { stage: stageName, error: err.message });
                break;
            }

            const elapsed = Date.now() - t0;
            ctx.addTrace({ stage: stageName, duration_ms: elapsed });

            // Built-in commands (exit, /profile, /clear etc.) skip remaining stages
            if (ctx.isBuiltinCommand) {
                Logger.debug(`Pipeline: short-circuit after "${stageName}" (builtin command)`);
                break;
            }

            // Hard stop if a critical error was set
            if (ctx.error) {
                Logger.warn(`Pipeline: halted after "${stageName}" due to error`);
                break;
            }
        }

        return ctx;
    }
}

export default Pipeline;
