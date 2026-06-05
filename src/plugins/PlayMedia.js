// src/plugins/PlayMedia.js
// Custom Media Player Plugin for Aria

import { bus, AGENT_EVENTS } from '../core/EventBus.js';

export default {
    name: 'playmedia',
    description: 'Plays a song or video. Can take a search query or a direct URL. Params: { query: string, type?: "music"|"video", artist?: string }',
    schema: {
        query: { type: 'string', required: true, description: 'The song title, video title, search query, or URL' },
        type: { type: 'string', required: false, description: 'Type of media: "music" or "video"' },
        artist: { type: 'string', required: false, description: 'Artist name (helps with finding lyrics)' }
    },
    async execute({ query, type = 'music', artist = '' }) {
        console.log(`[Plugin: PlayMedia] Processing: "${query}" (Artist: ${artist}, Type: ${type})`);
        
        let sourceType = 'youtube';
        let sourceUrl = '';
        let title = query;

        // 1. Check if the query is a URL
        const urlRegex = /^(https?:\/\/[^\s]+)/i;
        if (urlRegex.test(query.trim())) {
            const url = query.trim();
            const ytMatch = url.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i);
            if (ytMatch) {
                sourceType = 'youtube';
                sourceUrl = ytMatch[1];
                title = `YouTube Video (${sourceUrl})`;
            } else {
                sourceType = 'direct_video';
                sourceUrl = url;
                title = url.split('/').pop() || 'Direct Video';
            }
        } else {
            // It's a search query, search YouTube for the first video ID
            try {
                console.log(`[Plugin: PlayMedia] Searching YouTube for: "${query}"`);
                const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
                const response = await fetch(searchUrl, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' }
                });
                const html = await response.text();
                
                // YouTube search result videoIds are embedded in the ytInitialData JSON inside the page.
                // We can extract them using a regex search for "/watch?v=XXXXXXXXXXX"
                const videoIdMatches = html.match(/\/watch\?v=([a-zA-Z0-9_-]{11})/g);
                if (videoIdMatches && videoIdMatches.length > 0) {
                    // Extract the 11 character ID
                    sourceUrl = videoIdMatches[0].split('v=')[1];
                    console.log(`[Plugin: PlayMedia] Found YouTube Video ID: ${sourceUrl}`);
                } else {
                    throw new Error('No YouTube search results matched.');
                }
            } catch (err) {
                console.error(`[Plugin: PlayMedia] YouTube search scrape failed: ${err.message}`);
                // Fallback: Use search embed listType
                sourceUrl = query; 
            }
        }

        // 2. Lyrics Retrieval (Only for music)
        let lyrics = '';
        if (type === 'music') {
            // First, try local Ollama to generate SYNCED (LRC) lyrics
            try {
                console.log(`[Plugin: PlayMedia] Generating synced LRC lyrics via local Ollama...`);
                const ollamaPrompt = `You are a music lyrics repository. Generate the complete, correct lyrics for the song "${title}"${artist ? ` by "${artist}"` : ''} in LRC format (with [mm:ss] timestamps at the start of each line representing the progress of the song).
Rules:
1. Output ONLY the raw LRC lines (e.g. "[00:08] The club isn't the best place...").
2. Do not include markdown code blocks, intro/outro text, headers, chords, or explanations.
3. If you do not know the lyrics, output only "Lyrics not found".`;
                
                const res = await fetch('http://127.0.0.1:11434/api/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: 'qwen2.5-coder:7b',
                        messages: [{ role: 'user', content: ollamaPrompt }],
                        stream: false
                    })
                });
                if (res.ok) {
                    const data = await res.json();
                    const content = data.message?.content?.trim();
                    if (content && content !== 'Lyrics not found' && content.includes('[')) {
                        lyrics = content;
                        console.log(`[Plugin: PlayMedia] Synced LRC lyrics generated via Ollama.`);
                    }
                }
            } catch (err) {
                console.warn(`[Plugin: PlayMedia] Ollama synced lyrics generation failed: ${err.message}`);
            }

            // Fallback: Try lyrics.ovh if Ollama lyrics generation failed or returned unsynced lyrics
            if (!lyrics && artist) {
                try {
                    console.log(`[Plugin: PlayMedia] Falling back: Fetching lyrics from lyrics.ovh...`);
                    const lyricsRes = await fetch(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title.replace(/\([^)]*\)/g, '').trim())}`);
                    const lyricsData = await lyricsRes.json();
                    if (lyricsData && lyricsData.lyrics) {
                        lyrics = lyricsData.lyrics;
                        console.log(`[Plugin: PlayMedia] Lyrics fetched successfully from lyrics.ovh.`);
                    }
                } catch (err) {
                    console.warn(`[Plugin: PlayMedia] lyrics.ovh failed: ${err.message}`);
                }
            }
            
            // Second Fallback: Query Ollama for plain lyrics if still empty
            if (!lyrics) {
                try {
                    console.log(`[Plugin: PlayMedia] Falling back: Fetching plain lyrics from Ollama...`);
                    const ollamaPrompt = `You are a lyrics repository. Output ONLY the complete, correct lyrics for the song "${title}"${artist ? ` by "${artist}"` : ''}. Do not write metadata, intro, comments, markdown tags, or chords. If you do not know the lyrics, output only "Lyrics not found".`;
                    const res = await fetch('http://127.0.0.1:11434/api/chat', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            model: 'qwen2.5-coder:7b',
                            messages: [{ role: 'user', content: ollamaPrompt }],
                            stream: false
                        })
                    });
                    if (res.ok) {
                        const data = await res.json();
                        const content = data.message?.content?.trim();
                        if (content && content !== 'Lyrics not found') {
                            lyrics = content;
                            console.log(`[Plugin: PlayMedia] Plain lyrics generated via Ollama.`);
                        }
                    }
                } catch (err) {
                    console.warn(`[Plugin: PlayMedia] Ollama plain lyrics fallback failed: ${err.message}`);
                }
            }
        }

        // 3. Emit the event to EventBus
        const payload = {
            title,
            artist: artist || 'Unknown Artist',
            sourceType,
            sourceUrl,
            lyrics: lyrics || 'Lyrics not found for this song.'
        };
        
        bus.emit(AGENT_EVENTS.PLAY_MEDIA, payload);
        
        return `Successfully sent request to play "${title}" on the dashboard.${lyrics ? ' Loaded lyrics.' : ' Lyrics not found.'}`;
    }
};
