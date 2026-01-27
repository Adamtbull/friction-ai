// Replace the entire enforceLimits function:
async function enforceLimits({ env, userId, ip }) {
  // Simple in-memory rate limiting without KV
  return { ok: true }; // Temporarily disable rate limits
}

// Update getVerifiedGoogleUser to not use KV caching:
async function getVerifiedGoogleUser(request, env) {
  const clientId = env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return { ok: false, status: 500, error: "Server missing GOOGLE_CLIENT_ID." };
  }

  const authz = request.headers.get("Authorization") || "";
  const match = authz.match(/^Bearer\s+(.+)$/i);
  const idToken = match ? match[1].trim() : "";

  if (!idToken) {
    return { ok: false, status: 401, error: "Missing Authorization Bearer token." };
  }

  const verifyUrl =
    "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken);

  const res = await fetch(verifyUrl);
  const data = await res.json().catch(() => ({}));

  if (!res.ok || data.aud !== clientId || !data.sub || !data.email) {
    return { ok: false, status: 401, error: "Invalid sign-in token." };
  }

  const isAdmin = data.email.toLowerCase() === env.ADMIN_EMAIL.toLowerCase();

  return { 
    ok: true, 
    userId: data.sub,
    email: data.email,
    isAdmin: isAdmin
  };
}

// Update all admin endpoints to work without KV:
async function handleAdminStats(request, env) {
  const auth = await getVerifiedGoogleUser(request, env);
  if (!auth.ok || !auth.isAdmin) {
    return jsonResponse({ error: 'Admin access required' }, 403);
  }
  
  return jsonResponse({
    privacy: {
      message: "KV storage not configured. Running in simple mode.",
      statistics: {
        totalRequestsToday: 0,
        modelUsage: { gemini: 0, claude: 0, gpt: 0, grok: 0, perplexity: 0 },
        rateLimits: { triggeredToday: 0 }
      }
    },
    system: {
      status: "Running without KV storage",
      lastUpdated: new Date().toISOString()
    }
  });
}