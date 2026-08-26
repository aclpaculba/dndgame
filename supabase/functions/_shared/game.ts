import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { callStoryteller } from './gemini.ts';

const SYSTEM_PROMPT = `You are the game master for "Last Ember", a dark-fantasy, turn-based survival game.
Write intense, thrilling, vivid prose (120-180 words) with real stakes — never bland or generic.
You MUST respond with ONLY raw JSON (no markdown fences, no commentary) matching exactly:
{"narrative": string, "healthImpact": number, "choices": [string, string, string]}
- "narrative" continues the story and describes the outcome of the acting player's last choice (or opens the tale if there is no prior choice).
- "healthImpact" is an integer between -35 and 15 representing how this outcome affected the acting player's health (negative = damage, positive = healing/relief). Vary it — don't always pick the same number. Occasionally offer higher-risk beats with larger swings as the story progresses.
- "choices" are exactly three distinct, contextually relevant options for the NEXT player's turn, each under 90 characters, written as second-person actions.`;

export function adminClient(): SupabaseClient {
  return createClient(
    Deno.env.get('https://crusicbsdbdqlajgbvsb.supabase.co')!,
    Deno.env.get('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNydXNpY2JzZGJkcWxhamdidnNiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc3MDMxNTgsImV4cCI6MjEwMzI3OTE1OH0.WWdKIiUFA7ewIkVCTSXdnGI0fpLMOg65UifijhL8Fig')!,
  );
}

// There's no Supabase Auth session anymore — a player's identity is
// just a username-backed row in `profiles`, and the client sends that
// profile's id as `userId` with every call. This only checks that the
// id corresponds to a real profile; it is NOT a security boundary
// (anyone who knew or guessed a profile id could pass it), so this is
// meant for casual play, not anything that needs real access control.
export async function requireUser(db: SupabaseClient, userId: string): Promise<void> {
  if (!userId) throw new Error('Sign in first.');
  const { data, error } = await db.from('profiles').select('id').eq('id', userId).maybeSingle();
  if (error || !data) throw new Error('Unknown player — please sign in again.');
}

export async function generateOne(
  db: SupabaseClient,
  opts: { sessionId: string; choiceIndex?: number; kickoff?: boolean },
  apiKey: string,
) {
  const { sessionId, choiceIndex, kickoff } = opts;

  const { data: session, error: sErr } = await db.from('sessions').select('*').eq('id', sessionId).single();
  if (sErr || !session) throw new Error('Session not found.');
  if (session.status !== 'active') throw new Error('This session has ended.');

  const { data: players, error: pErr } = await db
    .from('players').select('*').eq('session_id', sessionId).order('position_in_turn_order');
  if (pErr || !players) throw new Error('Could not load players.');

  const actingUid = session.turn_order[session.current_turn_index];
  const actingPlayer = players.find((p: any) => p.user_id === actingUid);
  if (!actingPlayer) throw new Error('Acting player not found.');

  const history = session.story_history ?? [];
  const historyText = history.slice(-6)
    .map((h: any) => `- ${h.player}: chose "${h.choice}" → ${h.outcome}`).join('\n');

  let userPrompt: string;
  if (kickoff) {
    userPrompt = `Begin a brand-new session for ${players.length} player(s): ${players.map((p: any) => p.display_name).join(', ')}.
There is no prior choice yet, so set healthImpact to 0 and write only the opening scene. The first three choices are for ${actingPlayer.display_name}.`;
  } else {
    const choices: string[] = session.story_choices ?? [];
    const chosenText = choices[choiceIndex!];
    if (chosenText === undefined) throw new Error('Invalid choice.');
    userPrompt = `Story so far:\n${historyText || '(this is the first turn)'}\n\n${actingPlayer.display_name} (health ${actingPlayer.health}) just chose: "${chosenText}".
Write the outcome of that choice for ${actingPlayer.display_name} and give the next three choices for whichever player will act next.`;
  }

  const result = await callStoryteller(apiKey, SYSTEM_PROMPT, userPrompt);

  let updatedPlayers = players;
  if (!kickoff) {
    const impact = Math.max(-35, Math.min(15, Math.round(result.healthImpact || 0)));
    const newHealth = Math.max(0, Math.min(100, actingPlayer.health + impact));
    const isAlive = newHealth > 0;
    await db.from('players').update({ health: newHealth, is_alive: isAlive })
      .eq('session_id', sessionId).eq('user_id', actingUid);
    updatedPlayers = players.map((p: any) => p.user_id === actingUid ? { ...p, health: newHealth, is_alive: isAlive } : p);
  }

  const aliveCount = updatedPlayers.filter((p: any) => p.is_alive).length;
  const newHistory = kickoff ? history : [...history, {
    player: actingPlayer.display_name,
    choice: (session.story_choices ?? [])[choiceIndex!],
    outcome: String(result.narrative).slice(0, 160),
  }];

  if (aliveCount <= 1) {
    const winner = updatedPlayers.find((p: any) => p.is_alive);
    const summary = `${result.narrative}\n\n${winner ? `${winner.display_name} is the last ember still burning.` : 'No one survived the night.'}`;
    await db.from('sessions').update({
      status: 'completed',
      story_narrative: summary,
      story_choices: [],
      story_history: newHistory,
      updated_at: new Date().toISOString(),
    }).eq('id', sessionId);
  } else {
    let nextIndex = session.current_turn_index;
    const order: string[] = session.turn_order;
    if (!kickoff) {
      for (let i = 0; i < order.length; i++) {
        nextIndex = (nextIndex + 1) % order.length;
        const p = updatedPlayers.find((pl: any) => pl.user_id === order[nextIndex]);
        if (p && p.is_alive) break;
      }
    }
    await db.from('sessions').update({
      current_turn_index: nextIndex,
      story_narrative: result.narrative,
      story_choices: (result.choices ?? []).slice(0, 3),
      story_history: newHistory,
      updated_at: new Date().toISOString(),
    }).eq('id', sessionId);
  }
}

export async function resetSessionInternal(db: SupabaseClient, sessionId: string, apiKey?: string) {
  const { data: session, error } = await db.from('sessions').select('id').eq('id', sessionId).single();
  if (error || !session) throw new Error('Session not found.');

  await db.from('players').update({ health: 100, is_alive: true }).eq('session_id', sessionId);
  await db.from('sessions').update({
    status: 'active',
    current_turn_index: 0,
    story_narrative: 'A new tale begins…',
    story_choices: [],
    story_history: [],
    updated_at: new Date().toISOString(),
  }).eq('id', sessionId);

  if (apiKey) {
    await generateOne(db, { sessionId, kickoff: true }, apiKey);
  }
}