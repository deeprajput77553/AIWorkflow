// src/plugins/Installer.js
// Package installer plugin

import { execSync } from 'child_process';

function runInstall(cmd) {
    try {
        const out = execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
        return { ok: true, out: out.trim() };
    } catch (err) {
        return { ok: false, out: (err.stdout || err.stderr || err.message).toString().trim() };
    }
}

export default {
    name:        'install',
    description: 'Installs a package. Params: { manager: "npm"|"pip"|"winget", package: string }',
    schema: {
        manager: { type: 'string', required: false, description: 'Package manager: npm, pip, or winget' },
        package: { type: 'string', required: true,  description: 'The package name to install' }
    },
    execute({ manager = 'npm', package: pkg }) {
        const cmds = { npm: `npm install ${pkg}`, pip: `pip install ${pkg}`, winget: `winget install ${pkg}` };
        const cmd  = cmds[manager] || `npm install ${pkg}`;
        console.log(`[Plugin: Installer] + Running: ${cmd}`);
        const { ok, out } = runInstall(cmd);
        return ok ? `✓ Installed "${pkg}" via ${manager}:\n${out}` : `x Install failed:\n${out}`;
    }
};
