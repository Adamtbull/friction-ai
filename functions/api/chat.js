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
        const GEMINI_KEY = env.GEMINI_API_KEY || env["Gemini friction key"];
        if (!GEMINI_KEY) {
          return json(
            { error: "Server missing Gemini key (set GEMINI_API_KEY or 'Gemini friction key')" },
            500
          );
        }

        // Normalize incoming messages into plain text turns
        const normalized = (messages || [])
          .map(normalizeMessage)
          .filter(m => m.text.length > 0);

        // Find the most recent USER message (robust role handling)
        const lastUser = [...normalized].reverse().find(m => m.kind === "user");
        if (!lastUser) {
          return json(
            {
              error: "No user message found to send to Gemini.",
              hint: "Your frontend must send messages like { role:'user', content:'hi' } at least once.",
              received_sample: messages.slice(-3)
            },
            400
          );
        }

        // Build Gemini contents using full history, with correct roles:
        // Gemini roles: "user" and "model"
        const contents = normalized.map(m => ({
          role: m.kind === "assistant" ? "model" : "user",
          parts: [{ text: m.text }]
        }));

        // Optional: cap history size so you don't blow tokens
        const MAX_TURNS = 30;
        const clipped = contents.slice(-MAX_TURNS);

        const url =
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`;

        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: clipped,
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

        const parts = data?.candidates?.[0]?.content?.parts;
        const text = Array.isArray(parts)
          ? parts.map(p => p?.text || "").join("").trim()
          : (parts?.text || "").trim();

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
              content: toText(m?.content)
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
            messages: messages.map(m => ({
              role: m.role,
              content: toText(m?.content)
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
            messages: messages.map(m => ({
              role: m.role,
              content: toText(m?.content)
            })),
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
            messages: messages.map(m => ({
              role: m.role,
              content: toText(m?.content)
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

/** Normalize one message into { kind: 'user'|'assistant', text: string } */
function normalizeMessage(m) {
  const roleRaw = String(m?.role || "").toLowerCase();

  // Treat these as assistant
  const isAssistant =
    roleRaw === "assistant" || roleRaw === "model" || roleRaw === "ai";

  // Treat these as system/instructions (we still send to Gemini as user by default)
  // If you later want true system behavior, we can implement that.
  const text = toText(m?.content);

  return {
    kind: isAssistant ? "assistant" : "user",
    text
  };
}

/** Convert content to a plain string (handles string/object/array) */
function toText(content) {
  if (typeof content === "string") return content.trim();

  // OpenAI-style content arrays: [{type:'text', text:'...'}, ...]
  if (Array.isArray(content)) {
    const joined = content
      .map(part => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") return part.text || part.content || "";
        return "";
      })
      .join("");
    return String(joined).trim();
  }

  // Object content: { text: '...' } or { content: '...' }
  if (content && typeof content === "object") {
    const maybe = content.text || content.content || content.message || "";
    return String(maybe).trim();
  }

  return "";
}

// helper
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}