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

const JSON_SCHEMA = {
  type: 'object',
  properties: {
    hook_title: {
      type: 'string',
      description: 'Short punchy title, max 6 words, plain Latin text, no parentheses'
    },
    subtitle: {
      type: 'string',
      description: 'Optional subtitle, max 6 words or empty string'
    },
    did_you_know: {
      type: 'string',
      description: 'One clear sentence starting with core fact, max 28 words, simple English, no non-Latin script, no parentheses'
    },
    fun_fact: {
      type: 'string',
      description: 'Punchy memorable takeaway, max 22 words, DIFFERENT info from did_you_know'
    },
    sticker_quote: {
      type: 'string',
      description: 'Catchy 3-5 word micro-quote, can include 1 emoji'
    },
    caption: {
      type: 'string',
      description: 'Social caption with emoji, hook, call to action. Use \\n escape sequences for line breaks, never raw line breaks.'
    },
    hashtags: {
      type: 'array',
      items: { type: 'string' }
    },
    image_prompt: {
      type: 'string',
      description: 'Art director prompt (60-90 words) for full-frame scene representing the topic. No real person face, no text, leave calmer area for text.'
    },
    accent_color: {
      type: 'string',
      description: 'Hex color code matching topic mood (e.g. #F4B942, #38BDF8, #EC4899)'
    },
    layout: {
      type: 'string',
      enum: ['bottom', 'top', 'left']
    }
  },
  required: [
    'hook_title',
    'subtitle',
    'did_you_know',
    'fun_fact',
    'sticker_quote',
    'caption',
    'hashtags',
    'image_prompt',
    'accent_color',
    'layout'
  ],
  additionalProperties: false
};

const SYSTEM_PROMPT = `You are a viral social media content creator and art director specializing in engaging, educational knowledge cards.
Transform this fact into an attention-grabbing social media card with matching AI artwork instructions and caption.
You must respond with ONLY valid JSON and no other text or explanation. Do not wrap in markdown or backticks.

CRITICAL INSTRUCTIONS:
- hook_title: Short punchy title, max 6 words, plain Latin text only, no parentheses or non-Latin script.
- subtitle: Max 6 words or empty string.
- did_you_know: Max 28 words, ONE clear sentence, simple English, no non-Latin script, no parentheses.
- fun_fact: Max 22 words, memorable takeaway, must be completely DIFFERENT information from did_you_know.
- sticker_quote: Max 5 words, can include 1 emoji.
- caption: Write caption as a single string; use \\n escape sequences for line breaks, never raw line breaks.
- hashtags: Array of 5-6 hashtags.
- accent_color: Hex color like #F4B942, #38BDF8, #EC4899, #10B981, #A855F7 that fits the topic mood.
- layout: "bottom" | "top" | "left" (choose where the text sits best on the poster).
- image_prompt: You are an art director. Write ONE detailed English prompt (60-90 words) for an image generator describing a single striking full-frame scene that visually represents this exact topic: concrete subject, setting, era, art style (choose what fits: cinematic photo, oil painting, vintage travel poster, watercolor, 3D render, Byzantine icon mosaic, retro synthwave, etc.), lighting, mood, color palette, composition. Do NOT depict a recognizable real person's face; show a symbolic or historical scene, silhouette, object or landscape instead. Keep it tasteful and non-graphic even for sad or violent topics. The image must contain NO text, NO letters, NO numbers, NO logos, NO watermark. Leave the {top|bottom|left} area visually a bit calmer/darker for text overlay.`;

function parseLooseJson(text) {
  if (typeof text !== 'string') {
    throw new Error('Input must be a string');
  }

  // Strip markdown code fences
  let clean = text.replace(/```json/gi, '').replace(/```/g, '').trim();

  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('No JSON object found in output');
  }
  clean = clean.substring(start, end + 1);

  // Walk character-by-character escaping raw unescaped control chars (< 0x20) inside string literals
  let inString = false;
  let isEscaped = false;
  let out = '';

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    const code = ch.charCodeAt(0);

    if (inString) {
      if (isEscaped) {
        out += ch;
        isEscaped = false;
      } else if (ch === '\\') {
        out += ch;
        isEscaped = true;
      } else if (ch === '"') {
        out += ch;
        inString = false;
      } else if (code < 0x20) {
        if (ch === '\n') {
          out += '\\n';
        } else if (ch === '\r') {
          out += '\\r';
        } else if (ch === '\t') {
          out += '\\t';
        } else if (ch === '\b') {
          out += '\\b';
        } else if (ch === '\f') {
          out += '\\f';
        } else {
          out += '\\u' + code.toString(16).padStart(4, '0');
        }
      } else {
        out += ch;
      }
    } else {
      if (ch === '"') {
        inString = true;
      }
      out += ch;
    }
  }

  return JSON.parse(out);
}

async function requestLlama(userPrompt, useSchema = true) {
  const payload = {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.7,
    max_tokens: 850,
  };

  if (useSchema) {
    payload.response_format = {
      type: 'json_schema',
      json_schema: JSON_SCHEMA,
    };
  }

  let result;
  try {
    result = await runCf('@cf/meta/llama-3.1-8b-instruct', payload);
  } catch (err) {
    // If endpoint rejects response_format, retry once without it
    if (useSchema) {
      console.warn('Llama rejected response_format, retrying without schema:', err.message);
      return requestLlama(userPrompt, false);
    }
    throw err;
  }

  let rawText = '';
  if (typeof result === 'string') {
    rawText = result;
  } else if (result && result.response) {
    rawText = result.response;
  } else {
    rawText = JSON.stringify(result || '');
  }

  return rawText;
}

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
    const { title, extract, description, topic, seed_phrase, variation } = body;

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
    const variationPhrase = (typeof seed_phrase === 'string' && seed_phrase.trim())
      ? seed_phrase.trim()
      : (variation ? `variation ${variation}` : '');

    const userPrompt = `Generate a viral social card for:
Topic: ${cleanTopic || 'General Knowledge'}
Title: ${cleanTitle}
Description: ${cleanDesc}
Fact Extract: ${cleanExtract}${variationPhrase ? `\nSeed phrase: ${variationPhrase} (Create a distinct scene/layout/color variation from other runs)` : ''}`;

    let parsedData = null;
    let lastErr = null;

    // Retry once if parsing or LLM fails
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const rawText = await requestLlama(userPrompt, attempt === 1);
        parsedData = parseLooseJson(rawText);
        if (parsedData && parsedData.hook_title && parsedData.did_you_know) {
          break;
        }
        throw new Error('Parsed data missing required keys');
      } catch (err) {
        lastErr = err;
        console.warn(`Attempt ${attempt} to generate/parse post text failed:`, err.message);
      }
    }

    if (!parsedData) {
      throw lastErr || new Error('Failed to parse AI output after retry');
    }

    // Sanitize / normalize outputs
    if (!parsedData.layout || !['bottom', 'top', 'left'].includes(parsedData.layout)) {
      parsedData.layout = 'bottom';
    }
    if (!parsedData.accent_color || !/^#[0-9a-fA-F]{6}$/.test(parsedData.accent_color)) {
      parsedData.accent_color = '#F4B942';
    }
    if (!Array.isArray(parsedData.hashtags)) {
      parsedData.hashtags = ['#DidYouKnow', '#RandomFacts', '#InterestingFacts'];
    }

    return res.status(200).json({
      data: parsedData,
    });
  } catch (err) {
    const safeMessage = err.message ? err.message.replace(/([a-f0-9]{32,}|Bearer\s+[^\s]+)/gi, '[REDACTED]') : 'Text generation failed';
    return res.status(502).json({ error: safeMessage });
  }
};

// Export parser for unit testing
module.exports.parseLooseJson = parseLooseJson;
