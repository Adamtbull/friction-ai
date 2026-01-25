export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Only respond to /api/*
    if (!url.pathname.startsWith("/api/")) {
      return new Response("Not Found", { status: 404 });
    }

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders(),
      });
    }

    // Only handle POST /api/chat
    if (url.pathname === "/api/chat" && request.method === "POST") {
      try {
        const body = await request.json().catch(() => ({}));
        const model = body.model;
        const messages = Array.isArray(body.messages) ? body.messages : [];

        if (!messages.length) {
          return jsonResponse({ error: "No messages provided" }, 400);
        }

        // Clean/normalize messages
        const cleaned = messages
          .filter(m => m && typeof m.content === "string" && m.content.trim().length > 0)
          .map(m => ({
            role: m.role === "assistant" ? "assistant" : "user",
            content: m.content.trim(),
          }));

        if (!cleaned.length) {
          return jsonResponse(
            { response: "Hey! 👋 Looks like your message didn't come through. Try sending something again?" },
            200
          );
        }

        // Gemini requires the last turn to be user
        if (cleaned[cleaned.length - 1].role !== "user") {
          return jsonResponse(
            { error: "Last message must be from user (frontend sent assistant last). Try again." },
            400
          );
        }

        let responseText;

        if (model === "gemini") {
          responseText = await handleGemini(cleaned, env);
        } else {
          return jsonResponse({ error: "Model not configured: " + model }, 400);
        }

        return jsonResponse({ response: responseText }, 200);
      } catch (err) {
        return jsonResponse({ error: err?.message || "Server error" }, 500);
      }
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders() });
  },
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
    },
  });
}

async function handleGemini(messages, env) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Gemini API key not configured (missing GEMINI_API_KEY in Worker secrets).");

  // Convert your chat history to Gemini "contents"
  const contents = messages.map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const endpoint =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" +
    encodeURIComponent(apiKey);

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents,
      generationConfig: {
        temperature: 0.9,
        topP: 0.95,
        maxOutputTokens: 2048,
      },
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    // Keep full Gemini error visible so you can debug quota/billing/permissions
    throw new Error("Gemini API error: " + text);
  }

  const data = JSON.parse(text);
  const out = data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!out) throw new Error("No valid response text from Gemini.");
  return out;
}
