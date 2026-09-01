// Stackfall — Modern Client Application Logic
// With Character Creation, Stats System, and Realtime Fixes
// ============================================================

// ---------- Sound Manager ----------
class SoundManager {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.initAudio();
  }

  initAudio() {
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch {
      this.enabled = false;
    }
  }

  playTone(freq, duration, type = 'sine', volume = 0.1) {
    if (!this.enabled || !this.ctx) return;
    try {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.value = volume;
      gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start();
      osc.stop(this.ctx.currentTime + duration);
    } catch { /* Silently fail */ }
  }

  playTurn() {
    this.playTone(523, 0.12);
    setTimeout(() => this.playTone(659, 0.12), 100);
    setTimeout(() => this.playTone(784, 0.15), 200);
  }

  playDamage() {
    this.playTone(200, 0.3, 'sawtooth', 0.08);
  }

  playHeal() {
    this.playTone(600, 0.15);
    setTimeout(() => this.playTone(800, 0.15), 120);
    setTimeout(() => this.playTone(1000, 0.2), 240);
  }

  playClick() {
    this.playTone(800, 0.05, 'sine', 0.05);
  }

  playWin() {
    [523, 659, 784, 1047].forEach((freq, i) => {
      setTimeout(() => this.playTone(freq, 0.2), i * 150);
    });
  }
}

// ---------- Global State ----------
let currentUser = null;
let currentCharacter = null;
let currentSessionId = null;
let gameChannel = null;
let lobbyChannel = null;
let latestPlayers = [];
let latestSession = null;
let characters = [];
let latestCharactersById = new Map();
let autoResetTimer = null;
let pendingTableStartSessionId = null;
let isGeneratingStory = false;  
let refreshTimeout = null;      
let lastStoryVersion = '';
let lastImageNarrative = '';

const STORAGE_KEY = 'lastEmberUser';
const CHAR_STORAGE_KEY = 'lastEmberCharacter';
const RANDOM_CHAR_STORAGE_KEY = 'lastEmberRandomCharacter';
const sounds = new SoundManager();

// ---------- DOM Helpers ----------
function $(id) { return document.getElementById(id); }

async function extractFunctionError(error, fallbackData) {
  if (fallbackData?.error) return fallbackData.error;
  try {
    if (error?.context && typeof error.context.json === 'function') {
      const body = await error.context.json();
      if (body?.error) return body.error;
    }
  } catch {
    // Fall back to the SDK message when the response body is unavailable.
  }
  return error?.message || 'Unknown error.';
}

function showScreen(id) {
  const screens = document.querySelectorAll('.screen');
  screens.forEach(s => {
    s.classList.remove('active');
    s.style.opacity = '0';
  });
  
  const target = $(id);
  if (!target) return;
  
  target.classList.add('active');
  requestAnimationFrame(() => {
    target.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
    target.style.opacity = '1';
  });
}

function toast(msg, ms = 3200, type = 'info') {
  const t = $('toast');
  if (!t) return;
  
  t.textContent = msg;
  t.className = 'toast';
  t.classList.remove('hidden');
  
  if (type === 'error') t.style.borderColor = '#e17055';
  else if (type === 'success') t.style.borderColor = '#00b894';
  else t.style.borderColor = 'var(--glass-border)';
  
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}

function applyTheme(mode) {
  const isPlain = mode === 'animated';
  document.body.classList.toggle('theme-plain', isPlain);
  const label = isPlain ? 'Plain mode: On' : 'Plain mode: Off';
  const t1 = $('ui-mode-toggle');
  const t2 = $('ui-mode-toggle-2');
  if (t1) t1.textContent = label;
  if (t2) t2.textContent = label;
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

// ---------- Stat Helper Functions ----------
function getStatModifier(stat) {
  return Math.floor((stat - 10) / 2);
}

function getModifierDisplay(mod) {
  return mod >= 0 ? `+${mod}` : `${mod}`;
}

function getModifierClass(mod) {
  return mod >= 0 ? 'positive' : 'negative';
}

function getDefaultStats() {
  return {
    strength: 10,
    dexterity: 10,
    constitution: 10,
    intelligence: 10,
    wisdom: 10,
    charisma: 10
  };
}

function calculatePointBuyCost(stats) {
  const values = Object.values(stats);
  let cost = 0;
  for (const val of values) {
    if (val <= 13) cost += val - 8;
    else if (val === 14) cost += 7;
    else if (val === 15) cost += 9;
  }
  return cost;
}

function getAvailablePoints(stats) {
  return 0;
}

function statIsValid(stats) {
  return Object.values(stats).every(v => v >= 1 && v <= 20);
}

function getHitPoints(constitution, level = 1) {
  const conMod = getStatModifier(constitution);
  return 10 + conMod;
}

// ---------- Character Management ----------
async function loadCharacters() {
  if (!currentUser) return;
  
  try {
    const { data, error } = await sb
      .from('characters')
      .select('*')
      .eq('profile_id', currentUser.uid)
      .order('created_at', { ascending: true });
    
    if (error) throw error;
    characters = data || [];
    renderCharacterList();
    
    const savedCharId = localStorage.getItem(CHAR_STORAGE_KEY);
    if (savedCharId && characters.some(c => c.id === savedCharId)) {
      currentCharacter = characters.find(c => c.id === savedCharId);
    }
  } catch (err) {
    console.error('Failed to load characters:', err);
    toast('Could not load characters: ' + err.message, 3000, 'error');
  }
}

async function saveCharacter(characterData) {
  if (!currentUser) return;
  
  try {
    const { data, error } = await sb
      .from('characters')
      .insert({
        ...characterData,
        profile_id: currentUser.uid
      })
      .select()
      .single();
    
    if (error) throw error;
    
    characters.push(data);
    renderCharacterList();
    toast(`${data.name} has been created!`, 2500, 'success');
    sounds.playClick();
    
    const modal = $('modal-character-creation');
    if (modal) modal.close();
    
    return data;
  } catch (err) {
    console.error('Failed to save character:', err);
    toast('Could not save character: ' + err.message, 3000, 'error');
  }
}

async function deleteCharacter(charId) {
  if (!confirm('Are you sure you want to delete this character?')) return;
  
  try {
    const { error } = await sb
      .from('characters')
      .delete()
      .eq('id', charId)
      .eq('profile_id', currentUser.uid);
    
    if (error) throw error;
    
    characters = characters.filter(c => c.id !== charId);
    if (currentCharacter && currentCharacter.id === charId) {
      currentCharacter = null;
      localStorage.removeItem(CHAR_STORAGE_KEY);
    }
    renderCharacterList();
    toast('Character deleted.', 2000);
  } catch (err) {
    console.error('Failed to delete character:', err);
    toast('Could not delete character: ' + err.message, 3000, 'error');
  }
}

function selectCharacter(charId) {
  const char = characters.find(c => c.id === charId);
  if (!char) return;
  
  currentCharacter = char;
  localStorage.setItem(CHAR_STORAGE_KEY, charId);
  renderCharacterList();
  toast(`Selected ${char.name}`, 2000, 'success');
  sounds.playClick();
  
  enterLobby();
}

function showCharacterStats(charId) {
  const char = characters.find(c => c.id === charId) || currentCharacter;
  if (!char) {
    toast('No character selected.', 3000, 'error');
    return;
  }
  
  const stats = {
    strength: char.strength || 8,
    dexterity: char.dexterity || 8,
    constitution: char.constitution || 8,
    intelligence: char.intelligence || 8,
    wisdom: char.wisdom || 8,
    charisma: char.charisma || 8
  };
  
  const content = $('stats-content');
  if (!content) return;

  content.innerHTML = `
    <div style="text-align: center; margin-bottom: var(--space-md);">
      <h3 style="margin: var(--space-xs) 0;">${escapeHtml(char.name)}</h3>
      <p class="text-secondary">${escapeHtml(char.race)} · ${escapeHtml(char.class)} · Level ${char.level || 1}</p>
      <p style="font-size: 0.85rem; color: var(--text-muted);">HP: ${getHitPoints(char.constitution || 8, char.level || 1)}</p>
    </div>
    
    <div class="stats-sheet">
      <div class="stat-item">
        <span class="stat-label">Strength</span>
        <span class="stat-value">${stats.strength}</span>
        <span class="stat-mod ${getModifierClass(getStatModifier(stats.strength))}">${getModifierDisplay(getStatModifier(stats.strength))}</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">Dexterity</span>
        <span class="stat-value">${stats.dexterity}</span>
        <span class="stat-mod ${getModifierClass(getStatModifier(stats.dexterity))}">${getModifierDisplay(getStatModifier(stats.dexterity))}</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">Constitution</span>
        <span class="stat-value">${stats.constitution}</span>
        <span class="stat-mod ${getModifierClass(getStatModifier(stats.constitution))}">${getModifierDisplay(getStatModifier(stats.constitution))}</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">Intelligence</span>
        <span class="stat-value">${stats.intelligence}</span>
        <span class="stat-mod ${getModifierClass(getStatModifier(stats.intelligence))}">${getModifierDisplay(getStatModifier(stats.intelligence))}</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">Wisdom</span>
        <span class="stat-value">${stats.wisdom}</span>
        <span class="stat-mod ${getModifierClass(getStatModifier(stats.wisdom))}">${getModifierDisplay(getStatModifier(stats.wisdom))}</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">Charisma</span>
        <span class="stat-value">${stats.charisma}</span>
        <span class="stat-mod ${getModifierClass(getStatModifier(stats.charisma))}">${getModifierDisplay(getStatModifier(stats.charisma))}</span>
      </div>
    </div>
    
    ${char.background || char.personality || char.ideal || char.bond || char.flaw ? `
      <div class="stats-info">
        ${char.background ? `<div class="info-item"><span class="label">Background</span><span>${escapeHtml(char.background)}</span></div>` : ''}
        ${char.personality ? `<div class="info-item"><span class="label">Personality</span><span>${escapeHtml(char.personality)}</span></div>` : ''}
        ${char.ideal ? `<div class="info-item"><span class="label">Ideal</span><span>${escapeHtml(char.ideal)}</span></div>` : ''}
        ${char.bond ? `<div class="info-item"><span class="label">Bond</span><span>${escapeHtml(char.bond)}</span></div>` : ''}
        ${char.flaw ? `<div class="info-item"><span class="label">Flaw</span><span>${escapeHtml(char.flaw)}</span></div>` : ''}
      </div>
    ` : ''}
  `;
  
  const modal = $('modal-character-stats');
  if (modal) modal.showModal();
}

function renderCharacterList() {
  const list = $('character-list');
  if (!list) return;
  
  if (characters.length === 0) {
    list.innerHTML = `
      <p class="text-muted" style="padding: var(--space-lg); text-align: center; grid-column: 1 / -1;">
        No characters yet. Create your first adventure!
      </p>
    `;
    return;
  }
  
  list.innerHTML = characters.map(char => {
    const isSelected = currentCharacter && currentCharacter.id === char.id;
    const hp = getHitPoints(char.constitution || 8, char.level || 1);
    
    return `
      <div class="character-card ${isSelected ? 'selected' : ''}" style="${isSelected ? 'border-color: #6c5ce7;' : ''}">
        <div class="char-name">${escapeHtml(char.name)}</div>
        <div class="char-class-race">${escapeHtml(char.race)} · ${escapeHtml(char.class)}</div>
        <div class="char-level">Level ${char.level || 1} · ${hp} HP</div>
        <div style="display: flex; gap: var(--space-xs); margin-top: var(--space-sm); flex-wrap: wrap;">
          <button class="btn btn-primary btn-sm char-select-btn" data-char-id="${char.id}">
            ${isSelected ? 'Selected' : 'Select'}
          </button>
          <button class="btn btn-secondary btn-sm char-stats-btn" data-char-id="${char.id}">
            Stats
          </button>
          <button class="btn btn-danger btn-sm char-delete-btn" data-char-id="${char.id}">
            Delete
          </button>
        </div>
      </div>
    `;
  }).join('');
  
  list.querySelectorAll('.char-select-btn').forEach(btn => {
    btn.addEventListener('click', () => selectCharacter(btn.dataset.charId));
  });
  
  list.querySelectorAll('.char-stats-btn').forEach(btn => {
    btn.addEventListener('click', () => showCharacterStats(btn.dataset.charId));
  });
  
  list.querySelectorAll('.char-delete-btn').forEach(btn => {
    btn.addEventListener('click', () => deleteCharacter(btn.dataset.charId));
  });
}

function enterCharacterSelection() {
  showScreen('screen-characters');
  const charEl = $('char-username');
  if (charEl) charEl.textContent = `${currentUser.username}`;
  loadCharacters();
}

// ---------- Character Creation Modal ----------
let currentCharStats = getDefaultStats();

function showCharStep(step) {
  document.querySelectorAll('.char-step').forEach(el => el.classList.remove('active'));
  const target = $(`char-step-${step}`);
  if (target) target.classList.add('active');
  if (step === 2) updateStatsDisplay();
}

function updateStatsDisplay() {
  const statNames = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];
  
  for (const stat of statNames) {
    const valueEl = $(`stat-${stat}`);
    const modEl = $(`mod-${stat}`);
    if (valueEl) {
      valueEl.textContent = currentCharStats[stat];
    }
    if (modEl) {
      const mod = getStatModifier(currentCharStats[stat]);
      modEl.textContent = getModifierDisplay(mod);
      modEl.className = `stat-modifier ${getModifierClass(mod)}`;
    }
  }
  
  const pointsEl = $('stat-points-remaining');
  if (pointsEl) {
    const remaining = getAvailablePoints(currentCharStats);
    pointsEl.textContent = remaining;
    pointsEl.style.color = remaining < 0 ? 'var(--health-low)' : 'var(--text-primary)';
  }
}

function adjustStat(stat, direction) {
  const newValue = currentCharStats[stat] + direction;
  if (newValue < 8 || newValue > 15) return;
  const oldCost = calculatePointBuyCost(currentCharStats);
  const testStats = { ...currentCharStats, [stat]: newValue };
  const newCost = calculatePointBuyCost(testStats);
  if (newCost > 27) {
    toast('Not enough points remaining!', 2000, 'error');
    return;
  }
  currentCharStats = testStats;
  updateStatsDisplay();
  sounds.playClick();
}

// ---------- Auth ----------
$('form-name')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = $('name-error');
  if (errEl) errEl.textContent = '';
  
  const name = $('name-input')?.value.trim();
  if (!name) return;

  const submitBtn = e.target.querySelector('button[type="submit"]');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span>Loading…</span>';
  }
  
  try {
    console.log('1. Checking sb:', sb);
    if (!sb) throw new Error('The database client is unavailable. Check your internet connection and reload the page.');
    
    console.log('2. Calling login_or_create_profile for:', name);
    const { data: profile, error } = await sb.rpc('login_or_create_profile', { p_username: name });
    console.log('3. Profile response:', profile, error);
    
    if (error) throw error;
    if (!profile) throw new Error('No profile returned.');
    
    console.log('4. Setting current user from profile');
    setCurrentUserFromProfile(profile);
    
    console.log('5. Playing click sound');
    sounds.playClick();
    
    console.log('6. Entering lobby');
    enterLobby();
    
  } catch (err) {
    console.error('Login error:', err);
    if (errEl) errEl.textContent = err.message || 'Could not continue — try again.';
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<span>Continue</span><span aria-hidden="true">→</span>';
    }
  }
});

async function tryResumeFromStorage() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) { showScreen('screen-auth'); return; }

  let saved;
  try {
    saved = JSON.parse(raw);
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    showScreen('screen-auth');
    return;
  }

  const { data: profile } = await sb.from('profiles').select('*').eq('id', saved.uid).maybeSingle();
  if (!profile) {
    localStorage.removeItem(STORAGE_KEY);
    showScreen('screen-auth');
    return;
  }

  setCurrentUserFromProfile(profile);

  const savedRandomCharacter = localStorage.getItem(RANDOM_CHAR_STORAGE_KEY);
  if (savedRandomCharacter) {
    try { currentCharacter = JSON.parse(savedRandomCharacter); } catch { currentCharacter = null; }
  }
  
  const savedCharId = localStorage.getItem(CHAR_STORAGE_KEY);
  if (savedCharId) {
    await loadCharacters();
    if (currentCharacter) {
      enterLobby();
      return;
    }
  }
  
  enterLobby();
}

function signOut() {
  teardownSubscriptions();
  currentUser = null;
  currentCharacter = null;
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(CHAR_STORAGE_KEY);
  localStorage.removeItem(RANDOM_CHAR_STORAGE_KEY);
  const nameInput = $('name-input');
  if (nameInput) nameInput.value = '';
  showScreen('screen-auth');
  toast('Signed out successfully');
}

$('btn-char-logout')?.addEventListener('click', signOut);
$('btn-logout')?.addEventListener('click', signOut);

// ---------- Character Creation Events ----------
$('btn-create-character')?.addEventListener('click', () => {
  currentCharStats = getDefaultStats();
  updateStatsDisplay();
  const nameInput = $('char-name');
  if (nameInput) nameInput.value = '';
  const questionInput = $('char-question');
  if (questionInput) questionInput.value = '';
  showCharStep(1);
  const modal = $('modal-character-creation');
  if (modal) modal.showModal();
});

$('btn-creation-close')?.addEventListener('click', () => {
  const modal = $('modal-character-creation');
  if (modal) modal.close();
});

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.stat-btn');
  if (btn) {
    const stat = btn.dataset.stat;
    const dir = parseInt(btn.dataset.dir);
    adjustStat(stat, dir);
  }
});

$('form-character-creation')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!pendingTableStartSessionId) return;
  const sessionId = pendingTableStartSessionId;
  pendingTableStartSessionId = null;
  await startTableWithRandomCharacter(sessionId);
});

// ---------- UI Mode Toggle ----------
async function toggleUiMode() {
  if (!currentUser) return;
  const next = currentUser.preferredUiMode === 'animated' ? 'simple' : 'animated';
  currentUser.preferredUiMode = next;
  applyTheme(next);
  sounds.playClick();
  await sb.from('profiles').update({ preferred_ui_mode: next }).eq('id', currentUser.uid);
}

$('ui-mode-toggle')?.addEventListener('click', toggleUiMode);
$('ui-mode-toggle-2')?.addEventListener('click', toggleUiMode);

// ---------- User Management ----------
function setCurrentUserFromProfile(profile) {
  currentUser = {
    uid: profile.id,
    username: profile.username,
    preferredUiMode: profile.preferred_ui_mode || 'simple',
    activeSessionId: profile.active_session_id,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ uid: profile.id, username: profile.username }));
  applyTheme(currentUser.preferredUiMode);
  
  const el = $('lobby-username');
  if (el) el.textContent = `${currentUser.username}`;
  const charEl = $('char-username');
  if (charEl) charEl.textContent = `${currentUser.username}`;
}

// ---------- Lobby ----------
async function refreshLobbyList() {
  const { data: sessions } = await sb.from('sessions').select('*').eq('status', 'active');
  const list = $('session-list');
  if (!list) return;
  
  const rows = [];
  for (const s of sessions || []) {
    const { count } = await sb.from('players').select('*', { count: 'exact', head: true }).eq('session_id', s.id);
    if ((count ?? 0) >= 6) continue;
    const isOwn = s.creator_id === currentUser.uid;
    rows.push(`
      <div class="session-item">
        <div>
          <div style="font-weight: 600;">${escapeHtml(s.creator_name || 'A traveler')}'s table</div>
          <div class="session-meta">${count ?? 0}/6 players · ${s.id.slice(0, 6).toUpperCase()}</div>
        </div>
        <div class="session-item-actions">
          <button class="btn btn-secondary btn-sm" data-join="${s.id}">
            Join →
          </button>
          ${isOwn ? `<button class="btn btn-danger btn-sm" data-delete="${s.id}">Delete</button>` : ''}
        </div>
      </div>
    `);
  }
  
  list.innerHTML = rows.join('');
  const empty = $('session-list-empty');
  if (empty) empty.classList.toggle('hidden', rows.length > 0);
  
  list.querySelectorAll('[data-join]').forEach(b => {
    b.addEventListener('click', () => {
      sounds.playClick();
      joinSession(b.dataset.join);
    });
  });

  list.querySelectorAll('[data-delete]').forEach(b => {
    b.addEventListener('click', () => {
      sounds.playClick();
      deleteSession(b.dataset.delete);
    });
  });
}

async function deleteSession(sessionId) {
  if (!confirm('Delete this table? This removes it for everyone and cannot be undone.')) return;

  try {
    const { error } = await sb.from('sessions').delete().eq('id', sessionId);
    if (error) throw error;

    await sb.from('profiles').update({ active_session_id: null }).eq('active_session_id', sessionId);

    if (currentUser.activeSessionId === sessionId) {
      currentUser.activeSessionId = null;
      const banner = $('active-session-banner');
      if (banner) banner.classList.add('hidden');
    }

    toast('Table deleted.', 2500);
  } catch (err) {
    console.error('Failed to delete session:', err);
    toast('Could not delete table: ' + (err.message || err), 3500, 'error');
  }
}

function enterLobby() {
  showScreen('screen-lobby');
  const banner = $('active-session-banner');
  if (banner) banner.classList.toggle('hidden', !currentUser.activeSessionId);

  refreshLobbyList();
  
  if (lobbyChannel) {
    sb.removeChannel(lobbyChannel);
    lobbyChannel = null;
  }
  
  lobbyChannel = sb.channel('lobby-sessions');
  
  lobbyChannel
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions' }, refreshLobbyList)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'players' }, refreshLobbyList);
  
  lobbyChannel.subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      console.log('Lobby channel connected');
    } else if (status === 'CHANNEL_ERROR') {
      console.error('Lobby channel error');
    }
  });
}

// ---------- Session Management ----------
const ITEM_POOL = [
  { name: 'Healing Potion', type: 'heal', value: 10, description: 'Restores 10 health.' },
  { name: 'Field Rations', type: 'heal', value: 10, description: 'Restores 10 health.' },
  { name: 'Warhorn', type: 'damage_boss', value: 15, description: 'Deals 15 damage to the boss.' },
  { name: "Alchemist's Fire", type: 'damage_boss', value: 10, selfDamage: 5, description: 'Deals 10 damage to the boss, but 5 to you.' },
];

function rollStartingInventory(count = 2) {
  const items = [];
  const healingPotion = ITEM_POOL[0];
  for (let i = 0; i < count; i++) {
    items.push({ ...healingPotion, id: `${Date.now()}-${i}-${Math.floor(Math.random() * 100000)}` });
  }
  return items;
}

function starterGearForClass(className) {
  const loadouts = {
    Fighter: [['Main Hand', 'Longsword', '+1 Attack · 1d8 slashing · STR 10 · Weight 3'], ['Off Hand', 'Wooden Shield', '+2 AC · STR 10 · Weight 5'], ['Armor', 'Chainmail', '+4 AC · -1 DEX · STR 10 · Weight 15']],
    Paladin: [['Main Hand', 'Mace', '+1 Attack · 1d6 bludgeoning · STR 10 · Weight 4'], ['Off Hand', 'Wooden Shield', '+2 AC · STR 10 · Weight 5'], ['Armor', 'Chainmail', '+4 AC · -1 DEX · STR 10 · Weight 15']],
    Rogue: [['Main Hand', 'Dagger', '+2 Attack · 1d4 piercing · DEX 8 · Weight 1'], ['Off Hand', 'Shortbow', '+2 Attack · 1d6 ranged · DEX 10 · Weight 2'], ['Armor', 'Leather Armor', '+2 AC · DEX 8 · Weight 5']],
    Wizard: [['Main Hand', 'Long Staff', '0 Attack · 1d4 · INT 10 · Spell focus · Weight 2'], ['Ring 1', 'Ring of Protection', '+1 AC · Weight 0'], ['Armor', 'Leather Armor', '+2 AC · DEX 8 · Weight 5']],
    Ranger: [['Main Hand', 'Longbow', '+1 Attack · 1d8 ranged · DEX 12 · Weight 3'], ['Off Hand', 'Short Sword', '+1 Attack · 1d6 versatile · STR 8 · Weight 2'], ['Armor', 'Leather Armor', '+2 AC · DEX 8 · Weight 5']],
    Cleric: [['Main Hand', 'Mace', '+1 Attack · 1d6 bludgeoning · STR 10 · Weight 4'], ['Off Hand', 'Wooden Shield', '+2 AC · STR 10 · Weight 5'], ['Armor', 'Chainmail', '+4 AC · -1 DEX · STR 10 · Weight 15']],
    Bard: [['Main Hand', 'Shortsword', '+1 Attack · 1d6 versatile · STR 8 · Weight 2'], ['Armor', 'Leather Armor', '+2 AC · DEX 8 · Weight 5'], ['Ring 1', 'Gold Ring', '+1 Persuasion · Value 100 souls · Weight 0']],
    Druid: [['Main Hand', 'Long Staff', '0 Attack · 1d4 · INT 10 · Spell focus · Weight 2'], ['Armor', 'Leather Armor', '+2 AC · DEX 8 · Weight 5'], ['Ring 1', 'Holy Amulet', '+2 healing · Weight 0']]
  };
  return (loadouts[className] || loadouts.Fighter).map(([slot, name, specification], index) => ({ slot, name, specification, type: 'gear', id: `gear-${className}-${index}` }));
}

function createRandomCharacter() {
  const stats = getDefaultStats();

  const races = ['Human', 'Elf', 'Dwarf', 'Halfling', 'Gnome', 'Half-Elf', 'Half-Orc'];
  const classes = ['Fighter', 'Rogue', 'Cleric', 'Wizard', 'Ranger', 'Paladin', 'Bard', 'Druid'];
  const backgrounds = ['Noble', 'Soldier', 'Urchin', 'Sage', 'Criminal', 'Folk Hero', 'Acolyte'];
  const pick = values => values[Math.floor(Math.random() * values.length)];
  const chosenClass = pick(classes);
  const classBonuses = {
    Fighter: { strength: 2, constitution: 1 }, Rogue: { dexterity: 2, charisma: 1 },
    Cleric: { wisdom: 2, constitution: 1 }, Wizard: { intelligence: 2, wisdom: 1 },
    Ranger: { dexterity: 2, wisdom: 1 }, Paladin: { strength: 2, charisma: 1 },
    Bard: { charisma: 2, dexterity: 1 }, Druid: { wisdom: 2, intelligence: 1 }
  };
  for (const [stat, bonus] of Object.entries(classBonuses[chosenClass])) stats[stat] += bonus;

  return {
    name: currentUser.username,
    race: pick(races),
    class: chosenClass,
    level: 1,
    ...stats,
    background: pick(backgrounds),
    personality: '',
    ideal: '',
    bond: '',
    flaw: '',
    inventory: [...starterGearForClass(chosenClass), ...rollStartingInventory(2)],
  };
}

async function startTableWithRandomCharacter(sessionId, { triggerKickoff = true } = {}) {
  currentCharacter = createRandomCharacter();
  localStorage.setItem(RANDOM_CHAR_STORAGE_KEY, JSON.stringify(currentCharacter));
  
  const { error: playerError } = await sb.from('players').update({
    display_name: currentCharacter.name,
    race: currentCharacter.race,
    class: currentCharacter.class,
    strength: currentCharacter.strength,
    dexterity: currentCharacter.dexterity,
    constitution: currentCharacter.constitution,
    intelligence: currentCharacter.intelligence,
    wisdom: currentCharacter.wisdom,
    charisma: currentCharacter.charisma,
    inventory: currentCharacter.inventory,
  }).eq('session_id', sessionId).eq('user_id', currentUser.uid);
  if (playerError) throw playerError;

  if (!triggerKickoff) {
    await refreshGameState();
    return;
  }

  const { data: kickoffData, error: kickoffError } = await sb.functions.invoke('generate-story', {
    body: { sessionId, userId: currentUser.uid, kickoff: true },
  });
  if (kickoffError) {
    console.warn('Story kickoff unavailable; using local opening.', await extractFunctionError(kickoffError, kickoffData));
    await seedLocalOpening(sessionId);
  }
  await refreshGameState();
}

async function seedLocalOpening(sessionId) {
  const { data: session } = await sb.from('sessions').select('story_narrative, story_choices').eq('id', sessionId).single();
  
  if (session && session.story_narrative && session.story_narrative !== 'The story is being written…' && session.story_choices?.length > 0) {
    console.log('Story already exists, skipping local seed');
    return;
  }
  
  const { error } = await sb.from('sessions').update({
    status: 'active',
    current_turn_index: 0,
    story_narrative: 'THE BONFIRE FLICKERS\n\nYou awaken at a crumbling bonfire. The sky is the color of ash. You remember nothing but the fire choosing you. Your companions stir beside you: six souls, six destinies, all beginning at the same flame.\n\nThe curse of undeath follows you. The world is dying. Before you stand, you must remember who you are.',
    story_choices: ['Begin character creation', 'Listen to the fire', 'Wake your companions'],
    story_history: [],
    updated_at: new Date().toISOString(),
  }).eq('id', sessionId);
  if (error) throw error;
}

$('btn-create-session')?.addEventListener('click', async () => {
  try {
    const { data: newSession, error: sErr } = await sb.from('sessions').insert({
      creator_id: currentUser.uid,
      creator_name: currentUser.username,
      turn_order: [currentUser.uid],
    }).select().single();
    if (sErr) throw sErr;

    const { error: pErr } = await sb.from('players').insert({
      session_id: newSession.id,
      user_id: currentUser.uid,
      display_name: currentUser.username,
      position_in_turn_order: 0,
    });
    if (pErr) throw pErr;

    await sb.from('profiles').update({ active_session_id: newSession.id }).eq('id', currentUser.uid);
    currentUser.activeSessionId = newSession.id;

    enterGame(newSession.id);
    await startTableWithRandomCharacter(newSession.id);
  } catch (err) {
    console.error(err);
    toast('Could not create session: ' + (err.message || err), 4000, 'error');
  }
});

async function joinSession(sessionId) {
  try {
    const { data: existing } = await sb.from('players').select('user_id')
      .eq('session_id', sessionId).eq('user_id', currentUser.uid).maybeSingle();
    if (existing) { enterGame(sessionId); return; }

    const { data: sessionRow } = await sb.from('sessions').select('turn_order,status').eq('id', sessionId).single();
    if (!sessionRow || sessionRow.status !== 'active') throw new Error('That session is no longer open.');

    const { count } = await sb.from('players').select('*', { count: 'exact', head: true }).eq('session_id', sessionId);
    if ((count ?? 0) >= 6) throw new Error('That table is full (6 players max).');

    const order = sessionRow.turn_order || [];
    const { error: pErr } = await sb.from('players').insert({
      session_id: sessionId,
      user_id: currentUser.uid,
      display_name: currentUser.username,
      position_in_turn_order: order.length,
    });
    if (pErr) throw pErr;

    await sb.from('sessions').update({ turn_order: [...order, currentUser.uid] }).eq('id', sessionId);
    await sb.from('profiles').update({ active_session_id: sessionId }).eq('id', currentUser.uid);
    currentUser.activeSessionId = sessionId;
    
    enterGame(sessionId);
    await startTableWithRandomCharacter(sessionId, { triggerKickoff: false });
  } catch (err) {
    console.error(err);
    if (err.message?.includes('players_pkey') || err.code === '23505') {
      currentUser.activeSessionId = sessionId;
      enterGame(sessionId);
    } else {
      toast(err.message || 'Could not join that session.', 4000, 'error');
    }
  }
}

$('btn-resume-session')?.addEventListener('click', () => {
  sounds.playClick();
  enterGame(currentUser.activeSessionId);
});

$('btn-leave-session')?.addEventListener('click', () => {
  sounds.playClick();
  teardownSubscriptions();
  enterLobby();
  toast('Left the table.');
});

$('btn-back-to-lobby')?.addEventListener('click', () => {
  teardownSubscriptions();
  enterLobby();
});

$('btn-stats-close')?.addEventListener('click', () => {
  const modal = $('modal-character-stats');
  if (modal) modal.close();
});

$('modal-character-stats')?.addEventListener('click', (e) => {
  if (e.target === e.currentTarget) {
    e.currentTarget.close();
  }
});

// ---------- All-Time Stats ----------
async function openAllTimeStats() {
  const content = $('alltime-content');
  const modal = $('modal-alltime-stats');
  if (!content || !modal || !currentUser) return;

  content.innerHTML = '<p class="text-muted" style="padding: var(--space-md) 0;">Loading…</p>';
  modal.showModal();

  const { data, error } = await sb.from('profiles')
    .select('total_damage_dealt, total_damage_taken, enemies_slain, bosses_slain, sections_cleared, highest_single_hit')
    .eq('id', currentUser.uid).maybeSingle();

  if (error || !data) {
    content.innerHTML = '<p class="text-muted" style="padding: var(--space-md) 0;">Could not load your stats.</p>';
    return;
  }

  content.innerHTML = `
    <div class="stats-sheet">
      <div class="stat-item"><span class="stat-label">Enemies slain</span><span class="stat-value">${data.enemies_slain || 0}</span></div>
      <div class="stat-item"><span class="stat-label">Bosses slain</span><span class="stat-value">${data.bosses_slain || 0}</span></div>
      <div class="stat-item"><span class="stat-label">Sections cleared</span><span class="stat-value">${data.sections_cleared || 0}</span></div>
      <div class="stat-item"><span class="stat-label">Total damage dealt</span><span class="stat-value">${data.total_damage_dealt || 0}</span></div>
      <div class="stat-item"><span class="stat-label">Total damage taken</span><span class="stat-value">${data.total_damage_taken || 0}</span></div>
      <div class="stat-item"><span class="stat-label">Highest single hit</span><span class="stat-value">${data.highest_single_hit || 0}</span></div>
    </div>
    <p class="text-muted ability-info-footnote">These totals follow your username across every table you ever play — they never reset when a session ends.</p>
  `;
}

$('btn-open-alltime')?.addEventListener('click', () => {
  sounds.playClick();
  openAllTimeStats();
});

$('btn-open-alltime-game')?.addEventListener('click', () => {
  sounds.playClick();
  openAllTimeStats();
});

$('btn-alltime-close')?.addEventListener('click', () => {
  const modal = $('modal-alltime-stats');
  if (modal) modal.close();
});

$('modal-alltime-stats')?.addEventListener('click', (e) => {
  if (e.target === e.currentTarget) {
    e.currentTarget.close();
  }
});

// ---------- Game Screen ----------
async function refreshGameState() {
  if (refreshTimeout) {
    clearTimeout(refreshTimeout);
    refreshTimeout = null;
  }
  
  refreshTimeout = setTimeout(async () => {
    refreshTimeout = null;
    
    const [{ data: session }, { data: players }] = await Promise.all([
      sb.from('sessions').select('*').eq('id', currentSessionId).single(),
      sb.from('players').select('*').eq('session_id', currentSessionId).order('position_in_turn_order'),
    ]);
    if (!session) return;
    
    const storyHash = (session.story_narrative || '') + (session.story_choices || []).join(',');
    if (storyHash === lastStoryVersion && session.status !== 'completed') {
      return;
    }
    lastStoryVersion = storyHash;
    
    latestSession = session;
    latestPlayers = players || [];
    latestCharactersById = new Map();
    
    // Only regenerate image if the narrative actually changed
    const narrativeChanged = (session.story_narrative || '') !== lastImageNarrative;
    
    renderGame();
    
    // Generate image only if narrative changed (not for intermediate player updates)
    if (narrativeChanged && (latestSession.story_history || []).length > 0) {
      lastImageNarrative = session.story_narrative || '';
      const last = latestSession.story_history[latestSession.story_history.length - 1];
      if (last) {
        const sceneData = parseSceneFromStory(last, latestSession);
        await generateSceneImage(sceneData);
      }
    } else if (narrativeChanged) {
      // Update the marker even if there's no history to prevent re-attempts
      lastImageNarrative = session.story_narrative || '';
    }
    
    if (latestSession.status === 'completed') {
      sounds.playWin();
      showEndScreen(latestSession);
    }
  }, 100);
}

function renderPlayerStats(character) {
  if (!character) return '<div class="player-stats-empty">Character details unavailable</div>';

  const stats = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];
  const header = character.race && character.class
    ? `<div class="player-stats-header">${escapeHtml(character.race)} · ${escapeHtml(character.class)}</div>`
    : '';
  return `${header}<div class="player-stats-grid">${stats.map(stat => {
    const value = character[stat] || 8;
    return `<span>${stat.slice(0, 3).toUpperCase()} <strong>${value}</strong></span>`;
  }).join('')}</div>`;
}

async function allocateStatPoint(stat) {
  const me = latestPlayers.find(p => p.user_id === currentUser.uid);
  if (!me) return;
  const remaining = Number(me.unallocated_stat_points) || 0;
  if (remaining <= 0) return;
  const current = Number(me[stat]) || 10;
  if (current >= 20) {
    toast('That ability is already at its maximum.', 2500);
    return;
  }

  const { error } = await sb.from('players')
    .update({ [stat]: current + 1, unallocated_stat_points: remaining - 1 })
    .eq('session_id', currentSessionId).eq('user_id', currentUser.uid);
  if (error) {
    console.error('allocateStatPoint failed:', error);
    toast('Could not spend that point: ' + error.message, 3500, 'error');
  }
}

function renderPlayerInventory(player) {
  const inventory = Array.isArray(player.inventory) ? player.inventory.filter(item => item.type !== 'gear') : [];
  if (!inventory.length) return '<div class="player-stats-empty">No items carried</div>';
  return `<div class="player-inventory-list">${inventory.map(item => `
    <div class="player-inventory-item">
      <span>${escapeHtml(item.name || 'Unknown item')}</span>
      <small>${escapeHtml(item.description || '')}</small>
    </div>`).join('')}</div>`;
}

function renderPlayerGear(player) {
  const gear = Array.isArray(player.inventory) ? player.inventory.filter(item => item.type === 'gear') : [];
  if (!gear.length) return '<div class="player-stats-empty">No weapons or gear</div>';
  return `<div class="player-inventory-list">${gear.map(item => `
    <div class="player-inventory-item"><span>[${escapeHtml(item.slot || 'Gear')}] ${escapeHtml(item.name || 'Unknown item')}</span><small>${escapeHtml(item.specification || '')}</small></div>
  `).join('')}</div>`;
}

const ASHEN_ROOM_FLAVORS = [
  { name: 'Ash', flavor: 'A crumbling bonfire throws thin light across the ruins.' },
  { name: 'Gate', flavor: 'A broken gate watches over a road choked with ash.' },
  { name: 'Garden', flavor: 'Darkroot paths wind between trees that no longer grow.' },
  { name: 'Shrine', flavor: 'An old shrine, half-collapsed, still smells of incense.' },
  { name: 'Crypt', flavor: 'Old stones and broken graves line a sunken crypt.' },
  { name: 'Tower', flavor: 'A shattered tower stands under a sky of red lightning.' },
  { name: 'Marsh', flavor: 'Mist clings low over a marsh that swallows footsteps.' },
  { name: 'Keep', flavor: 'A sealed keep, its walls scarred by some old siege.' },
];

function toRomanNumeral(n) {
  const table = [[1000,'M'],[900,'CM'],[500,'D'],[400,'CD'],[100,'C'],[90,'XC'],[50,'L'],[40,'XL'],[10,'X'],[9,'IX'],[5,'V'],[4,'IV'],[1,'I']];
  let result = '';
  for (const [value, symbol] of table) {
    while (n >= value) { result += symbol; n -= value; }
  }
  return result;
}

function ashenRoomDisplayName(index) {
  const loop = Math.floor(index / ASHEN_ROOM_FLAVORS.length);
  const base = ASHEN_ROOM_FLAVORS[index % ASHEN_ROOM_FLAVORS.length].name;
  return loop > 0 ? `${base} ${toRomanNumeral(loop + 1)}` : base;
}

function renderAshenMap() {
  const map = $('mini-map');
  if (!map) return;

  const currentIndex = Number.isInteger(latestSession?.current_room_index)
    ? Math.max(0, latestSession.current_room_index)
    : 0;

  const windowStart = Math.max(0, currentIndex - 2);
  const windowEnd = currentIndex + 4;
  const indices = [];
  for (let i = windowStart; i <= windowEnd; i++) indices.push(i);

  map.innerHTML = `<div class="map-path-line"></div>` + indices.map(index => {
    const isCurrent = index === currentIndex;
    const isVisited = index < currentIndex;
    const marker = isCurrent ? '◆' : (isVisited ? '✓' : '●');
    return `<button class="map-node ${isCurrent ? 'current' : ''} ${isVisited ? 'visited' : ''}" type="button" data-map-index="${index}" aria-label="View ${ashenRoomDisplayName(index)}">${marker}</button>`;
  }).join('');

  const location = $('map-location');
  if (location) location.textContent = ashenRoomDisplayName(currentIndex);

  map.querySelectorAll('[data-map-index]').forEach(node => {
    node.addEventListener('click', () => {
      const index = Number(node.dataset.mapIndex);
      const name = ashenRoomDisplayName(index);
      $('map-popover-title').textContent = name;

      if (index === currentIndex) {
        const isBoss = !!latestSession?.is_boss_encounter;
        const enemyName = latestSession?.boss_name || 'Unknown enemy';
        const enemyMax = latestSession?.boss_max_health || 100;
        const enemyHealthNow = Math.max(0, Math.min(enemyMax, latestSession?.boss_health ?? enemyMax));
        const tagLine = `<div class="map-tag"><strong>${isBoss ? 'Boss' : 'Enemy'}:</strong> ${escapeHtml(enemyName)} (${enemyHealthNow}/${enemyMax} HP)</div>`;
        $('map-popover-description').innerHTML = `<strong class="map-kind">Current location</strong><br>${escapeHtml(ASHEN_ROOM_FLAVORS[index % ASHEN_ROOM_FLAVORS.length].flavor)}${tagLine}`;
      } else if (index < currentIndex) {
        $('map-popover-description').innerHTML = `<strong class="map-kind">Cleared</strong><br>The party already fought their way through here.`;
      } else {
        $('map-popover-description').innerHTML = `<strong class="map-kind">Unexplored</strong><br>What waits here is unknown until the party arrives.`;
      }
      $('map-popover')?.classList.remove('hidden');
    });
  });
}

$('map-popover-close')?.addEventListener('click', () => $('map-popover')?.classList.add('hidden'));
$('map-toggle')?.addEventListener('click', () => {
  const map = $('mini-map');
  const toggle = $('map-toggle');
  const isOpen = toggle.getAttribute('aria-expanded') === 'true';
  toggle.setAttribute('aria-expanded', String(!isOpen));
  toggle.textContent = isOpen ? 'View map' : 'Hide map';
  map?.classList.toggle('hidden', isOpen);
});

function renderHallOfDead() {
  const hall = $('hall-of-dead');
  if (!hall) return;
  const fallen = latestPlayers.filter(player => !player.is_alive);
  hall.innerHTML = fallen.length
    ? fallen.map(player => `<div class="fallen-hero"><strong>${escapeHtml(player.display_name)}</strong><span>Level ${player.level || 1} · ${player.death_count || 1} death</span></div>`).join('')
    : 'No fallen heroes yet.';
}

async function refreshChatMessages() {
  if (!currentSessionId) return;
  const { data: messages } = await sb.from('messages').select('*')
    .eq('session_id', currentSessionId).order('created_at', { ascending: true }).limit(200);
  renderChatMessages(messages || []);
}

function renderChatMessages(messages) {
  const box = $('chat-messages');
  if (!box) return;
  
  box.innerHTML = messages.map(m => `
    <div class="chat-message ${m.user_id === currentUser.uid ? 'own' : ''}">
      <span class="chat-author">${escapeHtml(m.display_name)}</span>
      <span class="chat-text">${escapeHtml(m.content)}</span>
    </div>
  `).join('');
  box.scrollTop = box.scrollHeight;
}

$('form-chat')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('chat-input');
  const content = input?.value.trim();
  if (!content || !currentSessionId) return;
  
  input.value = '';
  sounds.playClick();
  
  const { error } = await sb.from('messages').insert({
    session_id: currentSessionId,
    user_id: currentUser.uid,
    display_name: currentCharacter?.name || currentUser.username,
    content,
  });
  if (error) {
    console.error(error);
    toast('Could not send message.', 3000, 'error');
  }
});

function enterGame(sessionId) {
  currentSessionId = sessionId;
  showScreen('screen-game');
  
  const codeEl = $('game-session-code');
  if (codeEl) codeEl.textContent = `${sessionId.slice(0, 6).toUpperCase()}`;

  refreshGameState();
  refreshChatMessages();

  if (gameChannel) {
    sb.removeChannel(gameChannel);
    gameChannel = null;
  }
  
  gameChannel = sb.channel('game-' + sessionId);
  
  gameChannel
    .on('postgres_changes', { 
      event: '*', 
      schema: 'public', 
      table: 'sessions', 
      filter: `id=eq.${sessionId}` 
    }, refreshGameState)
    .on('postgres_changes', { 
      event: '*', 
      schema: 'public', 
      table: 'players', 
      filter: `session_id=eq.${sessionId}` 
    }, refreshGameState)
    .on('postgres_changes', { 
      event: 'INSERT', 
      schema: 'public', 
      table: 'messages', 
      filter: `session_id=eq.${sessionId}` 
    }, refreshChatMessages);
  
  gameChannel.subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      console.log('Game channel connected for:', sessionId);
    } else if (status === 'CHANNEL_ERROR') {
      console.error('Game channel error for:', sessionId);
    }
  });
}

// ---------- Retry Kickoff ----------
async function retryKickoff() {
  if (isGeneratingStory) {
    toast('Story is already being generated...', 2000);
    return;
  }
  
  const btn = $('btn-start-tale');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Writing…';
  }
  
  isGeneratingStory = true;
  
  try {
    const { data, error } = await sb.functions.invoke('generate-story', {
      body: { sessionId: currentSessionId, userId: currentUser.uid, kickoff: true },
    });
    
    if (error) {
      const message = await extractFunctionError(error, data);
      console.error('Retry kickoff failed:', message, error);
      await seedLocalOpening(currentSessionId);
      await refreshGameState();
      toast('Story engine unavailable. Local opening loaded.', 5000, 'error');
    }
  } finally {
    isGeneratingStory = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Start the tale';
    }
  }
}

// ---------- AI Image Generation ----------
let isGeneratingImage = false;
let lastImagePrompt = '';

async function generateSceneImage(sceneData) {
  if (isGeneratingImage) return;
  
  const container = $('pixel-scene');
  const loadingEl = $('pixel-loading');
  const imageEl = $('pixel-image');
  const canvasEl = $('pixel-canvas');
  
  if (!container || !sceneData) return;
  
  if (loadingEl) loadingEl.classList.remove('hidden');
  if (imageEl) imageEl.classList.add('hidden');
  
  isGeneratingImage = true;
  
  try {
    const prompt = buildImagePrompt(sceneData);
    
    if (prompt === lastImagePrompt && imageEl && !imageEl.classList.contains('hidden')) {
      if (loadingEl) loadingEl.classList.add('hidden');
      isGeneratingImage = false;
      return;
    }
    
    lastImagePrompt = prompt;
    
    // --- FIX: Use fetch with correct auth headers ---
    const response = await fetch(`${SUPABASE_URL}/functions/v1/generate-image`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({
        prompt: prompt,
        location: sceneData.location,
        action: sceneData.action,
        mood: sceneData.mood,
      })
    });
    
    const data = await response.json();
    
    if (!response.ok) throw new Error(data.error || 'Function returned error');
    
    if (data.imageUrl) {
      // Load the image
      const img = new Image();
      img.crossOrigin = 'anonymous';
      
      const imageLoadPromise = new Promise((resolve, reject) => {
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Image failed to load'));
        setTimeout(() => reject(new Error('Image load timeout')), 15000);
      });
      
      img.src = data.imageUrl;
      await imageLoadPromise;
      
      if (imageEl) {
        imageEl.src = data.imageUrl;
        imageEl.classList.remove('hidden');
        imageEl.style.opacity = '0';
        await new Promise(resolve => setTimeout(resolve, 50));
        imageEl.style.opacity = '1';
      }
      if (canvasEl) canvasEl.classList.add('hidden');
      
    } else {
      throw new Error('No image URL returned');
    }
    
  } catch (error) {
    console.warn('Image generation failed:', error);
    // Use fallback pixel renderer
    if (canvasEl) {
      canvasEl.classList.remove('hidden');
      renderFallbackPixelScene(canvasEl, sceneData);
    }
    if (imageEl) imageEl.classList.add('hidden');
    
    const resultEl = $('pixel-result');
    if (resultEl) {
      resultEl.textContent = '✦ Pixel render';
      resultEl.className = 'pixel-result';
    }
  }
  
  if (loadingEl) loadingEl.classList.add('hidden');
  isGeneratingImage = false;
}

function buildImagePrompt(sceneData) {
  const { location, action, mood, actor, target } = sceneData;
  
  // Short, punchy prompt - under 60 characters
  let prompt = '';
  
  // Base scene
  const locationWords = {
    bonfire: 'campfire in ruins',
    gate: 'broken stone gate',
    forest: 'dark twisted forest',
    shrine: 'ancient shrine',
    crypt: 'dark stone crypt',
    tower: 'shattered tower',
    marsh: 'misty marsh',
    keep: 'ruined keep',
    ash: 'ash wasteland'
  };
  const base = locationWords[location] || 'dark fantasy wasteland';
  
  // Action (short)
  const actionWords = {
    attack: 'warrior fighting monster',
    hit: 'warrior striking enemy',
    heal: 'warrior being healed',
    search: 'warrior searching ashes',
    stealth: 'warrior hiding in shadows',
    neutral: 'warrior standing'
  };
  const actionText = actionWords[action] || 'warrior';
  
  // Build short prompt
  prompt = `${actionText} at ${base}`;
  
  // Add mood in 2-3 words
  if (mood === 'combat') prompt += ', battle scene';
  else if (mood === 'dark') prompt += ', dark atmosphere';
  else if (mood === 'fire') prompt += ', firelight glow';
  
  return prompt;
}

// ---------- Fallback Pixel Art Renderer (canvas) ----------
function renderFallbackPixelScene(canvas, sceneData) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const p = 4; // Smaller pixel size = more detail!
  
  ctx.imageSmoothingEnabled = false;
  
  // Clear
  ctx.fillStyle = '#0a0806';
  ctx.fillRect(0, 0, w, h);
  
  // ----- SKY -----
  const colors = {
    dark: ['#1a1010', '#0a0806'],
    fire: ['#2a1a0a', '#0a0806'],
    combat: ['#1a0a0a', '#0a0604'],
    neutral: ['#1a1814', '#0a0806'],
    ash: ['#2a2820', '#1a1814'],
    gate: ['#1a1410', '#0a0806'],
    crypt: ['#0a0808', '#050303'],
    shrine: ['#2a1a0a', '#0a0806'],
    forest: ['#1a1a10', '#0a0a06'],
    tower: ['#1a0a0a', '#0a0505']
  };
  const sky = colors[sceneData.location] || colors.neutral;
  for (let y = 0; y < h * 0.6; y += p) {
    const t = y / (h * 0.6);
    const r = parseInt(sky[0].slice(1,3), 16) + (parseInt(sky[1].slice(1,3), 16) - parseInt(sky[0].slice(1,3), 16)) * t;
    const g = parseInt(sky[0].slice(3,5), 16) + (parseInt(sky[1].slice(3,5), 16) - parseInt(sky[0].slice(3,5), 16)) * t;
    const b = parseInt(sky[0].slice(5,7), 16) + (parseInt(sky[1].slice(5,7), 16) - parseInt(sky[0].slice(5,7), 16)) * t;
    ctx.fillStyle = `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
    ctx.fillRect(0, y, w, p);
  }
  
  // ----- STARS / EMBERS -----
  const numParticles = sceneData.location === 'ash' ? 15 : 8;
  for (let i = 0; i < numParticles; i++) {
    const x = Math.random() * w;
    const y = Math.random() * (h * 0.4);
    const size = Math.random() * 2 + 1;
    const alpha = Math.random() * 0.5 + 0.2;
    ctx.fillStyle = `rgba(255, 200, 100, ${alpha})`;
    ctx.fillRect(x, y, size, size);
  }
  
  // ----- MOON / CELESTIAL -----
  if (sceneData.location !== 'crypt' && sceneData.location !== 'tower') {
    const moonX = w * 0.8;
    const moonY = h * 0.15;
    ctx.fillStyle = 'rgba(180, 170, 150, 0.15)';
    for (let r = 20; r > 0; r -= 2) {
      ctx.beginPath();
      ctx.arc(moonX, moonY, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(200, 190, 170, 0.2)';
    ctx.beginPath();
    ctx.arc(moonX, moonY, 16, 0, Math.PI * 2);
    ctx.fill();
  }
  
  // ----- GROUND -----
  const groundY = h * 0.62;
  const groundColors = ['#1a1510', '#1c1712', '#18130e', '#1e1914'];
  for (let y = groundY; y < h; y += p) {
    const colorIndex = Math.floor(((y - groundY) / (h - groundY)) * groundColors.length);
    ctx.fillStyle = groundColors[Math.min(colorIndex, groundColors.length - 1)];
    ctx.fillRect(0, y, w, p);
  }
  
  // ----- GROUND TEXTURE -----
  for (let i = 0; i < 80; i++) {
    const x = Math.random() * w;
    const y = groundY + Math.random() * (h - groundY);
    const size = Math.random() * 3 + 1;
    const shade = Math.random() > 0.5 ? '#2a2018' : '#0a0806';
    ctx.fillStyle = shade;
    ctx.fillRect(x, y, size, size);
  }
  
  // ----- BACKGROUND ENVIRONMENT -----
  drawEnvironment(ctx, w, h, groundY, p, sceneData);
  
  // ----- CHARACTERS -----
  drawCharacter(ctx, w * 0.35, groundY - 10, p, '#f0c477', 'player', sceneData);
  
  if (sceneData.action === 'attack' || sceneData.action === 'hit' || sceneData.target) {
    drawCharacter(ctx, w * 0.65, groundY - 10, p, '#e17055', 'enemy', sceneData);
  }
  
  // ----- EFFECTS -----
  if (sceneData.action === 'attack' || sceneData.action === 'hit') {
    drawCombatEffects(ctx, w * 0.65, groundY - 30, p);
  }
  
  if (sceneData.action === 'search') {
    drawSearchEffects(ctx, w * 0.35, groundY - 5, p);
  }
  
  // ----- FOREGROUND DETAILS -----
  drawForeground(ctx, w, h, groundY, p, sceneData);
  
  // ----- BONFIRE (always present) -----
  drawBonfire(ctx, w * 0.5, groundY + 15, p);
}

// ----- HELPER FUNCTIONS -----

function drawEnvironment(ctx, w, h, groundY, p, sceneData) {
  switch(sceneData.location) {
    case 'gate':
      // Broken gate
      ctx.fillStyle = '#2a221a';
      ctx.fillRect(10, groundY - 60, 8, 60);
      ctx.fillRect(w - 18, groundY - 50, 8, 50);
      // Gate arch
      ctx.fillStyle = '#3a322a';
      ctx.fillRect(14, groundY - 70, w - 28, 6);
      // Broken top
      ctx.fillStyle = '#1a1410';
      ctx.fillRect(30, groundY - 68, 12, 4);
      ctx.fillRect(w - 42, groundY - 58, 12, 4);
      break;
      
    case 'forest':
      // Dark trees
      for (let i = 0; i < 6; i++) {
        const x = 20 + i * (w / 6) + Math.random() * 20;
        const treeH = 40 + Math.random() * 30;
        ctx.fillStyle = '#1a2010';
        ctx.fillRect(x, groundY - treeH, 6, treeH);
        ctx.fillStyle = '#0a1008';
        ctx.fillRect(x - 12, groundY - treeH - 8, 30, 12);
        // Dead branches
        ctx.fillStyle = '#1a1608';
        ctx.fillRect(x - 16, groundY - treeH + 10, 10, 3);
        ctx.fillRect(x + 12, groundY - treeH + 20, 10, 3);
      }
      break;
      
    case 'crypt':
      // Gravestones
      for (let i = 0; i < 4; i++) {
        const x = 30 + i * (w / 4);
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(x, groundY - 20, 16, 20);
        ctx.fillStyle = '#222222';
        ctx.fillRect(x + 2, groundY - 16, 12, 4);
        // Crack
        ctx.fillStyle = '#0a0a0a';
        ctx.fillRect(x + 6, groundY - 12, 2, 8);
      }
      break;
      
    case 'tower':
      // Broken tower
      ctx.fillStyle = '#1a1612';
      ctx.fillRect(w/2 - 30, groundY - 80, 60, 80);
      ctx.fillStyle = '#2a221a';
      ctx.fillRect(w/2 - 26, groundY - 76, 52, 10);
      // Broken top
      ctx.fillStyle = '#0a0806';
      ctx.fillRect(w/2 - 20, groundY - 84, 16, 8);
      ctx.fillRect(w/2 + 4, groundY - 78, 12, 6);
      // Window
      ctx.fillStyle = '#0a0a0a';
      ctx.fillRect(w/2 - 8, groundY - 44, 16, 20);
      ctx.fillStyle = 'rgba(255, 200, 100, 0.1)';
      ctx.fillRect(w/2 - 6, groundY - 42, 12, 16);
      break;
  }
}

function drawCharacter(ctx, x, y, p, color, type, sceneData) {
  // Body
  ctx.fillStyle = color;
  ctx.fillRect(x - 8, y - 28, 16, 28);
  
  // Head
  ctx.fillStyle = '#d4a87a';
  ctx.fillRect(x - 7, y - 36, 14, 10);
  
  // Hair
  const hairColor = type === 'player' ? '#6a4a2a' : '#1a0a0a';
  ctx.fillStyle = hairColor;
  ctx.fillRect(x - 8, y - 40, 16, 6);
  ctx.fillRect(x - 10, y - 36, 4, 4);
  ctx.fillRect(x + 6, y - 36, 4, 4);
  
  // Eyes
  const eyeColor = type === 'player' ? '#aabbcc' : '#ff6b35';
  ctx.fillStyle = eyeColor;
  ctx.fillRect(x - 5, y - 34, 3, 3);
  ctx.fillRect(x + 2, y - 34, 3, 3);
  
  // Armor/Clothing details
  if (type === 'player') {
    ctx.fillStyle = '#8a7a5a';
    ctx.fillRect(x - 6, y - 22, 12, 4);
    ctx.fillRect(x - 8, y - 14, 16, 4);
    // Belt
    ctx.fillStyle = '#5a4a2a';
    ctx.fillRect(x - 8, y - 6, 16, 3);
  } else {
    // Enemy armor details
    ctx.fillStyle = '#4a3a2a';
    ctx.fillRect(x - 8, y - 24, 16, 4);
    ctx.fillRect(x - 10, y - 14, 20, 4);
    // Enemy glowing core
    ctx.fillStyle = 'rgba(255, 100, 30, 0.3)';
    ctx.fillRect(x - 4, y - 20, 8, 8);
  }
  
  // Legs
  ctx.fillStyle = type === 'player' ? '#4a3a2a' : '#3a2a1a';
  ctx.fillRect(x - 6, y, 5, 12);
  ctx.fillRect(x + 1, y, 5, 12);
  
  // Boots
  ctx.fillStyle = type === 'player' ? '#3a2a1a' : '#2a1a0a';
  ctx.fillRect(x - 8, y + 10, 7, 4);
  ctx.fillRect(x + 1, y + 10, 7, 4);
  
  // Arms
  ctx.fillStyle = '#d4a87a';
  if (type === 'player') {
    // Player arms - one holding weapon
    ctx.fillRect(x - 14, y - 20, 6, 8);
    ctx.fillRect(x + 8, y - 20, 6, 8);
    // Weapon
    ctx.fillStyle = '#b8a88a';
    ctx.fillRect(x + 12, y - 32, 3, 20);
    ctx.fillStyle = '#8a7a6a';
    ctx.fillRect(x + 10, y - 34, 7, 4);
    ctx.fillRect(x + 11, y - 12, 5, 4);
  } else {
    // Enemy arms - with blade
    ctx.fillRect(x - 16, y - 22, 6, 10);
    ctx.fillRect(x + 10, y - 22, 6, 10);
    // Enemy blade
    ctx.fillStyle = '#6a5a4a';
    ctx.fillRect(x + 16, y - 34, 4, 24);
    ctx.fillStyle = '#8a7a6a';
    ctx.fillRect(x + 14, y - 38, 8, 6);
  }
  
  // Cape (player only)
  if (type === 'player') {
    ctx.fillStyle = 'rgba(100, 60, 40, 0.5)';
    ctx.fillRect(x - 12, y - 10, 8, 16);
    ctx.fillRect(x + 4, y - 10, 8, 16);
  }
}

function drawCombatEffects(ctx, x, y, p) {
  // Sword clash sparks
  const colors = ['#ffd700', '#ff8c00', '#ff4500', '#ffffff'];
  for (let i = 0; i < 25; i++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = Math.random() * 35 + 5;
    const size = Math.random() * 4 + 1;
    const color = colors[Math.floor(Math.random() * colors.length)];
    ctx.fillStyle = color;
    ctx.globalAlpha = Math.random() * 0.8 + 0.2;
    ctx.fillRect(
      x + Math.cos(angle) * dist,
      y + Math.sin(angle) * dist,
      size, size
    );
  }
  ctx.globalAlpha = 1;
  
  // Impact flash
  ctx.fillStyle = 'rgba(255, 255, 200, 0.15)';
  ctx.beginPath();
  ctx.arc(x, y, 20, 0, Math.PI * 2);
  ctx.fill();
}

function drawSearchEffects(ctx, x, y, p) {
  // Sparkles around search area
  for (let i = 0; i < 12; i++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = Math.random() * 20 + 5;
    const size = Math.random() * 3 + 1;
    ctx.fillStyle = `rgba(200, 230, 255, ${Math.random() * 0.5 + 0.1})`;
    ctx.fillRect(
      x + Math.cos(angle) * dist,
      y + Math.sin(angle) * dist - 10,
      size, size
    );
  }
  
  // Glow ring
  ctx.fillStyle = 'rgba(200, 230, 255, 0.05)';
  ctx.beginPath();
  ctx.arc(x, y - 10, 25, 0, Math.PI * 2);
  ctx.fill();
}

function drawForeground(ctx, w, h, groundY, p, sceneData) {
  // Grass blades
  for (let i = 0; i < 40; i++) {
    const x = Math.random() * w;
    const y = groundY - Math.random() * 6;
    const height = Math.random() * 6 + 2;
    ctx.fillStyle = Math.random() > 0.5 ? '#1a2a10' : '#2a1a10';
    ctx.fillRect(x, y, 1, height);
  }
  
  // Rocks
  for (let i = 0; i < 6; i++) {
    const x = Math.random() * w;
    const y = groundY + Math.random() * 20 + 10;
    const size = Math.random() * 8 + 4;
    ctx.fillStyle = '#2a221a';
    ctx.fillRect(x, y, size, size * 0.6);
    ctx.fillStyle = '#3a322a';
    ctx.fillRect(x + 2, y + 2, size * 0.4, size * 0.3);
  }
}

function drawBonfire(ctx, x, y, p) {
  // Wood logs
  ctx.fillStyle = '#3a2a1a';
  ctx.fillRect(x - 20, y - 4, 40, 8);
  ctx.fillStyle = '#4a3a2a';
  ctx.fillRect(x - 24, y + 2, 48, 6);
  ctx.fillRect(x - 16, y - 8, 32, 6);
  
  // Fire base glow
  ctx.fillStyle = 'rgba(255, 150, 50, 0.05)';
  ctx.beginPath();
  ctx.arc(x, y - 10, 40, 0, Math.PI * 2);
  ctx.fill();
  
  // Main fire
  const flicker = Math.random() * 0.2 + 0.8;
  ctx.fillStyle = `rgba(255, 180, 50, ${0.5 * flicker})`;
  ctx.fillRect(x - 14, y - 30 * flicker, 28, 26);
  ctx.fillStyle = `rgba(255, 100, 20, ${0.3 * flicker})`;
  ctx.fillRect(x - 8, y - 40 * flicker, 16, 22);
  ctx.fillStyle = `rgba(255, 60, 10, ${0.2 * flicker})`;
  ctx.fillRect(x - 4, y - 48 * flicker, 8, 16);
  
  // Embers
  for (let i = 0; i < 10; i++) {
    const ex = x + (Math.random() - 0.5) * 30;
    const ey = y - 10 - Math.random() * 35;
    const size = Math.random() * 3 + 1;
    const alpha = Math.random() * 0.5 + 0.2;
    ctx.fillStyle = `rgba(255, 200, 100, ${alpha})`;
    ctx.fillRect(ex, ey, size, size);
  }
  
  // Light cone (on ground)
  ctx.fillStyle = 'rgba(255, 150, 50, 0.03)';
  ctx.fillRect(x - 50, y + 4, 100, 16);
}

// ---------- Pixel Scene Functions ----------
function parseSceneFromStory(last, session) {
  const choice = (last.choice || '').toLowerCase();
  const player = last.player || 'Someone';
  const enemyName = session.boss_name || 'enemy';
  
  let location = 'ash';
  if (session.current_room_index !== undefined) {
    const roomIndex = session.current_room_index % 8;
    const rooms = ['bonfire', 'gate', 'forest', 'shrine', 'crypt', 'tower', 'marsh', 'keep'];
    location = rooms[roomIndex] || 'ash';
  }
  
  let action = 'neutral';
  let target = null;
  
  if (choice.includes('attack') || choice.includes('strike') || choice.includes('fight')) {
    action = 'attack';
    target = enemyName;
  } else if (choice.includes('heal') || choice.includes('rest')) {
    action = 'heal';
  } else if (choice.includes('search') || choice.includes('investigate')) {
    action = 'search';
  } else if (choice.includes('sneak') || choice.includes('stealth') || choice.includes('hide')) {
    action = 'stealth';
  } else if (last.impact !== undefined && last.impact < 0) {
    action = 'hit';
    target = player;
  } else if (last.impact !== undefined && last.impact > 0) {
    action = 'heal';
  }
  
  let mood = 'neutral';
  if (action === 'attack' || action === 'hit') {
    mood = 'combat';
  } else if (location === 'bonfire') {
    mood = 'fire';
  } else if (location === 'crypt' || location === 'tower') {
    mood = 'dark';
  }
  
  return {
    location,
    action,
    mood,
    actor: player,
    target: target || null,
    allies: session.players ? session.players.filter(p => p.is_alive).map(p => p.display_name) : [],
  };
}

function updatePixelOverlay(last) {
  const playerEl = $('pixel-player');
  const actionEl = $('pixel-action');
  const targetEl = $('pixel-target');
  const rollEl = $('pixel-roll');
  const resultEl = $('pixel-result');
  
  if (playerEl) playerEl.textContent = last.player || 'Someone';
  if (actionEl) actionEl.textContent = last.choice || 'acted';
  if (targetEl) {
    const enemyName = latestSession?.boss_name || 'enemy';
    if (last.impact !== undefined && last.impact < 0) {
      targetEl.textContent = `→ ${enemyName}`;
    } else {
      targetEl.textContent = '';
    }
  }
  
  if (rollEl) {
    if (last.roll) {
      rollEl.textContent = `🎲 ${last.roll}`;
      rollEl.style.display = 'inline-block';
    } else {
      rollEl.style.display = 'none';
    }
  }
  
  if (resultEl) {
    if (last.impact !== undefined && last.impact !== null) {
      if (last.impact < 0) {
        resultEl.textContent = `💔 ${Math.abs(last.impact)} HP`;
        resultEl.className = 'pixel-result damage';
      } else if (last.impact > 0) {
        resultEl.textContent = `💚 +${last.impact} HP`;
        resultEl.className = 'pixel-result heal';
      } else {
        resultEl.textContent = '✦ 0 HP';
        resultEl.className = 'pixel-result';
      }
    } else {
      resultEl.textContent = '';
    }
  }
}

async function updatePixelScene() {
  const container = $('pixel-scene');
  if (!container || !latestSession) return;
  
  const history = latestSession.story_history || [];
  if (history.length === 0) {
    container.classList.add('hidden');
    return;
  }
  
  const last = history[history.length - 1];
  container.classList.remove('hidden');
  
  updatePixelOverlay(last);
}

// ---------- Render Game ----------
function renderGame() {
  if (!latestSession) return;

  const SAFE_ZONE_ROOM_SLOTS = new Set([0, 3]);
  const currentRoomIdx = Number.isInteger(latestSession?.current_room_index) ? latestSession.current_room_index : 0;
  const inSafeZoneNow = SAFE_ZONE_ROOM_SLOTS.has(currentRoomIdx % 8);

  const bossNameEl = $('boss-name');
  const bossHealthNumEl = $('boss-health-num');
  const bossHealthFillEl = $('boss-health-fill');
  const bossPhaseEl = $('boss-phase');
  const bossPanelEl = $('boss-panel');
  const safeZoneBannerEl = $('safe-zone-banner');
  safeZoneBannerEl?.classList.toggle('hidden', !inSafeZoneNow);
  if (inSafeZoneNow) {
    bossPanelEl?.classList.add('hidden');
  } else if (bossNameEl && bossHealthNumEl && bossHealthFillEl) {
    const bossMax = latestSession.boss_max_health || 100;
    const bossHealth = Math.max(0, Math.min(bossMax, latestSession.boss_health ?? bossMax));
    const isBossEncounter = !!latestSession.is_boss_encounter;
    bossPanelEl?.classList.toggle('hidden', !(latestSession.story_history?.length || bossHealth < bossMax));
    bossPanelEl?.classList.toggle('boss-panel-monster', !isBossEncounter);
    const bossPct = bossMax > 0 ? Math.round((bossHealth / bossMax) * 100) : 0;
    bossNameEl.textContent = latestSession.boss_name || 'The Nameless Dread';
    bossHealthNumEl.textContent = `${bossHealth} / ${bossMax}`;
    if (bossPhaseEl) {
      if (bossHealth <= 0) {
        bossPhaseEl.textContent = 'Defeated';
      } else if (isBossEncounter) {
        bossPhaseEl.textContent = bossPct <= 25 ? 'BOSS · Phase 4 · Enraged' : bossPct <= 50 ? 'BOSS · Phase 3 · Aggressive' : bossPct <= 75 ? 'BOSS · Phase 2 · Awakened' : 'BOSS · Phase 1 · Watching';
      } else {
        bossPhaseEl.textContent = 'Monster · Engaged';
      }
    }
    bossHealthFillEl.style.width = `${bossPct}%`;
    bossHealthFillEl.style.background = bossHealth <= 0
      ? 'var(--text-muted)'
      : (bossPct <= 25 ? 'linear-gradient(135deg, #636e72, #2d3436)' : 'linear-gradient(135deg, #e17055, #d63031)');
  }

  // Player List
  const list = $('player-list');
  if (list) {
    list.innerHTML = latestPlayers.map((p) => {
      const isTurn = latestSession.turn_order && 
        latestSession.turn_order[latestSession.current_turn_index] === p.user_id && 
        p.is_alive;
      const maxHealth = Math.max(1, Number(p.max_health || 100));
      const pct = Math.max(0, Math.min(100, (p.health / maxHealth) * 100));
      const color = pct > 55 ? 'var(--health-full)' : pct > 25 ? 'var(--health-mid)' : 'var(--health-low)';
      const character = {
        name: p.display_name,
        race: p.race,
        class: p.class,
        strength: p.strength,
        dexterity: p.dexterity,
        constitution: p.constitution,
        intelligence: p.intelligence,
        wisdom: p.wisdom,
        charisma: p.charisma,
      };
      const characterName = p.display_name;
      
      return `
        <li class="player-item ${isTurn ? 'current-turn' : ''} ${!p.is_alive ? 'eliminated' : ''}" data-user-id="${p.user_id}">
          <div class="p-name">
            <span>${escapeHtml(characterName)}${p.user_id === currentUser.uid ? ' (you)' : ''}</span>
            <span class="p-health-num">${p.is_alive ? `${p.health}/${maxHealth}` : 'Dead'}</span>
          </div>
          <div class="p-health-track">
            <div class="p-health-fill" style="width:${pct}%;background:${color}"></div>
          </div>
          <div class="session-meta">Level ${p.level || 1} · ${p.souls || 0} souls · ${p.status || (p.is_alive ? 'Healthy' : 'Dead')}</div>
          ${p.user_id === currentUser.uid && Number(p.unallocated_stat_points) > 0 ? `
            <div class="player-allocate">
              <div class="allocate-header">${p.unallocated_stat_points} stat point${Number(p.unallocated_stat_points) === 1 ? '' : 's'} to spend — souls earned you these</div>
              <div class="allocate-grid">
                ${['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'].map(stat => `
                  <div class="allocate-row">
                    <span>${stat.slice(0, 3).toUpperCase()} <strong>${p[stat] || 10}</strong></span>
                    <button class="btn btn-secondary btn-sm" data-allocate-stat="${stat}" ${Number(p[stat] || 10) >= 20 ? 'disabled' : ''}>+1</button>
                  </div>
                `).join('')}
              </div>
            </div>
          ` : ''}
          <div class="player-detail-actions">
            <button class="player-stats-toggle" type="button" aria-expanded="false">Stats</button>
            <button class="player-inventory-toggle" type="button" aria-expanded="false">Inventory</button>
            <button class="player-gear-toggle" type="button" aria-expanded="false">Weapons &amp; Gear</button>
          </div>
          <div class="player-stats hidden">${renderPlayerStats(character)}</div>
          <div class="player-inventory hidden">${renderPlayerInventory(p)}</div>
          <div class="player-gear hidden">${renderPlayerGear(p)}</div>
        </li>
      `;
    }).join('');

    list.querySelectorAll('.player-stats-toggle').forEach(button => {
      button.addEventListener('click', () => {
        const stats = button.closest('.player-item')?.querySelector('.player-stats');
        if (!stats) return;
        const expanded = button.getAttribute('aria-expanded') === 'true';
        button.setAttribute('aria-expanded', String(!expanded));
        stats.classList.toggle('hidden', expanded);
      });
    });
    list.querySelectorAll('.player-inventory-toggle').forEach(button => {
      button.addEventListener('click', () => {
        const inventory = button.closest('.player-item')?.querySelector('.player-inventory');
        if (!inventory) return;
        const expanded = button.getAttribute('aria-expanded') === 'true';
        button.setAttribute('aria-expanded', String(!expanded));
        inventory.classList.toggle('hidden', expanded);
      });
    });
    list.querySelectorAll('.player-gear-toggle').forEach(button => {
      button.addEventListener('click', () => {
        const gear = button.closest('.player-item')?.querySelector('.player-gear');
        if (!gear) return;
        const expanded = button.getAttribute('aria-expanded') === 'true';
        button.setAttribute('aria-expanded', String(!expanded));
        gear.classList.toggle('hidden', expanded);
      });
    });
    list.querySelectorAll('[data-allocate-stat]').forEach(button => {
      button.addEventListener('click', () => {
        sounds.playClick();
        allocateStatPoint(button.dataset.allocateStat);
      });
    });
  }

  // Turn Indicator
  const currentTurnUid = latestSession.turn_order ? latestSession.turn_order[latestSession.current_turn_index] : null;
  const currentPlayer = latestPlayers.find(p => p.user_id === currentTurnUid);
  const turnEl = $('turn-indicator');
  
  const choices = latestSession.story_choices || [];
  const narrative = (latestSession.story_narrative || '').trim();
  const isStuck = latestSession.status === 'active' &&
  !choices.length &&
  (narrative === 'The story is being written…' || narrative.startsWith('A new tale begins')) &&
  !isGeneratingStory;

  if (turnEl) {
    if (latestSession.status === 'completed') {
      turnEl.textContent = 'The tale has ended.';
    } else if (isStuck) {
      turnEl.textContent = 'Waiting for the storyteller…';
    } else if (currentPlayer) {
      turnEl.textContent = currentTurnUid === currentUser.uid 
        ? 'It is your turn!' 
        : `Waiting on ${currentPlayer.display_name}…`;
    }
  }

  // Story Text
  const storyTextEl = $('story-text');
  if (storyTextEl) storyTextEl.textContent = latestSession.story_narrative || '';

  // Choices
const isMyTurn = currentTurnUid === currentUser.uid && latestSession.status === 'active';
const alivePlayers = latestPlayers.filter(player => player.is_alive);
const iAmAlive = alivePlayers.some(player => player.user_id === currentUser.uid);
const voteState = (latestSession.vote_state && latestSession.vote_state.active) ? latestSession.vote_state : null;
const choicesEl = $('choices');

if (choicesEl) {
  if (isStuck) {
    choicesEl.innerHTML = `<button id="btn-start-tale" class="choice-btn">Start the tale</button>`;
    $('btn-start-tale')?.addEventListener('click', retryKickoff);
  } else if (!choices.length || latestSession.status !== 'active') {
    choicesEl.innerHTML = '';
  } else if (voteState) {
    const votes = voteState.votes || {};
    const hasVoted = Object.prototype.hasOwnProperty.call(votes, currentUser.uid);
    choicesEl.innerHTML = choices.map((c, i) => {
      const count = Object.values(votes).filter(v => v === i).length;
      return `
        <button class="choice-btn" data-vote="${i}" ${(hasVoted || !iAmAlive) ? 'disabled' : ''}>
          ${escapeHtml(c)}
          <span class="vote-count">${count} vote${count === 1 ? '' : 's'}</span>
        </button>
      `;
    }).join('');
    choicesEl.querySelectorAll('[data-vote]').forEach(btn => {
      btn.addEventListener('click', () => {
        sounds.playClick();
        castVote(Number(btn.dataset.vote));
      });
    });
  } else {
    choicesEl.innerHTML = choices.map((c, i) => `
      <button class="choice-btn" data-choice="${i}" ${isMyTurn ? '' : 'disabled'}>
        ${escapeHtml(c)}
      </button>
    `).join('') + (isMyTurn ? `
      <button class="choice-btn choice-btn-vote" type="button" data-put-to-vote>Not sure? Put it to a vote</button>
    ` : '');

    choicesEl.querySelectorAll('[data-choice]').forEach(btn => {
      btn.addEventListener('click', () => {
        sounds.playClick();
        submitChoice(Number(btn.dataset.choice));
      });
    });
    choicesEl.querySelector('[data-put-to-vote]')?.addEventListener('click', () => {
      sounds.playClick();
      startVote();
    });
  }
}

  // Status
  const statusEl = $('story-status');
  if (statusEl) {
    if (isStuck) {
      statusEl.textContent = '';
    } else if (voteState) {
      const voteCount = Object.keys(voteState.votes || {}).length;
      statusEl.textContent = `Party vote: ${voteCount}/${alivePlayers.length} votes cast.`;
    } else if (latestSession.status === 'active') {
      statusEl.textContent = isMyTurn ? '' : 'Only the active player can choose (or put it to a vote).';
    } else {
      statusEl.textContent = '';
    }
  }

  // Inventory
  const inventoryPanel = $('inventory-panel');
  const inventoryList = $('inventory-list');
  if (inventoryPanel && inventoryList) {
    const myPlayer = latestPlayers.find(p => p.user_id === currentUser.uid);
    const myInventory = myPlayer && Array.isArray(myPlayer.inventory) ? myPlayer.inventory : [];
    const showInventory = isMyTurn && !isStuck && myInventory.length > 0;
    inventoryPanel.classList.toggle('hidden', !showInventory);
    if (showInventory) {
      const consumables = myInventory.filter(item => item.type !== 'gear');
      inventoryList.innerHTML = consumables.map(item => `
        <div class="inventory-item">
          <div class="item-info">
            <span class="item-name">${escapeHtml(item.name)}</span>
            <span class="item-description">${escapeHtml(item.description || '')}</span>
          </div>
          <button class="btn btn-secondary btn-sm" data-use-item="${escapeHtml(item.id)}">Use</button>
        </div>
      `).join('') || '<div class="player-stats-empty">No consumables</div>';
      inventoryList.querySelectorAll('[data-use-item]').forEach(btn => {
        btn.addEventListener('click', () => {
          sounds.playClick();
          useItem(btn.dataset.useItem);
        });
      });
    }
  }

  renderStoryLog();
}

// ---------- Use Item ----------
async function useItem(itemId) {
  if (isGeneratingStory) {
    toast('Story is already being generated...', 2000);
    return;
  }
  
  const choicesEl = $('choices');
  const inventoryList = $('inventory-list');
  if (choicesEl) choicesEl.querySelectorAll('button').forEach(b => b.disabled = true);
  if (inventoryList) inventoryList.querySelectorAll('button').forEach(b => b.disabled = true);

  const statusEl = $('story-status');
  if (statusEl) statusEl.textContent = 'Using item…';
  
  isGeneratingStory = true;

  try {
    const { data, error } = await sb.functions.invoke('generate-story', {
      body: { sessionId: currentSessionId, userId: currentUser.uid, itemId },
    });

    if (error) {
      const message = await extractFunctionError(error, data);
      console.error('useItem failed:', message, error);
      if (statusEl) statusEl.textContent = 'Could not use that item — please try again.';
      toast('Item use failed: ' + message, 4000, 'error');
    }
  } finally {
    isGeneratingStory = false;
  }
}

// ---------- Submit Choice ----------
async function submitChoice(choiceIndex) {
  if (isGeneratingStory) {
    toast('Story is already being generated...', 2000);
    return;
  }
  
  const choicesEl = $('choices');
  const statusEl = $('story-status');
  if (choicesEl) choicesEl.querySelectorAll('button').forEach(b => b.disabled = true);
  if (statusEl) statusEl.textContent = 'The storyteller is weaving…';
  
  isGeneratingStory = true;
  
  try {
    const { data, error } = await sb.functions.invoke('generate-story', {
      body: { sessionId: currentSessionId, userId: currentUser.uid, choiceIndex },
    });
    if (error) {
      console.error('submitChoice failed:', error);
      if (statusEl) statusEl.textContent = 'The story engine faltered — please try again.';
      toast('Story generation failed: ' + (error.message || 'Unknown error'), 4000, 'error');
    }
  } finally {
    isGeneratingStory = false;
  }
}

// ---------- Party Vote ----------
async function startVote() {
  const { error } = await sb.from('sessions')
    .update({ vote_state: { active: true, votes: {} } })
    .eq('id', currentSessionId);
  if (error) {
    console.error('startVote failed:', error);
    toast('Could not start a vote: ' + error.message, 4000, 'error');
  }
}

async function castVote(choiceIndex) {
  if (isGeneratingStory) {
    toast('Story is already being generated...', 2000);
    return;
  }
  
  const current = (latestSession.vote_state && latestSession.vote_state.active)
    ? latestSession.vote_state
    : { active: true, votes: {} };
  const votes = { ...current.votes, [currentUser.uid]: choiceIndex };
  const alivePlayers = latestPlayers.filter(p => p.is_alive);

  latestSession.vote_state = { active: true, votes };
  renderGame();

  const { error: voteError } = await sb.from('sessions')
    .update({ vote_state: { active: true, votes } })
    .eq('id', currentSessionId);
  if (voteError) {
    console.error('castVote failed:', voteError);
    toast('Vote failed: ' + voteError.message, 4000, 'error');
    return;
  }

  if (Object.keys(votes).length < alivePlayers.length) return;

  const tally = {};
  Object.values(votes).forEach(v => { tally[v] = (tally[v] || 0) + 1; });
  const winner = Number(Object.keys(tally).reduce((best, key) =>
    tally[key] > tally[best] ? key : best, Object.keys(tally)[0]));

  const choicesEl = $('choices');
  const statusEl = $('story-status');
  if (statusEl) statusEl.textContent = 'The party has agreed. The storyteller is weaving…';
  if (choicesEl) choicesEl.querySelectorAll('button').forEach(b => b.disabled = true);
  
  isGeneratingStory = true;

  try {
    const { data, error } = await sb.functions.invoke('generate-story', {
      body: { sessionId: currentSessionId, userId: currentUser.uid, choiceIndex: winner },
    });
    if (error) {
      console.error('submitChoice (vote) failed:', error);
      if (statusEl) statusEl.textContent = 'The story engine faltered — please try again.';
      toast('Story generation failed: ' + (error.message || 'Unknown error'), 4000, 'error');
    }
  } finally {
    isGeneratingStory = false;
  }
}

// ---------- Story Log ----------
function renderStoryLog() {
  const logEl = $('story-log');
  if (!logEl || !latestSession) return;
  
  const history = latestSession.story_history || [];
  if (!history.length) {
    logEl.innerHTML = `<li class="log-item" style="color: var(--text-muted);">No actions yet.</li>`;
    return;
  }
  
  logEl.innerHTML = history.slice().reverse().map(h => {
    if (h.party) {
      return `<li class="log-item log-party">${escapeHtml(h.outcome)}</li>`;
    }
    const impactText = typeof h.impact === 'number'
      ? (h.impact < 0 ? ` — lost ${Math.abs(h.impact)} HP` : h.impact > 0 ? ` — recovered ${h.impact} HP` : ' — unscathed')
      : '';
    const rollText = h.roll ? ` <span class="log-roll">d20: ${escapeHtml(h.roll)}${h.rollLabel ? ` · ${escapeHtml(h.rollLabel)}` : ''}</span>` : '';
    const lootText = h.loot ? `<div class="log-loot">Found: ${escapeHtml(h.loot)}</div>` : '';
    return `<li class="log-item">
      <div class="log-player">${escapeHtml(h.player)}${impactText}${rollText}</div>
      ${h.choice ? `<div class="log-choice">"${escapeHtml(h.choice)}"</div>` : ''}
      ${lootText}
    </li>`;
  }).join('');
}

// ---------- End Screen ----------
function showEndScreen(session) {
  showScreen('screen-end');
  const winner = latestPlayers.find(p => p.is_alive);
  const titleEl = $('end-title');
  const summaryEl = $('end-summary');
  
  if (titleEl) {
    titleEl.textContent = winner ? `${winner.display_name} survives!` : 'The table has fallen';
  }
  if (summaryEl) summaryEl.textContent = session.story_narrative || '';

  if (autoResetTimer) {
    clearTimeout(autoResetTimer);
    autoResetTimer = null;
  }
  
  autoResetTimer = setTimeout(async () => {
    autoResetTimer = null;
    const { data, error } = await sb.functions.invoke('reset-session', {
      body: { sessionId: currentSessionId, userId: currentUser.uid },
    });
    if (error) {
      console.error('Auto reset failed:', error);
    } else {
      toast('Table reset — ready for a new tale!', 3000, 'success');
    }
  }, 6000);
}

// ---------- Cleanup ----------
function teardownSubscriptions() {
  if (gameChannel) { 
    sb.removeChannel(gameChannel); 
    gameChannel = null; 
  }
  if (lobbyChannel) { 
    sb.removeChannel(lobbyChannel); 
    lobbyChannel = null; 
  }
  if (autoResetTimer) { 
    clearTimeout(autoResetTimer); 
    autoResetTimer = null; 
  }
  currentSessionId = null;
  latestSession = null;
  latestPlayers = [];
}

// ---------- Boot ----------
document.addEventListener('DOMContentLoaded', () => {
  tryResumeFromStorage();
});

// ---------- Keyboard Shortcuts ----------
document.addEventListener('keydown', (e) => {
  if (e.key >= '1' && e.key <= '3') {
    const choiceBtn = document.querySelector(`.choice-btn[data-choice="${parseInt(e.key) - 1}"]`);
    if (choiceBtn && !choiceBtn.disabled) {
      choiceBtn.click();
    }
  }
});

// ---------- Replay Pixel Scene ----------
$('btn-replay-pixel')?.addEventListener('click', () => {
  const container = $('pixel-scene');
  if (!container) return;
  
  container.classList.remove('flash');
  void container.offsetWidth;
  container.classList.add('flash');
  
  sounds.playClick();
  
  const history = latestSession?.story_history || [];
  if (history.length > 0) {
    const sceneData = parseSceneFromStory(history[history.length - 1], latestSession);
    generateSceneImage(sceneData);
  }
  
  toast('Replaying scene...', 1500);
});