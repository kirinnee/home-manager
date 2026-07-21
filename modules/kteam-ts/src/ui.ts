// Single-file kteam dashboard shell. Keep this dependency-free: the daemon serves the
// page directly and the browser talks to the authenticated JSON/WebSocket API.

const STYLE = `
@import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap");
:root {
  color-scheme: light dark;
  --s1: 4px; --s2: 6px; --s3: 10px; --s4: 12px; --s5: 16px; --s6: 24px; --s7: 36px;
  --r-sm: 6px; --r-md: 8px; --r-full: 999px;
  --font-ui: "Inter", system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  --bg: #fbfbfc; --surface: #fff; --surface-2: #f5f5f6; --fg: #18181b;
  --fg-soft: #3f3f46; --muted: #71717a; --border: #e4e4e7; --border-soft: #ececee;
  --accent: #4f5bd5; --accent-fg: #fff; --accent-soft: #eef0fb; --accent-border: #d4d8f4;
  --code-bg: #f5f5f6; --ok: #3f7e52; --ok-bg: #eef4f0; --ok-border: #cfe2d6;
  --warn: #8a6420; --warn-bg: #f7f1e6; --warn-border: #e7dac0;
  --pend: #52525b; --pend-bg: #f4f4f5; --pend-border: #e4e4e7;
  --err: #a14040; --err-bg: #f7eded; --err-border: #e6cfcf;
  --bar-bg: rgba(251,251,252,.86);
}
:root[data-theme="dark"] {
  --bg: #0a0a0b; --surface: #141416; --surface-2: #1b1b1e; --fg: #f4f4f5;
  --fg-soft: #d4d4d8; --muted: #9b9ba3; --border: #2a2a2e; --border-soft: #222226;
  --accent: #8b93e8; --accent-fg: #0b0b0e; --accent-soft: #1c1c2c; --accent-border: #353560;
  --code-bg: #141416; --ok: #6fae82; --ok-bg: #14241a; --ok-border: #234630;
  --warn: #c79a52; --warn-bg: #241d11; --warn-border: #463719;
  --pend: #9b9ba3; --pend-bg: #1b1b1e; --pend-border: #2e2e33;
  --err: #cc7d7d; --err-bg: #251616; --err-border: #482a2a;
  --bar-bg: rgba(10,10,11,.86);
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; scroll-behavior: smooth; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 13.5px/1.45 var(--font-ui); -webkit-font-smoothing: antialiased; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
button, input, textarea { font: inherit; }
button { cursor: pointer; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.bar { position: sticky; top: 0; z-index: 5; border-bottom: 1px solid var(--border); background: var(--bar-bg); backdrop-filter: saturate(160%) blur(10px); }
.bar-inner { max-width: 1180px; min-height: 42px; margin: 0 auto; padding: 0 var(--s4); display: flex; align-items: center; gap: var(--s3); }
.crumb { flex: 1; min-width: 0; display: flex; align-items: center; gap: 4px; color: var(--muted); }
.crumb .cur { color: var(--fg); font-weight: 600; }
.themebtn { border: 0; border-radius: var(--r-sm); padding: 4px 7px; background: transparent; color: var(--muted); }
.themebtn:hover { color: var(--accent); background: var(--accent-soft); }
.live { display: inline-flex; align-items: center; gap: 5px; color: var(--muted); font-size: 11px; }
.live .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--pend); }
.live.on .dot { background: var(--ok); }
.live.beat .dot { background: var(--accent); }
main { max-width: 1180px; margin: 0 auto; padding: var(--s6) var(--s4) var(--s7); }
h1 { margin: 0 0 var(--s2); font-size: 1.3rem; letter-spacing: -.015em; }
h2 { margin: 0; font-size: 1rem; }
.muted { color: var(--muted); }
.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s3); margin: var(--s5) 0 var(--s4); padding: var(--s3); border: 1px solid var(--border-soft); border-radius: var(--r-md); background: var(--surface-2); }
.field { min-width: 210px; flex: 1; padding: 7px 9px; border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--surface); color: var(--fg); }
.check { display: inline-flex; align-items: center; gap: 6px; color: var(--fg-soft); white-space: nowrap; }
.btn { border: 1px solid var(--border); border-radius: var(--r-sm); padding: 6px 10px; background: var(--surface); color: var(--fg-soft); font-weight: 600; }
.btn:hover { border-color: var(--accent-border); color: var(--accent); }
.btn.primary { border-color: var(--accent); background: var(--accent); color: var(--accent-fg); }
.btn.danger { color: var(--err); }
.btn:disabled { cursor: wait; opacity: .55; }
.table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface); }
table { width: 100%; border-collapse: collapse; min-width: 820px; }
th { padding: 8px 10px; border-bottom: 1px solid var(--border); background: var(--surface-2); color: var(--muted); font-size: 10.5px; font-weight: 700; letter-spacing: .06em; text-align: left; text-transform: uppercase; }
td { padding: 9px 10px; border-bottom: 1px solid var(--border-soft); vertical-align: middle; }
tbody tr { cursor: pointer; }
tbody tr:hover { background: var(--surface-2); }
tbody tr:last-child td { border-bottom: 0; }
.mono { font-family: var(--font-mono); font-size: .78rem; }
.task { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.badge { display: inline-flex; align-items: center; gap: 4px; padding: 3px 7px; border: 1px solid var(--pend-border); border-radius: var(--r-sm); background: var(--pend-bg); color: var(--pend); font-size: 11px; font-weight: 600; white-space: nowrap; }
.badge .pip { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
.badge.ok { border-color: var(--ok-border); background: var(--ok-bg); color: var(--ok); }
.badge.warn { border-color: var(--warn-border); background: var(--warn-bg); color: var(--warn); }
.badge.err { border-color: var(--err-border); background: var(--err-bg); color: var(--err); }
.badge.accent { border-color: var(--accent-border); background: var(--accent-soft); color: var(--accent); }
.empty { padding: var(--s7) var(--s4); border: 1px dashed var(--border); border-radius: var(--r-md); background: var(--surface-2); color: var(--muted); text-align: center; }
.card { margin-bottom: var(--s4); padding: var(--s4); border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface); }
.hero { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s3); margin-bottom: var(--s4); }
.hero h1 { margin: 0; }
.actions { display: flex; flex-wrap: wrap; gap: var(--s2); margin-left: auto; }
.vitals { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: var(--s3); }
.vital { padding: var(--s3); border: 1px solid var(--border-soft); border-radius: var(--r-sm); background: var(--surface-2); }
.vital .label { color: var(--muted); font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
.vital .value { margin-top: 3px; color: var(--fg); font-family: var(--font-mono); font-size: .82rem; }
.section-title { margin: var(--s5) 0 var(--s3); color: var(--muted); font-size: 11px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; }
.snapshot, .events { overflow: auto; max-height: 480px; margin: 0; padding: var(--s3); border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--code-bg); color: var(--fg-soft); font: .76rem/1.55 var(--font-mono); white-space: pre-wrap; word-break: break-word; }
.events { max-height: 420px; }
.event { padding: 3px 0; border-bottom: 1px solid var(--border-soft); }
.event:last-child { border-bottom: 0; }
.event .event-time { color: var(--muted); }
.send { display: flex; gap: var(--s3); align-items: flex-end; }
.send textarea { flex: 1; min-height: 76px; resize: vertical; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--surface); color: var(--fg); }
.notice { margin-top: var(--s3); padding: 7px 10px; border: 1px solid var(--warn-border); border-radius: var(--r-sm); background: var(--warn-bg); color: var(--warn); }
.notice.error { border-color: var(--err-border); background: var(--err-bg); color: var(--err); }
.question { margin-bottom: var(--s3); padding: var(--s3); border: 1px solid var(--accent-border); border-radius: var(--r-sm); background: var(--accent-soft); }
.question-title { margin-bottom: var(--s2); font-weight: 600; }
.option { display: block; margin: 5px 0; }
.option input { margin-right: 6px; }
.question textarea { width: 100%; min-height: 52px; margin-top: 5px; padding: 6px; border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--surface); color: var(--fg); }
.skel { display: grid; gap: var(--s2); }
.skel-card { height: 45px; border: 1px solid var(--border-soft); border-radius: var(--r-md); background: var(--surface-2); }
@media (max-width: 640px) { main { padding-top: var(--s4); } .send { align-items: stretch; flex-direction: column; } .actions { margin-left: 0; width: 100%; } }
@media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; transition: none !important; } }
`;

const CLIENT_SCRIPT = String.raw`
const TOKEN = __KTEAM_TOKEN_LITERAL__;
const terminal = new Set(['completed', 'failed', 'stalled', 'stopped', 'kill_failed']);
const waiting = new Set(['waiting', 'awaiting_user', 'awaiting_question', 'interrupted', 'rate_limited']);
const app = document.getElementById('app');
const main = document.getElementById('main');
const crumb = document.getElementById('crumb');
const live = document.getElementById('live');
const esc = (value) => String(value == null ? '' : value).replace(/[&<>\"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;' }[c]));
const el = (tag, cls, html) => { const node = document.createElement(tag); if (cls) node.className = cls; if (html != null) node.innerHTML = html; return node; };
function tone(status) { const s = String(status || '').toLowerCase(); if (/(completed|success|healthy|ready|done|awaiting_user|interrupted)/.test(s)) return 'ok'; if (/(running|starting|thinking|tool|retry|rate|waiting)/.test(s)) return 'warn'; if (/(failed|stalled|stopped|kill|error)/.test(s)) return 'err'; return 'pend'; }
function statusBadge(status) { return '<span class="badge ' + tone(status) + '"><span class="pip"></span>' + esc(status) + '</span>'; }
function fmtTime(value) { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString(); }
function fmtModel(view) { return view.config.model || view.config.modelHint || 'default'; }
function api(path, init) {
  const options = init || {};
  const headers = Object.assign({ authorization: 'Bearer ' + TOKEN }, options.headers || {});
  return fetch(path, Object.assign({}, options, { headers })).then(async (response) => {
    if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error || ('HTTP ' + response.status)); }
    if (response.status === 204) return undefined;
    const type = response.headers.get('content-type') || '';
    return type.includes('application/json') ? response.json() : response.text();
  });
}
function jsonApi(path, method, body) { return api(path, { method: method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); }
function showError(error) { main.classList.remove('prose-page'); app.innerHTML = '<div class="empty"><strong>Could not load kteam</strong><br>' + esc(error && error.message ? error.message : error) + '</div>'; }
function setCrumb(parts) { crumb.innerHTML = parts.map((part, index) => (index === parts.length - 1 ? '<span class="cur">' + esc(part) + '</span>' : '<a href="/">' + esc(part) + '</a><span>/</span>')).join(''); }
function showSkeleton(count) { app.innerHTML = '<div class="skel">' + Array.from({ length: count || 3 }, () => '<div class="skel-card"></div>').join('') + '</div>'; }
function push(path) { history.pushState({}, '', path); void route(); }
function isBusy(view) { return !waiting.has(view.state.status) && !terminal.has(view.state.status) && view.state.promptReady !== true; }
function eventText(event) { const data = event && event.data; if (typeof data === 'string') return data; if (data && typeof data.text === 'string') return data.text; if (data && typeof data.message === 'string') return data.message; if (data && Array.isArray(data.questions)) return data.questions.map((q) => q.question).join(' / '); try { return JSON.stringify(data); } catch (_) { return ''; } }
function eventLine(event) { return '<div class="event"><span class="event-time">' + esc(fmtTime(event.time)) + '</span> <strong>' + esc(event.type) + '</strong> <span class="muted">' + esc(eventText(event)) + '</span></div>'; }
function openSocket(sessionId, onEvent, after) {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = new URL(protocol + '//' + location.host + '/v1/events');
  url.searchParams.set('token', TOKEN); if (sessionId) url.searchParams.set('sessionId', sessionId); if (after) url.searchParams.set('after', String(after));
  const socket = new WebSocket(url);
  socket.onopen = () => { live.classList.add('on'); };
  socket.onmessage = (message) => { try { onEvent(JSON.parse(message.data)); live.classList.add('beat'); setTimeout(() => live.classList.remove('beat'), 500); } catch (_) {} };
  socket.onclose = () => live.classList.remove('on');
  socket.onerror = () => live.classList.remove('on');
  return socket;
}
function renderList(sessions) {
  setCrumb(['Kteam']);
  app.innerHTML = '<h1>Sessions</h1><div class="muted">Live teammate sessions managed by kteamd.</div>';
  const toolbar = el('div', 'toolbar');
  const filter = el('input', 'field'); filter.type = 'search'; filter.placeholder = 'Filter by label'; filter.setAttribute('aria-label', 'Filter by label');
  const finished = el('label', 'check'); finished.innerHTML = '<input type="checkbox"> include finished';
  toolbar.append(filter, finished); app.appendChild(toolbar);
  const tableHost = el('div'); app.appendChild(tableHost);
  const draw = () => {
    const needle = filter.value.trim().toLowerCase(); const includeFinished = finished.firstElementChild.checked;
    const visible = sessions.filter((view) => (includeFinished || !terminal.has(view.state.status)) && (!needle || (view.config.label || '').toLowerCase().includes(needle)));
    if (!visible.length) { tableHost.innerHTML = '<div class="empty">No matching sessions.</div>'; return; }
    tableHost.innerHTML = '<div class="table-wrap"><table><thead><tr><th>Teammate</th><th>Model</th><th>Label</th><th>Status</th><th>Mode</th><th>Task</th></tr></thead><tbody>' + visible.map((view) => '<tr data-id="' + esc(view.config.id) + '"><td><strong>' + esc(view.config.teammate || view.config.name || view.config.id) + '</strong><div class="mono muted">' + esc(view.config.id) + '</div></td><td class="mono">' + esc(fmtModel(view)) + '</td><td>' + esc(view.config.label || '—') + '</td><td>' + statusBadge(view.state.status) + '</td><td>' + esc(view.config.mode) + '</td><td class="task" title="' + esc(view.config.name) + '">' + esc(view.config.name) + '</td></tr>').join('') + '</tbody></table></div>';
    tableHost.querySelectorAll('tr[data-id]').forEach((row) => row.addEventListener('click', () => push('/session/' + encodeURIComponent(row.dataset.id))));
  };
  filter.addEventListener('input', draw); finished.addEventListener('change', draw); draw();
}
async function loadList() {
  showSkeleton(4);
  const sessions = await api('/v1/sessions');
  renderList(sessions);
  // Every session emits frame events every few seconds — refetching the full
  // list per event hammered the API; a trailing debounce batches the storm.
  let listTimer = null;
  // after=-1: live pings only — the initial table comes from /v1/sessions, so
  // replaying the entire multi-session journal here was pure startup cost.
  const socket = openSocket('', () => {
    if (listTimer) return;
    listTimer = setTimeout(async () => { listTimer = null; try { renderList(await api('/v1/sessions')); } catch (_) {} }, 1500);
  }, -1);
  window.__kteamSocket = socket;
}
function renderVitals(view) {
  const state = view.state;
  return '<div class="vitals"><div class="vital"><div class="label">Context</div><div class="value">' + esc(state.contextPercent === undefined ? '—' : state.contextPercent + '% used') + '</div></div><div class="vital"><div class="label">Last tool start</div><div class="value">' + esc(fmtTime(state.lastToolStartedAt)) + '</div></div><div class="vital"><div class="label">Last activity</div><div class="value">' + esc(fmtTime(state.lastActivityAt)) + '</div></div><div class="vital"><div class="label">Reason</div><div class="value">' + esc(state.reason || '—') + '</div></div></div>';
}
function renderQuestion(view, host, refresh) {
  const pending = view.state.pendingQuestion;
  if (!pending) { host.innerHTML = ''; return; }
  const body = pending.questions.map((question, index) => {
    const inputType = question.multiSelect ? 'checkbox' : 'radio';
    const options = (question.options || []).map((option) => '<label class="option"><input type="' + inputType + '" name="q' + index + '" value="' + esc(option.label) + '">' + esc(option.label) + (option.description ? ' <span class="muted">— ' + esc(option.description) + '</span>' : '') + '</label>').join('');
    return '<div class="question-title">' + esc(question.header || ('Question ' + (index + 1))) + ': ' + esc(question.question) + '</div>' + options + '<textarea data-other="' + index + '" placeholder="Other response (optional)"></textarea>';
  }).join('');
  host.innerHTML = '<div class="card question"><div class="section-title">Structured question</div>' + body + '<button class="btn primary" id="answer-btn">Submit answer</button></div>';
  host.querySelector('#answer-btn').addEventListener('click', async () => {
    // Mirror the CLI contract: single question -> labels (+ other for freeform),
    // NO responses key; multiple questions -> responses only, one entry per
    // question (the picked label, or the freeform text). Sending a responses
    // array of empty strings makes the daemon reject option-based answers.
    const perQuestion = pending.questions.map(function (question, index) {
      const picked = Array.from(host.querySelectorAll('input[name="q' + index + '"]:checked')).map((input) => input.value);
      const otherInput = host.querySelector('textarea[data-other="' + index + '"]');
      return { picked: picked, freeform: otherInput ? otherInput.value.trim() : '' };
    });
    let payload;
    if (pending.questions.length === 1) {
      const first = perQuestion[0];
      if (first.picked.length === 0 && !first.freeform) { showNotice(host, 'Pick an option or write a response first', true); return; }
      payload = { labels: first.picked, other: first.freeform || undefined };
    } else {
      const responses = perQuestion.map((entry) => entry.freeform || entry.picked[0] || '');
      if (responses.some((entry) => !entry)) { showNotice(host, 'Answer every question (option or text)', true); return; }
      payload = { labels: [], responses: responses };
    }
    try { await jsonApi('/v1/sessions/' + encodeURIComponent(view.config.id) + '/answer', 'POST', payload); await refresh(); } catch (error) { showNotice(host, error, true); }
  });
}
function showNotice(host, message, error) { let node = host.querySelector('.notice'); if (!node) { node = el('div', 'notice'); host.prepend(node); } node.classList.toggle('error', Boolean(error)); node.textContent = message && message.message ? message.message : String(message); }
async function renderDetail(id) {
  setCrumb(['Kteam', id]); showSkeleton(5);
  let view = await api('/v1/sessions/' + encodeURIComponent(id));
  let snapshot = await api('/v1/sessions/' + encodeURIComponent(id) + '/snapshot').catch(() => '');
  let events = await api('/v1/sessions/' + encodeURIComponent(id) + '/events?limit=500').catch(() => []);
  let socket;
  const draw = () => {
    main.classList.remove('prose-page'); app.innerHTML = '';
    const hero = el('div', 'hero'); hero.innerHTML = '<div><h1>' + esc(view.config.teammate || view.config.name || id) + '</h1><div class="mono muted">' + esc(id) + ' · ' + esc(fmtModel(view)) + ' · ' + esc(view.config.binary) + '</div></div><div>' + statusBadge(view.state.status) + '</div>';
    const actions = el('div', 'actions');
    const action = (label, method, path, body, cls) => { const button = el('button', 'btn' + (cls ? ' ' + cls : ''), label); button.onclick = async () => { let payload = body; if (label === 'Stop') { const reason = window.prompt('Reason for stopping this session:', 'stopped from browser'); if (reason === null) return; payload = { reason: reason.trim() || 'stopped from browser' }; } button.disabled = true; try { await jsonApi(path, method, payload); await refresh(); } catch (error) { showNotice(app, error, true); } finally { button.disabled = false; } }; actions.appendChild(button); };
    if (!terminal.has(view.state.status)) action('Interrupt', 'POST', '/v1/sessions/' + encodeURIComponent(id) + '/interrupt', {});
    // kill_failed requires another Stop before resume (the daemon rejects resume outright).
    if (!terminal.has(view.state.status) || view.state.status === 'kill_failed') action('Stop', 'POST', '/v1/sessions/' + encodeURIComponent(id) + '/stop', { reason: '' }, 'danger');
    if (terminal.has(view.state.status) && view.state.status !== 'kill_failed') action('Resume', 'POST', '/v1/sessions/' + encodeURIComponent(id) + '/resume', {});
    hero.appendChild(actions); app.appendChild(hero);
    app.appendChild(el('div', 'card', renderVitals(view)));
    const questionHost = el('div'); app.appendChild(questionHost); renderQuestion(view, questionHost, refresh);
    // The daemon rejects send while a structured question is pending — the
    // question card (above) is the only interaction channel in that state.
    if (view.state.status !== 'awaiting_question') {
      const sendCard = el('div', 'card'); sendCard.innerHTML = '<div class="section-title">Send message</div>';
      const send = el('div', 'send'); const textarea = el('textarea'); textarea.placeholder = 'Send a message to this teammate…'; const button = el('button', 'btn primary', 'Send');
      send.append(textarea, button); sendCard.appendChild(send);
      const busy = isBusy(view); if (busy) { const notice = el('div', 'notice', 'Session is busy — this message will be queued for the next turn boundary.'); sendCard.appendChild(notice); }
      button.onclick = async () => { const message = textarea.value.trim(); if (!message) return; button.disabled = true; try { const next = await jsonApi('/v1/sessions/' + encodeURIComponent(id) + '/send', 'POST', { message }); if (busy || isBusy(next)) showNotice(sendCard, 'Message queued for the next turn boundary.'); textarea.value = ''; await refresh(); } catch (error) { showNotice(sendCard, error, true); } finally { button.disabled = false; } };
      app.appendChild(sendCard);
    }
    const snapshotCard = el('div', 'card'); snapshotCard.innerHTML = '<div class="section-title">Latest pane snapshot</div>'; const pre = el('pre', 'snapshot'); pre.textContent = snapshot || '(no snapshot yet)'; snapshotCard.appendChild(pre); app.appendChild(snapshotCard);
    const eventsCard = el('div', 'card'); eventsCard.innerHTML = '<div class="section-title">Live event stream</div>'; const eventHost = el('div', 'events'); eventHost.innerHTML = events.length ? events.map(eventLine).join('') : '<span class="muted">Waiting for events…</span>'; eventsCard.appendChild(eventHost); app.appendChild(eventsCard);
    // First connect asks for the last 200 events (negative after = tail) —
    // replaying a long session's full history froze the initial load.
    if (socket) socket.close(); socket = openSocket(id, (event) => { events.push(event); if (events.length > 500) events.shift(); eventHost.innerHTML = events.map(eventLine).join(''); eventHost.scrollTop = eventHost.scrollHeight; scheduleRefresh(); }, events.length ? events.at(-1).sequence : -200); window.__kteamSocket = socket;
  };
  // Single-flight + change-detection: view and snapshot fetch in PARALLEL, and
  // the DOM only redraws when the payload actually changed. Event storms funnel
  // through a trailing debounce instead of issuing one fetch pair per event.
  let refreshing = false; let lastPayload = '';
  const refresh = async (redraw) => {
    if (refreshing) return; refreshing = true;
    try {
      const [nextView, nextSnapshot] = await Promise.all([
        api('/v1/sessions/' + encodeURIComponent(id)),
        api('/v1/sessions/' + encodeURIComponent(id) + '/snapshot').catch(() => snapshot),
      ]);
      view = nextView; snapshot = nextSnapshot;
      const payload = JSON.stringify(view) + '::SNAP::' + snapshot;
      if (redraw !== false && payload !== lastPayload) { lastPayload = payload; draw(); }
    } finally { refreshing = false; }
  };
  let refreshTimer = null;
  const scheduleRefresh = () => { if (refreshTimer) return; refreshTimer = setTimeout(() => { refreshTimer = null; void refresh(); }, 1200); };
  draw();
  const poll = setInterval(() => { if (location.pathname !== '/session/' + encodeURIComponent(id)) { clearInterval(poll); socket && socket.close(); return; } void refresh(); }, 5000);
}
async function route() {
  if (window.__kteamSocket) { window.__kteamSocket.close(); window.__kteamSocket = null; }
  const parts = location.pathname.split('/').filter(Boolean);
  try { if (parts[0] === 'session' && parts[1]) return await renderDetail(decodeURIComponent(parts[1])); return await loadList(); } catch (error) { showError(error); }
}
window.addEventListener('popstate', () => void route());
const themeButton = document.getElementById('themebtn');
const dark = document.documentElement.dataset.theme === 'dark'; themeButton.textContent = dark ? '☀' : '☾'; themeButton.onclick = () => { localStorage.setItem('theme', dark ? 'light' : 'dark'); location.reload(); };
route();
`;

function tokenLiteral(token: string): string {
  return JSON.stringify(token).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

export const SHELL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<script>try{document.documentElement.dataset.theme=localStorage.getItem('theme')||(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light')}catch(e){}</script>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>kteam</title>
<style>${STYLE}</style>
</head>
<body>
<header class="bar"><div class="bar-inner"><nav class="crumb" id="crumb"><span class="cur">Kteam</span></nav><button class="themebtn" id="themebtn" type="button" aria-label="Toggle light/dark"></button><span class="live" id="live"><span class="dot"></span><span>live</span></span></div></header>
<main id="main"><div id="app"><div class="skel"><div class="skel-card"></div><div class="skel-card"></div><div class="skel-card"></div></div></div></main>
<script type="module">${CLIENT_SCRIPT}</script>
</body>
</html>`;

/** Embed the daemon token into the otherwise static shell for browser API calls. */
export function renderShell(token: string): string {
  return SHELL_HTML.replace('__KTEAM_TOKEN_LITERAL__', tokenLiteral(token));
}
