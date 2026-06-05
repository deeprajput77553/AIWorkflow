import * as cheerio from 'cheerio';
import Logger from './Logger.js';
import { vectorStore } from '../core/VectorStore.js';

export class WebCrawler {
    constructor() {
        this.visited = new Set();
        this.queue = [];
    }

    /**
     * Crawls a website starting from startUrl and recursively/iteratively visits pages on the same domain up to maxPages.
     * @param {string} startUrl The entry point URL.
     * @param {number} maxPages The maximum number of pages to crawl.
     */
    async crawl(startUrl, maxPages = 10) {
        this.visited.clear();
        this.queue = [startUrl];
        
        let parsedStartUrl;
        try {
            parsedStartUrl = new URL(startUrl);
        } catch (err) {
            Logger.error(`[WebCrawler] Invalid starting URL: ${startUrl}`);
            throw new Error(`Invalid URL: ${startUrl}`);
        }

        const domain = parsedStartUrl.hostname;
        const protocol = parsedStartUrl.protocol; // http: or https:
        let pagesCrawled = 0;

        Logger.info(`[WebCrawler] Starting crawl of domain: ${domain} (Limit: ${maxPages} pages)`);

        while (this.queue.length > 0 && pagesCrawled < maxPages) {
            const currentUrl = this.queue.shift();

            // Normalise URL to prevent subtle duplication (remove hash, trailing slash)
            let normalizedUrl;
            try {
                const urlObj = new URL(currentUrl);
                urlObj.hash = ''; // strip fragment
                if (urlObj.pathname.endsWith('/') && urlObj.pathname.length > 1) {
                    urlObj.pathname = urlObj.pathname.slice(0, -1);
                }
                normalizedUrl = urlObj.toString();
            } catch {
                continue; // Skip invalid urls
            }

            if (this.visited.has(normalizedUrl)) {
                continue;
            }

            this.visited.add(normalizedUrl);
            pagesCrawled++;

            Logger.info(`[WebCrawler] [${pagesCrawled}/${maxPages}] Fetching: ${normalizedUrl}`);

            try {
                const response = await fetch(normalizedUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
                    },
                    signal: AbortSignal.timeout(10000) // 10s timeout
                });

                if (!response.ok) {
                    Logger.warn(`[WebCrawler] Failed to fetch ${normalizedUrl}: ${response.statusText} (${response.status})`);
                    continue;
                }

                const contentType = response.headers.get('content-type');
                if (!contentType || !contentType.includes('text/html')) {
                    Logger.warn(`[WebCrawler] Skipping non-HTML page: ${normalizedUrl} (Content-Type: ${contentType})`);
                    continue;
                }

                const html = await response.text();
                const $ = cheerio.load(html);

                // 1. Extract and Clean Text Content
                // Remove interactive or boilerplate elements
                $('script, style, nav, footer, header, noscript, iframe, .sidebar, .menu, #sidebar, #footer, #header').remove();
                
                const title = $('title').text().trim() || 'Untitled Page';
                let bodyText = $('body').text();
                // Normalize newlines and clean whitespace while preserving paragraph structure
                bodyText = bodyText.replace(/\r\n/g, '\n');
                bodyText = bodyText.split('\n')
                    .map(line => line.replace(/[ \t]+/g, ' ').trim())
                    .filter(line => line.length > 0)
                    .join('\n');
                bodyText = bodyText.replace(/\n{3,}/g, '\n\n');

                if (bodyText) {
                    // Prepend page title to text for better embedding context
                    const fullText = `Page Title: ${title}\nURL: ${normalizedUrl}\n\nContent:\n${bodyText}`;
                    Logger.info(`[WebCrawler] Ingesting page: "${title}" (${bodyText.length} chars)`);
                    
                    // Ingest to vector store
                    await vectorStore.ingestText(fullText, {
                        source: normalizedUrl,
                        type: 'url',
                        url: normalizedUrl,
                        title: title
                    });
                } else {
                    Logger.warn(`[WebCrawler] Empty content extracted from ${normalizedUrl}`);
                }

                // 2. Discover and Queue Links
                if (pagesCrawled < maxPages) {
                    const links = $('a');
                    links.each((_, el) => {
                        const href = $(el).attr('href');
                        if (!href) return;

                        try {
                            // Resolve relative URL
                            const resolvedUrl = new URL(href, normalizedUrl);
                            
                            // Filter conditions
                            const isSameDomain = resolvedUrl.hostname === domain;
                            const isHttp = resolvedUrl.protocol === 'http:' || resolvedUrl.protocol === 'https:';
                            
                            // Exclude common static resource extensions
                            const extMatch = resolvedUrl.pathname.match(/\.(png|jpe?g|gif|svg|pdf|zip|gz|tar|mp4|mp3|docx?|xlsx?|pptx?|css|js)$/i);
                            const isAsset = !!extMatch;

                            if (isSameDomain && isHttp && !isAsset) {
                                resolvedUrl.hash = ''; // strip fragment
                                const linkStr = resolvedUrl.toString();
                                if (!this.visited.has(linkStr) && !this.queue.includes(linkStr)) {
                                    this.queue.push(linkStr);
                                }
                            }
                        } catch {
                            // Invalid URL format inside href, ignore
                        }
                    });
                }

            } catch (err) {
                Logger.error(`[WebCrawler] Error crawling ${normalizedUrl}: ${err.message}`);
            }
        }

        Logger.success(`[WebCrawler] Completed crawling. Successfully processed ${pagesCrawled} page(s).`);
        return pagesCrawled;
    }
}

export const webCrawler = new WebCrawler();
export default WebCrawler;
