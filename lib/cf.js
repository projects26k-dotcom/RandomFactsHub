/**
 * Cloudflare Workers AI helper for Vercel Serverless Functions
 */

async function runCf(model, body) {
  const accountId = process.env.CF_ACCOUNT_ID;
  const apiToken = process.env.CF_API_TOKEN;

  if (!accountId || !apiToken) {
    throw new Error('Cloudflare credentials not configured in environment (CF_ACCOUNT_ID, CF_API_TOKEN).');
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => null);

  if (!json) {
    throw new Error(`Cloudflare AI request failed with HTTP ${res.status}`);
  }

  if (!res.ok || json.success === false) {
    const errorMsg =
      (json.errors && json.errors.length > 0 && json.errors[0].message) ||
      `Cloudflare AI error (HTTP ${res.status})`;
    throw new Error(errorMsg);
  }

  return json.result;
}

module.exports = {
  runCf,
};
