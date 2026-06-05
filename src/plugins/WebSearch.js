// src/plugins/WebSearch.js
// Open Web Search and Content Scraper Plugin

import * as cheerio from 'cheerio';

export default {
    name:        'websearch',
    description: 'Searches the open web for a query and scrapes the top results for context. Params: { topic: string }',
    schema: {
        topic: { type: 'string', required: true, description: 'The search query or topic to search' }
    },
    async execute({ topic }) {
        console.log(`[Plugin: WebSearch] @ Searching the open web for: "${topic}"`);
        try {
            // 1. Query DuckDuckGo HTML search
            const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(topic)}`;
            const response = await fetch(searchUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
                }
            });
            if (!response.ok) throw new Error(`DuckDuckGo returned HTTP ${response.status}`);
            
            const html = await response.text();
            const $ = cheerio.load(html);
            const searchResults = [];

            $('.result__snippet').each((i, el) => {
                if (i >= 3) return; // Top 3 results
                const parent = $(el).closest('.result');
                const titleEl = parent.find('.result__title a');
                const title = titleEl.text().trim();
                const href = titleEl.attr('href');
                const snippet = $(el).text().trim();

                let realUrl = href;
                if (href) {
                    try {
                        let parsedHref = href;
                        if (href.startsWith('//')) {
                            parsedHref = 'https:' + href;
                        } else if (href.startsWith('/l/?')) {
                            parsedHref = 'https://duckduckgo.com' + href;
                        }
                        const urlObj = new URL(parsedHref);
                        if (urlObj.searchParams.has('uddg')) {
                            realUrl = urlObj.searchParams.get('uddg');
                        } else if (parsedHref.startsWith('http')) {
                            realUrl = parsedHref;
                        }
                    } catch (e) {}
                }
                if (realUrl) {
                    searchResults.push({ title, url: realUrl, snippet });
                }
            });

            if (!searchResults.length) {
                return `No web search results found for "${topic}".`;
            }

            console.log(`[Plugin: WebSearch] Found ${searchResults.length} results. Scraping top result: ${searchResults[0].url}`);
            
            // 2. Scrape the content of the top search result
            let scrapedContent = '';
            try {
                const scrapeRes = await fetch(searchResults[0].url, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
                    },
                    signal: AbortSignal.timeout(7000) // 7s timeout
                });
                
                if (scrapeRes.ok) {
                    const scrapeHtml = await scrapeRes.text();
                    const s$ = cheerio.load(scrapeHtml);
                    
                    // Clean page boilerplate
                    s$('script, style, nav, footer, header, noscript, iframe, .sidebar, .menu, #footer, #header').remove();
                    
                    let bodyText = s$('body').text();
                    bodyText = bodyText.replace(/\r\n/g, '\n');
                    bodyText = bodyText.split('\n')
                        .map(line => line.replace(/\s+/g, ' ').trim())
                        .filter(line => line.length > 15) // ignore small lines
                        .slice(0, 150) // limit page lines
                        .join('\n\n');
                    
                    scrapedContent = bodyText.slice(0, 4000); // Max 4000 characters
                }
            } catch (err) {
                console.warn(`[Plugin: WebSearch] Scraping top result failed: ${err.message}`);
            }

            // 3. Construct response context for the AI
            let resultSummary = `Web Search results for "${topic}":\n\n`;
            searchResults.forEach((r, idx) => {
                resultSummary += `[${idx + 1}] Title: ${r.title}\nURL: ${r.url}\nSummary: ${r.snippet}\n\n`;
            });

            if (scrapedContent) {
                resultSummary += `=== Detailed Content Scraped from [1] (${searchResults[0].url}) ===\n${scrapedContent}`;
            } else {
                resultSummary += `(Could not scrape detailed content from top result. Relying on snippets)`;
            }

            return resultSummary;
        } catch (e) {
            return `WebSearch error: ${e.message}`;
        }
    }
};
