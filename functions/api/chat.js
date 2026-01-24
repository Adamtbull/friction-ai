export async function onRequestPost({ request, env }) {
  const body = await request.json().catch(() => ({}));
  const { model, messages } = body;

  if (!model || !Array.isArray(messages)) {
    return json({ error: "Invalid request" }, 400);
  }

  try {
    let responseText = "";

    switch (model) {

      // =====================
      // GOOGLE GEMINI 2.5
      // =====================
      case "gemini": {
        const userText = messages[messages.length - 1]?.content || "";

        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${env.GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [
                {
                  role: "user",
                  parts: [{ text: userText }]
                }
              ],
              generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 600
              }
            })
          }
        );

        const data = await r.json();
        responseText =
          data?.candidates?.[0]?.content?.parts?.[0]?.text
          || "No response from Gemini";
        break;
      }

      // =====================
      // CLAUDE SONNET 4.5
      // =====================
      case "claude": {
        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01"
          },
          body: JSON.stringify({
            model: "claude-3-5-sonnet-20241022",
            max_tokens: 700,
            messages: messages.map(m => ({
              role: m.role === "assistant" ? "assistant" : "user",
              content: m.content
            }))
          })
        });

        const data = await r.json();
        responseText =
          data?.content?.[0]?.text
          || "No response from Claude";
        break;
      }

      // =====================
      // GPT-4o
      // =====================
      case "gpt": {
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

        const data = await r.json();
        responseText =
          data?.choices?.[0]?.message?.content
          || "No response from GPT-4o";
        break;
      }

      // =====================
      // GROK
      // =====================
      case "grok": {
        const r = await fetch("https://api.x.ai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${env.XAI_API_KEY}`
          },
          body: JSON.stringify({
            model: "grok-4",
            messages,
            temperature: 0.7
          })
        });

        const data = await r.json();
        responseText =
          data?.choices?.[0]?.message?.content
          || "No response from Grok";
        break;
      }

      // =====================
      // PERPLEXITY SONAR
      // =====================
      case "perplexity": {
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

        const data = await r.json();
        responseText =
          data?.choices?.[0]?.message?.content
          || "No response from Perplexity";
        break;
      }

      // =====================
      // BING SEARCH (stub)
      // =====================
      case "bing": {
        responseText =
          "Bing Search integration coming next — this will inject live results.";
        break;
      }

      default:
        return json({ error: "Unknown model" }, 400);
    }

    return json({ response: responseText });

  } catch (err) {
    return json({ error: err.message || "Server error" }, 500);
  }
}

// helper
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}