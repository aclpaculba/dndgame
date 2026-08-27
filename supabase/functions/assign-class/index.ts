import { corsHeaders } from '../_shared/cors.ts';
import { adminClient, requireUser } from '../_shared/game.ts';
import { callStoryteller } from '../_shared/gemini.ts';

const SYSTEM_PROMPT = `Create a surprising random Last Ember fantasy hero.
Respond with ONLY raw JSON in exactly this shape:
{"name": string, "race": string, "class": string, "stats": {"strength": number, "dexterity": number, "constitution": number, "intelligence": number, "wisdom": number, "charisma": number}, "background": string, "personality": string, "ideal": string, "bond": string, "flaw": string}
The race must be exactly one of: Human, Elf, Dwarf, Halfling, Gnome, Half-Elf, Half-Orc.
The class must be exactly one of: Fighter, Rogue, Cleric, Wizard, Ranger, Paladin, Bard, Druid.
Each stat must be an integer from 8 through 15, and the six stats must use no more than 27 point-buy points.
Choose all details randomly but make the result coherent and fun.`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { userId } = await req.json();
    if (!userId) throw new Error('userId is required.');

    const db = adminClient();
    await requireUser(db, userId);

    const apiKey = Deno.env.get('GEMINI_API_KEY');
    if (!apiKey) throw new Error('Story engine is not configured.');

    const result = await callStoryteller(
      apiKey,
      SYSTEM_PROMPT,
      'Generate one random hero now.',
    );

    const allowedRaces = ['Human', 'Elf', 'Dwarf', 'Halfling', 'Gnome', 'Half-Elf', 'Half-Orc'];
    const allowedClasses = ['Fighter', 'Rogue', 'Cleric', 'Wizard', 'Ranger', 'Paladin', 'Bard', 'Druid'];
    const assignedRace = allowedRaces.find(
      (race) => race.toLowerCase() === String(result.race || '').trim().toLowerCase(),
    );
    const assignedClass = allowedClasses.find(
      (className) => className.toLowerCase() === String(result.class || '').trim().toLowerCase(),
    );
    const stats = result.stats || {};
    const statNames = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];
    const validStats = statNames.every((stat) => Number.isInteger(stats[stat]) && stats[stat] >= 8 && stats[stat] <= 15);
    const pointCost = statNames.reduce((total, stat) => {
      const value = stats[stat];
      return total + (value <= 13 ? value - 8 : value === 14 ? 7 : 9);
    }, 0);

    if (!assignedRace || !assignedClass || !validStats || pointCost > 27) {
      throw new Error('The storyteller returned an invalid character. Please try again.');
    }

    return new Response(JSON.stringify({
      ok: true,
      character: {
        name: String(result.name || 'The Nameless Ember').slice(0, 24),
        race: assignedRace,
        class: assignedClass,
        stats,
        background: String(result.background || '').slice(0, 200),
        personality: String(result.personality || '').slice(0, 200),
        ideal: String(result.ideal || '').slice(0, 200),
        bond: String(result.bond || '').slice(0, 200),
        flaw: String(result.flaw || '').slice(0, 200),
      },
    }), {
      headers: { ...corsHeaders, 'content-type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err.message || err) }), {
      status: 400,
      headers: { ...corsHeaders, 'content-type': 'application/json' },
    });
  }
});
