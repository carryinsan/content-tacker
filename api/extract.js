import * as cheerio from 'cheerio';

export const config = {
  runtime: 'edge',
};

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

  // ==========================================
  // TIER 1: The Jina AI Reader Proxy (Handles JS, Anti-Bot, gives clean Markdown)
  // ==========================================
  try {
    const proxyResponse = await fetchWithTimeout(`https://r.jina.ai/${encodeURIComponent(targetUrl)}`, {
      timeout: 6000, // Quick timeout so we don't stall the user
      headers: {
        'Accept': 'text/plain',
        'X-No-Cache': 'true',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (proxyResponse.ok) {
      const text = await proxyResponse.text();
      if (text && text.length > 100 && !text.includes("Cloudflare") && !text.includes("Just a moment...")) {
        finalContent = text.replace(/\[.*?\]\(.*?\)/g, ''); // Strip markdown links to make it cleaner text
        methodUsed = "Tier 1: AI Proxy";
      } else {
        throw new Error("Proxy returned empty or blocked response.");
      }
    } else {
       throw new Error(`Proxy failed with status: ${proxyResponse.status}`);
    }
  } catch (err) {
    errors.push(`Tier 1 Failed: ${err.message}`);
  }

  // ==========================================
  // TIER 2: Native Fetch + Cheerio Cleanup (Fast, handles static pages)
  // ==========================================
  if (!finalContent) {
    try {
      const rawResponse = await fetchWithTimeout(targetUrl, {
        timeout: 8000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
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

  // ==========================================
  // TIER 3: Last Resort Regex Stripper
  // ==========================================
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

  // ==========================================
  // Final Evaluation
  // ==========================================
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
