import fs from 'fs';
import path from 'path';
import { vectorStore } from './VectorStore.js';
import Logger from '../utils/Logger.js';

const WATCHED_EXTS = ['.txt', '.md', '.pdf', '.docx', '.json'];
const EXCLUDED_DIRS = ['node_modules', '.git', 'dist', 'build', '.gemini'];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

class DocumentWatcher {
    constructor() {
        this.workspaceDir = null;
        this.watcher = null;
        this.debounceTimers = new Map();
    }

    start(workspaceDir) {
        if (!workspaceDir || !fs.existsSync(workspaceDir)) return;
        
        this.stop(); // Stop previous watcher if exists
        this.workspaceDir = workspaceDir;
        
        Logger.info(`[DocumentWatcher] Starting auto-sync for workspace: ${workspaceDir}`);
        
        // Initial scan of workspace
        this.scanDirectory(workspaceDir);

        // Start filesystem watcher
        try {
            this.watcher = fs.watch(workspaceDir, { recursive: true }, (eventType, filename) => {
                if (!filename) return;
                
                const ext = path.extname(filename).toLowerCase();
                if (!WATCHED_EXTS.includes(ext)) return;
                
                // Ignore excluded dirs
                const parts = filename.split(path.sep);
                if (parts.some(p => EXCLUDED_DIRS.includes(p))) return;

                const fullPath = path.join(workspaceDir, filename);
                
                // Debounce events
                if (this.debounceTimers.has(fullPath)) {
                    clearTimeout(this.debounceTimers.get(fullPath));
                }
                
                this.debounceTimers.set(fullPath, setTimeout(() => {
                    this.debounceTimers.delete(fullPath);
                    this.handleFileChange(fullPath);
                }, 1000)); // wait 1s after last change
            });
        } catch (err) {
            Logger.warn(`[DocumentWatcher] Could not start file watcher: ${err.message}`);
        }
    }

    stop() {
        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
        }
        for (const timer of this.debounceTimers.values()) {
            clearTimeout(timer);
        }
        this.debounceTimers.clear();
    }

    async handleFileChange(fullPath) {
        if (!fs.existsSync(fullPath)) {
            // File was deleted. We should theoretically remove it from vector_store,
            // but for simplicity we'll just log it.
            Logger.debug(`[DocumentWatcher] File deleted: ${fullPath}`);
            return;
        }

        try {
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) return;
            if (stat.size > MAX_FILE_SIZE) {
                Logger.warn(`[DocumentWatcher] Skipping large file: ${fullPath}`);
                return;
            }

            Logger.debug(`[DocumentWatcher] Auto-syncing file change: ${fullPath}`);
            await vectorStore.ingestFile(fullPath);
        } catch (err) {
            Logger.error(`[DocumentWatcher] Failed to handle change for ${fullPath}: ${err.message}`);
        }
    }

    scanDirectory(dir) {
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory() && EXCLUDED_DIRS.includes(entry.name)) continue;
                
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    this.scanDirectory(fullPath);
                } else {
                    const ext = path.extname(entry.name).toLowerCase();
                    if (WATCHED_EXTS.includes(ext)) {
                        const stat = fs.statSync(fullPath);
                        if (stat.size <= MAX_FILE_SIZE) {
                            // Check if already embedded (very simple check using file path as source)
                            const isEmbedded = vectorStore.store.some(item => item.metadata.path === fullPath);
                            if (!isEmbedded) {
                                Logger.info(`[DocumentWatcher] Initial ingestion of new file: ${entry.name}`);
                                vectorStore.ingestFile(fullPath).catch(e => 
                                    Logger.error(`[DocumentWatcher] Ingest error for ${entry.name}: ${e.message}`)
                                );
                            }
                        }
                    }
                }
            }
        } catch (err) {
            Logger.error(`[DocumentWatcher] Scan error in ${dir}: ${err.message}`);
        }
    }
}

export const documentWatcher = new DocumentWatcher();
export default DocumentWatcher;
