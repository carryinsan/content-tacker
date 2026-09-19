import * as cheerio from 'cheerio';

export const config = {
  runtime: 'edge',
};

// Bypassing IP-based rate limiting
function getRandomIP() {
    const validFirstOctets = [8, 12, 17, 23, 34, 45, 50, 67, 72, 80, 99, 104, 142, 168, 173, 198, 203];
    const first = validFirstOctets[Math.floor(Math.random() * validFirstOctets.length)];
    return `${first}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
}

// Generates perfect Chrome browser headers to bypass strict WAFs
function getPerfectBrowserHeaders(spoofedIP, jinaKey) {
    const headers = {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'X-Forwarded-For': spoofedIP,
        'X-Real-IP': spoofedIP,
        'Client-IP': spoofedIP
    };
    
    // If you add JINA_API_KEY to your Vercel Environment Variables, it bypasses the 403 entirely.
    if (jinaKey) {
        headers['Authorization'] = `Bearer ${jinaKey}`;
    }
    
    return headers;
}

// Helper: Fetch with an abort timeout
async function fetchWithTimeout(resource, options = {}) {
  const { timeout = 8000 } = options;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(resource, { ...options, signal: controller.signal });
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

  if (!targetUrl) {
    return new Response(JSON.stringify({ success: false, error: "Missing URL parameter.", text: "Please provide a valid URL." }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  try { new URL(targetUrl); } catch (e) {
    return new Response(JSON.stringify({ success: false, error: "Invalid URL format.", text: "The provided link is not a valid URL format." }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  let finalContent = "";
  let methodUsed = "none";
  let errors = [];

  const spoofedIP = getRandomIP();
  // We use process.env to allow optional API key injection
  const jinaKey = process.env.JINA_API_KEY || null; 
  const browserHeaders = getPerfectBrowserHeaders(spoofedIP, jinaKey);
  
  // TIER 1: The Proxy Waterfall
  // If Vercel IP is blocked by Jina, we bounce the request through open public proxies to mask the Vercel origin.
  const jinaTarget = `https://r.jina.ai/${targetUrl}`;
  const fetchStrategies = [
      { name: "Direct Jina", url: jinaTarget },
      { name: "CorsProxy -> Jina", url: `https://corsproxy.io/?${encodeURIComponent(jinaTarget)}` },
      { name: "AllOrigins -> Jina", url: `https://api.allorigins.win/raw?url=${encodeURIComponent(jinaTarget)}` }
  ];

  for (const strategy of fetchStrategies) {
      if (finalContent) break;
      try {
          const proxyResponse = await fetchWithTimeout(strategy.url, {
              timeout: 6000,
              headers: browserHeaders
          });

          if (proxyResponse.ok) {
              const text = await proxyResponse.text();
              // Validate that we didn't just get a proxy error page
              if (text && text.length > 100 && !text.includes("Cloudflare") && !text.includes("403 Forbidden") && !text.includes("Access Denied")) {
                  finalContent = text.replace(/\[.*?\]\(.*?\)/g, ''); // Clean markdown links
                  methodUsed = `Tier 1: AI Proxy (${strategy.name})`;
                  break;
              } else {
                  throw new Error(`Invalid content received via ${strategy.name}`);
              }
          } else {
              throw new Error(`${strategy.name} failed with status: ${proxyResponse.status}`);
          }
      } catch (err) {
          errors.push(`Tier 1 (${strategy.name}) Failed: ${err.message}`);
      }
  }

  // TIER 2: Upgraded Semantic Markdown Scraper
  // If Jina completely fails, we now dynamically build clean Markdown using Cheerio
  if (!finalContent) {
    try {
      const rawResponse = await fetchWithTimeout(targetUrl, {
        timeout: 8000,
        headers: { 'User-Agent': browserHeaders['User-Agent'], 'X-Forwarded-For': spoofedIP }
      });

      if (!rawResponse.ok) throw new Error(`Target host returned status: ${rawResponse.status}`);

      const html = await rawResponse.text();
      const $ = cheerio.load(html);

      // Aggressively remove bloat
      $('script, style, noscript, iframe, img, svg, video, audio, canvas, map, object, embed, footer, header, nav, aside, [role="banner"], [role="navigation"], .ad, .ads, #comments, .comments, .sidebar, .menu').remove();

      let contentBlock = $('article').first();
      if (contentBlock.length === 0) contentBlock = $('main').first();
      if (contentBlock.length === 0) contentBlock = $('.main-content, #main-content, .post, .content').first();
      if (contentBlock.length === 0) contentBlock = $('body');

      let structuredText = "";
      
      // Iterate through elements to build Semantic Markdown
      contentBlock.find('h1, h2, h3, h4, p, li, th, td').each((i, el) => {
          const text = $(el).text().replace(/\s+/g, ' ').trim();
          if (text.length > 20 || $(el).is('h1, h2, h3, h4')) { // Ignore tiny fragmented texts
              const tag = el.tagName.toLowerCase();
              if (tag === 'h1' || tag === 'h2') {
                  structuredText += `\n\n## ${text}\n\n`;
              } else if (tag === 'h3' || tag === 'h4') {
                  structuredText += `\n### ${text}\n`;
              } else if (tag === 'li') {
                  structuredText += `- ${text}\n`;
              } else {
                  structuredText += `${text}\n\n`;
              }
          }
      });

      const cleaned = structuredText.trim();

      if (cleaned.length > 200) {
        finalContent = cleaned;
        methodUsed = "Tier 2: Semantic Cheerio Scraper (Markdown Generated)";
      } else {
        throw new Error("Semantic extraction yielded too little text. Page might be JS-only.");
      }
    } catch (err) {
       errors.push(`Tier 2 Failed: ${err.message}`);
    }
  }

  // TIER 3: Raw Regex Fallback
  if (!finalContent) {
    try {
      const fallbackResponse = await fetchWithTimeout(targetUrl, { timeout: 5000 });
      let rawString = await fallbackResponse.text();
      rawString = rawString.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
      rawString = rawString.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
      rawString = rawString.replace(/<[^>]+>/g, ' ');
      const regexCleaned = rawString.replace(/\s+/g, ' ').trim();
      
      if (regexCleaned.length > 50) {
        finalContent = regexCleaned;
        methodUsed = "Tier 3: Raw Regex Fallback";
      } else {
        throw new Error("Regex fallback resulted in empty string.");
      }
    } catch (err) {
      errors.push(`Tier 3 Failed: ${err.message}`);
    }
  }

  // Final Output Delivery
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
    return new Response(JSON.stringify({ 
      success: false, 
      error: "All extraction methods failed.", 
      text: "Failed to extract content. The site might be heavily protected or region-blocked.",
      debug: { method: "Failed", errors }
    }), { 
      status: 200, 
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' } 
    });
  }
}
