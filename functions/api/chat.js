export async function onRequestPost({ request, env }) {
  const body = await request.json().catch(() => ({}));
  const { model, messages } = body;

  if (!model || !Array.isArray(messages)) {
    return json({ error: "Invalid request. Expected { model, messages[] }" }, 400);
  }

  try {
    let responseText = "";

    switch (model) {
      case "gemini": {
        const GEMINI_KEY = env.GEMINI_API_KEY;
        if (!GEMINI_KEY) {
          return json({ error: "Server missing GEMINI_API_KEY" }, 500);
        }

        // Convert messages to Gemini format
        const contents = messages.map(m => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: String(m.content || "") }]
        }));

        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`;

        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: contents,
            generationConfig: {
              temperature: 0.7,
              maxOutputTokens: 2048
            }
          })
        });

        const data = await r.json().catch(() => ({}));
        
        if (!r.ok) {
          return json({ error: "Gemini API error", details: data }, r.status);
        }

        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        if (!text) {
          return json({ error: "Gemini returned no text", details: data }, 502);
        }

        responseText = text;
        break;
      }

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
            model: "claude-sonnet-4-20250514",
            max_tokens: 2048,
            messages: messages.map(m => ({
              role: m.role === "assistant" ? "assistant" : "user",
              content: String(m.content || "")
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
            messages: messages.map(m => ({
              role: m.role,
              content: String(m.content || "")
            }))
          })
        });

        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          return json({ error: "OpenAI API error", details: data }, r.status);
        }

        responseText = data?.choices?.[0]?.message?.content || "No response from GPT-4o";
        break;
      }

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
            model: "grok-3",
            messages: messages.map(m => ({
              role: m.role,
              content: String(m.content || "")
            })),
            temperature: 0.7
          })
        });

        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          return json({ error: "Grok API error", details: data }, r.status);
        }

        responseText = data?.choices?.[0]?.message?.content || "No response from Grok";
        break;
      }

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
            messages: messages.map(m => ({
              role: m.role,
              content: String(m.content || "")
            }))
          })
        });

        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          return json({ error: "Perplexity API error", details: data }, r.status);
        }

        responseText = data?.choices?.[0]?.message?.content || "No response from Perplexity";
        break;
      }

      case "bing": {
        responseText = "Bing Search integration coming soon!";
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

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}
