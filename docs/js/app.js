// ============================================================
// Last Ember — client application logic (Supabase edition)
//
// No Supabase Auth: a player's identity is just their username.
// Typing the same name again (on any device, any browser) calls
// login_or_create_profile() and gets back the same profile row —
// same id, same active_session_id, same UI preference — so it
// looks like you never left. There's no password, so this trusts
// people to type their own name; see the README for the trade-off.
// ============================================================

let currentUser = null;   // { uid, username, preferredUiMode, activeSessionId }
let currentSessionId = null;
let gameChannel = null;
let lobbyChannel = null;
let latestPlayers = [];
let latestSession = null;

const STORAGE_KEY = 'lastEmberUser';
const PLACEHOLDER_NARRATIVE = 'The story is being written…';

// ---------------- Utility ----------------
function $(id) { return document.getElementById(id); }
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id)?.classList.add('active');
}
function toast(msg, ms = 3200) {
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}
function applyTheme(mode) {
  document.body.classList.toggle('theme-animated', mode === 'animated');
  document.body.classList.toggle('theme-simple', mode !== 'animated');
  const label = mode === 'animated' ? 'Animated mode: On' : 'Animated mode: Off';
  const t1 = $('ui-mode-toggle');
  const t2 = $('ui-mode-toggle-2');
  if (t1) t1.textContent = label;
  if (t2) t2.textContent = label;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
async function extractFunctionError(error, fallbackData) {
  if (fallbackData?.error) return fallbackData.error;
  try {
    if (error?.context && typeof error.context.json === 'function') {
      const body = await error.context.json();
      if (body?.error) return body.error;
    }
  } catch { /* ignore, fall through */ }
  return error?.message || 'Unknown error.';
}

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
  if (el) el.textContent = currentUser.username;
}

// ---------------- Name entry ("login") ----------------
$('form-name')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = $('name-error');
  if (errEl) errEl.textContent = '';
  const name = $('name-input')?.value.trim();
  if (!name) return;

  const submitBtn = e.target.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;
  try {
    const { data: profile, error } = await sb.rpc('login_or_create_profile', { p_username: name });
    if (error) throw error;
    setCurrentUserFromProfile(profile);
    enterLobby();
  } catch (err) {
    console.error(err);
    if (errEl) errEl.textContent = err.message || 'Could not continue — try again.';
  } finally {
    if (submitBtn) submitBtn.disabled = false;
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
});

// ---------------- UI mode toggle (per-user, persisted) ----------------
async function toggleUiMode() {
  if (!currentUser) return;
  const next = currentUser.preferredUiMode === 'animated' ? 'simple' : 'animated';
  currentUser.preferredUiMode = next;
  applyTheme(next);
  await sb.from('profiles').update({ preferred_ui_mode: next }).eq('id', currentUser.uid);
}
$('ui-mode-toggle')?.addEventListener('click', toggleUiMode);
$('ui-mode-toggle-2')?.addEventListener('click', toggleUiMode);

// ---------------- Lobby ----------------
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
          <div>${escapeHtml(s.creator_name || 'A traveler')}'s table</div>
          <div class="session-meta">${count ?? 0}/6 players · code ${s.id.slice(0, 6).toUpperCase()}</div>
        </div>
        <button class="btn btn-secondary" data-join="${s.id}">Join</button>
      </div>
    `);
  }
  list.innerHTML = rows.join('');
  $('session-list-empty')?.classList.toggle('hidden', rows.length > 0);
  list.querySelectorAll('[data-join]').forEach(b => {
    b.addEventListener('click', () => joinSession(b.dataset.join));
  });
}

function enterLobby() {
  showScreen('screen-lobby');
  $('active-session-banner')?.classList.toggle('hidden', !currentUser.activeSessionId);

  refreshLobbyList();
  lobbyChannel = sb.channel('lobby-sessions')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions' }, refreshLobbyList)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'players' }, refreshLobbyList)
    .subscribe();
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

    const { data: fnData, error: fnErr } = await sb.functions.invoke('generate-story', {
      body: { sessionId: newSession.id, userId: currentUser.uid, kickoff: true },
    });
    if (fnErr) {
      const msg = await extractFunctionError(fnErr, fnData);
      console.error('Kickoff failed:', msg, fnErr);
      toast('The opening scene failed to generate — use "Start the tale" to retry.');
    }
  } catch (err) {
    console.error(err);
    toast('Could not create a session: ' + (err.message || err));
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
  } catch (err) {
    console.error(err);
    if (err.message?.includes('players_pkey') || err.code === '23505') {
      currentUser.activeSessionId = sessionId;
      enterGame(sessionId);
    } else {
      toast(err.message || 'Could not join that session.');
    }
  }
}

$('btn-resume-session')?.addEventListener('click', () => enterGame(currentUser.activeSessionId));
$('btn-leave-session')?.addEventListener('click', () => { teardownSubscriptions(); enterLobby(); });
$('btn-back-to-lobby')?.addEventListener('click', () => { teardownSubscriptions(); enterLobby(); });

// ---------------- Game screen ----------------
async function refreshGameState() {
  const [{ data: session }, { data: players }] = await Promise.all([
    sb.from('sessions').select('*').eq('id', currentSessionId).single(),
    sb.from('players').select('*').eq('session_id', currentSessionId).order('position_in_turn_order'),
  ]);
  if (!session) return;
  latestSession = session;
  latestPlayers = players || [];
  renderGame();
  if (latestSession.status === 'completed') showEndScreen(latestSession);
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
  const { error } = await sb.from('messages').insert({
    session_id: currentSessionId,
    user_id: currentUser.uid,
    display_name: currentUser.username,
    content,
  });
  if (error) {
    console.error(error);
    toast('Could not send message.');
  }
});

function enterGame(sessionId) {
  currentSessionId = sessionId;
  showScreen('screen-game');
  const codeEl = $('game-session-code');
  if (codeEl) codeEl.textContent = 'Table ' + sessionId.slice(0, 6).toUpperCase();

  refreshGameState();
  refreshChatMessages();

  gameChannel = sb.channel('game-' + sessionId)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions', filter: `id=eq.${sessionId}` }, refreshGameState)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'players', filter: `session_id=eq.${sessionId}` }, refreshGameState)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `session_id=eq.${sessionId}` }, refreshChatMessages)
    .subscribe();
}

// If a session's opening scene never generated, anyone at the table
// can retry it with this button — it just re-calls generate-story
// with kickoff: true.
async function retryKickoff() {
  const btn = $('btn-start-tale');
  if (btn) { btn.disabled = true; btn.textContent = 'Writing the opening scene…'; }
  const { data, error } = await sb.functions.invoke('generate-story', {
    body: { sessionId: currentSessionId, userId: currentUser.uid, kickoff: true },
  });
  if (error) {
    const msg = await extractFunctionError(error, data);
    console.error('Retry kickoff failed:', msg, error);
    toast('Still failed: ' + msg);
    if (btn) { btn.disabled = false; btn.textContent = 'Start the tale'; }
  }
}

function renderStoryLog() {
  const logEl = $('story-log');
  if (!logEl || !latestSession) return;
  const history = latestSession.story_history || [];
  if (!history.length) {
    logEl.innerHTML = `<li class="log-empty muted">No actions yet.</li>`;
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

function renderGame() {
  if (!latestSession) return;

  const list = $('player-list');
  if (list) {
    list.innerHTML = latestPlayers.map((p) => {
      const isTurn = latestSession.turn_order && latestSession.turn_order[latestSession.current_turn_index] === p.user_id && p.is_alive;
      const pct = Math.max(0, Math.min(100, p.health));
      const color = pct > 55 ? 'var(--health-full)' : pct > 25 ? 'var(--health-mid)' : 'var(--health-low)';
      return `
        <li class="player-item ${isTurn ? 'current-turn' : ''} ${!p.is_alive ? 'eliminated' : ''}">
          <div class="p-name"><span>${escapeHtml(p.display_name)}${p.user_id === currentUser.uid ? ' (you)' : ''}</span>
          <span class="p-health-num">${p.is_alive ? pct : 'eliminated'}</span></div>
          <div class="p-health-track"><div class="p-health-fill" style="width:${pct}%;background:${color}"></div></div>
        </li>`;
    }).join('');
  }

  const currentTurnUid = latestSession.turn_order ? latestSession.turn_order[latestSession.current_turn_index] : null;
  const currentPlayer = latestPlayers.find(p => p.user_id === currentTurnUid);
  const turnEl = $('turn-indicator');

  const choices = latestSession.story_choices || [];
  const isStuck = latestSession.status === 'active'
    && !choices.length
    && (latestSession.story_narrative || '').trim() === PLACEHOLDER_NARRATIVE;

  if (turnEl) {
    if (latestSession.status === 'completed') {
      turnEl.textContent = 'The tale has ended.';
    } else if (isStuck) {
      turnEl.textContent = 'The opening scene never generated.';
    } else if (currentPlayer) {
      turnEl.textContent = currentTurnUid === currentUser.uid ? 'It is your turn.' : `Waiting on ${currentPlayer.display_name}…`;
    }
  }

  const storyTextEl = $('story-text');
  if (storyTextEl) storyTextEl.textContent = latestSession.story_narrative || '';

  const isMyTurn = currentTurnUid === currentUser.uid && latestSession.status === 'active';
  const choicesEl = $('choices');
  if (choicesEl) {
    if (isStuck) {
      choicesEl.innerHTML = `<button id="btn-start-tale" class="choice-btn">Start the tale</button>`;
      $('btn-start-tale')?.addEventListener('click', retryKickoff);
    } else if (!choices.length || latestSession.status !== 'active') {
      choicesEl.innerHTML = '';
    } else {
      choicesEl.innerHTML = choices.map((c, i) => `
        <button class="choice-btn" data-choice="${i}" ${isMyTurn ? '' : 'disabled'}>${escapeHtml(c)}</button>
      `).join('');
      choicesEl.querySelectorAll('[data-choice]').forEach(btn => {
        btn.addEventListener('click', () => submitChoice(Number(btn.dataset.choice)));
      });
    }
  }
  const statusEl = $('story-status');
  if (statusEl) {
    statusEl.textContent = isStuck
      ? ''
      : (isMyTurn ? '' : (latestSession.status === 'active' ? 'Only the player whose turn it is can choose.' : ''));
  }

  renderStoryLog();
}

async function submitChoice(choiceIndex) {
  $('choices')?.querySelectorAll('button').forEach(b => b.disabled = true);
  const statusEl = $('story-status');
  if (statusEl) statusEl.textContent = 'The storyteller is weaving the outcome…';
  const { data, error } = await sb.functions.invoke('generate-story', {
    body: { sessionId: currentSessionId, userId: currentUser.uid, choiceIndex },
  });
  if (error) {
    const msg = await extractFunctionError(error, data);
    console.error('submitChoice failed:', msg, error);
    if (statusEl) statusEl.textContent = 'The story engine faltered — please try again.';
    toast('Story generation failed: ' + msg);
  }
}

// ---------------- End screen + automatic reset ----------------
let autoResetTimer = null;
function showEndScreen(session) {
  showScreen('screen-end');
  const winner = latestPlayers.find(p => p.is_alive);
  const titleEl = $('end-title');
  const summaryEl = $('end-summary');
  if (titleEl) titleEl.textContent = winner ? `${winner.display_name} survives` : 'The table has fallen';
  if (summaryEl) summaryEl.textContent = session.story_narrative || '';

  if (!autoResetTimer) {
    autoResetTimer = setTimeout(async () => {
      autoResetTimer = null;
      const { data, error } = await sb.functions.invoke('reset-session', {
        body: { sessionId: currentSessionId, userId: currentUser.uid },
      });
      if (error) {
        const msg = await extractFunctionError(error, data);
        console.error('Auto reset-session failed:', msg, error);
      }
    }, 6000);
  }
}

// ---------------- Master reset ----------------
$('btn-master-reset-open')?.addEventListener('click', () => {
  if (!currentUser.activeSessionId && !currentSessionId) {
    toast('Join or create a session first.');
    return;
  }
  const err = $('reset-error');
  if (err) err.textContent = '';
  $('modal-reset')?.classList.remove('hidden');
});
$('btn-reset-cancel')?.addEventListener('click', () => $('modal-reset')?.classList.add('hidden'));
$('btn-reset-confirm')?.addEventListener('click', async () => {
  const sessionId = currentSessionId || currentUser.activeSessionId;
  const errEl = $('reset-error');
  if (errEl) errEl.textContent = '';
  const { data, error } = await sb.functions.invoke('master-reset', {
    body: { sessionId, userId: currentUser.uid },
  });
  if (error) {
    const msg = await extractFunctionError(error, data);
    console.error('master-reset failed:', msg, error);
    if (errEl) errEl.textContent = msg || 'Something went wrong — check the console for details.';
  } else {
    $('modal-reset')?.classList.add('hidden');
    toast('Session reset.');
  }
});

// ---------------- Cleanup ----------------
function teardownSubscriptions() {
  if (gameChannel) { sb.removeChannel(gameChannel); gameChannel = null; }
  if (lobbyChannel) { sb.removeChannel(lobbyChannel); lobbyChannel = null; }
  if (autoResetTimer) { clearTimeout(autoResetTimer); autoResetTimer = null; }
  currentSessionId = null;
  latestSession = null;
  latestPlayers = [];
}

// ---------------- Boot ----------------
tryResumeFromStorage();