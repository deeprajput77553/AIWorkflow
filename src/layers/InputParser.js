// src/layers/InputParser.js
// Stage 1 — Parses raw CLI input: slash commands, built-in commands, normal prompts

import Logger from '../utils/Logger.js';
import { bus, AGENT_EVENTS } from '../core/EventBus.js';

const EXACT_BUILTINS = new Set([
    'exit',
    '/models',
    '/profile',
    '/clear',
    '/clearprofile',
    'clear user data',
    'clear profile',
    'reset profile',
    'reset user profile',
    'clear history',
    'clear memory',
    '/help',
    '/status',
]);

export class InputParser {
    get name() { return 'InputParser'; }

    async process(ctx) {
        const raw   = ctx.rawInput.trim();
        const lower = raw.toLowerCase();

        Logger.stage('InputParser', `→ "${raw.slice(0, 70)}${raw.length > 70 ? '...' : ''}"`);

        // 1. Exact built-in matches
        if (EXACT_BUILTINS.has(lower)) {
            ctx.isBuiltinCommand = true;
            ctx.parsedCommand    = { type: this._mapBuiltin(lower) };
            bus.emit(AGENT_EVENTS.BUILTIN_COMMAND, { type: ctx.parsedCommand.type });
            return;
        }

        // 2. Prefix-based commands
        const prefixes = [
            { prefix: '/run ',       type: 'run',       slice: 5  },
            { prefix: '/install ',   type: 'install',   slice: 9  },
            { prefix: '/pull ',      type: 'pull',      slice: 6  },
            { prefix: '/workspace ', type: 'workspace', slice: 11 },
            { prefix: '/search ',    type: 'search',    slice: 8  },
            { prefix: '/embed ',     type: 'embed',     slice: 7  },
            { prefix: '/crawl ',     type: 'crawl',     slice: 7  },
        ];

        for (const { prefix, type, slice } of prefixes) {
            if (lower.startsWith(prefix)) {
                ctx.isBuiltinCommand = true;
                ctx.parsedCommand    = { type, args: raw.slice(slice).trim() };
                bus.emit(AGENT_EVENTS.BUILTIN_COMMAND, { type, args: ctx.parsedCommand.args });
                return;
            }
        }

        // 3. Normal user prompt — passes through to ContextManager
        ctx.enrichedPrompt = raw;
        bus.emit(AGENT_EVENTS.INPUT_RECEIVED, { input: raw });
    }

    _mapBuiltin(lower) {
        if (['exit'].includes(lower))                                                       return 'exit';
        if (['/models'].includes(lower))                                                    return 'models';
        if (['/profile'].includes(lower))                                                   return 'profile';
        if (['/help'].includes(lower))                                                      return 'help';
        if (['/status'].includes(lower))                                                    return 'status';
        if (['/clear','/clearprofile','clear user data','clear profile','reset profile',
             'reset user profile','clear history','clear memory'].includes(lower))          return 'clear';
        return 'unknown';
    }
}

export default InputParser;
