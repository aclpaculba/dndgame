import { corsHeaders } from '../_shared/cors.ts';
import { adminClient, requireUser, resetSessionInternal } from '../_shared/game.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const { sessionId, userId, password } = await req.json();
    if (!sessionId) throw new Error('sessionId is required.');

    const db = adminClient();
    await requireUser(db, userId);

    const adminPassword = Deno.env.get('ADMIN_PASSWORD')!;
    if (!password || password !== adminPassword) {
      throw new Error('Incorrect master password.');
    }

    const apiKey = Deno.env.get('GEMINI_API_KEY')!;
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