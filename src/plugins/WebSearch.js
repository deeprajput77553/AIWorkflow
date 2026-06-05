// src/plugins/WebSearch.js
// Wikipedia search plugin

export default {
    name:        'websearch',
    description: 'Searches Wikipedia for a topic. Params: { topic: string }',
    schema: {
        topic: { type: 'string', required: true, description: 'The topic to search Wikipedia for' }
    },
    async execute({ topic }) {
        console.log(`[Plugin: WebSearch] @ Searching Wikipedia: "${topic}"`);
        try {
            const url  = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(topic)}&utf8=&format=json`;
            const res  = await fetch(url);
            const data = await res.json();
            const hits = data.query?.search?.slice(0, 3) || [];
            if (!hits.length) return `No Wikipedia results found for "${topic}".`;
            const snips = hits.map(r => `**${r.title}**: ${r.snippet.replace(/<\/?[^>]+(>|$)/g, '')}`).join('\n\n');
            return `Wikipedia results for "${topic}":\n\n${snips}`;
        } catch (e) {
            return `WebSearch error: ${e.message}`;
        }
    }
};
