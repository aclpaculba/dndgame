// Calls DeepSeek's OpenAI-compatible chat endpoint and returns parsed JSON.
export async function callStoryteller(apiKey: string, systemPrompt: string, userPrompt: string) {
  const url = 'https://api.deepseek.com/chat/completions';

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 1,
      max_tokens: 900,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Story engine error: ${res.status} ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content ?? '';
  const cleaned = raw.replace(/```json|```/g, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    // Salvage the JSON object if the model wraps it in extra text.
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch { /* fall through to the error below */ }
    }
    console.error('Unparseable story response:', JSON.stringify(data));
    throw new Error('Story engine returned an unreadable response: ' + cleaned.slice(0, 300));
  }
}