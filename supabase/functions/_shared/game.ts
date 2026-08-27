import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.46.0';
import { callStoryteller } from './storyteller.ts';

const SYSTEM_PROMPT = `You are the game master for "Stackfall", a dark-fantasy, tech-infused, turn-based survival game.
Write intense, thrilling, vivid prose (45-80 words) with real stakes — never bland or generic.
Do NOT state exact numbers or health totals in your prose — the game engine reports those separately.
You MUST respond with ONLY raw JSON (no markdown fences, no commentary) matching exactly:
{"narrative": string, "healthImpact": number, "choices": [string, string, string]}
- "narrative" continues the story and describes the outcome of the acting player's last choice (or opens the tale if there is no prior choice), using compact paragraphs and specific sensory details. Keep enough ambiguity that the true severity could still go either way — the actual health change is randomized by the engine afterward, so don't commit to a precise result in the prose.
- "healthImpact" is your baseline suggestion, an integer between -35 and 15 (negative = damage, positive = healing/relief) — the engine randomizes around this, so vary it honestly based on how risky the choice was.
- "choices" are exactly three distinct, contextually relevant options for the NEXT player's turn, each under 70 characters, written as second-person actions.`;

function getRuntimeEnv(name: string): string {
  const denoEnv = (globalThis as any).Deno?.env;
  if (denoEnv && typeof denoEnv.get === 'function') {
    return denoEnv.get(name) ?? '';
  }

  const nodeEnv = (globalThis as any).process?.env;
  if (nodeEnv && typeof nodeEnv[name] === 'string') {
    return nodeEnv[name];
  }

  return '';
}

export function adminClient(): SupabaseClient {
  return createClient(
    getRuntimeEnv('SUPABASE_URL'),
    getRuntimeEnv('SUPABASE_SERVICE_ROLE_KEY'),
  );
}

export async function requireUser(db: SupabaseClient, userId: string): Promise<void> {
  if (!userId) throw new Error('Sign in first.');
  const { data, error } = await db.from('profiles').select('id').eq('id', userId).maybeSingle();
  if (error || !data) throw new Error('Unknown player — please sign in again.');
}

// ---------------- Randomized outcome roll ----------------
type RollOutcome = {
  roll: number;
  impact: number;
  rollLabel: string;
  partyImpact: number;
  partyLabel: string | null;
};

function rollOutcome(baseImpact: number): RollOutcome {
  const roll = Math.floor(Math.random() * 20) + 1;

  if (roll === 1) {
    const impact = Math.min(-15, Math.round(baseImpact * 1.8) - 8);
    return {
      roll,
      impact: Math.max(-45, impact),
      rollLabel: 'Critical failure!',
      partyImpact: -6,
      partyLabel: 'The disaster catches the rest of the table off guard.',
    };
  }

  if (roll === 20) {
    const impact = baseImpact < 0 ? Math.abs(Math.round(baseImpact * 0.5)) + 4 : baseImpact + 8;
    return {
      roll,
      impact: Math.min(25, impact),
      rollLabel: 'Critical success!',
      partyImpact: 6,
      partyLabel: 'The table draws confidence from the moment.',
    };
  }

  const variance = 0.5 + Math.random() * 0.9;
  const impact = Math.round(baseImpact * variance);
  const rollLabel = roll <= 5 ? 'A close call.' : roll >= 16 ? 'Fortune favors them.' : '';
  return { roll, impact: Math.max(-40, Math.min(20, impact)), rollLabel, partyImpact: 0, partyLabel: null };
}

function describeImpact(name: string, impact: number): string {
  if (impact < 0) return `${name} takes ${Math.abs(impact)} damage.`;
  if (impact > 0) return `${name} recovers ${impact} health.`;
  return `${name} comes through unscathed.`;
}

function fallbackStory(kickoff: boolean, actingName: string) {
  if (kickoff) {
    return {
      narrative: 'The rekindled ember throws a thin ring of light across the ruins. Beyond it, something shifts in the dark. The night is listening.',
      healthImpact: 0,
      choices: ['Search the ruins for a safer path', 'Call into the darkness', 'Keep watch beside the ember'],
    };
  }

  return {
    narrative: `${actingName}'s choice changes the shape of the silence. The ember burns lower, but a narrow path appears beyond the ash.`,
    healthImpact: 0,
    choices: ['Follow the newly revealed path', 'Protect the ember', 'Wait and listen'],
  };
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

  // If no players, reset the session
  if (players.length === 0) {
    await resetSessionInternal(db, sessionId, apiKey);
    return;
  }

  const actingUid = session.turn_order[session.current_turn_index];
  const actingPlayer = players.find((p: any) => p.user_id === actingUid);
  if (!actingPlayer) throw new Error('Acting player not found.');

  const history = session.story_history ?? [];
  const historyText = history.slice(-6)
    .map((h: any) => h.party
      ? `- (party) ${h.outcome}`
      : `- ${h.player}: chose "${h.choice}" → ${h.outcome}`)
    .join('\n');

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

  let result;
  try {
    result = await callStoryteller(apiKey, SYSTEM_PROMPT, userPrompt);
  } catch (error) {
    const message = String(error);
    if (!message.includes('429') && !message.toLowerCase().includes('quota')) throw error;
    console.warn('Story provider quota reached; using fallback story.', message);
    result = fallbackStory(!!kickoff, actingPlayer.display_name);
  }

  let updatedPlayers = players;
  let narrative = String(result.narrative || '');
  let appliedImpact = 0;
  let rollLabel = '';
  let rollValue: number | null = null;
  let partyLabel: string | null = null;

  if (!kickoff) {
    const baseImpact = Math.max(-35, Math.min(15, Math.round(result.healthImpact || 0)));
    const roll = rollOutcome(baseImpact);
    rollValue = roll.roll;
    appliedImpact = roll.impact;
    rollLabel = roll.rollLabel;
    partyLabel = roll.partyLabel;

    const newHealth = Math.max(0, Math.min(100, actingPlayer.health + appliedImpact));
    const isAlive = newHealth > 0;
    await db.from('players').update({ health: newHealth, is_alive: isAlive })
      .eq('session_id', sessionId).eq('user_id', actingUid);

    updatedPlayers = players.map((p: any) =>
      p.user_id === actingUid ? { ...p, health: newHealth, is_alive: isAlive } : p);

    if (roll.partyImpact !== 0) {
      const others = updatedPlayers.filter((p: any) => p.user_id !== actingUid && p.is_alive);
      for (const other of others) {
        const otherHealth = Math.max(0, Math.min(100, other.health + roll.partyImpact));
        const otherAlive = otherHealth > 0;
        await db.from('players').update({ health: otherHealth, is_alive: otherAlive })
          .eq('session_id', sessionId).eq('user_id', other.user_id);
        updatedPlayers = updatedPlayers.map((p: any) =>
          p.user_id === other.user_id ? { ...p, health: otherHealth, is_alive: otherAlive } : p);
      }
    }

    const lines = [narrative.trim(), describeImpact(actingPlayer.display_name, appliedImpact)];
    if (partyLabel) lines.push(partyLabel);
    narrative = lines.join('\n\n');
  }

  const aliveCount = updatedPlayers.filter((p: any) => p.is_alive).length;

  const newHistory = kickoff ? history : [
    ...history,
    {
      player: actingPlayer.display_name,
      choice: (session.story_choices ?? [])[choiceIndex!],
      outcome: String(result.narrative).slice(0, 160),
      impact: appliedImpact,
      roll: rollValue,
      rollLabel: rollLabel || null,
    },
    ...(partyLabel ? [{ party: true, outcome: partyLabel, impact: null, roll: null }] : []),
  ];

  if (!kickoff && aliveCount <= 1) {
    const winner = updatedPlayers.find((p: any) => p.is_alive);
    const summary = `${narrative}\n\n${winner ? `${winner.display_name} is the last signal still active.` : 'No one survived the night.'}`;
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
      story_narrative: narrative,
      story_choices: (result.choices ?? []).slice(0, 3),
      story_history: newHistory,
      updated_at: new Date().toISOString(),
    }).eq('id', sessionId);
  }
}

export async function resetSessionInternal(db: SupabaseClient, sessionId: string, apiKey?: string) {
  const { data: session, error } = await db.from('sessions').select('id').eq('id', sessionId).single();
  if (error || !session) throw new Error('Session not found.');

  // Delete all players
  await db.from('players').delete().eq('session_id', sessionId);
  
  // Delete all messages
  await db.from('messages').delete().eq('session_id', sessionId);
  
  // Reset the session
  await db.from('sessions').update({
    status: 'active',
    current_turn_index: 0,
    turn_order: [],
    story_narrative: 'A new tale begins… The ember has been rekindled.',
    story_choices: [],
    story_history: [],
    updated_at: new Date().toISOString(),
  }).eq('id', sessionId);

  // Clear active_session_id from all profiles
  await db
    .from('profiles')
    .update({ active_session_id: null })
    .eq('active_session_id', sessionId);

  if (apiKey) {
    await generateOne(db, { sessionId, kickoff: true }, apiKey);
  }
}