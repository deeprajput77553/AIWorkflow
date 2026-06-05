import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import mammoth from 'mammoth';
import * as cheerio from 'cheerio';
import Logger from '../utils/Logger.js';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.join(__dirname, '..', '..');
const STORE_PATH = path.join(SERVER_DIR, 'vector_store.json');

const OLLAMA_URL = 'http://127.0.0.1:11434';
const EMBED_MODEL = 'nomic-embed-text';

function cosineSimilarity(vecA, vecB) {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

class VectorStore {
    constructor() {
        this.store = [];
        this.loadStore();
    }

    loadStore() {
        if (fs.existsSync(STORE_PATH)) {
            try {
                this.store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
                Logger.info(`[VectorStore] Loaded ${this.store.length} embedded chunks.`);
            } catch (err) {
                Logger.error('[VectorStore] Failed to parse vector_store.json. Creating new.');
                this.store = [];
            }
        }
    }

    saveStore() {
        try {
            fs.writeFileSync(STORE_PATH, JSON.stringify(this.store, null, 2));
            Logger.debug(`[VectorStore] Saved ${this.store.length} chunks to disk.`);
        } catch (err) {
            Logger.error('[VectorStore] Failed to save store:', err.message);
        }
    }

    async getEmbedding(text) {
        try {
            const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: EMBED_MODEL, prompt: text })
            });
            if (!res.ok) {
                if (res.status === 404) {
                    throw new Error(`Model '${EMBED_MODEL}' not found. Please run: /pull ${EMBED_MODEL}`);
                }
                throw new Error(`Ollama API error: ${res.statusText}`);
            }
            const data = await res.json();
            return data.embedding;
        } catch (err) {
            throw new Error(`Embedding failed: ${err.message}`);
        }
    }

    chunkText(text, source) {
        // First, normalize line breaks to standard paragraphs
        const paragraphs = text.split(/\n\s*\n/);
        const chunks = [];
        let currentChunk = '';
        const maxChunkSize = 1500;

        const addChunk = (chunk) => {
            const trimmed = chunk.trim();
            if (trimmed) chunks.push(trimmed);
        };

        for (const p of paragraphs) {
            const cleanP = p.trim();
            if (!cleanP) continue;

            // If the paragraph itself fits, or is just slightly over, handle normally
            if (cleanP.length <= maxChunkSize) {
                if (currentChunk.length + cleanP.length + 2 > maxChunkSize) {
                    addChunk(currentChunk);
                    currentChunk = cleanP;
                } else {
                    currentChunk = currentChunk ? currentChunk + '\n\n' + cleanP : cleanP;
                }
            } else {
                // If current accumulated chunk is not empty, flush it
                if (currentChunk) {
                    addChunk(currentChunk);
                    currentChunk = '';
                }

                // Split large paragraph into sentences
                const sentences = cleanP.split(/(?<=[.!?])\s+/);
                for (const sentence of sentences) {
                    const cleanSentence = sentence.trim();
                    if (!cleanSentence) continue;

                    if (currentChunk.length + cleanSentence.length + 1 > maxChunkSize) {
                        if (currentChunk) addChunk(currentChunk);
                        
                        // If a single sentence is still larger than maxChunkSize, hard split it
                        if (cleanSentence.length > maxChunkSize) {
                            let start = 0;
                            while (start < cleanSentence.length) {
                                addChunk(cleanSentence.slice(start, start + maxChunkSize));
                                start += maxChunkSize;
                            }
                            currentChunk = '';
                        } else {
                            currentChunk = cleanSentence;
                        }
                    } else {
                        currentChunk = currentChunk ? currentChunk + ' ' + cleanSentence : cleanSentence;
                    }
                }
            }
        }
        if (currentChunk) addChunk(currentChunk);
        return chunks;
    }

    async ingestText(text, metadata) {
        // Remove existing chunks for this source to avoid duplication
        this.store = this.store.filter(item => item.metadata.source !== metadata.source);
        
        const chunks = this.chunkText(text, metadata.source);
        if (chunks.length === 0) return;

        Logger.info(`[VectorStore] Embedding ${chunks.length} chunks from ${metadata.source}...`);
        
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const vector = await this.getEmbedding(chunk);
            this.store.push({
                text: chunk,
                vector,
                metadata: {
                    ...metadata,
                    chunkIndex: i,
                    totalChunks: chunks.length,
                    timestamp: Date.now()
                }
            });
        }
        
        this.saveStore();
        Logger.success(`[VectorStore] Successfully ingested ${metadata.source}`);
    }

    async ingestFile(filePath) {
        try {
            const ext = path.extname(filePath).toLowerCase();
            let text = '';
            
            if (ext === '.pdf') {
                const dataBuffer = fs.readFileSync(filePath);
                const data = await pdfParse(dataBuffer);
                text = data.text;
            } else if (ext === '.docx') {
                const result = await mammoth.extractRawText({ path: filePath });
                text = result.value;
            } else if (ext === '.txt' || ext === '.md' || ext === '.js' || ext === '.py' || ext === '.json') {
                text = fs.readFileSync(filePath, 'utf-8');
            } else {
                Logger.warn(`[VectorStore] Unsupported file type: ${ext}`);
                return;
            }

            if (!text.trim()) {
                Logger.warn(`[VectorStore] Extracted empty text from ${filePath}`);
                return;
            }

            await this.ingestText(text, { source: path.basename(filePath), type: 'file', path: filePath });
        } catch (err) {
            Logger.error(`[VectorStore] Failed to ingest file ${filePath}: ${err.message}`);
            throw err;
        }
    }

    async ingestUrl(url) {
        try {
            const res = await fetch(url);
            const html = await res.text();
            const $ = cheerio.load(html);
            
            // Remove scripts, styles, etc.
            $('script, style, nav, footer, header').remove();
            let text = $('body').text();
            
            // Normalize newlines and clean whitespace while preserving paragraph structure
            text = text.replace(/\r\n/g, '\n');
            text = text.split('\n')
                .map(line => line.replace(/[ \t]+/g, ' ').trim())
                .filter(line => line.length > 0)
                .join('\n');
            text = text.replace(/\n{3,}/g, '\n\n');

            if (!text.trim()) {
                Logger.warn(`[VectorStore] Could not extract text from URL: ${url}`);
                return;
            }

            await this.ingestText(text, { source: url, type: 'url', url });
        } catch (err) {
            Logger.error(`[VectorStore] Failed to ingest URL ${url}: ${err.message}`);
            throw err;
        }
    }

    async search(query, topK = 3) {
        if (this.store.length === 0) return [];
        
        try {
            const queryVector = await this.getEmbedding(query);
            
            const scored = this.store.map(item => ({
                ...item,
                score: cosineSimilarity(queryVector, item.vector)
            }));
            
            scored.sort((a, b) => b.score - a.score);
            return scored.slice(0, topK);
        } catch (err) {
            Logger.error(`[VectorStore] Search failed: ${err.message}`);
            return [];
        }
    }
}

export const vectorStore = new VectorStore();
export default VectorStore;
