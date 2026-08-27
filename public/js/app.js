// ============================================================
// Last Ember — Modern Client Application Logic
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
let autoResetTimer = null;

const STORAGE_KEY = 'lastEmberUser';
const CHAR_STORAGE_KEY = 'lastEmberCharacter';
const sounds = new SoundManager();

// ---------- DOM Helpers ----------
function $(id) { return document.getElementById(id); }

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
  const isAnimated = mode === 'animated';
  document.body.classList.toggle('theme-animated', isAnimated);
  document.body.classList.toggle('theme-simple', !isAnimated);
  
  const label = isAnimated ? '✨ Animated: On' : '✨ Animated: Off';
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

function getClassEmoji(className) {
  const emojis = {
    fighter: '⚔️',
    rogue: '🗡️',
    cleric: '✨',
    wizard: '🔮',
    ranger: '🏹',
    paladin: '🛡️',
    bard: '🎵',
    druid: '🌿'
  };
  return emojis[className.toLowerCase()] || '⚔️';
}

function getRaceEmoji(raceName) {
  const emojis = {
    human: '🧑',
    elf: '🧝',
    dwarf: '⛏️',
    halfling: '🍃',
    gnome: '🔧',
    'half-elf': '🧝‍♂️',
    'half-orc': '💪'
  };
  return emojis[raceName.toLowerCase()] || '🧑';
}

function getDefaultStats() {
  return {
    strength: 8,
    dexterity: 8,
    constitution: 8,
    intelligence: 8,
    wisdom: 8,
    charisma: 8
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
  return 27 - calculatePointBuyCost(stats);
}

function statIsValid(stats) {
  const points = getAvailablePoints(stats);
  const allValid = Object.values(stats).every(v => v >= 8 && v <= 15);
  return allValid && points >= 0;
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
    
    // Check if there's a stored character selection
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
    toast(`✨ ${data.name} has been created!`, 2500, 'success');
    sounds.playClick();
    
    // Close modal
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
  toast(`🎯 Selected ${char.name}`, 2000, 'success');
  sounds.playClick();
  
  // Go to lobby
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
  
  const raceEmoji = getRaceEmoji(char.race);
  const classEmoji = getClassEmoji(char.class);
  
  content.innerHTML = `
    <div style="text-align: center; margin-bottom: var(--space-md);">
      <span style="font-size: 2.5rem;">${classEmoji}</span>
      <h3 style="margin: var(--space-xs) 0;">${escapeHtml(char.name)}</h3>
      <p class="text-secondary">${raceEmoji} ${escapeHtml(char.race)} · ${classEmoji} ${escapeHtml(char.class)} · Level ${char.level || 1}</p>
      <p style="font-size: 0.85rem; color: var(--text-muted);">❤️ HP: ${getHitPoints(char.constitution || 8, char.level || 1)}</p>
    </div>
    
    <div class="stats-sheet">
      <div class="stat-item">
        <span class="stat-label">💪 Strength</span>
        <span class="stat-value">${stats.strength}</span>
        <span class="stat-mod ${getModifierClass(getStatModifier(stats.strength))}">${getModifierDisplay(getStatModifier(stats.strength))}</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">🏃 Dexterity</span>
        <span class="stat-value">${stats.dexterity}</span>
        <span class="stat-mod ${getModifierClass(getStatModifier(stats.dexterity))}">${getModifierDisplay(getStatModifier(stats.dexterity))}</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">💚 Constitution</span>
        <span class="stat-value">${stats.constitution}</span>
        <span class="stat-mod ${getModifierClass(getStatModifier(stats.constitution))}">${getModifierDisplay(getStatModifier(stats.constitution))}</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">🧠 Intelligence</span>
        <span class="stat-value">${stats.intelligence}</span>
        <span class="stat-mod ${getModifierClass(getStatModifier(stats.intelligence))}">${getModifierDisplay(getStatModifier(stats.intelligence))}</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">👁️ Wisdom</span>
        <span class="stat-value">${stats.wisdom}</span>
        <span class="stat-mod ${getModifierClass(getStatModifier(stats.wisdom))}">${getModifierDisplay(getStatModifier(stats.wisdom))}</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">🎭 Charisma</span>
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
    const raceEmoji = getRaceEmoji(char.race);
    const classEmoji = getClassEmoji(char.class);
    const hp = getHitPoints(char.constitution || 8, char.level || 1);
    
    return `
      <div class="character-card ${isSelected ? 'selected' : ''}" style="${isSelected ? 'border-color: #6c5ce7;' : ''}">
        <span class="char-avatar">${classEmoji}</span>
        <div class="char-name">${escapeHtml(char.name)}</div>
        <div class="char-class-race">${raceEmoji} ${escapeHtml(char.race)} · ${classEmoji} ${escapeHtml(char.class)}</div>
        <div class="char-level">Level ${char.level || 1} · ❤️ ${hp} HP</div>
        <div style="display: flex; gap: var(--space-xs); margin-top: var(--space-sm); flex-wrap: wrap;">
          <button class="btn btn-primary btn-sm char-select-btn" data-char-id="${char.id}">
            ${isSelected ? '✅ Selected' : 'Select'}
          </button>
          <button class="btn btn-secondary btn-sm char-stats-btn" data-char-id="${char.id}">
            📊 Stats
          </button>
          <button class="btn btn-danger btn-sm char-delete-btn" data-char-id="${char.id}">
            ✕
          </button>
        </div>
      </div>
    `;
  }).join('');
  
  // Event listeners for character cards
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
  if (charEl) charEl.textContent = `👤 ${currentUser.username}`;
  loadCharacters();
}

// ---------- Character Creation Modal ----------
let currentCharStats = getDefaultStats();

function showCharStep(step) {
  // Hide all steps
  document.querySelectorAll('.char-step').forEach(el => el.classList.remove('active'));
  
  // Show target step
  const target = $(`char-step-${step}`);
  if (target) target.classList.add('active');
  
  // Update stats display if on step 2
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
  
  // Validate range
  if (newValue < 8 || newValue > 15) return;
  
  // Check if we have enough points
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
    const { data: profile, error } = await sb.rpc('login_or_create_profile', { p_username: name });
    if (error) throw error;
    setCurrentUserFromProfile(profile);
    sounds.playClick();
    enterCharacterSelection();
  } catch (err) {
    console.error(err);
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
  
  // Check if there's a saved character
  const savedCharId = localStorage.getItem(CHAR_STORAGE_KEY);
  if (savedCharId) {
    // Try to load characters and auto-select
    await loadCharacters();
    if (currentCharacter) {
      enterLobby();
      return;
    }
  }
  
  enterCharacterSelection();
}

$('btn-char-logout')?.addEventListener('click', () => {
  teardownSubscriptions();
  currentUser = null;
  currentCharacter = null;
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(CHAR_STORAGE_KEY);
  showScreen('screen-auth');
  toast('Signed out successfully');
});

// ---------- Character Creation Events ----------
$('btn-create-character')?.addEventListener('click', () => {
  // Reset stats
  currentCharStats = getDefaultStats();
  updateStatsDisplay();
  
  // Clear form fields
  const nameInput = $('char-name');
  if (nameInput) nameInput.value = '';
  
  // Show step 1
  showCharStep(1);
  
  const modal = $('modal-character-creation');
  if (modal) modal.showModal();
});

$('btn-creation-close')?.addEventListener('click', () => {
  const modal = $('modal-character-creation');
  if (modal) modal.close();
});

// Stat adjustment buttons
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
  
  const name = $('char-name')?.value.trim();
  if (!name) {
    toast('Please enter a character name.', 2000, 'error');
    return;
  }
  
  // Check if stats are valid
  if (!statIsValid(currentCharStats)) {
    toast('Please assign your stats properly (27 points, 8-15 each).', 3000, 'error');
    showCharStep(2);
    return;
  }
  
  const charData = {
    name,
    race: $('char-race')?.value || 'Human',
    class: $('char-class')?.value || 'Fighter',
    level: 1,
    strength: currentCharStats.strength,
    dexterity: currentCharStats.dexterity,
    constitution: currentCharStats.constitution,
    intelligence: currentCharStats.intelligence,
    wisdom: currentCharStats.wisdom,
    charisma: currentCharStats.charisma,
    background: $('char-background')?.value || '',
    personality: $('char-personality')?.value || '',
    ideal: $('char-ideal')?.value || '',
    bond: $('char-bond')?.value || '',
    flaw: $('char-flaw')?.value || ''
  };
  
  await saveCharacter(charData);
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
  if (el) el.textContent = `👤 ${currentUser.username}`;
  
  const charEl = $('char-username');
  if (charEl) charEl.textContent = `👤 ${currentUser.username}`;
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
    const isFull = (count ?? 0) >= 6;
    rows.push(`
      <div class="session-item">
        <div>
          <div style="font-weight: 600;">${escapeHtml(s.creator_name || 'A traveler')}'s table</div>
          <div class="session-meta">${count ?? 0}/6 players · ${s.id.slice(0, 6).toUpperCase()}</div>
        </div>
        <button class="btn btn-secondary btn-sm" data-join="${s.id}" ${isFull ? 'disabled' : ''}>
          ${isFull ? 'Full' : 'Join →'}
        </button>
      </div>
    `);
  }
  
  list.innerHTML = rows.join('');
  const empty = $('session-list-empty');
  if (empty) empty.classList.toggle('hidden', rows.length > 0);
  
  list.querySelectorAll('[data-join]').forEach(b => {
    b.addEventListener('click', () => {
      if (!currentCharacter) {
        toast('Please select a character first.', 3000, 'error');
        enterCharacterSelection();
        return;
      }
      sounds.playClick();
      joinSession(b.dataset.join);
    });
  });
}

function enterLobby() {
  if (!currentCharacter) {
    enterCharacterSelection();
    return;
  }
  
  showScreen('screen-lobby');
  const banner = $('active-session-banner');
  if (banner) banner.classList.toggle('hidden', !currentUser.activeSessionId);

  refreshLobbyList();
  
  // FIX: Remove existing channel first
  if (lobbyChannel) {
    sb.removeChannel(lobbyChannel);
    lobbyChannel = null;
  }
  
  // FIX: Create channel and add ALL listeners BEFORE subscribe
  lobbyChannel = sb.channel('lobby-sessions');
  
  // Add all listeners FIRST
  lobbyChannel
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions' }, refreshLobbyList)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'players' }, refreshLobbyList);
  
  // THEN subscribe
  lobbyChannel.subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      console.log('✅ Lobby channel connected');
    } else if (status === 'CHANNEL_ERROR') {
      console.error('❌ Lobby channel error');
    }
  });
}

// ---------- Session Management ----------
$('btn-create-session')?.addEventListener('click', async () => {
  if (!currentCharacter) {
    toast('Please select a character first.', 3000, 'error');
    enterCharacterSelection();
    return;
  }
  
  try {
    const { data: newSession, error: sErr } = await sb.from('sessions').insert({
      creator_id: currentUser.uid,
      creator_name: currentCharacter.name,
      turn_order: [currentUser.uid],
    }).select().single();
    if (sErr) throw sErr;

    const { error: pErr } = await sb.from('players').insert({
      session_id: newSession.id,
      user_id: currentUser.uid,
      display_name: currentCharacter.name,
      position_in_turn_order: 0,
      character_id: currentCharacter.id,
    });
    if (pErr) throw pErr;

    await sb.from('profiles').update({ active_session_id: newSession.id }).eq('id', currentUser.uid);
    currentUser.activeSessionId = newSession.id;

    enterGame(newSession.id);
    toast(`🔥 ${currentCharacter.name} enters the tale!`, 2500, 'success');

    const { error: fnErr } = await sb.functions.invoke('generate-story', {
      body: { sessionId: newSession.id, userId: currentUser.uid, kickoff: true },
    });
    if (fnErr) {
      console.error('Kickoff failed:', fnErr);
      toast('Opening scene failed — use "Start the tale" to retry.', 4000, 'error');
    }
  } catch (err) {
    console.error(err);
    toast('Could not create session: ' + (err.message || err), 4000, 'error');
  }
});

async function joinSession(sessionId) {
  if (!currentCharacter) {
    toast('Please select a character first.', 3000, 'error');
    enterCharacterSelection();
    return;
  }
  
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
      display_name: currentCharacter.name,
      position_in_turn_order: order.length,
      character_id: currentCharacter.id,
    });
    if (pErr) throw pErr;

    await sb.from('sessions').update({ turn_order: [...order, currentUser.uid] }).eq('id', sessionId);
    await sb.from('profiles').update({ active_session_id: sessionId }).eq('id', currentUser.uid);
    currentUser.activeSessionId = sessionId;
    
    enterGame(sessionId);
    toast(`🎲 ${currentCharacter.name} joins the table!`, 2000, 'success');
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

// ---------- Stats Buttons ----------
$('lobby-char-stats')?.addEventListener('click', () => {
  if (currentCharacter) {
    showCharacterStats(currentCharacter.id);
  } else {
    toast('No character selected.', 3000, 'error');
  }
});

$('game-char-stats')?.addEventListener('click', () => {
  if (currentCharacter) {
    showCharacterStats(currentCharacter.id);
  } else {
    toast('No character selected.', 3000, 'error');
  }
});

$('btn-stats-close')?.addEventListener('click', () => {
  const modal = $('modal-character-stats');
  if (modal) modal.close();
});

// Close stats modal on backdrop click
$('modal-character-stats')?.addEventListener('click', (e) => {
  if (e.target === e.currentTarget) {
    e.currentTarget.close();
  }
});

// ---------- Game Screen ----------
async function refreshGameState() {
  const [{ data: session }, { data: players }] = await Promise.all([
    sb.from('sessions').select('*').eq('id', currentSessionId).single(),
    sb.from('players').select('*').eq('session_id', currentSessionId).order('position_in_turn_order'),
  ]);
  if (!session) return;
  
  latestSession = session;
  latestPlayers = players || [];
  renderGame();
  
  if (latestSession.status === 'completed') {
    sounds.playWin();
    showEndScreen(latestSession);
  }
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
  if (codeEl) codeEl.textContent = `🎯 ${sessionId.slice(0, 6).toUpperCase()}`;

  refreshGameState();
  refreshChatMessages();

  // FIX: Remove existing channel first
  if (gameChannel) {
    sb.removeChannel(gameChannel);
    gameChannel = null;
  }
  
  // FIX: Create channel and add ALL listeners BEFORE subscribe
  gameChannel = sb.channel('game-' + sessionId);
  
  // Add all listeners FIRST
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
  
  // THEN subscribe
  gameChannel.subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      console.log('✅ Game channel connected for:', sessionId);
    } else if (status === 'CHANNEL_ERROR') {
      console.error('❌ Game channel error for:', sessionId);
    }
  });
}

// ---------- Retry Kickoff ----------
async function retryKickoff() {
  const btn = $('btn-start-tale');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Writing…';
  }
  
  const { data, error } = await sb.functions.invoke('generate-story', {
    body: { sessionId: currentSessionId, userId: currentUser.uid, kickoff: true },
  });
  
  if (error) {
    console.error('Retry kickoff failed:', error);
    toast('Still failed: ' + (error.message || 'Unknown error'), 4000, 'error');
    if (btn) {
      btn.disabled = false;
      btn.textContent = '🔥 Start the tale';
    }
  }
}

// ---------- Render Game ----------
function renderGame() {
  if (!latestSession) return;

  // Player List
  const list = $('player-list');
  if (list) {
    list.innerHTML = latestPlayers.map((p) => {
      const isTurn = latestSession.turn_order && 
        latestSession.turn_order[latestSession.current_turn_index] === p.user_id && 
        p.is_alive;
      const pct = Math.max(0, Math.min(100, p.health));
      const color = pct > 55 ? 'var(--health-full)' : pct > 25 ? 'var(--health-mid)' : 'var(--health-low)';
      
      return `
        <li class="player-item ${isTurn ? 'current-turn' : ''} ${!p.is_alive ? 'eliminated' : ''}" data-user-id="${p.user_id}">
          <div class="p-name">
            <span>${escapeHtml(p.display_name)}${p.user_id === currentUser.uid ? ' (you)' : ''}</span>
            <span class="p-health-num">${p.is_alive ? pct : '💀'}</span>
          </div>
          <div class="p-health-track">
            <div class="p-health-fill" style="width:${pct}%;background:${color}"></div>
          </div>
        </li>
      `;
    }).join('');
  }

  // Turn Indicator
  const currentTurnUid = latestSession.turn_order ? latestSession.turn_order[latestSession.current_turn_index] : null;
  const currentPlayer = latestPlayers.find(p => p.user_id === currentTurnUid);
  const turnEl = $('turn-indicator');
  
  const choices = latestSession.story_choices || [];
  const isStuck = latestSession.status === 'active' &&
    !choices.length &&
    (latestSession.story_narrative || '').trim() === 'The story is being written…';

  if (turnEl) {
    if (latestSession.status === 'completed') {
      turnEl.textContent = '🏁 The tale has ended.';
    } else if (isStuck) {
      turnEl.textContent = '⏳ Waiting for the storyteller…';
    } else if (currentPlayer) {
      turnEl.textContent = currentTurnUid === currentUser.uid 
        ? '🎯 It is your turn!' 
        : `⏳ Waiting on ${currentPlayer.display_name}…`;
    }
  }

  // Story Text
  const storyTextEl = $('story-text');
  if (storyTextEl) storyTextEl.textContent = latestSession.story_narrative || '';

  // Choices
  const isMyTurn = currentTurnUid === currentUser.uid && latestSession.status === 'active';
  const choicesEl = $('choices');
  
  if (choicesEl) {
    if (isStuck) {
      choicesEl.innerHTML = `<button id="btn-start-tale" class="choice-btn">🔥 Start the tale</button>`;
      $('btn-start-tale')?.addEventListener('click', retryKickoff);
    } else if (!choices.length || latestSession.status !== 'active') {
      choicesEl.innerHTML = '';
    } else {
      choicesEl.innerHTML = choices.map((c, i) => `
        <button class="choice-btn" data-choice="${i}" ${isMyTurn ? '' : 'disabled'}>
          ${escapeHtml(c)}
        </button>
      `).join('');
      
      choicesEl.querySelectorAll('[data-choice]').forEach(btn => {
        btn.addEventListener('click', () => {
          sounds.playClick();
          submitChoice(Number(btn.dataset.choice));
        });
      });
    }
  }

  // Status
  const statusEl = $('story-status');
  if (statusEl) {
    statusEl.textContent = isStuck 
      ? '' 
      : (isMyTurn ? '' : (latestSession.status === 'active' ? 'Only the active player can choose.' : ''));
  }

  renderStoryLog();
}

// ---------- Submit Choice ----------
async function submitChoice(choiceIndex) {
  const choicesEl = $('choices');
  if (choicesEl) choicesEl.querySelectorAll('button').forEach(b => b.disabled = true);
  
  const statusEl = $('story-status');
  if (statusEl) statusEl.textContent = '⏳ The storyteller is weaving…';
  
  const { data, error } = await sb.functions.invoke('generate-story', {
    body: { sessionId: currentSessionId, userId: currentUser.uid, choiceIndex },
  });
  
  if (error) {
    console.error('submitChoice failed:', error);
    if (statusEl) statusEl.textContent = '❌ The story engine faltered — please try again.';
    toast('Story generation failed: ' + (error.message || 'Unknown error'), 4000, 'error');
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
      return `<li class="log-item log-party">⚡ ${escapeHtml(h.outcome)}</li>`;
    }
    const impactText = typeof h.impact === 'number'
      ? (h.impact < 0 ? ` — lost ${Math.abs(h.impact)} HP` : h.impact > 0 ? ` — recovered ${h.impact} HP` : ' — unscathed')
      : '';
    const rollText = h.roll ? ` (${escapeHtml(h.roll)})` : '';
    return `<li class="log-item">
      <div class="log-player">${escapeHtml(h.player)}${impactText}${rollText}</div>
      ${h.choice ? `<div class="log-choice">"${escapeHtml(h.choice)}"</div>` : ''}
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
    titleEl.textContent = winner ? `🔥 ${winner.display_name} survives!` : '💀 The table has fallen';
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
      toast('🔄 Table reset — ready for a new tale!', 3000, 'success');
    }
  }, 6000);
}

// ============================================================
// MASTER RESET - FIXED VERSION
// ============================================================

// ============================================================
// MASTER RESET - NO PASSWORD REQUIRED
// ============================================================

// ---------- Master Reset Button - Open Modal ----------
const resetOpenBtn = document.getElementById('btn-master-reset-open');
if (resetOpenBtn) {
  resetOpenBtn.addEventListener('click', function(e) {
    console.log('🔄 Reset button clicked!');
    
    if (!currentUser) {
      toast('Please login first.', 3000, 'error');
      return;
    }
    
    const sessionId = currentSessionId || currentUser?.activeSessionId;
    if (!sessionId) {
      toast('Join or create a session first.', 3000, 'error');
      return;
    }
    
    // Clear previous error
    const errEl = document.getElementById('reset-error');
    if (errEl) errEl.textContent = '';
    
    // Show the modal
    const modal = document.getElementById('modal-reset');
    if (modal) {
      modal.showModal();
      console.log('✅ Reset modal opened');
    } else {
      console.error('❌ Modal element not found!');
      toast('Modal not found.', 3000, 'error');
    }
  });
} else {
  console.error('❌ Reset button not found!');
}

// ---------- Reset Cancel Button ----------
const resetCancelBtn = document.getElementById('btn-reset-cancel');
if (resetCancelBtn) {
  resetCancelBtn.addEventListener('click', function() {
    const modal = document.getElementById('modal-reset');
    if (modal) modal.close();
    console.log('Reset cancelled');
  });
}

// ---------- Reset Confirm Button (No Password) ----------
const resetConfirmBtn = document.getElementById('btn-reset-confirm');
if (resetConfirmBtn) {
  resetConfirmBtn.addEventListener('click', async function() {
    console.log('🔄 Reset confirm clicked!');
    
    const sessionId = currentSessionId || currentUser?.activeSessionId;
    const errEl = document.getElementById('reset-error');
    
    // Clear previous error
    if (errEl) errEl.textContent = '';
    
    // Validate
    if (!sessionId) {
      if (errEl) errEl.textContent = 'No active session to reset.';
      return;
    }
    
    // Disable button while processing
    const confirmBtn = this;
    confirmBtn.disabled = true;
    confirmBtn.textContent = '⏳ Resetting...';
    
    try {
      console.log(`📤 Sending reset request for session: ${sessionId}`);
      
      const { data, error } = await sb.functions.invoke('master-reset', {
        body: { 
          sessionId: sessionId, 
          userId: currentUser.uid
        },
      });
      
      console.log('📥 Reset response:', { data, error });
      
      if (error) {
        console.error('❌ Reset error:', error);
        const errorMsg = error.message || 'Server error.';
        if (errEl) errEl.textContent = errorMsg;
        toast('❌ Reset failed: ' + errorMsg, 4000, 'error');
        return;
      }
      
      // Success!
      console.log('✅ Reset successful!', data);
      
      // Close modal
      const modal = document.getElementById('modal-reset');
      if (modal) modal.close();
      
      toast('🔄 Session has been completely wiped and reset!', 3000, 'success');
      
      // Refresh the game state
      if (typeof refreshGameState === 'function') {
        await refreshGameState();
      }
      
      // If we're in the lobby, refresh the lobby list
      const lobbyScreen = document.getElementById('screen-lobby');
      if (lobbyScreen && lobbyScreen.classList.contains('active')) {
        if (typeof refreshLobbyList === 'function') {
          refreshLobbyList();
        }
      }
      
      // If we're in the game, reload
      const gameScreen = document.getElementById('screen-game');
      if (gameScreen && gameScreen.classList.contains('active')) {
        if (typeof enterGame === 'function') {
          enterGame(sessionId);
        }
      }
      
    } catch (err) {
      console.error('❌ Unexpected reset error:', err);
      if (errEl) errEl.textContent = err.message || 'Something went wrong.';
      toast('❌ Reset failed: ' + (err.message || 'Unknown error'), 4000, 'error');
    } finally {
      // Re-enable button
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Yes, Reset Session';
    }
  });
} else {
  console.error('❌ Reset confirm button not found!');
}

// ---------- Close modal on backdrop click ----------
const resetModal = document.getElementById('modal-reset');
if (resetModal) {
  resetModal.addEventListener('click', function(e) {
    if (e.target === this) {
      this.close();
      console.log('Modal closed by backdrop click');
    }
  });
}

// ---------- Close modal with Escape key ----------
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    const modal = document.getElementById('modal-reset');
    if (modal && modal.open) {
      modal.close();
      console.log('Modal closed with Escape key');
    }
  }
});

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
  // Escape to close modal
  if (e.key === 'Escape') {
    const modal = $('modal-reset');
    if (modal?.open) modal.close();
  }
  
  // Number keys 1-3 for choices
  if (e.key >= '1' && e.key <= '3') {
    const choiceBtn = document.querySelector(`.choice-btn[data-choice="${parseInt(e.key) - 1}"]`);
    if (choiceBtn && !choiceBtn.disabled) {
      choiceBtn.click();
    }
  }
});