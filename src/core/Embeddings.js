// src/core/Embeddings.js
// Interfaces with Ollama for vector embeddings and provides cosine similarity math

import Logger from '../utils/Logger.js';

const OLLAMA_EMBED_URL = 'http://127.0.0.1:11434/api/embeddings';
const EMBED_MODEL = 'nomic-embed-text'; // Typical fast embedding model

export async function getEmbedding(text, model = EMBED_MODEL) {
    if (!text || typeof text !== 'string') return null;
    try {
        const res = await fetch(OLLAMA_EMBED_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, prompt: text })
        });
        if (!res.ok) {
            // Silently fail, ContextManager will fallback to keyword overlap
            return null;
        }
        const data = await res.json();
        return data.embedding || null;
    } catch (err) {
        return null;
    }
}

/**
 * Calculates the cosine similarity between two vector arrays.
 * Returns a value between -1.0 and 1.0 (1.0 = identical).
 */
export function cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
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
