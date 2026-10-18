// The page: the lab as a full-width banner over a page about it; a click opens it over the whole
// window (#lab), Esc or Back returns. One code path for both servers (schema/api.md): the hosted
// api.php and the collector's local emulation answer the same routes with the same shapes.
// Polls the current project every 5 s (ETag) and the index every 15 s, and stops both, and the
// render loop, while the page is hidden; the loop also rests while the banner is scrolled away.
// Every API string reaches the page as textContent.
// Signed in, the banner is the real lab. Anyone else gets the demo: the same page fed by
// lab/sim.mjs instead of api.php; on the owner's network (whoami's `home`) the banner invites a
// sign-in. ?demo=1 forces the demo, ?signin=1 opens the sign-in plate.
import { createLab } from './lab/scene.mjs';
import { createSim, demoApi } from './lab/sim.mjs';
import { STATE_WORD, agentState, countsOf, fmtCount, fmtDuration, leadState } from './lab/model.mjs';

const SNAPSHOT_MS = 5000;
const INDEX_MS = 15000;
const RETRY_MS = 5000;
const DEMO_SNAPSHOT_MS = 1500;   // the demo changes every second; poll it often enough to show that
const FEED_DOWN_MS = 180_000;   // no push for 3 min: the feed is down (schema/api.md "Freshness")
const FONTS = 'https://fonts.googleapis.com/css2?family=Barlow:wght@500;600&family=Barlow+Condensed:wght@800&display=swap';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const lab = window.lab = {
  ready: false, figures: 0, frames: 0, fps: 0, project: null, renderer: null, local: false, hiddenSessions: 0,
  select: key => openPanel(key), keys: () => scene?.keys() ?? [], states: () => scene?.states() ?? [],
  screenOf: key => scene?.screenOf(key) ?? null,
  view: name => scene?.view(name), orbit: (dx, dy) => scene?.orbit(dx, dy), gizmoBalls: () => scene?.gizmoBalls() ?? [], boards: () => scene?.boards() ?? {},
  pods: () => scene?.pods() ?? {},
  doors: () => scene?.doors() ?? [],
  focusArea: id => scene?.focusArea(id), podScreenOf: id => scene?.podScreenOf(id) ?? null, focusedArea: () => scene?.focusedArea ?? null,
  full: () => isFull(), openFull: () => openFull(), closeFull: () => closeFull(),
};

let scene = null;
let demo = null;           // set: api() answers from the simulation
let home = false;          // whoami: on the network the collector pushes from
let index = { projects: [] };
let current = null;
let snapshot = null;
const etags = new Map();
let selected = null;
let snapTimer = 0, indexTimer = 0, clockTimer = 0;
let inflight = null;
let lastFailure = false;
let ticking = [];          // panel timers: [{ el, since, until, prefix }]
let enterTimer = 0, bootTimer = 0;
let skew = 0;              // the server's clock minus this one, from the index response's Date header
let frozenAt = null;       // while the current project's feed is down: the moment of its last report
let downSet = '';          // which projects are down, to re-render the tabs only on a change
let opener = null;         // the element a card was opened from by keyboard, to return focus to
const now = () => frozenAt ?? Date.now();

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private window */ } },
};

// ── API ─────────────────────────────────────────────────────────────────────────────────────────

async function api(action, { method = 'GET', body, project, etag, signal } = {}) {
  if (demo) return demo(action, { project, etag });
  const q = new URLSearchParams({ action });
  if (project) q.set('project', project);
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (etag) headers['If-None-Match'] = etag;
  const r = await fetch(`api.php?${q}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin', cache: 'no-store', signal,
  });
  let data = null;
  if (r.status !== 304) { try { data = await r.json(); } catch { data = null; } }
  const date = Date.parse(r.headers.get('Date') || '');
  return { status: r.status, data, etag: r.headers.get('ETag'), serverDate: Number.isFinite(date) ? date : null };
}

// ── boot and login ──────────────────────────────────────────────────────────────────────────────

async function boot() {
  if (params.get('demo') === '1') { startDemo(); return; }
  let who = null;
  try { who = await api('whoami'); } catch { who = null; }
  // A 5xx, an HTML error page or no answer at all is not "signed out": say so and try again.
  if (!who || who.status !== 200 || typeof who.data?.authed !== 'boolean') {
    const b = $('boot');
    b.hidden = false;
    b.textContent = 'Can\u2019t reach the server. Retrying.';
    clearTimeout(bootTimer);
    bootTimer = setTimeout(boot, RETRY_MS);
    return;
  }
  $('boot').hidden = true;
  home = who.data.home === true;
  if (who.data.authed) enterLab(!!who.data.local);
  else if (params.has('signin')) showLogin();
  else startDemo();
}

function startDemo() {
  demo = demoApi(createSim());
  lab.demo = true;
  $('boot').hidden = true;
  enterLab(false);
}

/** Barlow from Google Fonts, added after load (no render blocking, no inline handler for the CSP). */
function loadFonts() {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = FONTS;
  document.head.append(link);
}

function showLogin(message = '') {
  stopPolling();
  clearTimeout(enterTimer);
  scene?.stop();
  lab.ready = false;
  closePanel();
  setView('banner');
  $('page').hidden = true;
  document.documentElement.classList.add('plate-up');
  $('login').hidden = false;
  say($('login-msg'), message, message ? 'bad' : '');
  $('password').focus();
}

function say(el, text, tone = '') {
  el.textContent = text;
  if (tone) el.dataset.tone = tone; else delete el.dataset.tone;
}

$('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const input = $('password'), button = $('login-button'), msg = $('login-msg');
  if (!input.value) { say(msg, 'Enter the password.', 'bad'); input.focus(); return; }
  button.disabled = true;
  button.textContent = 'Signing in';
  say(msg, '');
  let r;
  try {
    r = await api('login', { method: 'POST', body: { password: input.value } });
  } catch {
    r = { status: 0 };
  }
  button.disabled = false;
  button.textContent = 'Sign in';
  if (r.status === 200) {
    input.value = '';
    $('login').hidden = true;
    enterLab(false);
    openFull();
    return;
  }
  input.select();
  if (r.status === 401) {
    const n = r.data?.remaining ?? 0;
    say(msg, n > 0 ? `Wrong password. ${n} ${n === 1 ? 'try' : 'tries'} left.` : 'Wrong password. Sign-in is locked for 15 minutes.', 'bad');
  } else if (r.status === 429) {
    const min = Math.max(1, Math.ceil((r.data?.retryAfter ?? 900) / 60));
    say(msg, `Too many tries. Try again in ${min} min.`, 'bad');
  } else {
    say(msg, 'Could not sign in. Check the connection and try again.', 'bad');
  }
});

$('logout').addEventListener('click', async () => {
  try { await api('logout', { method: 'POST' }); } catch { /* signed out locally either way */ }
  closePanel();
  showLogin();
});

// ── the lab ─────────────────────────────────────────────────────────────────────────────────────

async function enterLab(local) {
  lab.local = local;
  $('local-badge').hidden = !local;
  $('demo-badge').hidden = !demo;
  $('logout').hidden = local || !!demo;
  $('signin').hidden = !demo;
  $('page').hidden = false;
  document.documentElement.classList.remove('plate-up');
  dressPage(local);
  if (location.hash === '#lab') openFull({ push: false });
  if (!scene) {
    try {
      scene = await createLab({
        host: $('stage'), hudHost: $('hud'), state: lab,
        uncapped: params.get('uncapped') === '1',
        onSelect: (key, keyboard) => (key ? openPanel(key, { keyboard }) : closePanel()),
      });
    } catch (err) {
      console.error(err);
      showEmpty('The lab could not be drawn here. It needs WebGL, which this browser did not provide.');
      return;
    }
  }
  scene.setBanner(!isFull());
  // Signed in again after signing out: the snapshot may answer 304, so nothing else would restart it.
  syncRender();
  const got = await loadIndex();
  if (got === 'auth') return;
  if (!got) {
    // The first index load failed: keep trying, every 5 s, with the status saying so.
    clearTimeout(enterTimer);
    enterTimer = setTimeout(() => enterLab(local), RETRY_MS);
    return;
  }
  const wanted = params.get('project') || store.get('mhilo-agents.project');
  current = index.projects.some(p => p.id === wanted) ? wanted : index.projects[0]?.id ?? null;
  renderTabs();
  if (current) await loadSnapshot();
  else showEmpty('No project has reported yet. The collector sends one when a session starts.');
  lab.ready = true;
  startClock();
  schedule();
}

/** true, false (failed: retry), or 'auth' (signed out: the login plate is showing). */
async function loadIndex() {
  let r;
  try { r = await api('state'); } catch { failed(); return false; }
  if (r.status === 401) { showLogin('Signed out. Sign in again.'); return 'auth'; }
  if (r.status !== 200 || !Array.isArray(r.data?.projects)) { failed(); return false; }
  index = r.data;
  if (r.serverDate) skew = r.serverDate - Date.now();
  ok();
  renderTabs();
  checkFeed();
  return true;
}

// ── feed freshness ──────────────────────────────────────────────────────────────────────────────

/** A project's feed is down when its last push (index `at`, server time) is over 3 min old. */
const feedAge = p => Date.now() + skew - p.at;
const isDown = p => feedAge(p) > FEED_DOWN_MS;

/** Once a second: mark down feeds on the tabs and over the floor, and freeze the floor's clock. */
function checkFeed() {
  const down = index.projects.filter(isDown).map(p => p.id).join(',');
  if (down !== downSet) { downSet = down; renderTabs(); }
  const p = index.projects.find(x => x.id === current);
  const isCurrentDown = !!p && isDown(p);
  const was = frozenAt;
  frozenAt = isCurrentDown ? p.at - skew : null;
  const feed = $('feed');
  if (isCurrentDown) {
    const min = Math.max(3, Math.floor(feedAge(p) / 60_000));
    feed.textContent = `No update from this project for ${min} min. Showing its last report, from ${clockTime(p.at - skew)}.`;
    feed.hidden = false;
  } else {
    feed.hidden = true;
  }
  if ((was === null) !== (frozenAt === null) || (was !== null && was !== frozenAt)) scene?.setClock(now);
}

async function loadSnapshot() {
  const id = current;
  if (!id) return;
  inflight?.abort();
  const ctrl = inflight = new AbortController();
  let r;
  try {
    r = await api('state', { project: id, etag: etags.get(id), signal: ctrl.signal });
  } catch (err) {
    if (err?.name !== 'AbortError') failed();
    return;
  } finally {
    if (inflight === ctrl) inflight = null;
  }
  if (id !== current) return;
  if (r.status === 401) { showLogin('Signed out. Sign in again.'); return; }
  if (r.status === 404) {
    await loadIndex();
    if (!index.projects.some(p => p.id === current)) switchProject(index.projects[0]?.id ?? null);
    return;
  }
  ok();
  if (r.status === 304) { renderStatus(); return; }
  if (r.status !== 200 || !r.data) { failed(); return; }
  if (r.etag) etags.set(id, r.etag);
  snapshot = r.data;
  lab.project = snapshot.project;
  const shown = scene.setSnapshot(snapshot);
  // The tab's counts follow the snapshot at once rather than waiting for the next index poll.
  const entry = index.projects.find(p => p.id === id);
  if (entry) { entry.counts = countsOf(snapshot); renderTabs(); }
  showEmpty(snapshot.sessions.length ? '' : 'No sessions in this project right now.');
  showNote(shown.hiddenSessions ? `${shown.hiddenSessions} more sessions are not drawn: the floor shows 40 figures at most.` : '');
  if (selected) renderPanel();
  renderStatus();
}

const snapshotMs = () => (demo ? DEMO_SNAPSHOT_MS : SNAPSHOT_MS);

function switchProject(id) {
  if (!id || id === current) return;
  current = id;
  // The floor shows another project now: ask for this one in full, not "has it changed?" (a 304
  // would leave the other project on screen).
  etags.delete(id);
  store.set('mhilo-agents.project', id);
  closePanel();
  showNote('');
  renderTabs();
  checkFeed();
  clearTimeout(snapTimer);
  loadSnapshot().then(() => { if (!document.hidden) { clearTimeout(snapTimer); snapTimer = setTimeout(pollSnapshot, snapshotMs()); } });
}

// ── polling, paused while hidden ────────────────────────────────────────────────────────────────

async function pollSnapshot() {
  await loadSnapshot();
  if (!document.hidden && lab.ready) snapTimer = setTimeout(pollSnapshot, snapshotMs());
}
async function pollIndex() {
  await loadIndex();
  // The first project to report, after a page that opened on an empty index.
  if (!current && index.projects[0]) { showEmpty(''); switchProject(index.projects[0].id); }
  if (!document.hidden && lab.ready) indexTimer = setTimeout(pollIndex, INDEX_MS);
}
function schedule() {
  stopPolling();
  if (document.hidden) return;
  snapTimer = setTimeout(pollSnapshot, snapshotMs());
  indexTimer = setTimeout(pollIndex, INDEX_MS);
}
function stopPolling() {
  clearTimeout(enterTimer);
  clearTimeout(snapTimer);
  clearTimeout(indexTimer);
  clearInterval(clockTimer);
  inflight?.abort();
}
document.addEventListener('visibilitychange', () => {
  if (!lab.ready) return;
  if (document.hidden) { stopPolling(); return; }
  // Back in view: catch up at once, then resume the cadence.
  stopPolling();
  startClock();
  pollSnapshot();
  pollIndex();
});

function ok() { lastFailure = false; renderStatus(); }
function failed() { lastFailure = true; renderStatus(); }

function renderStatus() {
  // A failed request here; a quiet collector is the feed's business (checkFeed).
  say($('status'), lastFailure ? 'Connection lost. Retrying.' : '', lastFailure ? 'bad' : '');
}

function startClock() {
  clearInterval(clockTimer);
  const tick = () => {
    const wall = new Date();
    const clock = $('clock');
    clock.textContent = wall.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    clock.dateTime = wall.toISOString();
    checkFeed();
    for (const t of ticking) t.el.textContent = t.prefix + fmtDuration((t.until ?? now()) - t.since);
  };
  tick();
  clockTimer = setInterval(tick, 1000);
}

// ── tabs and keys ───────────────────────────────────────────────────────────────────────────────

function renderTabs() {
  const tabs = $('tabs');
  const hadFocus = tabs.contains(document.activeElement);
  const buttons = index.projects.map((p, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tab';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(p.id === current));
    b.tabIndex = p.id === current ? 0 : -1;
    b.style.setProperty('--tab-colour', /^#[0-9a-f]{6}$/i.test(p.colour) ? p.colour : '');
    const label = document.createElement('span');
    label.className = 'tab-label';
    label.textContent = p.label;
    const counts = document.createElement('span');
    counts.className = 'tab-counts';
    const live = document.createElement('span');
    live.className = 'live';
    live.textContent = `${p.counts.busy} live`;
    if (isDown(p)) {
      const down = document.createElement('span');
      down.className = 'down';
      down.textContent = 'feed down';
      counts.append(down, ' · ');
      b.dataset.down = '';
    }
    counts.append(live, ` · ${p.counts.idle} idle`);
    const trouble = p.counts.stalled + p.counts.error;
    if (trouble) {
      const warn = document.createElement('span');
      warn.className = 'warn';
      warn.textContent = `${trouble} stalled`;
      counts.append(' · ', warn);
    }
    b.append(label, counts);
    if (i < 9) {
      const key = document.createElement('kbd');
      key.className = 'tab-key';
      key.textContent = String(i + 1);
      key.setAttribute('aria-hidden', 'true');
      b.append(key);
    }
    b.setAttribute('aria-label', `${p.label}: ${isDown(p) ? 'feed down, ' : ''}${p.counts.busy} live, ${p.counts.idle} idle, ${p.counts.agents} agents${trouble ? `, ${trouble} stalled` : ''}`);
    b.addEventListener('click', () => switchProject(p.id));
    return b;
  });
  tabs.replaceChildren(...buttons);
  if (hadFocus) tabs.querySelector('[aria-selected="true"]')?.focus();
}

$('tabs').addEventListener('keydown', e => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const i = index.projects.findIndex(p => p.id === current);
  const next = index.projects[(i + (e.key === 'ArrowRight' ? 1 : -1) + index.projects.length) % index.projects.length];
  if (next) { switchProject(next.id); $('tabs').querySelector('[aria-selected="true"]')?.focus(); }
});

document.addEventListener('keydown', e => {
  if (!isFull() || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target instanceof HTMLElement && e.target.matches('input, textarea')) return;
  if (e.key === 'Escape') { if (!$('panel').hidden) closePanel(); else closeFull(); return; }
  if (e.target instanceof HTMLElement && e.target.closest('#panel')) return;
  if (/^[1-9]$/.test(e.key)) {
    const p = index.projects[Number(e.key) - 1];
    if (p) switchProject(p.id);
  }
});

function showEmpty(text) {
  const el = $('empty');
  el.textContent = text;
  el.hidden = !text;
}

/** A small fact in the corner (never over the floor's middle). */
function showNote(text) {
  const el = $('note');
  el.textContent = text;
  el.hidden = !text;
}

// ── the worker card ─────────────────────────────────────────────────────────────────────────────

$('panel-close').addEventListener('click', () => closePanel());

/**
 * Open a worker's card. Opened by keyboard, focus moves into the card (its heading) and comes
 * back to where it was when the card closes. The camera glides so the figure stays in view
 * beside the card (or above the bottom sheet).
 */
function openPanel(key, { keyboard = false } = {}) {
  if (!key) return;
  const wasOpen = !$('panel').hidden && selected === key;
  if (keyboard) opener = document.activeElement instanceof window.HTMLElement && !$('panel').contains(document.activeElement) ? document.activeElement : opener;
  selected = key;
  scene?.select(key);
  renderPanel();
  $('panel').hidden = false;
  if (keyboard) $('panel-title')?.focus();
  if (!wasOpen) requestAnimationFrame(frameSelected);
}

/** The part of the stage the card leaves visible, handed to the scene to re-frame the selection. */
function frameSelected() {
  if (!selected || $('panel').hidden || !scene) return;
  const stage = $('stage').getBoundingClientRect(), p = $('panel').getBoundingClientRect();
  const sheet = p.width >= stage.width - 2;
  const rect = sheet
    ? { left: 0, top: 0, right: stage.width, bottom: p.top - stage.top }
    : { left: 0, top: 0, right: p.left - stage.left - 8, bottom: stage.height };
  scene.focusOn(selected, rect);
}

function closePanel() {
  const wasOpen = !$('panel').hidden;
  selected = null;
  ticking = [];
  scene?.select(null);
  $('panel').hidden = true;
  if (wasOpen && opener?.isConnected) opener.focus();
  opener = null;
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
}

function timer(since, until = null, prefix = '') {
  const span = el('span', 'num');
  ticking.push({ el: span, since, until, prefix });
  span.textContent = prefix + fmtDuration((until ?? now()) - since);
  return span;
}

const clockTime = ms => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const areaLabel = id => snapshot?.areas.find(a => a.id === id)?.label ?? (id === 'lobby' ? 'Lobby' : id);

function rows(pairs) {
  const dl = el('dl', 'rows');
  for (const [k, v] of pairs) {
    if (v === null || v === undefined || v === '') continue;
    dl.append(el('dt', '', k));
    const dd = el('dd');
    if (Array.isArray(v)) dd.append(...v); else dd.append(v instanceof window.Node ? v : String(v));
    dl.append(dd);
  }
  return dl;
}

function pill(state) {
  const p = el('span', 'pill', STATE_WORD[state] ?? state);
  p.dataset.state = { work: 'busy', wait: 'idle' }[state] ?? state;
  return p;
}

function toolLine(tool) {
  if (!tool) return null;
  const parts = [el('span', '', tool.name)];
  if (tool.hint) parts.push(el('span', 'quiet', ` ${tool.hint}`));
  return parts;
}

function renderPanel() {
  const body = $('panel-body');
  ticking = [];
  const [kind, rest] = [selected?.[0], selected?.slice(2)];
  const sessionId = rest?.split('/')[0];
  const s = snapshot?.sessions.find(x => x.id === sessionId);
  if (!s) {
    body.replaceChildren(el('p', 'eyebrow', 'Gone'), el('h2', '', 'This worker has left the lab.'));
    body.firstChild.nextSibling.id = 'panel-title';
    body.firstChild.nextSibling.tabIndex = -1;
    return;
  }
  const at = Math.max(now(), snapshot.at);
  const parts = [];
  if (kind === 's') {
    const state = leadState(s);
    parts.push(el('p', 'eyebrow', 'Session lead'), el('h2', '', s.title || s.name));
    parts.push(el('p', 'sub', [s.name, s.cwd, s.branch].filter(Boolean).join(' · ')));
    parts.push(pill(state));
    parts.push(rows([
      [state === 'work' ? 'Busy for' : 'Quiet for', state === 'work' ? timer(s.busySince || s.startedAt) : timer(s.lastActivity)],
      ['Started', [el('span', '', `${clockTime(s.startedAt)} · `), timer(s.startedAt, null, '')]],
      ['Model', s.model],
      ['Effort', s.effort],
      // null = the collector could not see the whole story: "—", never a partial sum (schema/api.md).
      ['Cost', s.costUSD === null ? '—' : `$${s.costUSD.toFixed(2)}`],
      ['Tokens', s.tokens ? `${fmtCount(s.tokens.in)} in · ${fmtCount(s.tokens.out)} out · ${fmtCount(s.tokens.cacheRead)} cache` : '—'],
      ['Tool', toolLine(s.tool)],
      ['Area', [el('span', '', areaLabel(s.area)), ...(s.areaWhy ? [el('span', 'quiet', ` · ${s.areaWhy}`)] : [])]],
    ]));
    const agents = [...s.agents].sort((a, b) => (a.finishedAt === null ? 0 : 1) - (b.finishedAt === null ? 0 : 1) || b.startedAt - a.startedAt);
    if (agents.length) {
      parts.push(el('h3', '', `Agents · ${agents.filter(a => a.finishedAt === null).length} running`));
      const list = el('ul', 'list');
      for (const a of agents) {
        const key = `a:${s.id}/${a.id}`;
        const onFloor = lab.keys().includes(key);
        const item = el(onFloor ? 'button' : 'div', 'item');
        if (onFloor) { item.type = 'button'; item.addEventListener('click', e => openPanel(key, { keyboard: e.detail === 0 })); }
        if (a.finishedAt !== null) item.dataset.finished = '';
        item.append(el('span', 'item-title', a.description || a.type));
        const meta = el('span', 'item-meta', `${a.type} · ${a.model || 'model unknown'} · `);
        meta.append(a.finishedAt !== null ? el('span', '', `finished after ${fmtDuration(a.finishedAt - a.startedAt)}`) : timer(a.startedAt));
        item.append(meta);
        const li = el('li');
        li.append(item);
        list.append(li);
      }
      parts.push(list);
    }
    if (s.workflows.length) {
      parts.push(el('h3', '', 'Workflows'));
      const list = el('ul', 'list');
      for (const w of s.workflows) {
        const item = el('div', 'item');
        item.append(el('span', 'item-title', w.name));
        const meta = el('span', 'item-meta', `${w.status} · ${w.agents} agents · `);
        meta.append(timer(w.startedAt));
        item.append(meta);
        const li = el('li');
        li.append(item);
        list.append(li);
      }
      parts.push(list);
    }
  } else if (kind === 'a') {
    const a = s.agents.find(x => x.id === rest.split('/')[1]);
    if (!a) { selected = null; closePanel(); return; }
    const state = agentState(a, s, at);
    const wf = a.workflow ? s.workflows.find(w => w.id === a.workflow) : null;
    parts.push(el('p', 'eyebrow', `Agent · ${a.type}`), el('h2', '', a.description || a.type));
    parts.push(pill(state));
    const back = el('button', 'item');
    back.type = 'button';
    back.append(el('span', 'item-title', s.title || s.name), el('span', 'item-meta', 'Open the session lead'));
    back.addEventListener('click', e => openPanel(`s:${s.id}`, { keyboard: e.detail === 0 }));
    parts.push(rows([
      [a.finishedAt !== null ? 'Ran for' : 'Running for', timer(a.startedAt, a.finishedAt)],
      ['Started', clockTime(a.startedAt)],
      ['Last activity', a.finishedAt !== null ? null : timer(a.lastActivity, null, '')],
      ['Model', a.model],
      ['Tool', toolLine(a.tool)],
      ['Area', areaLabel(a.area)],
      ['Workflow', wf ? `${wf.name} · ${wf.status}` : a.workflow],
    ]));
    parts.push(el('h3', '', 'Session'), back);
  } else {
    const crew = s.agents.filter(a => a.finishedAt === null);
    parts.push(el('p', 'eyebrow', 'Agents'), el('h2', '', `${crew.length} agents of ${s.title || s.name}`));
    parts.push(el('p', 'sub', 'Shown as one figure so the floor stays under 40 figures.'));
    const list = el('ul', 'list');
    for (const a of crew) {
      const item = el('div', 'item');
      item.append(el('span', 'item-title', a.description || a.type));
      const meta = el('span', 'item-meta', `${a.type} · ${areaLabel(a.area)} · `);
      meta.append(timer(a.startedAt));
      item.append(meta);
      const li = el('li');
      li.append(item);
      list.append(li);
    }
    parts.push(list);
  }
  body.replaceChildren(...parts);
  const h2 = body.querySelector('h2');
  h2.id = 'panel-title';
  h2.tabIndex = -1;
}

// ── the banner and the full view ────────────────────────────────────────────────────────────────

const labEl = $('lab');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';   // --ease-out
let inView = true;         // some of the banner is on screen

function isFull() { return labEl.dataset.view === 'full'; }

function setView(view) {
  labEl.dataset.view = view;
  scene?.setBanner(view !== 'full');
  document.documentElement.classList.toggle('lab-full', view === 'full');
}

/** Render while the lab can be seen: full, or the banner on screen. */
function syncRender() {
  if (!scene || $('page').hidden) return;
  if (isFull() || inView) scene.start(); else scene.stop();
}

const onScreen = r => r.bottom > 0 && r.top < innerHeight && r.width > 0;
const clipTo = r => `inset(${Math.max(0, r.top)}px ${Math.max(0, innerWidth - r.right)}px ${Math.max(0, innerHeight - r.bottom)}px ${Math.max(0, r.left)}px)`;

/** Open the lab over the window. It grows out of the banner, or out of the button pressed. */
function openFull({ push = true, from = null } = {}) {
  if (isFull() || $('page').hidden) return;
  const banner = $('masthead').getBoundingClientRect();
  const r = onScreen(banner) ? banner : from?.getBoundingClientRect();
  setView('full');
  if (push && location.hash !== '#lab') window.history.pushState({ lab: true }, '', '#lab');
  syncRender();
  if (!reduced.matches && r && onScreen(r)) labEl.animate([{ clipPath: clipTo(r) }, { clipPath: 'inset(0px 0px 0px 0px)' }], { duration: 420, easing: EASE });
  $('close-lab').focus({ preventScroll: true });
}

/** Back to the page: the lab shrinks into the banner (or fades, if the banner is off screen). */
function closeFull({ popped = false } = {}) {
  if (!isFull()) return;
  // Opened from this page: step back through history, and popstate closes it.
  if (!popped && window.history.state?.lab) { window.history.back(); return; }
  if (!popped && location.hash === '#lab') window.history.replaceState(null, '', location.pathname + location.search);
  closePanel();
  const done = () => { setView('banner'); syncRender(); $('open-lab').focus({ preventScroll: true }); };
  const banner = $('masthead').getBoundingClientRect();
  if (reduced.matches) { done(); return; }
  const frames = onScreen(banner) ? [{ clipPath: 'inset(0px 0px 0px 0px)' }, { clipPath: clipTo(banner) }] : [{ opacity: 1 }, { opacity: 0 }];
  labEl.animate(frames, { duration: 320, easing: EASE }).finished.then(done, done);
}

window.addEventListener('popstate', () => { if (location.hash === '#lab') openFull({ push: false }); else closeFull({ popped: true }); });
$('open-lab').addEventListener('click', () => openFull());
$('close-lab').addEventListener('click', () => closeFull());
for (const b of document.querySelectorAll('[data-open-lab]')) b.addEventListener('click', e => openFull({ from: e.currentTarget }));
$('nav-action').addEventListener('click', e => { if (!demo) { e.preventDefault(); openFull({ from: e.currentTarget }); } });

new window.IntersectionObserver(([e]) => { inView = e.isIntersecting; syncRender(); }).observe($('masthead'));

/** What the banner says it is, and what the nav offers: the demo invites a sign-in, the real lab opens. */
function dressPage(local) {
  const label = demo
    ? (home ? 'Demo: simulated sessions. Sign in to see your own.' : 'Demo: made-up projects, simulated sessions')
    : (local ? 'Live: the sessions on this Mac' : 'Live: your sessions');
  $('masthead-label').textContent = label;
  const action = $('nav-action');
  action.textContent = demo ? 'Sign in' : 'Open the lab';
  action.href = demo ? './?signin=1' : '#lab';
}

// The page's words arrive as they scroll in, once.
const reveal = new window.IntersectionObserver(entries => {
  for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); reveal.unobserve(e.target); }
}, { rootMargin: '0px 0px -8% 0px' });
for (const el of document.querySelectorAll('#page .headline, #page .body, #page .feature, #page .step, #page .lists, #page .big-link')) {
  el.classList.add('reveal');
  reveal.observe(el);
}

loadFonts();
boot();
