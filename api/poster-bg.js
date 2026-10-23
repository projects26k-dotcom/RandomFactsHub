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
    let { image_prompt, title, description, variation, hook_title, text_in_image } = body;

    let basePrompt = '';

    if (typeof image_prompt === 'string' && image_prompt.trim().length > 10) {
      basePrompt = image_prompt.trim();
    } else {
      // Build a content-specific prompt from title+description (never "abstract background")
      const cleanTitle = (typeof title === 'string' ? title.trim() : 'Fascinating Subject').slice(0, 200);
      const cleanDesc = (typeof description === 'string' ? description.trim() : '').slice(0, 200);
      basePrompt = `Striking visual depiction representing ${cleanTitle}${cleanDesc ? ': ' + cleanDesc : ''}, dramatic lighting, rich texture, cinematic atmosphere`;
    }

    // Strip trailing punctuation from basePrompt
    basePrompt = basePrompt.replace(/[.,;]+$/, '');

    let finalPrompt = '';

    // Experimental: AI-written title inside image
    if (text_in_image && hook_title && typeof hook_title === 'string' && hook_title.trim()) {
      const cleanHook = hook_title.trim().replace(/"/g, "'").slice(0, 60);
      finalPrompt = `${basePrompt}, highly detailed, professional composition, sharp focus, no watermark, no logo. The poster title reads exactly "${cleanHook}" in large bold letters.`;
    } else {
      finalPrompt = `${basePrompt}, highly detailed, professional composition, sharp focus, no text, no letters, no watermark, no logo.`;
    }

    // Seed / variation phrase
    if (variation !== undefined && variation !== null) {
      const varStr = String(variation).replace(/[^a-zA-Z0-9#_-]/g, '').slice(0, 30);
      if (varStr) {
        finalPrompt += ` variation ${varStr}`;
      }
    }

    const cfPayload = {
      prompt: finalPrompt,
      steps: 6,
    };

    if (typeof variation === 'number' && Number.isInteger(variation)) {
      cfPayload.seed = Math.abs(variation) % 2147483647;
    }

    const result = await runCf('@cf/black-forest-labs/flux-1-schnell', cfPayload);

    if (!result || !result.image) {
      throw new Error('Image generation completed without image data.');
    }

    return res.status(200).json({
      image: `data:image/jpeg;base64,${result.image}`,
      prompt: finalPrompt,
    });
  } catch (err) {
    const safeMessage = err.message ? err.message.replace(/([a-f0-9]{32,}|Bearer\s+[^\s]+)/gi, '[REDACTED]') : 'Background generation failed';
    return res.status(502).json({ error: safeMessage });
  }
};
