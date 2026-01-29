// functions/api/appointments/structure.js

const JWKS_TTL_MS = 60 * 60 * 1000; // 1 hour
let JWKS_CACHE = { keys: null, fetchedAt: 0 };

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json().catch(() => ({}));
    const text = (body.text || '').trim();

    if (!text) {
      return json({ error: 'Invalid request. Expected { text }' }, 400);
    }

    const auth = request.headers.get('Authorization') || '';
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) return json({ error: 'Missing Authorization Bearer token' }, 401);

    const idToken = m[1].trim();

    if (!env.GOOGLE_CLIENT_ID) {
      return json({ error: 'Server missing GOOGLE_CLIENT_ID (env var)' }, 500);
    }

    await verifyGoogleIdToken(idToken, env.GOOGLE_CLIENT_ID);

    const GEMINI_KEY = env.GEMINI_API_KEY;
    if (!GEMINI_KEY) return json({ error: 'Server missing GEMINI_API_KEY' }, 500);

    const prompt =
      'Extract appointment fields from the text below. Return STRICT JSON only. ' +
      'Schema: {"fields": {"title"?: string, "date"?: "YYYY-MM-DD", "time"?: "HH:MM", "venueName"?: string, "address"?: string, "contactName"?: string, "phone"?: string, "notes"?: string}, "confidence"?: object}. ' +
      'Use 24h time. Omit unknown fields. No markdown.' +
      '\n\nText:\n' + text;

    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(
        GEMINI_KEY
      )}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 512 }
        })
      }
    );

    const data = await r.json().catch(() => ({}));
    if (!r.ok) return json({ error: 'Gemini API error', details: data }, r.status);

    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!raw) return json({ error: 'Gemini returned no text', details: data }, 502);

    const parsed = parseJsonResponse(raw);
    if (!parsed) {
      return json({ error: 'Unable to parse AI response', details: raw }, 502);
    }

    return json({
      fields: parsed.fields || parsed || {},
      confidence: parsed.confidence || null
    }, 200);
  } catch (err) {
    return json({ error: err?.message || 'Server error' }, 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders() });
}

function parseJsonResponse(text) {
  if (!text) return null;
  let trimmed = text.trim();
  if (trimmed.startsWith('```')) {
    trimmed = trimmed.replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim();
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  const slice = trimmed.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch (e) {
    return null;
  }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}

async function verifyGoogleIdToken(idToken, expectedAud) {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('Invalid ID token format');

  const header = JSON.parse(decodeBase64UrlToString(parts[0]));
  const payload = JSON.parse(decodeBase64UrlToString(parts[1]));
  const sigBytes = decodeBase64UrlToBytes(parts[2]);

  if (header.alg !== 'RS256') throw new Error('Unexpected JWT alg');
  if (!header.kid) throw new Error('Missing kid in JWT header');

  const now = Math.floor(Date.now() / 1000);

  if (payload.iss !== 'accounts.google.com' && payload.iss !== 'https://accounts.google.com') {
    throw new Error('Invalid issuer');
  }

  if (payload.aud !== expectedAud) throw new Error('Invalid audience (aud)');
  if (!payload.exp || now >= payload.exp) throw new Error('Token expired');

  const jwks = await getGoogleJwks();
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('No matching Google public key (kid)');

  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const signedData = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const ok = await crypto.subtle.verify(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    sigBytes,
    signedData
  );

  if (!ok) throw new Error('Invalid token signature');

  return payload;
}

async function getGoogleJwks() {
  const now = Date.now();
  if (JWKS_CACHE.keys && now - JWKS_CACHE.fetchedAt < JWKS_TTL_MS) return JWKS_CACHE.keys;

  const r = await fetch('https://www.googleapis.com/oauth2/v3/certs', { method: 'GET' });
  if (!r.ok) throw new Error('Failed to fetch Google certs');
  const jwks = await r.json();

  JWKS_CACHE = { keys: jwks, fetchedAt: now };
  return jwks;
}

function decodeBase64UrlToString(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64url.length + 3) % 4);
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function decodeBase64UrlToBytes(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64url.length + 3) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
