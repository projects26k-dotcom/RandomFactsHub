const { runCf } = require('../lib/cf');

// In-memory rate limiter: 10 requests per minute per IP
const rateLimitMap = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxRequests = 10;

  const timestamps = (rateLimitMap.get(ip) || []).filter(t => now - t < windowMs);
  if (timestamps.length >= maxRequests) {
    return true;
  }

  timestamps.push(now);
  rateLimitMap.set(ip, timestamps);

  if (rateLimitMap.size > 1000) {
    for (const [key, list] of rateLimitMap.entries()) {
      if (list.every(t => now - t >= windowMs)) {
        rateLimitMap.delete(key);
      }
    }
  }

  return false;
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';
}

function checkOrigin(req) {
  const host = req.headers['host'];
  const origin = req.headers['origin'];
  const referer = req.headers['referer'];

  if (origin) {
    try {
      const originHost = new URL(origin).host;
      if (originHost !== host) return false;
    } catch {
      return false;
    }
  } else if (referer) {
    try {
      const refererHost = new URL(referer).host;
      if (refererHost !== host) return false;
    } catch {
      return false;
    }
  }
  return true;
}

const SYSTEM_PROMPT = `You are a viral social media content creator specializing in engaging, educational knowledge cards (like Instagram, X/Twitter, Threads, LinkedIn).
Transform this fact into an attention-grabbing social media post graphic and caption.
You must respond with ONLY valid JSON and no other text or explanation. Do not wrap in markdown or backticks.

The output JSON must strictly follow this structure:
{
  "hook_title": "Short punchy title (max 5-7 words, e.g. 'Summer Nights by Grease' or 'Secrets of the Blue Whale')",
  "did_you_know": "One clear, intriguing sentence starting with the core fact (approx 20-30 words)",
  "fun_fact": "A punchy, memorable, emotional or surprising fact takeaway (approx 15-25 words)",
  "sticker_quote": "A catchy 3-5 word sticker tagline or micro-quote (e.g. 'Good Music Never Gets Old 🎵' or 'Cosmic Wonder 🌌')",
  "caption": "A high-engagement social media caption with emoji bullet points, hook, short summary, fun fact, and a call-to-action to learn more",
  "hashtags": ["#Tag1", "#Tag2", "#Tag3", "#Tag4", "#RandomFacts"]
}`;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  if (!checkOrigin(req)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const clientIp = getClientIp(req);
  if (isRateLimited(clientIp)) {
    return res.status(429).json({ error: 'Rate limit exceeded. Please wait a moment.' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { title, extract, description, topic } = body;

    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'title is required and must be a string' });
    }
    if (!extract || typeof extract !== 'string' || !extract.trim()) {
      return res.status(400).json({ error: 'extract is required and must be a string' });
    }

    const cleanTitle = title.trim().slice(0, 300);
    const cleanExtract = extract.trim().slice(0, 3000);
    const cleanDesc = (typeof description === 'string' ? description.trim() : '').slice(0, 300);
    const cleanTopic = (typeof topic === 'string' ? topic.trim() : '').slice(0, 100);

    const userPrompt = `Generate a viral social card for:
Topic: ${cleanTopic || 'General Knowledge'}
Title: ${cleanTitle}
Description: ${cleanDesc}
Fact Extract: ${cleanExtract}`;

    const result = await runCf('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.7,
      max_tokens: 700,
    });

    let rawText = '';
    if (typeof result === 'string') {
      rawText = result;
    } else if (result && result.response) {
      rawText = result.response;
    } else {
      rawText = JSON.stringify(result || '');
    }

    // Strip markdown fences
    rawText = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();

    const start = rawText.indexOf('{');
    const end = rawText.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      throw new Error('AI output did not contain valid JSON object');
    }

    const parsedData = JSON.parse(rawText.substring(start, end + 1));

    return res.status(200).json({
      data: parsedData,
    });
  } catch (err) {
    const safeMessage = err.message ? err.message.replace(/([a-f0-9]{32,}|Bearer\s+[^\s]+)/gi, '[REDACTED]') : 'Text generation failed';
    return res.status(502).json({ error: safeMessage });
  }
};
