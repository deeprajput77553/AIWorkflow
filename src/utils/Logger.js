// src/utils/Logger.js
// Typed structured logger — replaces all scattered console.log calls

const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, TRACE: 4 };

const C = {
    DEBUG:  '\x1b[36m',   // cyan
    INFO:   '\x1b[32m',   // green
    WARN:   '\x1b[33m',   // yellow
    ERROR:  '\x1b[31m',   // red
    TRACE:  '\x1b[35m',   // magenta
    BOLD:   '\x1b[1m',
    DIM:    '\x1b[2m',
    RESET:  '\x1b[0m',
    CYAN:   '\x1b[96m',
    BLUE:   '\x1b[34m',
    GOLD:   '\x1b[93m',
};

const BG = {
    DEBUG:   '\x1b[46m\x1b[30m', // cyan bg, black text
    INFO:    '\x1b[42m\x1b[30m', // green bg, black text
    WARN:    '\x1b[43m\x1b[30m', // yellow bg, black text
    ERROR:   '\x1b[41m\x1b[97m', // red bg, white text
    TRACE:   '\x1b[45m\x1b[30m', // magenta bg, black text
    STAGE:   '\x1b[44m\x1b[97m', // blue bg, white text
    TOOL:    '\x1b[104m\x1b[30m', // bright blue bg, black text
    SUCCESS: '\x1b[102m\x1b[30m', // bright green bg, black text
    FAIL:    '\x1b[41m\x1b[97m', // red bg, white text
};

let currentLevel = LEVELS.INFO;
let wsEmitter = null; // optional WebSocket broadcast function

export function setLogLevel(level) {
    currentLevel = LEVELS[level] ?? LEVELS.INFO;
}

export function setWsBroadcast(fn) {
    wsEmitter = fn;
}

function ts() {
    return new Date().toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' });
}

function fmt(...args) {
    return args.map(a => (typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a))).join(' ');
}

function emit(type, message) {
    if (wsEmitter) {
        try {
            const now = new Date().toISOString();
            wsEmitter({ type: 'log', level: type, message, ts: now, timestamp: now });
        }
        catch { /* ws not ready */ }
    }
}

export const Logger = {
    debug(...args) {
        if (currentLevel > LEVELS.DEBUG) return;
        const msg = fmt(...args);
        console.log(`${C.DIM}${ts()}${C.RESET} ${BG.DEBUG} ⚙  DEBUG ${C.RESET} ${msg}`);
        emit('debug', msg);
    },
    info(...args) {
        if (currentLevel > LEVELS.INFO) return;
        const msg = fmt(...args);
        console.log(`${C.DIM}${ts()}${C.RESET} ${BG.INFO} ℹ  INFO  ${C.RESET} ${msg}`);
        emit('info', msg);
    },
    warn(...args) {
        const msg = fmt(...args);
        console.log(`${C.DIM}${ts()}${C.RESET} ${BG.WARN} ⚠  WARN  ${C.RESET} ${C.WARN}${msg}${C.RESET}`);
        emit('warn', msg);
    },
    error(...args) {
        const msg = fmt(...args);
        console.log(`${C.DIM}${ts()}${C.RESET} ${BG.ERROR} ✖  ERROR ${C.RESET} ${C.ERROR}${msg}${C.RESET}`);
        emit('error', msg);
    },
    trace(...args) {
        const msg = fmt(...args);
        console.log(`${C.DIM}${ts()}${C.RESET} ${BG.TRACE} ›  TRACE ${C.RESET} ${msg}`);
        emit('trace', msg);
    },

    // Named stage banner
    stage(name, ...args) {
        const msg = fmt(...args);
        console.log(`${C.DIM}${ts()}${C.RESET} ${BG.STAGE} ✦  STAGE ${C.RESET} ${C.BOLD}${C.CYAN}[${name}]${C.RESET} ${msg}`);
        emit('stage', `[${name}] ${msg}`);
    },

    // Live token streaming  — writes to stdout without newline
    token(t) {
        process.stdout.write(`${C.GOLD}${t}${C.RESET}`);
        if (wsEmitter) { try { wsEmitter({ type: 'token', token: t }); } catch {} }
    },

    nl() { console.log(); },

    divider(char = '─', len = 60) {
        console.log(`${C.DIM}${char.repeat(len)}${C.RESET}`);
    },

    banner(lines) {
        const w = 62;
        console.log('\n' + `${C.CYAN}${'═'.repeat(w)}${C.RESET}`);
        lines.forEach(l => console.log(`  ${l}`));
        console.log(`${C.CYAN}${'═'.repeat(w)}${C.RESET}\n`);
    },

    toolCall(tool, detail = '') {
        console.log(`${C.DIM}${ts()}${C.RESET} ${BG.TOOL} ⛭  TOOL  ${C.RESET} ${C.BOLD}${tool}${C.RESET} ${C.DIM}${detail}${C.RESET}`);
        emit('tool', `${tool} ${detail}`);
    },

    success(msg) {
        console.log(`${C.DIM}${ts()}${C.RESET} ${BG.SUCCESS} ✔  SUCCESS ${C.RESET} ${msg}`);
        emit('success', msg);
    },

    fail(msg) {
        console.log(`${C.DIM}${ts()}${C.RESET} ${BG.FAIL} ✖  FAIL  ${C.RESET} ${C.ERROR}${msg}${C.RESET}`);
        emit('fail', msg);
    }
};

export default Logger;
