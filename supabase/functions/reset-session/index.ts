import { corsHeaders } from '../_shared/cors.ts';
import { adminClient, requireUser, resetSessionInternal } from '../_shared/game.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const { sessionId, userId } = await req.json();
    if (!sessionId) throw new Error('sessionId is required.');

    const db = adminClient();
    await requireUser(db, userId);

    const apiKey = Deno.env.get('AQ.Ab8RN6LVPVRSbv5p38C3hrbIKLxp56A_JApRuoqS0w-Njk1FZA')!;
    await resetSessionInternal(db, sessionId, apiKey);

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