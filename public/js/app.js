// ============================================================
// Last Ember — Modern Client Application Logic
// Enhanced with smooth animations, better UX, and sound effects
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
let currentSessionId = null;
let gameChannel = null;
let lobbyChannel = null;
let latestPlayers = [];
let latestSession = null;

const STORAGE_KEY = 'lastEmberUser';
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

// ---------- Health Animation ----------
function animateHealthChange(playerElement, newHealth) {
  const fill = playerElement?.querySelector('.p-health-fill');
  if (!fill) return;
  
  const pct = Math.max(0, Math.min(100, newHealth));
  const color = pct > 55 ? 'var(--health-full)' : pct > 25 ? 'var(--health-mid)' : 'var(--health-low)';
  
  fill.style.transition = 'width 0.8s cubic-bezier(0.34, 1.56, 0.64, 1), background 0.5s ease';
  fill.style.width = `${pct}%`;
  fill.style.background = color;
  
  // Pulse effect
  fill.animate([
    { transform: 'scale(1)' },
    { transform: 'scale(1.08)' },
    { transform: 'scale(1)' }
  ], {
    duration: 400,
    iterations: 1
  });
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
    enterLobby();
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
  enterLobby();
}

$('btn-logout')?.addEventListener('click', () => {
  teardownSubscriptions();
  currentUser = null;
  localStorage.removeItem(STORAGE_KEY);
  const nameInput = $('name-input');
  const nameError = $('name-error');
  if (nameInput) nameInput.value = '';
  if (nameError) nameError.textContent = '';
  showScreen('screen-auth');
  toast('Signed out successfully');
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

// ---------- Lobby ----------
async function refreshLobbyList() {
  const { data: sessions } = await sb.from('sessions').select('*').eq('status', 'active');
  const list = $('session-list');
  if (!list) return;
  
  const rows = [];
  for (const s of sessions || []) {
    const { count } = await sb.from('players').select('*', { count: 'exact', head: true }).eq('session_id', s.id);
    if ((count ?? 0) >= 6) continue;
    rows.push(`
      <div class="session-item">
        <div>
          <div style="font-weight: 600;">${escapeHtml(s.creator_name || 'A traveler')}'s table</div>
          <div class="session-meta">${count ?? 0}/6 players · ${s.id.slice(0, 6).toUpperCase()}</div>
        </div>
        <button class="btn btn-secondary btn-sm" data-join="${s.id}">Join →</button>
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
}

function enterLobby() {
  showScreen('screen-lobby');
  const banner = $('active-session-banner');
  if (banner) banner.classList.toggle('hidden', !currentUser.activeSessionId);

  refreshLobbyList();
  lobbyChannel = sb.channel('lobby-sessions')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions' }, refreshLobbyList)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'players' }, refreshLobbyList)
    .subscribe();
}

// ---------- Session Management ----------
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
    toast('🔥 Session created! The tale begins…', 2500, 'success');

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
    toast('🎲 You joined the table!', 2000, 'success');
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
    display_name: currentUser.username,
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

  gameChannel = sb.channel('game-' + sessionId)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions', filter: `id=eq.${sessionId}` }, refreshGameState)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'players', filter: `session_id=eq.${sessionId}` }, refreshGameState)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `session_id=eq.${sessionId}` }, refreshChatMessages)
    .subscribe();
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
let autoResetTimer = null;

function showEndScreen(session) {
  showScreen('screen-end');
  const winner = latestPlayers.find(p => p.is_alive);
  const titleEl = $('end-title');
  const summaryEl = $('end-summary');
  
  if (titleEl) {
    titleEl.textContent = winner ? `🔥 ${winner.display_name} survives!` : '💀 The table has fallen';
  }
  if (summaryEl) summaryEl.textContent = session.story_narrative || '';

  if (!autoResetTimer) {
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
}

// ---------- Master Reset ----------
$('btn-master-reset-open')?.addEventListener('click', () => {
  if (!currentUser.activeSessionId && !currentSessionId) {
    toast('Join or create a session first.', 3000, 'error');
    return;
  }
  const pw = $('reset-password');
  const err = $('reset-error');
  if (pw) pw.value = '';
  if (err) err.textContent = '';
  $('modal-reset')?.showModal();
});

$('btn-reset-cancel')?.addEventListener('click', () => {
  $('modal-reset')?.close();
});

$('btn-reset-confirm')?.addEventListener('click', async () => {
  const sessionId = currentSessionId || currentUser.activeSessionId;
  const errEl = $('reset-error');
  if (errEl) errEl.textContent = '';
  
  const { data, error } = await sb.functions.invoke('master-reset', {
    body: { 
      sessionId, 
      userId: currentUser.uid, 
      password: $('reset-password')?.value 
    },
  });
  
  if (error) {
    const msg = error.message || 'Incorrect password.';
    if (errEl) errEl.textContent = msg;
    toast('Reset failed: ' + msg, 4000, 'error');
  } else {
    $('modal-reset')?.close();
    toast('🔄 Session reset successfully.', 3000, 'success');
  }
});

// ---------- Cleanup ----------
function teardownSubscriptions() {
  if (gameChannel) { sb.removeChannel(gameChannel); gameChannel = null; }
  if (lobbyChannel) { sb.removeChannel(lobbyChannel); lobbyChannel = null; }
  if (autoResetTimer) { clearTimeout(autoResetTimer); autoResetTimer = null; }
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