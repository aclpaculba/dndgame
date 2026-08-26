import { corsHeaders } from '../_shared/cors.ts';
import { adminClient, requireUser, generateOne } from '../_shared/game.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    await requireUser(req);
    const { sessionId, choiceIndex, kickoff } = await req.json();
    if (!sessionId) throw new Error('sessionId is required.');

    const apiKey = Deno.env.get('GEMINI_API_KEY')!;
    const db = adminClient();
    await generateOne(db, { sessionId, choiceIndex, kickoff: !!kickoff }, apiKey);

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, 'content-type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err.message || err) }), {
      status: 400,
      headers: { ...corsHeaders, 'content-type': 'application/json' },
    });
  }
});
