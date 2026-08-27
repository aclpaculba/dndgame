import { corsHeaders } from '../_shared/cors.ts';
import { adminClient, requireUser } from '../_shared/game.ts';
import { callStoryteller } from '../_shared/gemini.ts';

const SYSTEM_PROMPT = `You assign a fantasy class for Last Ember.
Respond with ONLY raw JSON in exactly this shape: {"class": string}.
The class must be exactly one of: Fighter, Rogue, Cleric, Wizard, Ranger, Paladin, Bard, Druid.
Choose the class that best fits the player's answer.`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { userId, answer } = await req.json();
    if (!userId) throw new Error('userId is required.');
    if (!answer || !String(answer).trim()) throw new Error('Tell the storyteller about your character.');

    const db = adminClient();
    await requireUser(db, userId);

    const apiKey = Deno.env.get('GEMINI_API_KEY');
    if (!apiKey) throw new Error('Story engine is not configured.');

    const result = await callStoryteller(
      apiKey,
      SYSTEM_PROMPT,
      `The player answered: "${String(answer).trim().slice(0, 500)}"`,
    );

    const allowedClasses = ['Fighter', 'Rogue', 'Cleric', 'Wizard', 'Ranger', 'Paladin', 'Bard', 'Druid'];
    const assignedClass = allowedClasses.find(
      (className) => className.toLowerCase() === String(result.class || '').trim().toLowerCase(),
    );

    if (!assignedClass) throw new Error('The storyteller could not choose a class. Please try again.');

    return new Response(JSON.stringify({ ok: true, class: assignedClass }), {
      headers: { ...corsHeaders, 'content-type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err.message || err) }), {
      status: 400,
      headers: { ...corsHeaders, 'content-type': 'application/json' },
    });
  }
});
