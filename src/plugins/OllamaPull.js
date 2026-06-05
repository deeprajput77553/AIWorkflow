// src/plugins/OllamaPull.js
// Ollama model downloader plugin

import { execSync } from 'child_process';

export default {
    name:        'ollama_pull',
    description: 'Downloads an Ollama model. Params: { model: string }',
    schema: {
        model: { type: 'string', required: true, description: 'The Ollama model name to pull, e.g. "llama3:latest"' }
    },
    execute({ model }) {
        console.log(`[Plugin: OllamaPull] + Pulling model: ${model}`);
        try {
            const out = execSync(`ollama pull ${model}`, {
                encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000
            });
            return `✓ Model "${model}" downloaded successfully.\n${out.trim()}`;
        } catch (err) {
            const msg = (err.stdout || err.stderr || err.message).toString().trim();
            return `x Ollama pull failed for "${model}":\n${msg}`;
        }
    }
};
