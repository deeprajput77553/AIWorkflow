// src/plugins/RunCommand.js
// Allowed shell command runner plugin

import { execSync } from 'child_process';

const ALLOWED_PREFIXES = [
    'node ', 'python ', 'python3 ', 'pip ', 'pip3 ',
    'npm ', 'npx ', 'yarn ', 'pnpm ',
    'git ', 'ollama ', 'winget ', 'choco ', 'scoop ',
    'dir', 'ls', 'echo ', 'cat ', 'type ',
    'mkdir ', 'rmdir ', 'del ', 'copy ', 'move ',
    'curl ', 'wget ', 'powershell ', 'pwsh '
];

function isAllowed(cmd) {
    const lower = cmd.trim().toLowerCase();
    return ALLOWED_PREFIXES.some(p => lower.startsWith(p));
}

export default {
    name:        'run_command',
    description: 'Runs an allowed shell command. Params: { command: string }',
    schema: {
        command: { type: 'string', required: true, description: 'The shell command to execute' }
    },
    execute({ command }) {
        if (!isAllowed(command)) {
            return `x Command not in allowlist: "${command}".\nAllowed prefixes: ${ALLOWED_PREFIXES.join(', ')}`;
        }
        try {
            const out = execSync(command, {
                encoding: 'utf-8', shell: true, timeout: 60_000,
                stdio: ['ignore', 'pipe', 'pipe']
            });
            return `✓ Output:\n${(out || '(no output)').trim()}`;
        } catch (err) {
            const msg = (err.stdout || err.stderr || err.message).toString().trim();
            return `x Command failed (exit ${err.status ?? 1}):\n${msg}`;
        }
    },
    isAllowed
};
