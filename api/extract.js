export const config = {
    runtime: 'edge',
};

const CRAWLER_URL = 'https://web-crawler-pink.vercel.app/api/crawler';
const EXTRACTOR_URL = 'https://content-tacker.vercel.app/api/extract';

// Increased to 28 seconds. Gives maximum time before Vercel's 30s hard limit.
const TOTAL_TIMEOUT_MS = 28000; 

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json'
};

// Helper: Fetch with a localized timeout so one bad request doesn't hang the loop
async function fetchWithTimeout(resource, options = {}, timeoutMs, globalSignal) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    
    // If the global timeout fires, abort this local fetch too
    if (globalSignal) {
        globalSignal.addEventListener('abort', () => controller.abort());
    }
    
    try {
        const response = await fetch(resource, { ...options, signal: controller.signal });
        clearTimeout(id);
        return response;
    } catch (error) {
        clearTimeout(id);
        throw error;
    }
}

// Step 1: Perform the search
async function performSearch(query, count, signal) {
    const targetUrl = `${CRAWLER_URL}?query=${encodeURIComponent(query)}&count=${count}`;
    
    try {
        // Generous 10-second timeout for the search phase
        const res = await fetchWithTimeout(targetUrl, {
            method: 'GET',
            headers: { 'Accept': 'application/json' }
        }, 10000, signal); 
        
        if (!res.ok) throw new Error(`Crawler API returned status: ${res.status}`);
        const data = await res.json();
        return data;
    } catch (err) {
        if (err.name === 'AbortError') throw new Error('Search phase timed out.');
        throw err;
    }
}

// Step 2: Extract content (Delegating entirely to the robust content-tacker)
async function extractContent(url, signal) {
    const startTime = Date.now();

    try {
        const targetUrl = `${EXTRACTOR_URL}?url=${encodeURIComponent(url)}`;
        
        // Massive 25-second timeout. We let content-tacker do all the heavy lifting, 
        // proxies, and fallbacks without interrupting it prematurely.
        const res = await fetchWithTimeout(targetUrl, {
            method: 'GET',
            headers: { 'Accept': 'application/json' }
        }, 25000, signal); 
        
        const data = await res.json();
        
        if (!data.success) {
            return { 
                url, 
                success: false, 
                content: null, 
                error: data.error, 
                debug: data.debug, 
                latency: Date.now() - startTime 
            };
        }
        
        return { 
            url, 
            success: true, 
            content: data.text, 
            debug: data.debug, 
            latency: Date.now() - startTime 
        };
    } catch (err) {
        return {
            url, 
            success: false, 
            content: null,
            error: err.name === 'AbortError' ? 'Extraction timeout exceeded (Took longer than 25s).' : err.message,
            debug: { method: "None", errors: [err.message] }, 
            latency: Date.now() - startTime
        };
    }
}

export default async function handler(req) {
    // 1. Handle CORS Preflight Requests
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // 2. Global Abort Controller to ensure we return safely before Vercel kills the function
    const controller = new AbortController();
    const globalTimeoutId = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS);
    const startOverallTime = Date.now();

    try {
        let input = {};
        if (req.method === 'POST') {
            input = await req.json();
        } else {
            const urlObj = new URL(req.url);
            input = Object.fromEntries(urlObj.searchParams.entries());
        }

        const action = input.action || 'auto'; 
        const count = parseInt(input.count || 20, 10);
        
        let finalPayload = { 
            success: true, action, results: [], failed_extractions: 0, total_time_ms: 0 
        };

        if (action === 'search' || action === 'auto') {
            if (!input.query) throw new Error("Missing 'query' parameter.");
            
            const searchData = await performSearch(input.query, count, controller.signal);
            let searchResults = searchData.results || [];
            
            if (action === 'search') {
                finalPayload.results = searchResults;
            } 
            
            if (action === 'auto') {
                // Fire all extraction requests to content-tacker simultaneously
                const extractionPromises = searchResults.map(async (res) => {
                    const ext = await extractContent(res.url, controller.signal);
                    if (!ext.success) finalPayload.failed_extractions++;
                    return { ...res, extraction: ext };
                });
                
                finalPayload.results = await Promise.all(extractionPromises);
            }
        } 
        else if (action === 'extract') {
            if (!input.urls || !Array.isArray(input.urls)) {
                throw new Error("Missing 'urls' array parameter.");
            }
            const extractionPromises = input.urls.map(async (url) => {
                const ext = await extractContent(url, controller.signal);
                if (!ext.success) finalPayload.failed_extractions++;
                return { url, extraction: ext };
            });
            finalPayload.results = await Promise.all(extractionPromises);
        } else {
            throw new Error("Invalid action. Use 'auto', 'search', or 'extract'.");
        }

        clearTimeout(globalTimeoutId);
        finalPayload.total_time_ms = Date.now() - startOverallTime;

        return new Response(JSON.stringify(finalPayload), { status: 200, headers: CORS_HEADERS });

    } catch (err) {
        clearTimeout(globalTimeoutId);
        return new Response(JSON.stringify({
            success: false,
            error: err.name === 'AbortError' ? 'Global timeout reached. The request was safely halted to prevent server crash.' : err.message,
            total_time_ms: Date.now() - startOverallTime
        }), { status: 200, headers: CORS_HEADERS });
    }
}
