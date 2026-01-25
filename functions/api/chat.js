export async function onRequestPost({ request, env }) {
  const body = await request.json().catch(() => ({}));
  const { model, messages } = body;

  if (!model || !Array.isArray(messages)) {
    return json({ error: "Invalid request. Expected { model, messages[] }" }, 400);
  }

  try {
    let responseText = "";

    switch (model) {
      // =====================
      // GOOGLE GEMINI 2.5
      // =====================
      case "gemini": {
        // Support BOTH naming styles:
        // 1) Recommended: GEMINI_API_KEY
        // 2) Your current CF secret name: "Gemini friction key"
        const GEMINI_KEY = env.GEMINI_API_KEY || env["Gemini friction key"];

        if (!GEMINI_KEY) {
          return json(
            { error: "Server missing Gemini key (set GEMINI_API_KEY or 'Gemini friction key')" },
            500
          );
        }

        // Build proper Gemini "contents" from full history:
        // - user -> role: "user"
        // - assistant -> role: "model"
        const history = (messages || [])
          .filter(m => m && typeof m.content === "string" && m.content.trim().length > 0)
          .map(m => ({
            role: m.role === "assistant" ? "model" : "user",
            parts: [{ text: m.content }]
          }));

        // Ensure we have at least one real user message
        const lastUser = [...history].reverse().find(m => m.role === "user");
        if (!lastUser) {
          return json({ error: "No user message found to send to Gemini." }, 400);
        }

        // Optional: keep history from getting too large
        const MAX_TURNS = 30; // tweak if you want
        const clippedHistory = history.slice(-MAX_TURNS);

        const url =
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`;

        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: clippedHistory,
            generationConfig: {
              temperature: 0.7,
              maxOutputTokens: 700
            }
          })
        });

        const data = await r.json().catch(() => ({}));

        if (!r.ok) {
          return json({ error: "Gemini API error", details: data }, r.status);
        }

        // Gemini may return multiple parts—join them safely
        const parts = data?.candidates?.[0]?.content?.parts;
        const text =
          Array.isArray(parts) ? parts.map(p => p?.text || "").join("").trim() : "";

        if (!text) {
          return json({ error: "Gemini returned no text", details: data }, 502);
        }

        responseText = text;
        break;
      }

      // =====================
      // CLAUDE SONNET
      // =====================
      case "claude": {
        if (!env.ANTHROPIC_API_KEY) {
          return json({ error: "Server missing ANTHROPIC_API_KEY" }, 500);
        }

        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01"
          },
          body: JSON.stringify({
            model: "claude-3-5-sonnet-20241022",
            max_tokens: 800,
            messages: messages.map(m => ({
              role: m.role === "assistant" ? "assistant" : "user",
              content: m.content
            }))
          })
        });

        const data = await r.json().catch(() => ({}));

        if (!r.ok) {
          return json({ error: "Claude API error", details: data }, r.status);
        }

        responseText = data?.content?.[0]?.text || "No response from Claude";
        break;
      }

      // =====================
      // GPT-4o
      // =====================
      case "gpt": {
        if (!env.OPENAI_API_KEY) {
          return json({ error: "Server missing OPENAI_API_KEY" }, 500);
        }

        const r = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${env.OPENAI_API_KEY}`
          },
          body: JSON.stringify({
            model: "gpt-4o",
            temperature: 0.7,
            messages
          })
        });

        const data = await r.json().catch(() => ({}));

        if (!r.ok) {
          return json({ error: "OpenAI API error", details: data }, r.status);
        }

        responseText = data?.choices?.[0]?.message?.content || "No response from GPT-4o";
        break;
      }

      // =====================
      // GROK (xAI)
      // =====================
      case "grok": {
        if (!env.XAI_API_KEY) {
          return json({ error: "Server missing XAI_API_KEY" }, 500);
        }

        const r = await fetch("https://api.x.ai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${env.XAI_API_KEY}`
          },
          body: JSON.stringify({
            model: "grok-4",
            messages,
            temperature: 0.7,
            stream: false
          })
        });

        const data = await r.json().catch(() => ({}));

        if (!r.ok) {
          return json({ error: "Grok API error", details: data }, r.status);
        }

        responseText = data?.choices?.[0]?.message?.content || "No response from Grok";
        break;
      }

      // =====================
      // PERPLEXITY SONAR
      // =====================
      case "perplexity": {
        if (!env.PERPLEXITY_API_KEY) {
          return json({ error: "Server missing PERPLEXITY_API_KEY" }, 500);
        }

        const r = await fetch("https://api.perplexity.ai/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${env.PERPLEXITY_API_KEY}`
          },
          body: JSON.stringify({
            model: "sonar",
            messages
          })
        });

        const data = await r.json().catch(() => ({}));

        if (!r.ok) {
          return json({ error: "Perplexity API error", details: data }, r.status);
        }

        responseText = data?.choices?.[0]?.message?.content || "No response from Perplexity";
        break;
      }

      // =====================
      // BING SEARCH (stub)
      // =====================
      case "bing": {
        responseText = "Bing Search integration coming next — this will inject live results.";
        break;
      }

      default:
        return json({ error: `Unknown model: ${model}` }, 400);
    }

    return json({ response: responseText });
  } catch (err) {
    return json({ error: err?.message || "Server error" }, 500);
  }
}

// helper
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}