// src/plugins/PluginManager.js
// Clean self-registering plugin registry — replaces the hard-coded FEATURES object

import Logger from '../utils/Logger.js';

/**
 * Plugin interface:
 * {
 *   name:        string          — unique key used by router
 *   description: string          — injected into router system prompt
 *   schema:      { [param]: { type, required, description } }
 *   execute:     async (params) => string   — returns string result
 * }
 */
export class PluginManager {
    constructor() {
        this._plugins = new Map();
    }

    /** Register a plugin (auto-validates it has required fields) */
    register(plugin) {
        if (!plugin.name || typeof plugin.execute !== 'function') {
            Logger.warn(`[PluginManager] Invalid plugin skipped: ${plugin.name || '(unnamed)'}`);
            return;
        }
        this._plugins.set(plugin.name, plugin);
        Logger.debug(`[PluginManager] Registered plugin: "${plugin.name}"`);
    }

    /** Validate that all required params are present */
    validate(name, params) {
        const plugin = this._plugins.get(name);
        if (!plugin) return { valid: false, error: `Plugin "${name}" not found` };
        const schema = plugin.schema || {};
        for (const [key, rules] of Object.entries(schema)) {
            if (rules.required && (params[key] === undefined || params[key] === null || params[key] === '')) {
                return { valid: false, error: `Missing required parameter "${key}" for plugin "${name}"` };
            }
        }
        return { valid: true };
    }

    /** Execute a plugin by name with given params */
    async execute(name, params, workspaceDir) {
        const plugin = this._plugins.get(name);
        if (!plugin) return `x Plugin "${name}" not found.`;

        const { valid, error } = this.validate(name, params);
        if (!valid) return `x Plugin validation error: ${error}`;

        try {
            Logger.stage('Plugin', `Running "${name}" with params: ${JSON.stringify(params)}`);
            const result = await plugin.execute(params, workspaceDir);
            return result;
        } catch (err) {
            Logger.error(`[PluginManager] Plugin "${name}" threw: ${err.message}`);
            return `x Plugin "${name}" failed: ${err.message}`;
        }
    }

    /** Returns a description string injected into the router's system prompt */
    getRouterDescription() {
        if (!this._plugins.size) return '(no plugins registered)';
        return [...this._plugins.values()]
            .map(p => `  ${p.name}: ${p.description}`)
            .join('\n');
    }

    /** Returns plugin names list */
    getNames() { return [...this._plugins.keys()]; }

    /** Returns all plugins (for introspection) */
    getAll()   { return [...this._plugins.values()]; }

    has(name)  { return this._plugins.has(name); }
}

export const pluginManager = new PluginManager();
export default PluginManager;
