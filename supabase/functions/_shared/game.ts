import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.46.0';
import { callStoryteller } from './storyteller.ts';

const SYSTEM_PROMPT = `You are the AI Storyteller for "Stackfall: Ashen Edition", a grim, melancholic dark-fantasy survival RPG. Every choice matters, death is permanent unless the engine explicitly reports resurrection, and the party is fighting a living enemy with a health bar — sometimes a regular monster, sometimes a boss. The engine tells you which one and its name; never invent a different name for it.
All characters begin from STR 10, DEX 10, CON 10, INT 10, WIS 10, CHA 10 before coherent racial, class, and background bonuses. Use the modifier bands from -5 to +5 for ability checks. Starting HP is class-based from 6-12 plus CON modifier. The engine applies the mechanics; you narrate their consequences.
Use tabletop-style rules in your reasoning: initiative is d20 + DEX, attacks use d20 + STR/DEX + weapon bonus, damage uses weapon dice + STR/DEX, AC is 10 + DEX + armor + shield. Exploration may test STR 14 to climb, DEX 12 to pick locks, WIS 12 to perceive, INT 15 to decipher, CHA 13 to persuade, or CON 14 to survive. Social actions may use persuasion, intimidation, deception, inspiration, or insight with the relevant ability and background or item.
Write intense, thrilling, vivid prose (45-90 words) with real stakes — never bland or generic. Weave in the acting player's race, class, personality, relevant ability, and inventory when they fit naturally.
Do NOT state exact numbers, health totals, damage totals, or soul totals in prose — the game engine reports those separately and awards souls only for an actual kill, not for narrative color.
You MUST respond with ONLY raw JSON (no markdown fences, no commentary) matching exactly:
{"narrative": string, "healthImpact": number, "bossImpact": number, "relevantStat": string, "choices": [string, string, string]}
- "narrative" continues the story and describes the outcome of the acting player's last choice (or opens the tale if there is no prior choice). Keep enough ambiguity that the true severity could still go either way — the actual numbers are randomized by the engine afterward, so don't commit to a precise result in the prose.
- "healthImpact" is your baseline suggestion for the ACTING PLAYER, an integer between -35 and 15 (negative = damage, positive = healing/relief).
- "bossImpact" is your baseline suggestion for the CURRENT ENEMY (monster or boss, whichever the engine told you is active), an integer between -30 and 10 (negative = damage dealt to it, positive = it recovering or gaining ground) — most actions aimed at the enemy should deal some damage; actions that don't engage it directly can use 0.
- "relevantStat" is exactly one of: strength, dexterity, constitution, intelligence, wisdom, charisma — whichever ability best explains why this action might succeed or fail.
- Souls pay for levels at 100 × current level. Each level grants 3 stat points; the maximum level and stat are 99 and 20. The engine awards souls only when an enemy is actually defeated — never mention a specific soul amount yourself.
- Inventory uses weapon, off-hand, armor, helm, boots, ring1, and ring2 slots. Items may have requirements, bonuses, consumable effects, and weight; never grant impossible equipment without narrative justification.
- Regular monsters are territorial: place them in named regions, show them before they notice the party, and offer fight, sneak, observe, bait, or retreat. Bosses do not roam and are noticeably tougher and more dangerous than a regular monster — describe boss phases at 75%, 50%, and 25% HP thresholds when the engine tells you the current enemy is a boss.
- Always describe visible enemies and their behavior before combat. A stealth action uses DEX, retreat uses CHA, and observation uses WIS when those approaches fit the scene.
- For a fallen character, remember their achievements and treat Ghost Mode as a spectator state. Resurrection, when permitted by the engine, costs 1,000 souls and may grant a permanent Flame-Touched-style mark.
- Death is permanent unless the engine explicitly reports a resurrection. Narrate death with weight and never resolve resurrection, souls, or level-up math yourself.
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

const MONSTER_NAMES = [
  'Hollow Soldier',
  'Ashen Wraith',
  'Rotcrawler',
  'Bloated Ghast',
  'Crypt Rat Swarm',
  'Marsh Leech',
  'Broken Sentinel',
  'Starving Hound',
];

// The canonical world map. This is the single source of truth for
// room flavor — the client's Ashen Map keeps an identical copy (it
// can't import this file directly), but the *position* within it
// lives only here, in sessions.current_room_index. Progression is
// now unbounded (the path never ends), so room names cycle through
// this list with a Roman-numeral suffix once the party loops back
// around — see roomDisplayName().
const ROOMS = [
  { name: 'Ash', flavor: 'A crumbling bonfire throws thin light across the ruins.' },
  { name: 'Gate', flavor: 'A broken gate watches over a road choked with ash.' },
  { name: 'Garden', flavor: 'Darkroot paths wind between trees that no longer grow.' },
  { name: 'Shrine', flavor: 'An old shrine, half-collapsed, still smells of incense.' },
  { name: 'Crypt', flavor: 'Old stones and broken graves line a sunken crypt.' },
  { name: 'Tower', flavor: 'A shattered tower stands under a sky of red lightning.' },
  { name: 'Marsh', flavor: 'Mist clings low over a marsh that swallows footsteps.' },
  { name: 'Keep', flavor: 'A sealed keep, its walls scarred by some old siege.' },
];

const ROMAN_NUMERALS: Array<[number, string]> = [
  [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
  [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
];

function toRoman(n: number): string {
  let result = '';
  for (const [value, symbol] of ROMAN_NUMERALS) {
    while (n >= value) { result += symbol; n -= value; }
  }
  return result;
}

// e.g. room index 8 is a second pass through "Ash" -> "Ash II".
function roomDisplayName(index: number): string {
  const loop = Math.floor(index / ROOMS.length);
  const base = ROOMS[index % ROOMS.length].name;
  return loop > 0 ? `${base} ${toRoman(loop + 1)}` : base;
}

// Every 5th encounter in a room is a boss; the four before it are
// regular monsters. Kept as a named constant so "bosses every 5
// levels" is one obvious number to tune, not something buried in
// arithmetic scattered around the file.
const ENCOUNTERS_PER_BOSS = 5;

function isBossEncounterNumber(n: number): boolean {
  return n % ENCOUNTERS_PER_BOSS === 0;
}

// Difficulty scales with how many rooms the party has cleared.
// current_room_index only advances when a boss is actually
// defeated, so this ramps up permanently and smoothly as the party
// goes deeper — it never resets.
function monsterMaxHealthFor(roomIndex: number): number {
  return Math.min(300, 30 + roomIndex * 8);
}

// Bosses are always meaningfully tougher than a regular monster at
// the same depth, and that gap widens the deeper the party goes —
// this is what makes them "stronger and harder to kill" rather than
// just a differently-named monster with the same stats.
function bossMaxHealthFor(roomIndex: number, playerCount: number): number {
  return Math.min(1500, 90 + roomIndex * 30 + playerCount * 15);
}

function pickEnemyName(isBoss: boolean): string {
  const pool = isBoss ? BOSS_NAMES : MONSTER_NAMES;
  return pool[Math.floor(Math.random() * pool.length)];
}

type Encounter = { name: string; maxHealth: number; isBoss: boolean };

function spawnEncounter(roomIndex: number, encounterNumber: number, playerCount: number): Encounter {
  const isBoss = isBossEncounterNumber(encounterNumber);
  return {
    name: pickEnemyName(isBoss),
    maxHealth: isBoss ? bossMaxHealthFor(roomIndex, playerCount) : monsterMaxHealthFor(roomIndex),
    isBoss,
  };
}

// Souls are awarded ONLY at the moment an enemy is actually
// defeated — never for ordinary narrative success — and a boss
// kill is worth substantially more than a regular monster, scaled
// by depth so early and late kills don't feel the same.
function soulsForDefeat(isBoss: boolean, roomIndex: number): number {
  const base = isBoss ? 200 : 40;
  const scaled = base + roomIndex * (isBoss ? 40 : 8);
  return Math.min(5000, scaled);
}

// Deterministic items — their effects never depend on the story engine,
// so using one always does exactly what it says, regardless of AI
// availability or quota.
const ITEM_POOL = [
  { name: 'Healing Potion', type: 'heal', value: 10, description: 'Restores 10 health.' },
  { name: 'Field Rations', type: 'heal', value: 10, description: 'Restores 10 health.' },
  { name: 'Warhorn', type: 'damage_boss', value: 15, description: "Deals 15 damage to the current enemy." },
  { name: "Alchemist's Fire", type: 'damage_boss', value: 10, selfDamage: 5, description: 'Deals 10 damage to the current enemy, but 5 to you.' },
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
  const healingPotion = ITEM_POOL[0];
  for (let i = 0; i < count; i++) {
    items.push({ ...healingPotion, id: `${Date.now()}-${i}-${Math.floor(Math.random() * 100000)}` });
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
// damage lands on the current enemy, so one die decides the whole beat.
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

function applyRollToEnemyImpact(baseImpact: number, roll: RollOutcome): number {
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

function statusForHealth(health: number, maxHealth: number): string {
  if (health <= 0) return 'Dead';
  const ratio = maxHealth > 0 ? health / maxHealth : 0;
  return ratio <= 0.25 ? 'Critical' : ratio <= 0.55 ? 'Wounded' : 'Healthy';
}

function describeEnemyImpact(enemyName: string, impact: number): string {
  if (impact < 0) return `${enemyName} takes ${Math.abs(impact)} damage.`;
  if (impact > 0) return `${enemyName} recovers ${impact} health.`;
  return `${enemyName} shrugs off the attempt.`;
}

function fallbackStory(kickoff: boolean, actingName: string) {
  if (kickoff) {
    return {
      narrative: `THE BONFIRE FLICKERS\n\nYou awaken at a crumbling bonfire. The sky is the color of ash. You remember nothing but the fire choosing you. Your companions stir beside you: six souls, six destinies, all beginning at the same flame.\n\nThe curse of undeath follows you. The world is dying. Before you stand, you must remember who you are.`,
      healthImpact: 0,
      bossImpact: 0,
      relevantStat: 'constitution',
      choices: ['Begin character creation', 'Listen to the fire', 'Wake your companions'],
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

// Souls/leveling math, shared between the item-use kill path and the
// normal-turn kill path so they can never drift out of sync with
// each other.
function applySoulsAndLevel(player: any, soulsGained: number) {
  const currentSouls = Math.max(0, Number(player.souls || 0));
  const currentLevel = Math.max(1, Math.min(99, Number(player.level || 1)));
  const priorPoints = Math.max(0, Number(player.unallocated_stat_points || 0));
  let nextLevel = currentLevel;
  let statPoints = priorPoints;
  let totalSouls = currentSouls + soulsGained;
  while (nextLevel < 99 && totalSouls >= 100 * nextLevel) {
    totalSouls -= 100 * nextLevel;
    nextLevel += 1;
    statPoints += 3;
  }
  return {
    totalSouls, nextLevel, statPoints,
    leveledUp: nextLevel > currentLevel,
    gainedPoints: statPoints - priorPoints,
  };
}

// Called the instant an enemy's health reaches zero, from either the
// item-use path or the normal roll path. Awards souls/levels to the
// player who landed the kill, decides what comes next (a new monster
// in the same room, or — only after a boss — the party moving on to
// the next room with a fresh monster), and returns everything the
// caller needs to finish narrating and saving the turn. The session
// itself never ends here anymore; only a full party wipe does that.
async function resolveEnemyDefeat(
  db: SupabaseClient,
  sessionId: string,
  actingUid: string,
  actingPlayer: any,
  roomIndex: number,
  encounterNumber: number,
  wasBoss: boolean,
  enemyName: string,
  playerCount: number,
) {
  const soulsGained = soulsForDefeat(wasBoss, roomIndex);
  const { totalSouls, nextLevel, statPoints, leveledUp, gainedPoints } = applySoulsAndLevel(actingPlayer, soulsGained);

  const { error: killUpdateError } = await db.from('players')
    .update({ souls: totalSouls, level: nextLevel, unallocated_stat_points: statPoints })
    .eq('session_id', sessionId).eq('user_id', actingUid);
  if (killUpdateError) {
    console.error('[db] Failed to save kill reward:', JSON.stringify(killUpdateError));
  }

  let newRoomIndex = roomIndex;
  let newEncounterNumber = encounterNumber + 1;
  if (wasBoss) {
    newRoomIndex = roomIndex + 1;
    newEncounterNumber = 1;
  }
  const nextEncounter = spawnEncounter(newRoomIndex, newEncounterNumber, playerCount);

  const transitionLine = wasBoss
    ? `${enemyName} finally falls! The path opens — the party presses onward into ${roomDisplayName(newRoomIndex)}, where ${nextEncounter.name} awaits.`
    : `${enemyName} falls. ${nextEncounter.name} stirs nearby.`;

  const lines = [
    transitionLine,
    `${actingPlayer.display_name} claims ${soulsGained} souls.`,
  ];
  if (leveledUp) lines.push(`${actingPlayer.display_name} reaches Level ${nextLevel} and gains ${gainedPoints} stat points.`);

  return {
    newRoomIndex,
    newEncounterNumber,
    nextEncounter,
    narrativeExtra: lines.join(' '),
  };
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
  // gets seeded in — but that must NOT re-roll or re-heal the current
  // enemy once the story has actually started.
  const isFreshKickoff = !!kickoff && history.length === 0;

  // current_room_index is unbounded now (the path never ends), so it
  // is only ever clamped at 0, never capped at ROOMS.length like it
  // was in the single-boss version.
  const currentRoomIndex = Math.max(0, Number(session.current_room_index) || 0);
  const encounterNumber = Math.max(1, Number(session.encounter_number) || 1);

  let enemyName: string = session.boss_name || 'The Nameless Dread';
  let enemyMaxHealth: number = Number(session.boss_max_health) || 100;
  let enemyHealth: number = Number(session.boss_health) || enemyMaxHealth;
  let isBossNow: boolean = !!session.is_boss_encounter;

  if (isFreshKickoff) {
    const spawned = spawnEncounter(currentRoomIndex, 1, players.length);
    enemyName = spawned.name;
    enemyMaxHealth = spawned.maxHealth;
    enemyHealth = spawned.maxHealth;
    isBossNow = spawned.isBoss;
  }

  // ---------------- Item use (fully deterministic, no dice roll) ----------------
  if (itemId) {
    const inventory: any[] = Array.isArray(actingPlayer.inventory) ? actingPlayer.inventory : [];
    const item = inventory.find((it) => it.id === itemId);
    if (!item) throw new Error('Item not found in your inventory.');

    let playerHealthDelta = 0;
    let enemyHealthDelta = 0;
    let effectSummary = '';

    if (item.type === 'heal') {
      playerHealthDelta = item.value;
      effectSummary = `They recovered ${item.value} health.`;
    } else if (item.type === 'damage_boss') {
      enemyHealthDelta = -item.value;
      if (item.selfDamage) {
        playerHealthDelta = -item.selfDamage;
        effectSummary = `${enemyName} took ${item.value} damage, and the backlash cost them ${item.selfDamage} health.`;
      } else {
        effectSummary = `${enemyName} took ${item.value} direct damage.`;
      }
    }

    const maxHealth = Math.max(1, Number(actingPlayer.max_health || 100));
    const newHealth = Math.max(0, Math.min(maxHealth, actingPlayer.health + playerHealthDelta));
    const isAlive = newHealth > 0;
    const remainingInventory = inventory.filter((it) => it.id !== itemId);

    const { error: itemPlayerUpdateError } = await db.from('players').update({
      health: newHealth, is_alive: isAlive, inventory: remainingInventory,
      status: statusForHealth(newHealth, maxHealth),
    })
      .eq('session_id', sessionId).eq('user_id', actingUid);
    if (itemPlayerUpdateError) {
      console.error('[db] Failed to update player after item use:', JSON.stringify(itemPlayerUpdateError));
      throw new Error('Could not save item effect: ' + itemPlayerUpdateError.message);
    }

    const newEnemyHealth = Math.max(0, Math.min(enemyMaxHealth, enemyHealth + enemyHealthDelta));

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
      console.warn('Story engine unavailable; using fallback story.', String(error));
      result = fallbackStory(false, actingPlayer.display_name);
    }

    let narrative = String(result.narrative || effectSummary);
    const updatedPlayers = players.map((p: any) =>
      p.user_id === actingUid ? { ...p, health: newHealth, is_alive: isAlive, status: statusForHealth(newHealth, maxHealth) } : p);
    const aliveCount = updatedPlayers.filter((p: any) => p.is_alive).length;

    let finalEnemyName = enemyName;
    let finalEnemyMaxHealth = enemyMaxHealth;
    let finalEnemyHealth = newEnemyHealth;
    let finalRoomIndex = currentRoomIndex;
    let finalEncounterNumber = encounterNumber;
    let finalIsBoss = isBossNow;

    if (newEnemyHealth <= 0) {
      const defeat = await resolveEnemyDefeat(
        db, sessionId, actingUid, actingPlayer,
        currentRoomIndex, encounterNumber, isBossNow, enemyName, players.length,
      );
      narrative = `${narrative}\n\n${defeat.narrativeExtra}`;
      finalRoomIndex = defeat.newRoomIndex;
      finalEncounterNumber = defeat.newEncounterNumber;
      finalEnemyName = defeat.nextEncounter.name;
      finalEnemyMaxHealth = defeat.nextEncounter.maxHealth;
      finalEnemyHealth = defeat.nextEncounter.maxHealth;
      finalIsBoss = defeat.nextEncounter.isBoss;
    }

    const newHistory = [...history, {
      player: actingPlayer.display_name,
      choice: `Used ${item.name}`,
      outcome: narrative.slice(0, 160),
      impact: playerHealthDelta,
      roll: null,
      rollLabel: null,
    }];

    if (aliveCount === 0) {
      const summary = `${narrative}\n\nNo one survived the night. The flame fades, and this story is over.`;
      const { error: itemLossError } = await db.from('sessions').update({
        status: 'completed',
        boss_name: finalEnemyName, boss_max_health: finalEnemyMaxHealth, boss_health: finalEnemyHealth,
        is_boss_encounter: finalIsBoss, encounter_number: finalEncounterNumber,
        current_room_index: finalRoomIndex,
        story_narrative: summary, story_choices: [], story_history: newHistory, vote_state: {},
        updated_at: new Date().toISOString(),
      }).eq('id', sessionId);
      if (itemLossError) {
        console.error('[db] Failed to save session-ended update (item use):', JSON.stringify(itemLossError));
        throw new Error('Could not save the session ending: ' + itemLossError.message);
      }
      return;
    }

    let nextIndex = session.current_turn_index;
    const order: string[] = session.turn_order;
    for (let i = 0; i < order.length; i++) {
      nextIndex = (nextIndex + 1) % order.length;
      const p = updatedPlayers.find((pl: any) => pl.user_id === order[nextIndex]);
      if (p && p.is_alive) break;
    }

    const { error: itemTurnError } = await db.from('sessions').update({
      current_turn_index: nextIndex,
      boss_name: finalEnemyName, boss_max_health: finalEnemyMaxHealth, boss_health: finalEnemyHealth,
      is_boss_encounter: finalIsBoss, encounter_number: finalEncounterNumber,
      current_room_index: finalRoomIndex,
      story_narrative: narrative,
      story_choices: (result.choices ?? []).slice(0, 3),
      story_history: newHistory,
      vote_state: {},
      updated_at: new Date().toISOString(),
    }).eq('id', sessionId);
    if (itemTurnError) {
      console.error('[db] Failed to save turn update after item use:', JSON.stringify(itemTurnError));
      throw new Error('Could not save the story update: ' + itemTurnError.message);
    }
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
  const currentRoom = ROOMS[currentRoomIndex % ROOMS.length];
  const enemyKindLabel = isBossNow ? 'boss' : 'monster';
  if (kickoff) {
    userPrompt = `Begin a brand-new session for ${players.length} player(s): ${players.map((p: any) => p.display_name).join(', ')}.
The party's first enemy is a ${enemyKindLabel} called ${enemyName}.
The party begins in the room "${roomDisplayName(currentRoomIndex)}": ${currentRoom.flavor}
There is no prior choice yet. Set healthImpact and bossImpact to 0. Begin at the bonfire with the canonical opening: the player awakens at a crumbling bonfire beneath an ash-colored sky, remembers only that the fire chose them, and sees their companions stir. Do not introduce ${enemyName} yet. The first three choices are for ${actingPlayer.display_name}, a ${actingPlayer.race} ${actingPlayer.class} carrying: ${inventoryText}.`;
  } else {
    const choices: string[] = session.story_choices ?? [];
    const chosenText = choices[choiceIndex!];
    if (chosenText === undefined) throw new Error('Invalid choice.');
    userPrompt = `Story so far:\n${historyText || '(this is the first turn)'}\n\nThe current enemy is a ${enemyKindLabel} called ${enemyName}, still in the fight.
The party is currently in the room "${roomDisplayName(currentRoomIndex)}": ${currentRoom.flavor} Weave this setting into the scene naturally — don't just restate it.
${actingPlayer.display_name} (a ${actingPlayer.race} ${actingPlayer.class}, health ${actingPlayer.health}, carrying: ${inventoryText}) just chose: "${chosenText}".
Write the outcome of that choice for ${actingPlayer.display_name} and give the next three choices for whichever player will act next.`;
  }

  let result;
  try {
    result = await callStoryteller(apiKey, SYSTEM_PROMPT, userPrompt);
  } catch (error) {
    // Any story-engine failure — quota, an empty/truncated response
    // from a reasoning model that ran out of tokens thinking, a
    // malformed reply, etc. — degrades to the local fallback rather
    // than failing the whole turn.
    console.warn('Story engine unavailable; using fallback story.', String(error));
    result = fallbackStory(!!kickoff, actingPlayer.display_name);
  }

  let updatedPlayers = players;
  let narrative = String(result.narrative || '');
  let appliedImpact = 0;
  let appliedEnemyImpact = 0;
  let rollLabel = '';
  let rollValue: number | null = null;
  let partyLabel: string | null = null;
  let lootedItemName: string | null = null;
  let finalRoomIndex = currentRoomIndex;
  let finalEncounterNumber = encounterNumber;
  let finalEnemyName = enemyName;
  let finalEnemyMaxHealth = enemyMaxHealth;
  let finalEnemyHealth = enemyHealth;
  let finalIsBoss = isBossNow;

  if (!kickoff) {
    const { modifier, statUsed } = resolveModifier(actingPlayer, result.relevantStat);
    const roll = rollOutcome(modifier, statUsed);
    rollValue = roll.roll;
    rollLabel = roll.rollLabel;
    partyLabel = roll.partyLabel;

    const baseImpact = Math.max(-35, Math.min(15, Math.round(result.healthImpact || 0)));
    appliedImpact = applyRollToPlayerImpact(baseImpact, roll);

    const baseEnemyImpact = Math.max(-30, Math.min(10, Math.round(result.bossImpact || 0)));
    appliedEnemyImpact = applyRollToEnemyImpact(baseEnemyImpact, roll);

    const maxHealth = Math.max(1, Number(actingPlayer.max_health || 100));
    const newHealth = Math.max(0, Math.min(maxHealth, actingPlayer.health + appliedImpact));
    const isAlive = newHealth > 0;
    const status = statusForHealth(newHealth, maxHealth);

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

    const { error: playerUpdateError } = await db.from('players').update({
      health: newHealth, is_alive: isAlive, inventory: newInventory, status,
    })
      .eq('session_id', sessionId).eq('user_id', actingUid);
    if (playerUpdateError) {
      console.error('[db] Failed to update acting player:', JSON.stringify(playerUpdateError));
      throw new Error('Could not save the acting player\'s new health/inventory: ' + playerUpdateError.message);
    }

    updatedPlayers = players.map((p: any) =>
      p.user_id === actingUid ? { ...p, health: newHealth, is_alive: isAlive, inventory: newInventory, status } : p);

    if (roll.partyImpact !== 0) {
      const others = updatedPlayers.filter((p: any) => p.user_id !== actingUid && p.is_alive);
      for (const other of others) {
        const otherMaxHealth = Math.max(1, Number(other.max_health || 100));
        const otherHealth = Math.max(0, Math.min(otherMaxHealth, other.health + roll.partyImpact));
        const otherAlive = otherHealth > 0;
        const { error: otherUpdateError } = await db.from('players').update({ health: otherHealth, is_alive: otherAlive, status: statusForHealth(otherHealth, otherMaxHealth) })
          .eq('session_id', sessionId).eq('user_id', other.user_id);
        if (otherUpdateError) {
          console.error('[db] Failed to update party-splash player:', JSON.stringify(otherUpdateError));
        }
        updatedPlayers = updatedPlayers.map((p: any) =>
          p.user_id === other.user_id ? { ...p, health: otherHealth, is_alive: otherAlive, status: statusForHealth(otherHealth, otherMaxHealth) } : p);
      }
    }

    finalEnemyHealth = Math.max(0, Math.min(enemyMaxHealth, enemyHealth + appliedEnemyImpact));

    const lines = [
      narrative.trim(),
      describeImpact(actingPlayer.display_name, appliedImpact),
      describeEnemyImpact(enemyName, appliedEnemyImpact),
    ];
    if (lootedItem) lines.push(`${actingPlayer.display_name} found a ${lootedItem.name}!`);
    if (!isAlive) lines.push(`${actingPlayer.display_name} has fallen. The dead pass into Ghost Mode.`);
    if (partyLabel) lines.push(partyLabel);
    lootedItemName = lootedItem?.name ?? null;

    if (finalEnemyHealth <= 0) {
      const defeat = await resolveEnemyDefeat(
        db, sessionId, actingUid, updatedPlayers.find((p: any) => p.user_id === actingUid),
        currentRoomIndex, encounterNumber, isBossNow, enemyName, players.length,
      );
      lines.push(defeat.narrativeExtra);
      finalRoomIndex = defeat.newRoomIndex;
      finalEncounterNumber = defeat.newEncounterNumber;
      finalEnemyName = defeat.nextEncounter.name;
      finalEnemyMaxHealth = defeat.nextEncounter.maxHealth;
      finalEnemyHealth = defeat.nextEncounter.maxHealth;
      finalIsBoss = defeat.nextEncounter.isBoss;
    } else {
      finalEnemyName = enemyName;
      finalEnemyMaxHealth = enemyMaxHealth;
      finalIsBoss = isBossNow;
    }

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
      loot: lootedItemName,
    },
    ...(partyLabel ? [{ party: true, outcome: partyLabel, impact: null, roll: null }] : []),
  ];

  // The session only ever ends on a full party wipe now — defeating
  // an enemy (even a boss) just moves the party onward.
  if (!kickoff && aliveCount === 0) {
    const summary = `${narrative}\n\nNo one survived the night. The flame fades, and this story is over.`;
    const { error: lossUpdateError } = await db.from('sessions').update({
      status: 'completed',
      boss_name: finalEnemyName, boss_max_health: finalEnemyMaxHealth, boss_health: finalEnemyHealth,
      is_boss_encounter: finalIsBoss, encounter_number: finalEncounterNumber,
      current_room_index: finalRoomIndex,
      story_narrative: summary,
      story_choices: [],
      story_history: newHistory,
      vote_state: {},
      updated_at: new Date().toISOString(),
    }).eq('id', sessionId);
    if (lossUpdateError) {
      console.error('[db] Failed to save session-ended update:', JSON.stringify(lossUpdateError));
      throw new Error('Could not save the session ending: ' + lossUpdateError.message);
    }
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

  const { error: turnUpdateError } = await db.from('sessions').update({
    current_turn_index: nextIndex,
    boss_name: finalEnemyName, boss_max_health: finalEnemyMaxHealth, boss_health: finalEnemyHealth,
    is_boss_encounter: finalIsBoss, encounter_number: finalEncounterNumber,
    current_room_index: finalRoomIndex,
    story_narrative: narrative,
    story_choices: (result.choices ?? []).slice(0, 3),
    story_history: newHistory,
    vote_state: {},
    updated_at: new Date().toISOString(),
  }).eq('id', sessionId);
  if (turnUpdateError) {
    console.error('[db] Failed to save turn update:', JSON.stringify(turnUpdateError));
    throw new Error('Could not save the story update: ' + turnUpdateError.message);
  }
}

export async function resetSessionInternal(db: SupabaseClient, sessionId: string, apiKey?: string) {
  const { data: session, error } = await db.from('sessions').select('id').eq('id', sessionId).single();
  if (error || !session) throw new Error('Session not found.');

  // Delete all players
  await db.from('players').delete().eq('session_id', sessionId);

  // Delete all messages
  await db.from('messages').delete().eq('session_id', sessionId);

  // Reset the session (the enemy gets a fresh name/health once real
  // players exist again — the next genuine kickoff call re-rolls it).
  await db.from('sessions').update({
    status: 'active',
    current_turn_index: 0,
    turn_order: [],
    boss_name: 'The Nameless Dread',
    boss_max_health: 100,
    boss_health: 100,
    is_boss_encounter: false,
    encounter_number: 1,
    current_room_index: 0,
    story_narrative: 'A new tale begins… The ember has been rekindled.',
    story_choices: [],
    story_history: [],
    vote_state: {},
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