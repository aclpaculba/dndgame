import { corsHeaders } from '../_shared/cors.ts';
import { adminClient, requireUser, generateOne } from '../_shared/game.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const { sessionId, userId, choiceIndex, kickoff, itemId } = await req.json();
    if (!sessionId) throw new Error('sessionId is required.');

    const db = adminClient();
    await requireUser(db, userId);

    const apiKey = Deno.env.get('DEEPSEEK_API_KEY')!;
    await generateOne(db, { sessionId, choiceIndex, kickoff: !!kickoff, itemId }, apiKey);

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