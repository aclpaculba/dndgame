import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.46.0';
import { callStoryteller } from './storyteller.ts';

const SYSTEM_PROMPT = `You are the game master for "Stackfall", a dark-fantasy, tech-infused, turn-based survival game. The party is fighting a single boss enemy that has its own health bar, shown separately from the players.
Write intense, thrilling, vivid prose (45-90 words) with real stakes — never bland or generic. Weave in the acting player's race, class, and whichever ability score is most relevant to their action, and reference an inventory item if one fits naturally — but do this through story detail, not by stating numbers.
Do NOT state exact numbers, health totals, or damage totals in your prose — the game engine reports those separately.
You MUST respond with ONLY raw JSON (no markdown fences, no commentary) matching exactly:
{"narrative": string, "healthImpact": number, "bossImpact": number, "relevantStat": string, "choices": [string, string, string]}
- "narrative" continues the story and describes the outcome of the acting player's last choice (or opens the tale if there is no prior choice). Keep enough ambiguity that the true severity could still go either way — the actual numbers are randomized by the engine afterward, so don't commit to a precise result in the prose.
- "healthImpact" is your baseline suggestion for the ACTING PLAYER, an integer between -35 and 15 (negative = damage, positive = healing/relief).
- "bossImpact" is your baseline suggestion for the BOSS, an integer between -30 and 10 (negative = damage dealt to the boss, positive = the boss recovering or gaining ground) — most actions aimed at the boss should deal some damage; actions that don't engage the boss directly can use 0.
- "relevantStat" is exactly one of: strength, dexterity, constitution, intelligence, wisdom, charisma — whichever ability best explains why this action might succeed or fail.
- "choices" are exactly three distinct, contextually relevant options for the NEXT player's turn, each under 70 characters, written as second-person actions.`;

const ABILITY_KEYS = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'] as const;
type AbilityKey = typeof ABILITY_KEYS[number];

const BOSS_NAMES = [
  'The Hollow Sovereign',
  'Krael, Ashborn Wyrm',
  'The Static Choir',
  'Mother of Rust',
  'The Unbound Signal',
  'Vaelgrim the Ember-Eater',
];

// Deterministic items — their effects never depend on the story engine,
// so using one always does exactly what it says, regardless of AI
// availability or quota.
const ITEM_POOL = [
  { name: 'Healing Potion', type: 'heal', value: 20, description: 'Restores 20 health.' },
  { name: 'Field Rations', type: 'heal', value: 10, description: 'Restores 10 health.' },
  { name: 'Warhorn', type: 'damage_boss', value: 15, description: "Deals 15 damage to the boss." },
  { name: "Alchemist's Fire", type: 'damage_boss', value: 10, selfDamage: 5, description: 'Deals 10 damage to the boss, but 5 to you.' },
] as const;

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

// Generates a small, random starting inventory for a freshly-created
// character. Called from the client side too (kept here so both share
// the exact same pool/shape), but re-exported for that purpose.
export function rollStartingInventory(count = 2) {
  const items = [];
  for (let i = 0; i < count; i++) {
    const template = ITEM_POOL[Math.floor(Math.random() * ITEM_POOL.length)];
    items.push({ ...template, id: `${Date.now()}-${i}-${Math.floor(Math.random() * 100000)}` });
  }
  return items;
}

function getStatModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

// Works out how much a player's stats should nudge the roll: uses the
// specific ability the story engine flagged as relevant if it gave a
// valid one, otherwise falls back to the player's overall average
// modifier across all six scores.
function resolveModifier(player: any, relevantStat?: string): { modifier: number; statUsed: string } {
  const normalized = (relevantStat || '').toLowerCase();
  const key = (ABILITY_KEYS as readonly string[]).includes(normalized) ? (normalized as AbilityKey) : null;

  if (key) {
    const score = player[key] ?? 8;
    return { modifier: getStatModifier(score), statUsed: key };
  }

  const avg = ABILITY_KEYS.reduce((sum, k) => sum + getStatModifier(player[k] ?? 8), 0) / ABILITY_KEYS.length;
  return { modifier: Math.round(avg), statUsed: 'overall aptitude' };
}

// ---------------- Randomized outcome roll ----------------
// A hidden d20 roll, nudged by the acting player's relevant ability
// score, decides how a story choice actually plays out. Natural 1s
// and 20s always trigger a critical failure/success regardless of
// stats (the classic tabletop convention) — everywhere else, a
// strong, relevant stat makes good rolls a bit better and bad rolls
// a bit milder, without ever guaranteeing the result outright. The
// same roll drives both the acting player's outcome and how much
// damage lands on the boss, so one die decides the whole beat.
type RollOutcome = {
  roll: number;
  modifier: number;
  statUsed: string;
  multiplier: number;
  isCritFail: boolean;
  isCritSuccess: boolean;
  rollLabel: string;
  partyImpact: number;
  partyLabel: string | null;
};

function rollOutcome(modifier: number, statUsed: string): RollOutcome {
  const roll = Math.floor(Math.random() * 20) + 1;

  if (roll === 1) {
    return {
      roll, modifier, statUsed,
      multiplier: 1.8,
      isCritFail: true,
      isCritSuccess: false,
      rollLabel: 'Critical failure!',
      partyImpact: -6,
      partyLabel: 'The disaster catches the rest of the table off guard.',
    };
  }

  if (roll === 20) {
    return {
      roll, modifier, statUsed,
      multiplier: 1.6,
      isCritFail: false,
      isCritSuccess: true,
      rollLabel: 'Critical success!',
      partyImpact: 6,
      partyLabel: 'The table draws confidence from the moment.',
    };
  }

  const base = 0.5 + Math.random() * 0.9; // 0.5x - 1.4x
  const nudge = Math.max(-0.25, Math.min(0.25, modifier * 0.05));
  const multiplier = Math.max(0.2, Math.min(1.6, base + nudge));
  const effectiveRoll = roll + modifier;
  const rollLabel = effectiveRoll <= 6 ? 'A close call.' : effectiveRoll >= 17 ? 'Fortune favors them.' : '';
  return {
    roll, modifier, statUsed, multiplier,
    isCritFail: false, isCritSuccess: false,
    rollLabel, partyImpact: 0, partyLabel: null,
  };
}

function applyRollToPlayerImpact(baseImpact: number, roll: RollOutcome): number {
  if (roll.isCritFail) {
    const impact = Math.min(-15, Math.round(baseImpact * roll.multiplier) - 8);
    return Math.max(-45, impact);
  }
  if (roll.isCritSuccess) {
    const impact = baseImpact < 0 ? Math.abs(Math.round(baseImpact * 0.5)) + 4 : baseImpact + 8;
    return Math.min(25, impact);
  }
  const impact = Math.round(baseImpact * roll.multiplier);
  return Math.max(-40, Math.min(20, impact));
}

function applyRollToBossImpact(baseImpact: number, roll: RollOutcome): number {
  const damagePortion = Math.min(0, baseImpact); // only the damage side scales with the roll
  if (roll.isCritFail) {
    return Math.round(damagePortion * 0.2); // barely scratched it
  }
  if (roll.isCritSuccess) {
    return Math.round(damagePortion * roll.multiplier) - 6; // extra, guaranteed bite
  }
  const impact = Math.round(baseImpact * roll.multiplier);
  return Math.max(-35, Math.min(10, impact));
}

function describeImpact(name: string, impact: number): string {
  if (impact < 0) return `${name} takes ${Math.abs(impact)} damage.`;
  if (impact > 0) return `${name} recovers ${impact} health.`;
  return `${name} comes through unscathed.`;
}

function describeBossImpact(bossName: string, impact: number): string {
  if (impact < 0) return `${bossName} takes ${Math.abs(impact)} damage.`;
  if (impact > 0) return `${bossName} recovers ${impact} health.`;
  return `${bossName} shrugs off the attempt.`;
}

function fallbackStory(kickoff: boolean, actingName: string) {
  if (kickoff) {
    return {
      narrative: 'The rekindled ember throws a thin ring of light across the ruins. Beyond it, something shifts in the dark. The night is listening.',
      healthImpact: 0,
      bossImpact: 0,
      relevantStat: 'constitution',
      choices: ['Search the ruins for a safer path', 'Call into the darkness', 'Keep watch beside the ember'],
    };
  }

  return {
    narrative: `${actingName}'s choice changes the shape of the silence. The ember burns lower, but a narrow path appears beyond the ash.`,
    healthImpact: 0,
    bossImpact: 0,
    relevantStat: 'constitution',
    choices: ['Follow the newly revealed path', 'Protect the ember', 'Wait and listen'],
  };
}

function bossMaxHealthFor(playerCount: number): number {
  return Math.min(160, Math.max(60, playerCount * 30 + 30));
}

export async function generateOne(
  db: SupabaseClient,
  opts: { sessionId: string; choiceIndex?: number; kickoff?: boolean; itemId?: string },
  apiKey: string,
) {
  const { sessionId, choiceIndex, kickoff, itemId } = opts;

  const { data: session, error: sErr } = await db.from('sessions').select('*').eq('id', sessionId).single();
  if (sErr || !session) throw new Error('Session not found.');
  if (session.status !== 'active') throw new Error('This session has ended.');

  const { data: players, error: pErr } = await db
    .from('players').select('*').eq('session_id', sessionId).order('position_in_turn_order');
  if (pErr || !players) throw new Error('Could not load players.');

  // Nothing to narrate yet if no one has joined — and critically, do
  // NOT call resetSessionInternal here: that function deletes players
  // and then calls back into this one with kickoff, which would find
  // zero players again and recurse forever.
  if (players.length === 0) return;

  const actingUid = session.turn_order[session.current_turn_index];
  const actingPlayer = players.find((p: any) => p.user_id === actingUid);
  if (!actingPlayer) throw new Error('Acting player not found.');

  const history = session.story_history ?? [];

  // Joining an already-active session re-triggers a "kickoff" call
  // (see startTableWithRandomCharacter on the client) so the newcomer
  // gets seeded in — but that must NOT re-roll or re-heal the boss
  // once the story has actually started.
  const isFreshKickoff = !!kickoff && history.length === 0;

  let bossName: string = session.boss_name;
  let bossMaxHealth: number = session.boss_max_health;
  let bossHealth: number = session.boss_health;
  if (isFreshKickoff) {
    bossName = BOSS_NAMES[Math.floor(Math.random() * BOSS_NAMES.length)];
    bossMaxHealth = bossMaxHealthFor(players.length);
    bossHealth = bossMaxHealth;
  }

  // ---------------- Item use (fully deterministic, no dice roll) ----------------
  if (itemId) {
    const inventory: any[] = Array.isArray(actingPlayer.inventory) ? actingPlayer.inventory : [];
    const item = inventory.find((it) => it.id === itemId);
    if (!item) throw new Error('Item not found in your inventory.');

    let playerHealthDelta = 0;
    let bossHealthDelta = 0;
    let effectSummary = '';

    if (item.type === 'heal') {
      playerHealthDelta = item.value;
      effectSummary = `They recovered ${item.value} health.`;
    } else if (item.type === 'damage_boss') {
      bossHealthDelta = -item.value;
      if (item.selfDamage) {
        playerHealthDelta = -item.selfDamage;
        effectSummary = `${bossName} took ${item.value} damage, and the backlash cost them ${item.selfDamage} health.`;
      } else {
        effectSummary = `${bossName} took ${item.value} direct damage.`;
      }
    }

    const newHealth = Math.max(0, Math.min(100, actingPlayer.health + playerHealthDelta));
    const isAlive = newHealth > 0;
    const remainingInventory = inventory.filter((it) => it.id !== itemId);

    await db.from('players').update({ health: newHealth, is_alive: isAlive, inventory: remainingInventory })
      .eq('session_id', sessionId).eq('user_id', actingUid);

    const newBossHealth = Math.max(0, Math.min(bossMaxHealth, bossHealth + bossHealthDelta));

    const historyText = history.slice(-6)
      .map((h: any) => h.party
        ? `- (party) ${h.outcome}`
        : `- ${h.player}: ${h.choice} → ${h.outcome}`)
      .join('\n');

    const userPrompt = `Story so far:\n${historyText || '(this is the first turn)'}\n\n${actingPlayer.display_name} just used their ${item.name} (${item.description}). ${effectSummary}
Narrate this moment vividly, then give the next three choices for whichever player will act next. Set healthImpact and bossImpact to 0 in your response — the mechanical effect has already been resolved.`;

    let result;
    try {
      result = await callStoryteller(apiKey, SYSTEM_PROMPT, userPrompt);
    } catch (error) {
      // Any story-engine failure — quota, an empty/truncated response
      // from a reasoning model that ran out of tokens thinking, a
      // malformed reply, etc. — degrades to the local fallback rather
      // than failing the whole turn. The item's mechanical effect has
      // already been applied above regardless, so the player never
      // loses their action to a flaky AI response.
      console.warn('Story engine unavailable; using fallback story.', String(error));
      result = fallbackStory(false, actingPlayer.display_name);
    }

    const narrative = String(result.narrative || effectSummary);
    const updatedPlayers = players.map((p: any) =>
      p.user_id === actingUid ? { ...p, health: newHealth, is_alive: isAlive } : p);
    const aliveCount = updatedPlayers.filter((p: any) => p.is_alive).length;

    const newHistory = [...history, {
      player: actingPlayer.display_name,
      choice: `Used ${item.name}`,
      outcome: narrative.slice(0, 160),
      impact: playerHealthDelta,
      roll: null,
      rollLabel: null,
    }];

    if (newBossHealth <= 0) {
      const summary = `${narrative}\n\n${bossName} finally falls. The table has won the night.`;
      await db.from('sessions').update({
        status: 'completed',
        boss_name: bossName, boss_max_health: bossMaxHealth, boss_health: 0,
        story_narrative: summary, story_choices: [], story_history: newHistory,
        updated_at: new Date().toISOString(),
      }).eq('id', sessionId);
      return;
    }

    if (aliveCount <= 1) {
      const winner = updatedPlayers.find((p: any) => p.is_alive);
      const summary = `${narrative}\n\n${winner ? `${winner.display_name} is the last signal still active.` : 'No one survived the night.'}`;
      await db.from('sessions').update({
        status: 'completed',
        boss_name: bossName, boss_max_health: bossMaxHealth, boss_health: newBossHealth,
        story_narrative: summary, story_choices: [], story_history: newHistory,
        updated_at: new Date().toISOString(),
      }).eq('id', sessionId);
      return;
    }

    let nextIndex = session.current_turn_index;
    const order: string[] = session.turn_order;
    for (let i = 0; i < order.length; i++) {
      nextIndex = (nextIndex + 1) % order.length;
      const p = updatedPlayers.find((pl: any) => pl.user_id === order[nextIndex]);
      if (p && p.is_alive) break;
    }

    await db.from('sessions').update({
      current_turn_index: nextIndex,
      boss_name: bossName, boss_max_health: bossMaxHealth, boss_health: newBossHealth,
      story_narrative: narrative,
      story_choices: (result.choices ?? []).slice(0, 3),
      story_history: newHistory,
      updated_at: new Date().toISOString(),
    }).eq('id', sessionId);
    return;
  }

  // ---------------- Normal turn: kickoff or a chosen story option ----------------
  const historyText = history.slice(-6)
    .map((h: any) => h.party
      ? `- (party) ${h.outcome}`
      : `- ${h.player}: chose "${h.choice}" → ${h.outcome}`)
    .join('\n');

  const inventoryText = Array.isArray(actingPlayer.inventory) && actingPlayer.inventory.length
    ? actingPlayer.inventory.map((it: any) => it.name).join(', ')
    : 'nothing notable';

  let userPrompt: string;
  if (kickoff) {
    userPrompt = `Begin a brand-new session for ${players.length} player(s): ${players.map((p: any) => p.display_name).join(', ')}.
The party faces a boss called ${bossName}.
There is no prior choice yet, so set healthImpact and bossImpact to 0 and write only the opening scene, introducing the boss without stating its health. The first three choices are for ${actingPlayer.display_name}, a ${actingPlayer.race} ${actingPlayer.class} carrying: ${inventoryText}.`;
  } else {
    const choices: string[] = session.story_choices ?? [];
    const chosenText = choices[choiceIndex!];
    if (chosenText === undefined) throw new Error('Invalid choice.');
    userPrompt = `Story so far:\n${historyText || '(this is the first turn)'}\n\nThe boss, ${bossName}, is still in the fight.
${actingPlayer.display_name} (a ${actingPlayer.race} ${actingPlayer.class}, health ${actingPlayer.health}, carrying: ${inventoryText}) just chose: "${chosenText}".
Write the outcome of that choice for ${actingPlayer.display_name} and give the next three choices for whichever player will act next.`;
  }

  let result;
  try {
    result = await callStoryteller(apiKey, SYSTEM_PROMPT, userPrompt);
  } catch (error) {
    // Same reasoning as the item-use branch above: degrade to the
    // local fallback on any story-engine failure so a flaky or
    // over-budget AI response never blocks a player's whole turn.
    console.warn('Story engine unavailable; using fallback story.', String(error));
    result = fallbackStory(!!kickoff, actingPlayer.display_name);
  }

  let updatedPlayers = players;
  let narrative = String(result.narrative || '');
  let appliedImpact = 0;
  let appliedBossImpact = 0;
  let rollLabel = '';
  let rollValue: number | null = null;
  let partyLabel: string | null = null;
  let lootedItemName: string | null = null;

  if (!kickoff) {
    const { modifier, statUsed } = resolveModifier(actingPlayer, result.relevantStat);
    const roll = rollOutcome(modifier, statUsed);
    rollValue = roll.roll;
    rollLabel = roll.rollLabel;
    partyLabel = roll.partyLabel;

    const baseImpact = Math.max(-35, Math.min(15, Math.round(result.healthImpact || 0)));
    appliedImpact = applyRollToPlayerImpact(baseImpact, roll);

    const baseBossImpact = Math.max(-30, Math.min(10, Math.round(result.bossImpact || 0)));
    appliedBossImpact = applyRollToBossImpact(baseBossImpact, roll);

    const newHealth = Math.max(0, Math.min(100, actingPlayer.health + appliedImpact));
    const isAlive = newHealth > 0;

    // A good roll can turn up a new item — guaranteed on a critical
    // success, a decent chance otherwise, never on a critical failure.
    // This is how inventory actually grows over the course of a game,
    // rather than only ever shrinking as items get used.
    let lootedItem: (typeof ITEM_POOL)[number] & { id: string } | null = null;
    if (isAlive && (roll.isCritSuccess || (!roll.isCritFail && Math.random() < 0.3))) {
      const template = ITEM_POOL[Math.floor(Math.random() * ITEM_POOL.length)];
      lootedItem = { ...template, id: `${Date.now()}-loot-${Math.floor(Math.random() * 100000)}` };
    }
    const currentInventory: any[] = Array.isArray(actingPlayer.inventory) ? actingPlayer.inventory : [];
    const newInventory = lootedItem ? [...currentInventory, lootedItem] : currentInventory;

    await db.from('players').update({ health: newHealth, is_alive: isAlive, inventory: newInventory })
      .eq('session_id', sessionId).eq('user_id', actingUid);

    updatedPlayers = players.map((p: any) =>
      p.user_id === actingUid ? { ...p, health: newHealth, is_alive: isAlive, inventory: newInventory } : p);

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

    bossHealth = Math.max(0, Math.min(bossMaxHealth, bossHealth + appliedBossImpact));

    const lines = [
      narrative.trim(),
      describeImpact(actingPlayer.display_name, appliedImpact),
      describeBossImpact(bossName, appliedBossImpact),
    ];
    if (lootedItem) lines.push(`${actingPlayer.display_name} found a ${lootedItem.name}!`);
    if (partyLabel) lines.push(partyLabel);
    narrative = lines.join('\n\n');
    lootedItemName = lootedItem?.name ?? null;
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
      loot: lootedItemName,
    },
    ...(partyLabel ? [{ party: true, outcome: partyLabel, impact: null, roll: null }] : []),
  ];

  if (!kickoff && bossHealth <= 0) {
    const summary = `${narrative}\n\n${bossName} finally falls. The table has won the night.`;
    await db.from('sessions').update({
      status: 'completed',
      boss_name: bossName, boss_max_health: bossMaxHealth, boss_health: 0,
      story_narrative: summary,
      story_choices: [],
      story_history: newHistory,
      updated_at: new Date().toISOString(),
    }).eq('id', sessionId);
    return;
  }

  if (!kickoff && aliveCount <= 1) {
    const winner = updatedPlayers.find((p: any) => p.is_alive);
    const summary = `${narrative}\n\n${winner ? `${winner.display_name} is the last signal still active.` : 'No one survived the night.'}`;
    await db.from('sessions').update({
      status: 'completed',
      boss_name: bossName, boss_max_health: bossMaxHealth, boss_health: bossHealth,
      story_narrative: summary,
      story_choices: [],
      story_history: newHistory,
      updated_at: new Date().toISOString(),
    }).eq('id', sessionId);
    return;
  }

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
    boss_name: bossName, boss_max_health: bossMaxHealth, boss_health: bossHealth,
    story_narrative: narrative,
    story_choices: (result.choices ?? []).slice(0, 3),
    story_history: newHistory,
    updated_at: new Date().toISOString(),
  }).eq('id', sessionId);
}

export async function resetSessionInternal(db: SupabaseClient, sessionId: string, apiKey?: string) {
  const { data: session, error } = await db.from('sessions').select('id').eq('id', sessionId).single();
  if (error || !session) throw new Error('Session not found.');

  // Delete all players
  await db.from('players').delete().eq('session_id', sessionId);
  
  // Delete all messages
  await db.from('messages').delete().eq('session_id', sessionId);
  
  // Reset the session (boss gets a fresh name/health once real players
  // exist again — the next genuine kickoff call re-rolls it properly).
  await db.from('sessions').update({
    status: 'active',
    current_turn_index: 0,
    turn_order: [],
    boss_name: 'The Nameless Dread',
    boss_max_health: 100,
    boss_health: 100,
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

  // Note: no follow-up kickoff call here — there are zero players
  // immediately after the delete above, and generateOne() correctly
  // no-ops in that case. The real kickoff happens naturally once
  // someone actually creates/joins a session and the client calls
  // generate-story with kickoff: true.
}