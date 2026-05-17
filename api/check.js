export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "API sleutel niet geconfigureerd op server." });
  }

  const { filters = {} } = req.body || {};

  const filterRegels = [];
  if (filters.zoektype) filterRegels.push(`Zoektype: ${filters.zoektype}`);
  if (filters.instrument) filterRegels.push(`Instrument: ${filters.instrument}`);
  if (filters.provincie) filterRegels.push(`Provincie: ${filters.provincie}`);
  if (filters.genres && filters.genres.length > 0) filterRegels.push(`Genres: ${filters.genres.join(", ")}`);
  if (filters.maxOud) filterRegels.push(`Max geplaatst: ${filters.maxOud}`);
  const filterTekst = filterRegels.length > 0 ? "\nFilters: " + filterRegels.join("; ") : "";

  const SYSTEM_PROMPT = `Zoek recente advertenties op muzikantenbank.net/advertenties/zoeken.${filterTekst}
Reageer ALLEEN met JSON-array, geen tekst eromheen, geen markdown, geen uitleg.
Schema: [{"id":"...","titel":"...","type":"gezocht|aangeboden","datum":"..."|null,"url":"..."|null,"beschrijving":"..."}]
Max 8 items.`;

  // Robuuste JSON-array extractie uit een tekstblok
  function extractJsonArray(text) {
    const start = text.search(/\[\s*[\{\]]/);
    if (start === -1) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === "[" || c === "{") depth++;
      else if (c === "]" || c === "}") {
        depth--;
        if (depth === 0 && c === "]") return text.substring(start, i + 1);
      }
    }
    return null;
  }

  try {
    let messages = [{
      role: "user",
      content: "Geef de JSON array van recente advertenties op muzikantenbank.net/advertenties/zoeken."
    }];

    let finalText = null;
    let toolUseHappened = false;

    for (let i = 0; i < 6; i++) {
      // Na de zoekactie: voeg prefilling toe om model te dwingen direct met [ te beginnen
      const reqMessages = (toolUseHappened && i > 0)
        ? [...messages, { role: "assistant", content: "[" }]
        : messages;

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 3000,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          system: SYSTEM_PROMPT,
          messages: reqMessages
        })
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        return res.status(response.status).json({
          error: `API fout ${response.status}: ${err?.error?.message || response.statusText}`
        });
      }

      const data = await response.json();
      messages.push({ role: "assistant", content: data.content });

      const textBlock = data.content.find(b => b.type === "text");
      if (textBlock && textBlock.text.trim()) {
        // Bij prefilling: plak '[' weer voorop
        let txt = textBlock.text.trim();
        if (toolUseHappened && !txt.startsWith("[")) txt = "[" + txt;
        finalText = txt;
      }

      if (data.stop_reason === "end_turn") break;

      const toolUseBlocks = data.content.filter(b => b.type === "tool_use");
      if (toolUseBlocks.length > 0) {
        toolUseHappened = true;
        const toolResults = toolUseBlocks.map(b => ({
          type: "tool_result",
          tool_use_id: b.id,
          content: "OK"
        }));
        messages.push({ role: "user", content: toolResults });
        continue;
      }
      break;
    }

    if (!finalText) {
      return res.status(500).json({ error: "Geen respons ontvangen." });
    }

    const jsonStr = extractJsonArray(finalText);
    if (!jsonStr) {
      return res.status(500).json({
        error: "Geen geldige JSON gevonden.",
        debug: finalText.substring(0, 500)
      });
    }

    let ads;
    try {
      ads = JSON.parse(jsonStr);
    } catch (e) {
      return res.status(500).json({
        error: "JSON parse fout: " + e.message,
        debug: jsonStr.substring(0, 500)
      });
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ ads });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
