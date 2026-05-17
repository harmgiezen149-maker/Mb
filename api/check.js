export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "API sleutel niet geconfigureerd op server." });
  }

  const SYSTEM_PROMPT = `Je bent een assistent die advertenties ophaalt van muzikantenbank.net.
Zoek op https://www.muzikantenbank.net/advertenties/zoeken naar de meest recente advertenties.
Geef uitsluitend een JSON-array terug. Geen uitleg, geen markdown, geen backticks. Alleen de array.
Elk item bevat:
- id: unieke string (gebruik de URL of een combinatie van titel+datum)
- titel: de advertentietitel
- type: "gezocht", "aangeboden", of "onbekend"
- datum: datum als string of null
- url: directe link of null
- beschrijving: max 100 tekens samenvatting

Geef maximaal 20 advertenties. Begin direct met [ en eindig met ].`;

  try {
    let messages = [{
      role: "user",
      content: "Zoek de meest recente advertenties op muzikantenbank.net/advertenties/zoeken en geef ze terug als JSON array."
    }];

    let finalText = null;

    // Loop voor multi-turn tool use (max 6 rondes)
    for (let i = 0; i < 6; i++) {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 2000,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          system: SYSTEM_PROMPT,
          messages
        })
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        return res.status(response.status).json({
          error: `API fout ${response.status}: ${err?.error?.message || response.statusText}`
        });
      }

      const data = await response.json();

      // Voeg assistent respons toe aan berichten
      messages.push({ role: "assistant", content: data.content });

      // Zoek tekstblok
      const textBlock = data.content.find(b => b.type === "text");
      if (textBlock && textBlock.text.trim()) {
        finalText = textBlock.text.trim();
      }

      // Als we klaar zijn (end_turn), stop de loop
      if (data.stop_reason === "end_turn") {
        break;
      }

      // Als er tool_use blokken zijn, stuur tool resultaten terug
      const toolUseBlocks = data.content.filter(b => b.type === "tool_use");
      if (toolUseBlocks.length > 0) {
        const toolResults = toolUseBlocks.map(b => ({
          type: "tool_result",
          tool_use_id: b.id,
          content: "Zoekresultaten zijn beschikbaar."
        }));
        messages.push({ role: "user", content: toolResults });
        continue;
      }

      // Geen tool use en geen end_turn → stop
      break;
    }

    if (!finalText) {
      return res.status(500).json({ error: "Geen respons ontvangen van model." });
    }

    // Probeer JSON array te extraheren
    const clean = finalText.replace(/```json|```/g, "").trim();
    const match = clean.match(/\[[\s\S]*\]/);
    if (!match) {
      return res.status(500).json({
        error: "Kon geen advertenties ophalen. Probeer het opnieuw."
      });
    }

    const ads = JSON.parse(match[0]);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ ads });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
