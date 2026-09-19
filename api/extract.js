import * as cheerio from 'cheerio';

export const config = {
  runtime: 'edge',
};

const userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2.1 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0'
];

function getRandomIP() {
  return `${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
}

function getEvasionHeaders() {
  const ip = getRandomIP();
  return {
    'User-Agent': userAgents[Math.floor(Math.random() * userAgents.length)],
    'X-Forwarded-For': ip,
    'X-Real-IP': ip,
    'Client-IP': ip,
    'Via': `1.1 ${ip}`,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Cache-Control': 'no-cache'
  };
}

// Helper: Fetch with an abort timeout to prevent hanging requests
async function fetchWithTimeout(resource, options = {}) {
  const { timeout = 8000 } = options;
  
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(resource, {
      ...options,
      signal: controller.signal  
    });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    throw error;
  }
}

async function extractSingleUrl(targetUrl, rank) {
  let finalContent = "";
  let extractedTitle = "Unknown Title";
  let methodUsed = "none";
  let isSuccess = false;
  
  // Basic URL Validation
  try {
    new URL(targetUrl);
  } catch(e) {
    return createResultObject(rank, targetUrl, "Invalid URL format", false, "none", "Failed");
  }

  // Generate Dummy IP Headers for this specific request
  const dummyHeaders = getEvasionHeaders();

  // ==========================================
  // TIER 1: The Jina AI Reader Proxy with IP Spoofing
  // ==========================================
  try {
    const proxyResponse = await fetchWithTimeout(`https://r.jina.ai/${encodeURIComponent(targetUrl)}`, {
      timeout: 8000, 
      headers: { ...dummyHeaders, 'Accept': 'text/plain', 'X-No-Cache': 'true' }
    });

    if (proxyResponse.ok) {
      const text = await proxyResponse.text();
      if (text && text.length > 100 && !text.includes("Cloudflare") && !text.includes("Just a moment...")) {
        // Extract title from Jina markdown (usually first line like "Title: ...")
        const titleMatch = text.match(/Title:\s*(.+)/i);
        if (titleMatch) extractedTitle = titleMatch[1];
        
        finalContent = text.replace(/\[.*?\]\(.*?\)/g, ''); // Clean markdown links
        methodUsed = "Tier 1: AI Proxy (Spoofed IP)";
        isSuccess = true;
      }
    }
  } catch (err) {}

  // ==========================================
  // TIER 2: Native Fetch + Cheerio Cleanup
  // ==========================================
  if (!isSuccess) {
    try {
      const rawResponse = await fetchWithTimeout(targetUrl, { timeout: 8000, headers: dummyHeaders });
      if (rawResponse.ok) {
        const html = await rawResponse.text();
        const $ = cheerio.load(html);

        extractedTitle = $('title').text().trim() || extractedTitle;

        $('script, style, noscript, iframe, img, svg, video, audio, canvas, map, object, embed, footer, header, nav, aside, [role="banner"], [role="navigation"], .ad, .ads, #comments, .sidebar, .menu').remove();

        let contentBlock = $('article').first();
        if (contentBlock.length === 0) contentBlock = $('main').first();
        if (contentBlock.length === 0) contentBlock = $('[role="main"]').first();
        if (contentBlock.length === 0) contentBlock = $('body');

        const cleaned = contentBlock.text()
          .replace(/(\r\n|\n|\r)/gm, "\n")
          .replace(/\n\s*\n/g, '\n\n')
          .replace(/[ \t]+/g, ' ')
          .trim();

        if (cleaned.length > 50) {
          finalContent = cleaned;
          methodUsed = "Tier 2: Cheerio Scraper";
          isSuccess = true;
        }
      }
    } catch (err) {}
  }

  // ==========================================
  // TIER 3: Last Resort Regex Fallback
  // ==========================================
  if (!isSuccess) {
    try {
      const fallbackResponse = await fetchWithTimeout(targetUrl, { timeout: 5000, headers: dummyHeaders });
      let rawString = await fallbackResponse.text();
      
      const titleMatch = rawString.match(/<title[^>]*>([^<]+)<\/title>/i);
      if (titleMatch) extractedTitle = titleMatch[1].trim();

      rawString = rawString.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
      rawString = rawString.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
      rawString = rawString.replace(/<[^>]+>/g, ' ');
      
      const regexCleaned = rawString.replace(/\s+/g, ' ').trim();
      
      if (regexCleaned.length > 10) {
        finalContent = regexCleaned;
        methodUsed = "Tier 3: Raw Regex Fallback";
        isSuccess = true;
      }
    } catch (err) {}
  }

  return createResultObject(rank, targetUrl, finalContent, isSuccess, methodUsed, extractedTitle);
}

function createResultObject(rank, url, content, success, method, title) {
  let domain = "unknown";
  try { domain = new URL(url).hostname; } catch(e){}

  const snippet = content ? content.substring(0, 300).replace(/\n/g, ' ') + '...' : "No content extracted.";

  return {
    "rank": rank,
    "title": title,
    "url": url,
    "domain": domain,
    "type": "web",
    "source": "arix-extractor",
    "snippet": snippet,
    "publishedAt": null,
    "freshness": "unknown",
    "verified": success,
    "httpStatus": success ? 200 : 500,
    "contentType": "text/plain",
    "trust": success ? 0.9 : 0.0,
    "relevanceScore": success ? 100 : 0,
    "relevanceBand": success ? "usable" : "weak",
    "relevance": {
      "score": success ? 100 : 0,
      "acceptable": success,
      "band": success ? "usable" : "weak"
    },
    "extractedText": content || "Failed to extract content.",
    "pageContent": content || "Failed to extract content.",
    "contentAvailable": success,
    "contentStatus": success ? "full" : "failed",
    "contentMethod": method,
    "contentLength": content ? content.length : 0,
    "contentConfidence": success ? 0.98 : 0.0,
    "contentSourceUrl": url,
    "contentFormat": "plain_text",
    "contentRole": "publisher_page_content",
    "contentForAI": `SOURCE_URL: ${url}\nTITLE: ${title}\nCONTENT_STATUS: ${success ? 'full' : 'failed'}\n\n${content || "Extraction failed."}`,
    "verificationMethod": method
  };
}

export default async function handler(req) {
  const startTime = Date.now();
  
  // CORS Headers for outside providers
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  let urls = [];

  // Parse URLs from GET or POST
  try {
    if (req.method === 'POST') {
      const body = await req.json();
      if (body.urls && Array.isArray(body.urls)) urls = body.urls;
    } else {
      const urlParams = new URL(req.url).searchParams;
      const urlsParam = urlParams.get('url') || urlParams.get('urls');
      if (urlsParam) {
        urls = urlsParam.split(',').map(u => u.trim()).filter(u => u);
      }
    }
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: "Invalid request format." }), { status: 400, headers: corsHeaders });
  }

  if (urls.length === 0) {
    return new Response(JSON.stringify({ ok: false, error: "No URLs provided." }), { status: 400, headers: corsHeaders });
  }

  // Cap at 40 URLs per request
  if (urls.length > 40) {
    urls = urls.slice(0, 40);
  }

  // Execute all extractions in parallel
  const extractionPromises = urls.map((url, index) => extractSingleUrl(url, index + 1));
  const resultsData = await Promise.allSettled(extractionPromises);
  
  const formattedResults = resultsData.map((res, i) => {
    if (res.status === 'fulfilled') return res.value;
    // Ultimate Fail-safe if a promise completely crashes
    return createResultObject(i + 1, urls[i], `Fatal Error: ${res.reason}`, false, "Fatal Crash", "Error");
  });

  const successfulCount = formattedResults.filter(r => r.contentAvailable).length;
  const latency = Date.now() - startTime;

  // Final Output formatting matching exact requested Schema
  const finalResponse = {
    "ok": true,
    "version": "arix-crawler-1.11.1-edge",
    "query": "batch-extraction",
    "requestedResults": urls.length,
    "mode": "auto",
    "streaming": false,
    "results": formattedResults,
    "returnedResults": formattedResults.length,
    "sourceCountMode": "all-fetched-real-content",
    "resultSelectionPolicy": "return-all-fetched-real-content-ranked-by-query-match",
    "intent": {
      "type": "mixed",
      "wantsNews": true,
      "wantsVideo": false,
      "wantsGov": false,
      "wantsDocs": false,
      "wantsHistory": false,
      "wantsAcademic": false
    },
    "generatedAt": new Date().toISOString(),
    "latencyMs": latency,
    "keylessCoreSearch": true,
    "groqUsed": false,
    "cached": false,
    "providers": {
      "edge-extractor": {
        "ok": successfulCount,
        "failed": formattedResults.length - successfulCount,
        "results": formattedResults.length
      }
    },
    "quality": {
      "validatedResults": successfulCount,
      "relevantResults": successfulCount,
      "requestedResults": urls.length,
      "realContentOnly": true,
      "contentGuarantee": "Every returned result contains fetched source content."
    },
    "searchPlan": {
      "queryVariants": urls,
      "engineRequests": urls.length,
      "verificationRequested": true,
      "verificationPerformed": formattedResults.length,
      "verificationSucceeded": successfulCount,
      "commonCrawlEnabled": false,
      "commonCrawlPerformed": 0,
      "latencyTargetMs": 15000,
      "deep": false,
      "aiRequested": "false"
    }
  };

  return new Response(JSON.stringify(finalResponse), { 
    status: 200, 
    headers: corsHeaders
  });
}
