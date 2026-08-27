// ============================================================
// Last Ember — Modern Client Application Logic
// With Character Creation and Stats System
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
let currentCharacter = null; // Selected character for this session
let currentSessionId = null;
let gameChannel = null;
let lobbyChannel = null;
let latestPlayers = [];
let latestSession = null;

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

// ---------- Character Management ----------
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
  // Base HP for level 1: max hit die (10 for fighter) + con mod
  return 10 + conMod;
}

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
    
    // Go to character selection instead of directly to lobby
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

async function