// Calls Gemini's free-tier generateContent endpoint and returns parsed JSON.
// Get a free key (no billing required) at https://aistudio.google.com/apikey
export async function callStoryteller(apiKey: string, systemPrompt: string, userPrompt: string) {
  const model = 'gemini-3.6-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 1,
        maxOutputTokens: 900,
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Story engine error: ${res.status} ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const raw = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('\n') ?? '';
  const cleaned = raw.replace(/```json|```/g, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    // Model sometimes wraps or trails the JSON with extra prose even
    // with responseMimeType set. Try to salvage just the {...} block.
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch { /* fall through to the error below */ }
    }
    console.error('Unparseable Gemini response:', JSON.stringify(data));
    throw new Error('Story engine returned an unreadable response: ' + cleaned.slice(0, 300));
  }
}