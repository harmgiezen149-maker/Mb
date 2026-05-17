export default async function handler(req, res) {
  // Alleen POST toestaan
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "API sleutel niet geconfigureerd op server." });
  }

  const SYSTEM_PROMPT = `Je bent een parser voor advertenties op muzikantenbank.net.
Zoek naar de meest recente advertenties op https://www.muzikantenbank.net/advertenties/zoeken via web search.
Geef een JSON-array terug van de gevonden advertenties. Geef ALLEEN geldige JSON terug, geen uitleg, geen markdown backticks.
Elk item heeft de volgende velden:
- id: een unieke string identifier (bijv. URL of titel+datum combinatie)
- titel: de advertentietitel
- type: "gezocht" of "aangeboden" (of "onbekend")
- datum: datum als string (bijv. "17 mei 2025") als beschikbaar, anders null
- url: directe URL naar de advertentie als beschikbaar, anders null
- beschrijving: korte samenvatting (max 100 tekens)

Voorbeeld output:
[{"id":"abc123","titel":"Bassist gezocht","type":"gezocht","datum":"17 mei 2025","url":"https://muzikantenbank.net/...","beschrijving":"Rockband zoekt bassist in Amsterdam"}]

Geef maximaal 20 meest recente advertenties.`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        system: SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: "Haal de meest recente advertenties op van https://www.muzikantenbank.net/advertenties/zoeken en geef ze terug als JSON array."
        }]
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({
        error: `API fout ${response.status}: ${err?.error?.message || response.statusText}`
      });
    }

    const data = await response.json();
    const textBlock = data.content.find(b => b.type === "text");
    if (!textBlock) {
      return res.status(500).json({ error: "Geen tekstrespons ontvangen van API" });
    }

    let text = textBlock.text.replace(/```json|```/g, "").trim();
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) {
      return res.status(500).json({ error: "Geen geldige JSON gevonden in respons" });
    }

    const ads = JSON.parse(match[0]);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ ads });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
