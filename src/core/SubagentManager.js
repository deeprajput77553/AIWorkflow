// src/core/SubagentManager.js
// Handles parallel execution of LLM subtasks

import Logger from '../utils/Logger.js';
import { callOllama, MODELS } from '../layers/OutputLayer.js';

export class SubagentManager {
    /**
     * Executes multiple tasks in parallel using the specified model.
     * @param {Array<{id: string, prompt: string}>} tasks
     * @param {string} model
     * @param {string} systemPrompt
     * @returns {Promise<Array<{id: string, result: string, error?: string}>>}
     */
    async executeParallel(tasks, model = MODELS.COMPLEX, systemPrompt = 'You are a parallel subagent.') {
        if (!tasks || !tasks.length) return [];
        
        Logger.stage('Subagents', `Spawning ${tasks.length} parallel subagents on model ${model}...`);
        
        const promises = tasks.map(async (task) => {
            const start = Date.now();
            try {
                Logger.debug(`[Subagent ${task.id}] Started: "${task.prompt.slice(0, 50)}..."`);
                const msgs = [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: task.prompt }
                ];
                // Subagents do not stream to stdout to prevent mangling
                const result = await callOllama(msgs, model, false);
                const ms = Date.now() - start;
                Logger.debug(`[Subagent ${task.id}] Completed in ${ms}ms`);
                return { id: task.id, result };
            } catch (err) {
                Logger.error(`[Subagent ${task.id}] Failed: ${err.message}`);
                return { id: task.id, result: null, error: err.message };
            }
        });

        const results = await Promise.all(promises);
        Logger.success(`All ${tasks.length} subagents completed.`);
        return results;
    }
}

export const subagentManager = new SubagentManager();
export default SubagentManager;
