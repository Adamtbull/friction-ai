export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // --- CORS preflight ---
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders(),
      });
    }

    // --- Only handle POST /api/chat ---
    if (url.pathname !== "/api/chat" || request.method !== "POST") {
      return new Response("Not Found", { status: 404 });
    }

    try {
      const body = await request.json();
      const { model, messages } = body;

      if (!model) {
        return json({ error: "No model specified" }, 400);
      }

      if (!Array.isArray(messages) || messages.length === 0) {
        return json({ error: "No messages provided" }, 400);
      }

      // ✅ Gemini REQUIRES the LAST message to be a USER message
      const cleanedMessages = messages
        .filter(m => m && typeof m.content === "string" && m.content.trim())
        .map(m => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content.trim() }],
        }));

      // Force last role to user (Gemini rule)
      cleanedMessages[cleanedMessages.length - 1].role = "user";

      let responseText = "";

      if (model === "gemini") {
        responseText = await callGemini(cleanedMessages, env);
      } else {
        return json({ error: `Model not supported: ${model}` }, 400);
      }

      return json({ response: responseText });
    } catch (err) {
      return json(
        {
          error: err.message || "Worker error",
        },
        500
      );
    }
  },
};

/* ---------------- HELPERS ---------------- */

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
    },
  });
}

/* ---------------- GEMINI ---------------- */

async function callGemini(contents, env) {
  if (!env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY not configured");
  }

  const res = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" +
      env.GEMINI_API_KEY,
    {
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
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error("Gemini API error: " + text);
  }

  const data = await res.json();
  const candidate = data.candidates?.[0];
  const part = candidate?.content?.parts?.[0]?.text;

  if (!part) {
    throw new Error("No response from Gemini");
  }

  return part;
}
