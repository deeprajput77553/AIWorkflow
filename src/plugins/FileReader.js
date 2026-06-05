// src/plugins/FileReader.js
// Reads text files from the workspace

import fs from 'fs';
import path from 'path';

export default {
    name: 'file_reader',
    description: 'Reads the contents of a local text file. Params: { path: string }',
    schema: {
        path: { type: 'string', required: true, description: 'Relative path to the file to read' }
    },
    execute({ path: filePath }) {
        try {
            const p = path.resolve(process.cwd(), filePath);
            if (!p.startsWith(process.cwd())) return 'x Path is outside workspace.';
            if (!fs.existsSync(p)) return `x File not found: ${filePath}`;
            
            const stats = fs.statSync(p);
            if (stats.size > 500_000) return `x File too large to read into context (${stats.size} bytes).`;
            
            const content = fs.readFileSync(p, 'utf-8');
            return `> Contents of ${filePath}:\n\n${content}`;
        } catch (e) {
            return `x Failed to read file: ${e.message}`;
        }
    }
};
