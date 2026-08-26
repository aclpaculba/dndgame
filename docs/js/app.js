// ============================================================
// Last Ember — client application logic (Supabase edition)
// Talks to Supabase Auth + Postgres directly for reads/writes
// that are safe under Row Level Security, and calls Edge
// Functions for anything that needs a secret (AI story calls,
// master reset password check).
// ============================================================

let currentUser = null;   // { uid, username, preferredUiMode, activeSessionId }
let currentSessionId = null;
let gameChannel = null;
let lobbyChannel = null;
let latestPlayers = [];
let latestSession = null;

// ---------------- Utility ----------------
function $(id) { return document.getElementById(id); }
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
}
function toast(msg, ms = 3200) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}
function applyTheme(mode) {
  document.body.classList.toggle('theme-animated', mode === 'animated');
  document.body.classList.toggle('theme-simple', mode !== 'animated');
  const label = mode === 'animated' ? 'Animated mode: On' : 'Animated mode: Off';
  $('ui-mode-toggle').textContent = label;
  $('ui-mode-toggle-2').textContent = label;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------- Auth tabs ----------------
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
    btn.classList.add('active');
    $(`form-${btn.dataset.tab}`).classList.add('active');
  });
});

$('form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  const { error } = await sb.auth.signInWithPassword({
    email: $('login-email').value.trim(),
    password: $('login-password').value,
  });
  if (error) $('login-error').textContent = friendlyAuthError(error);
});

$('form-register').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('register-error').textContent = '';
  const { error } = await sb.auth.signUp({
    email: $('register-email').value.trim(),
    password: $('register-password').value,
    options: { data: { username: $('register-name').value.trim() } },
  });
  if (error) {
    $('register-error').textContent = friendlyAuthError(error);
  } else {
    toast('Account created — you\'re signed in.');
  }
});

function friendlyAuthError(err) {
  const msg = err.message || '';
  if (/already registered/i.test(msg)) return 'That email already has an account — try signing in instead.';
  if (/invalid login credentials/i.test(msg)) return 'Incorrect email or password.';
  if (/password/i.test(msg) && /6/.test(msg)) return 'Password needs to be at least 6 characters.';
  return msg;
}

$('btn-logout').addEventListener('click', () => sb.auth.signOut());

// ---------------- Auth state → routing ----------------
sb.auth.onAuthStateChange(async (event, session) => {
  teardownSubscriptions();
  const user = session?.user;
  if (!user) {
    currentUser = null;
    showScreen('screen-auth');
    return;
  }

  // The DB trigger (handle_new_user) creates the profile row on sign-up,
  // but it can lag by a beat right after registration — poll briefly.
  let profile = null;
  for (let i = 0; i < 5 && !profile; i++) {
    const { data } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
    if (data) { profile = data; break; }
    await new Promise(r => setTimeout(r, 300));
  }
  if (!profile) { toast('Could not load your profile — try refreshing.'); return; }

  currentUser = {
    uid: user.id,
    username: profile.username,
    preferredUiMode: profile.preferred_ui_mode || 'simple',
    activeSessionId: profile.active_session_id,
  };
  applyTheme(currentUser.preferredUiMode);
  $('lobby-username').textContent = currentUser.username;
  enterLobby();
});

// ---------------- UI mode toggle (per-user, persisted) ----------------
async function toggleUiMode() {
  if (!currentUser) return;
  const next = currentUser.preferredUiMode === 'animated' ? 'simple' : 'animated';
  currentUser.preferredUiMode = next;
  applyTheme(next);
  await sb.from('profiles').update({ preferred_ui_mode: next }).eq('id', currentUser.uid);
}
$('ui-mode-toggle').addEventListener('click', toggleUiMode);
$('ui-mode-toggle-2').addEventListener('click', toggleUiMode);

// ---------------- Lobby ----------------
async function refreshLobbyList() {
  const { data: sessions } = await sb.from('sessions').select('*').eq('status', 'active');
  const list = $('session-list');
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
  $('session-list-empty').classList.toggle('hidden', rows.length > 0);
  list.querySelectorAll('[data-join]').forEach(b => {
    b.addEventListener('click', () => joinSession(b.dataset.join));
  });
}

function enterLobby() {
  showScreen('screen-lobby');
  $('active-session-banner').classList.toggle('hidden', !currentUser.activeSessionId);

  refreshLobbyList();
  lobbyChannel = sb.channel('lobby-sessions')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions' }, refreshLobbyList)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'players' }, refreshLobbyList)
    .subscribe();
}

$('btn-create-session').addEventListener('click', async () => {
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

    const { error: fnErr } = await sb.functions.invoke('generate-story', { body: { sessionId: newSession.id, kickoff: true } });
    if (fnErr) throw fnErr;

    enterGame(newSession.id);
  } catch (err) {
    console.error(err);
    toast('Could not create a session: ' + (err.message || err));
  }
});

async function joinSession(sessionId) {
  try {
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
    toast(err.message);
  }
}

$('btn-resume-session').addEventListener('click', () => enterGame(currentUser.activeSessionId));
$('btn-leave-session').addEventListener('click', () => { teardownSubscriptions(); enterLobby(); });
$('btn-back-to-lobby').addEventListener('click', () => { teardownSubscriptions(); enterLobby(); });

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

function enterGame(sessionId) {
  currentSessionId = sessionId;
  showScreen('screen-game');
  $('game-session-code').textContent = 'Table ' + sessionId.slice(0, 6).toUpperCase();

  refreshGameState();
  gameChannel = sb.channel('game-' + sessionId)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions', filter: `id=eq.${sessionId}` }, refreshGameState)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'players', filter: `session_id=eq.${sessionId}` }, refreshGameState)
    .subscribe();
}

function renderGame() {
  if (!latestSession) return;

  const list = $('player-list');
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

  const currentTurnUid = latestSession.turn_order ? latestSession.turn_order[latestSession.current_turn_index] : null;
  const currentPlayer = latestPlayers.find(p => p.user_id === currentTurnUid);
  const turnEl = $('turn-indicator');
  if (latestSession.status === 'completed') {
    turnEl.textContent = 'The tale has ended.';
  } else if (currentPlayer) {
    turnEl.textContent = currentTurnUid === currentUser.uid ? 'It is your turn.' : `Waiting on ${currentPlayer.display_name}…`;
  }

  $('story-text').textContent = latestSession.story_narrative || '';
  const choices = latestSession.story_choices || [];
  const isMyTurn = currentTurnUid === currentUser.uid && latestSession.status === 'active';
  const choicesEl = $('choices');
  if (!choices.length || latestSession.status !== 'active') {
    choicesEl.innerHTML = '';
  } else {
    choicesEl.innerHTML = choices.map((c, i) => `
      <button class="choice-btn" data-choice="${i}" ${isMyTurn ? '' : 'disabled'}>${escapeHtml(c)}</button>
    `).join('');
    choicesEl.querySelectorAll('[data-choice]').forEach(btn => {
      btn.addEventListener('click', () => submitChoice(Number(btn.dataset.choice)));
    });
  }
  $('story-status').textContent = isMyTurn ? '' : (latestSession.status === 'active' ? 'Only the player whose turn it is can choose.' : '');
}

async function submitChoice(choiceIndex) {
  $('choices').querySelectorAll('button').forEach(b => b.disabled = true);
  $('story-status').textContent = 'The storyteller is weaving the outcome…';
  const { error } = await sb.functions.invoke('generate-story', { body: { sessionId: currentSessionId, choiceIndex } });
  if (error) {
    console.error(error);
    $('story-status').textContent = 'The story engine faltered — please try again.';
    toast('Story generation failed: ' + error.message);
  }
}

// ---------------- End screen + automatic reset ----------------
let autoResetTimer = null;
function showEndScreen(session) {
  showScreen('screen-end');
  const winner = latestPlayers.find(p => p.is_alive);
  $('end-title').textContent = winner ? `${winner.display_name} survives` : 'The table has fallen';
  $('end-summary').textContent = session.story_narrative || '';

  // Requirement: auto-reset once the game ends and one player remains.
  if (!autoResetTimer) {
    autoResetTimer = setTimeout(async () => {
      autoResetTimer = null;
      const { error } = await sb.functions.invoke('reset-session', { body: { sessionId: currentSessionId } });
      if (error) console.error(error);
    }, 6000);
  }
}

// ---------------- Master reset (password-gated) ----------------
$('btn-master-reset-open').addEventListener('click', () => {
  if (!currentUser.activeSessionId && !currentSessionId) {
    toast('Join or create a session first.');
    return;
  }
  $('reset-password').value = '';
  $('reset-error').textContent = '';
  $('modal-reset').classList.remove('hidden');
});
$('btn-reset-cancel').addEventListener('click', () => $('modal-reset').classList.add('hidden'));
$('btn-reset-confirm').addEventListener('click', async () => {
  const sessionId = currentSessionId || currentUser.activeSessionId;
  $('reset-error').textContent = '';
  const { error } = await sb.functions.invoke('master-reset', { body: { sessionId, password: $('reset-password').value } });
  if (error) {
    $('reset-error').textContent = error.message || 'Incorrect password.';
  } else {
    $('modal-reset').classList.add('hidden');
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
