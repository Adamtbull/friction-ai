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
        if (!env.GEMINI_API_KEY) {
          return json({ error: "Server missing GEMINI_API_KEY" }, 500);
        }

        // For Gemini, we’ll send the latest user message (simple + reliable).
        const userText = messages[messages.length - 1]?.content || "";

        // Flash is usually available on more keys than Pro
        const url =
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;

        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [
              { role: "user", parts: [{ text: userText }] }
            ],
            generationConfig: {
              temperature: 0.7,
              maxOutputTokens: 700
            }
          })
        });

        const data = await r.json().catch(() => ({}));

        // If Gemini returns an error, show the details (instead of "No response")
        if (!r.ok) {
          return json({ error: "Gemini API error", details: data }, r.status);
        }

        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

        // If Gemini returns no text, surface full payload so we can see why (safety block, etc.)
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
            // Keep your chosen model here (update if your account uses a different ID)
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