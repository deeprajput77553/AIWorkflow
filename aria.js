// aria.js — Aria Local Workflow AI — Structured Pipeline Entry Point
// Replaces the monolithic ollama_agent.js with a clean 6-stage pipeline.

import fs       from 'fs';
import path     from 'path';
import http     from 'http';
import readline from 'readline';
import crypto   from 'crypto';

// ── Core ──────────────────────────────────────────────────────────────────
import { Pipeline }        from './src/core/Pipeline.js';
import { AgentContext }    from './src/core/AgentContext.js';
import { bus, AGENT_EVENTS } from './src/core/EventBus.js';
import Logger, { setWsBroadcast } from './src/utils/Logger.js';

// ── Pipeline Stages ───────────────────────────────────────────────────────
import { InputParser }     from './src/layers/InputParser.js';
import { contextManager }  from './src/layers/ContextManager.js';
import { RouterLayer }     from './src/layers/RouterLayer.js';
import { ExecutionLayer }  from './src/layers/ExecutionLayer.js';
import { ReflectionLayer } from './src/layers/ReflectionLayer.js';
import { OutputLayer }     from './src/layers/OutputLayer.js';
import { runTerminal }     from './src/layers/ExecutionLayer.js';

// ── Plugins ───────────────────────────────────────────────────────────────
import { pluginManager }   from './src/plugins/PluginManager.js';
import WebSearch   from './src/plugins/WebSearch.js';
import Timer       from './src/plugins/Timer.js';
import Installer   from './src/plugins/Installer.js';
import OllamaPull  from './src/plugins/OllamaPull.js';
import RunCommand  from './src/plugins/RunCommand.js';
import FileReader  from './src/plugins/FileReader.js';
import GenerateImage from './src/plugins/GenerateImage.js';

// ── Register Plugins ──────────────────────────────────────────────────────
pluginManager.register(WebSearch);
pluginManager.register(Timer);
pluginManager.register(Installer);
pluginManager.register(OllamaPull);
pluginManager.register(RunCommand);
pluginManager.register(FileReader);
pluginManager.register(GenerateImage);

// ── Build Pipeline ────────────────────────────────────────────────────────
const pipeline = new Pipeline()
    .use(new InputParser())
    .use(contextManager)          // ContextManager acts as its own stage
    .use(new RouterLayer())
    .use(new ExecutionLayer())
    .use(new ReflectionLayer())
    .use(new OutputLayer());

// ── Global State ──────────────────────────────────────────────────────────
let WORKSPACE_DIR = process.cwd();

// ── Live Dashboard (HTTP + WebSocket) ────────────────────────────────────
const WS_PORT    = 4200;
const DASH_PATH  = path.join(process.cwd(), 'dashboard', 'index.html');
let wsClients    = new Set();

function startDashboard() {
    if (!fs.existsSync(DASH_PATH)) {
        Logger.debug('Dashboard HTML not found — skipping dashboard server.');
        return;
    }
    const server = http.createServer((req, res) => {
        if (req.url === '/' || req.url === '/index.html') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            fs.createReadStream(DASH_PATH).pipe(res);
        } else {
            res.writeHead(404); res.end('Not found');
        }
    });

    // Minimal WebSocket upgrade handling (no external dep)
    server.on('upgrade', (req, socket) => {
        const key    = req.headers['sec-websocket-key'];
        const hash   = crypto.createHash('sha1')
            .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
            .digest('base64');
        socket.write([
            'HTTP/1.1 101 Switching Protocols',
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Accept: ${hash}`,
            '\r\n'
        ].join('\r\n'));

        socket.on('error', () => wsClients.delete(socket));
        socket.on('close', () => wsClients.delete(socket));
        wsClients.add(socket);

        // Replay recent event history to new client
        const history = bus.getHistory(30);
        history.forEach(evt => sendWs(socket, evt));

        Logger.debug(`[Dashboard] WebSocket client connected (total: ${wsClients.size})`);
        bus.emit(AGENT_EVENTS.WS_CLIENT_CONNECTED, { clientCount: wsClients.size });
    });

    server.on('error', (e) => {
        if (e.code === 'EADDRINUSE') {
            Logger.warn(`Dashboard port ${WS_PORT} is already in use (likely by another Aria instance). Dashboard will not start, but Aria will continue to work.`);
        } else {
            Logger.error(`Dashboard server error: ${e.message}`);
        }
    });

    server.listen(WS_PORT, () => {
        Logger.info(`@ Dashboard: http://localhost:${WS_PORT}`);
    });
}

function sendWs(socket, data) {
    try {
        const msg    = JSON.stringify(data);
        const buf    = Buffer.from(msg);
        const header = Buffer.alloc(buf.length < 126 ? 2 : 4);
        header[0]    = 0x81; // text frame
        if (buf.length < 126) {
            header[1] = buf.length;
        } else {
            header[1] = 126;
            header.writeUInt16BE(buf.length, 2);
        }
        socket.write(Buffer.concat([header, buf]));
    } catch { wsClients.delete(socket); }
}

function broadcastWs(data) {
    wsClients.forEach(s => sendWs(s, data));
}

// Wire EventBus → WebSocket broadcast
bus.on('*', (evt) => broadcastWs(evt));
setWsBroadcast(broadcastWs);

// ── Built-in Command Handler ──────────────────────────────────────────────
async function handleBuiltin(ctx) {
    const cmd = ctx.parsedCommand;
    switch (cmd.type) {
    case 'exit':
        Logger.info('Goodbye!');
        process.exit(0);
        break;
    case 'models': {
        const { stdout } = runTerminal('ollama list');
        console.log(`\n+ Ollama Models:\n${stdout}\n`);
        ctx.builtinResult = stdout;
        break;
    }
    case 'profile': {
        const p = contextManager.getProfile();
        console.log(`\n@ User Profile:\n${JSON.stringify(p, null, 2)}\n`);
        ctx.builtinResult = JSON.stringify(p);
        break;
    }
    case 'clear':
        contextManager.clearAll();
        console.log('\n~ Memory, history, and user profile have been cleared and reset.\n');
        ctx.builtinResult = 'cleared';
        break;
    case 'run': {
        const { stdout, stderr, code } = runTerminal(cmd.args);
        const out = (stdout + stderr).trim();
        console.log(`\n${code === 0 ? '✅' : '❌'} Exit ${code}:\n${out}\n`);
        ctx.builtinResult = out;
        break;
    }
    case 'install': {
        const result = await pluginManager.execute('install', { manager: 'npm', package: cmd.args });
        console.log(`\n${result}\n`);
        ctx.builtinResult = result;
        break;
    }
    case 'pull': {
        const result = await pluginManager.execute('ollama_pull', { model: cmd.args });
        console.log(`\n${result}\n`);
        ctx.builtinResult = result;
        break;
    }
    case 'workspace':
        WORKSPACE_DIR = path.resolve(cmd.args);
        if (!fs.existsSync(WORKSPACE_DIR)) fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
        contextManager.invalidateSnapshot();
        console.log(`\n🔒  Workspace changed to: ${WORKSPACE_DIR}\n`);
        ctx.builtinResult = WORKSPACE_DIR;
        break;
    case 'help':
        printHelp();
        ctx.builtinResult = 'help';
        break;
    case 'status':
        printStatus();
        ctx.builtinResult = 'status';
        break;
    default:
        ctx.builtinResult = 'unknown command';
    }
}

function printHelp() {
    console.log(`
\x1b[1m\x1b[96m━━━  Aria — Command Reference  ━━━\x1b[0m

  \x1b[93mexit\x1b[0m              Quit Aria
  \x1b[93m/models\x1b[0m           List installed Ollama models
  \x1b[93m/profile\x1b[0m          Show current user profile
  \x1b[93m/clear\x1b[0m            Reset memory, history & profile
  \x1b[93m/run <cmd>\x1b[0m        Execute a shell command directly
  \x1b[93m/install <pkg>\x1b[0m    Install an npm package
  \x1b[93m/pull <model>\x1b[0m     Download an Ollama model
  \x1b[93m/workspace <dir>\x1b[0m  Change workspace directory
  \x1b[93m/status\x1b[0m           Show system status
  \x1b[93m/help\x1b[0m             Show this help

  \x1b[2mPlugins: ${pluginManager.getNames().join(', ')}\x1b[0m
  \x1b[2mDashboard: http://localhost:${WS_PORT}\x1b[0m
`);
}

function printStatus() {
    const profile = contextManager.getProfile();
    const history = contextManager.getHistory();
    console.log(`
\x1b[1m\x1b[96m━━━  Aria — System Status  ━━━\x1b[0m

  Workspace : ${WORKSPACE_DIR}
  User      : ${profile.user_name} | ${profile.operating_system}
  Memory    : ${history.length} messages stored
  Plugins   : ${pluginManager.getNames().join(', ')}
  Dashboard : http://localhost:${WS_PORT}
  WS Clients: ${wsClients.size}
`);
}

// ── Main Interaction Loop ─────────────────────────────────────────────────
async function runLoop() {
    // Banner
    Logger.banner([
        '\x1b[1m\x1b[96m🚀  Aria — Local Workflow AI  v2.0\x1b[0m',
        '\x1b[2m  Structured Pipeline · Streaming · Plugin System\x1b[0m',
        '',
        `\x1b[2m  🔵 Router   : llama3.2:1b\x1b[0m`,
        `\x1b[2m  🟢 Reactive  : llama3:latest  (streaming)\x1b[0m`,
        `\x1b[2m  🟡 Complex   : qwen2.5-coder:7b\x1b[0m`,
        `\x1b[2m  🟠 Verify    : codellama:latest\x1b[0m`,
        `\x1b[2m  🌐 Dashboard : http://localhost:${WS_PORT}\x1b[0m`,
    ]);

    // Workspace selection
    const rl  = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise(resolve => rl.question(q, resolve));

    const ws = await ask('Workspace folder (blank = current dir):\n\x1b[93m❯ \x1b[0m');
    if (ws.trim()) WORKSPACE_DIR = path.resolve(ws.trim());
    if (!fs.existsSync(WORKSPACE_DIR)) fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    Logger.success(`Workspace locked: ${WORKSPACE_DIR}`);

    console.log(`\n\x1b[2mType /help for commands, exit to quit.\x1b[0m\n`);

    // Start dashboard server
    startDashboard();

    const loop = async () => {
        const input = await ask('\n\x1b[1m\x1b[34mYou\x1b[0m\x1b[2m ›\x1b[0m ');

        const ctx = new AgentContext(input, {
            workspaceDir:     WORKSPACE_DIR,
            history:          contextManager.getHistory(),
            userProfile:      contextManager.getProfile(),
        });

        // Run pipeline
        await pipeline.run(ctx);

        // Handle built-in commands (pipeline short-circuits but we still need to act)
        if (ctx.isBuiltinCommand) {
            await handleBuiltin(ctx);
        }

        loop();   // recurse (no stack overflow — async tail)
    };

    loop();
}

runLoop();
