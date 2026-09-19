import * as cheerio from 'cheerio';

export const config = {
  runtime: 'edge',
};

// Bypassing IP-based rate limiting & Jina 403 blocks by rotating believable Public IP ranges
function getRandomIP() {
    const validFirstOctets = [8, 12, 17, 23, 34, 45, 50, 67, 72, 80, 99, 104, 142, 168, 173, 198, 203];
    const first = validFirstOctets[Math.floor(Math.random() * validFirstOctets.length)];
    return `${first}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
}

// Randomizing User-Agents to prevent bot detection blocking
function getRandomUserAgent() {
    const uas = [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0",
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36"
    ];
    return uas[Math.floor(Math.random() * uas.length)];
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

export default async function handler(req) {
  const urlParams = new URL(req.url).searchParams;
  const targetUrl = urlParams.get('url');

  // Validate URL
  if (!targetUrl) {
    return new Response(JSON.stringify({ 
      success: false, 
      error: "Missing URL parameter.", 
      text: "Please provide a valid URL." 
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    new URL(targetUrl); // Validate URL format
  } catch (e) {
    return new Response(JSON.stringify({ 
      success: false, 
      error: "Invalid URL format.", 
      text: "The provided link is not a valid URL format." 
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  let finalContent = "";
  let methodUsed = "none";
  let errors = [];

  const spoofedIP = getRandomIP();
  const userAgent = getRandomUserAgent();
  
  // Multiple fallback Jina endpoints to ensure 100% reliability
  const jinaEndpoints = [
      `https://r.jina.ai/${targetUrl}`,
      `https://s.jina.ai/${targetUrl}`
  ];

  for (const jinaUrl of jinaEndpoints) {
      if (finalContent) break;
      try {
          const proxyResponse = await fetchWithTimeout(jinaUrl, {
              timeout: 6000,
              headers: {
                  'Accept': 'text/plain, */*',
                  'X-No-Cache': 'true',
                  'X-Return-Format': 'markdown',
                  'User-Agent': userAgent,
                  'X-Forwarded-For': spoofedIP,
                  'X-Real-IP': spoofedIP,
                  'Client-IP': spoofedIP,
                  'Referer': 'https://www.google.com/',
                  'Accept-Language': 'en-US,en;q=0.9'
              }
          });

          if (proxyResponse.ok) {
              const text = await proxyResponse.text();
              if (text && text.length > 80 && !text.includes("Cloudflare") && !text.includes("Just a moment...") && !text.includes("403 Forbidden")) {
                  finalContent = text.replace(/\[.*?\]\(.*?\)/g, ''); // Strip markdown links for cleaner text
                  methodUsed = "Tier 1: AI Proxy (Fail-safe Bypassed)";
                  break;
              } else {
                  throw new Error(`Proxy returned blocked/empty response (Status: ${proxyResponse.status})`);
              }
          } else {
              throw new Error(`Proxy failed with status: ${proxyResponse.status}`);
          }
      } catch (err) {
          errors.push(`Tier 1 (${jinaUrl}) Failed: ${err.message}`);
      }
  }

  if (!finalContent) {
    try {
      const rawResponse = await fetchWithTimeout(targetUrl, {
        timeout: 8000,
        headers: {
          'User-Agent': userAgent,
          'X-Forwarded-For': spoofedIP
        }
      });

      if (!rawResponse.ok) {
         throw new Error(`Target host returned status: ${rawResponse.status}`);
      }

      const html = await rawResponse.text();
      const $ = cheerio.load(html);

      // Remove bloat aggressively
      $('script, style, noscript, iframe, img, svg, video, audio, canvas, map, object, embed, footer, header, nav, aside, [role="banner"], [role="navigation"], .ad, .ads, #comments, .comments, .sidebar, .menu').remove();

      // Try to find the main article, otherwise grab the body
      let contentBlock = $('article').first();
      if (contentBlock.length === 0) contentBlock = $('main').first();
      if (contentBlock.length === 0) contentBlock = $('[role="main"]').first();
      if (contentBlock.length === 0) contentBlock = $('body');

      const extracted = contentBlock.text();
      
      // Clean up whitespace
      const cleaned = extracted
        .replace(/(\r\n|\n|\r)/gm, "\n") // Normalize newlines
        .replace(/\n\s*\n/g, '\n\n')     // Reduce multiple newlines to double newlines
        .replace(/[ \t]+/g, ' ')         // Reduce multiple spaces
        .trim();

      if (cleaned.length > 50) {
        finalContent = cleaned;
        methodUsed = "Tier 2: Cheerio Scraper";
      } else {
        throw new Error("Cheerio extracted less than 50 characters, likely blocked by JS-only render.");
      }
    } catch (err) {
       errors.push(`Tier 2 Failed: ${err.message}`);
    }
  }

  if (!finalContent) {
    try {
      const fallbackResponse = await fetchWithTimeout(targetUrl, { timeout: 5000 });
      let rawString = await fallbackResponse.text();
      
      // Extremely basic regex to strip HTML tags
      rawString = rawString.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
      rawString = rawString.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
      rawString = rawString.replace(/<[^>]+>/g, ' ');
      
      const regexCleaned = rawString.replace(/\s+/g, ' ').trim();
      
      if (regexCleaned.length > 10) {
        finalContent = regexCleaned;
        methodUsed = "Tier 3: Raw Regex Fallback";
      } else {
        throw new Error("Regex fallback resulted in empty string.");
      }
    } catch (err) {
      errors.push(`Tier 3 Failed: ${err.message}`);
    }
  }

  if (finalContent) {
    return new Response(JSON.stringify({ 
      success: true, 
      text: finalContent,
      debug: { method: methodUsed, errors } 
    }), { 
      status: 200, 
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' } 
    });
  } else {
    // Total Failure
    return new Response(JSON.stringify({ 
      success: false, 
      error: "All extraction methods failed.", 
      text: "Failed to extract content. The site might be heavily protected, region-blocked, or completely reliant on client-side JavaScript that blocked our attempts.",
      debug: { method: "Failed", errors }
    }), { 
      status: 200, // Return 200 so the UI can parse the JSON error gracefully
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' } 
    });
  }
}
