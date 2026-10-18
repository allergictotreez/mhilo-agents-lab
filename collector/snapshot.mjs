// Builds one project's snapshot (schema/snapshot.schema.json) and the index
// (schema/index.schema.json) from raw session records. Every string goes through clean(), which
// is closed under the redaction rules (schema/redaction.mjs): whatever it returns passes them.
// A session that still fails the schema has its offending fields blanked, and is dropped only
// if that does not fix it — one bad string never freezes or drops a whole wing.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { validate } from '../schema/validate.mjs';
import { redactionProblems, KEY_MATERIAL } from '../schema/redaction.mjs';
import { toPosix } from './paths.mjs';

const readJson = rel => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
export const snapshotSchema = readJson('../schema/snapshot.schema.json');
export const indexSchema = readJson('../schema/index.schema.json');

export const LINGER_MS = 60_000; // DECISIONS.md: finished agents linger 60 s
export const MAX_BYTES = 400 * 1024 - 1024; // schema: under 400 KB, with a little headroom
const MAX_INPUT = 4096; // any string is cut to this before a regex runs over it
const STATUS = ['busy', 'idle', 'error', 'stalled'];
const MASKS = KEY_MATERIAL.map(re => new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`));
const baseOf = p => path.posix.basename(toPosix(p).replace(/\/+$/, ''));

function sanitiseOnce(t) {
  // Windows paths (C:\x\y, \\server\share) first, to their basename like any other absolute path.
  t = t.replace(/(^|[\s('"`=,[])((?:[A-Za-z]:[\\/]|\\\\)[^\s'"`),\]]*)/g, (_, pre, p) => pre + baseOf(p));
  t = t.replace(/\.\.\\/g, '');
  t = t.replace(/(^|[\s('"`=,[])(~*\/[^\s'"`),\]]*)/g, (_, pre, p) => pre + baseOf(p));
  t = t.replace(/\S*\/(?:Users|home)\/\S*/g, baseOf);
  t = t.replace(/\.\.\//g, '');
  for (const re of MASKS) t = t.replace(re, '[key]');
  t = t.replace(/^[~/\s]+/, '');
  return t;
}

// Free text → safe text: no control characters (bidi overrides included), no absolute or climbing paths (reduced to their
// basename), no key-shaped strings, at most `max` characters (an ellipsis marks a cut). Runs to
// a fixpoint; if the result would still trip a redaction rule it is blanked rather than kept.
export function clean(value, max = 120) {
  if (value === null || value === undefined) return '';
  let t = String(value).slice(0, MAX_INPUT).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g, '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 16; i++) {
    const next = sanitiseOnce(t).trim();
    if (next === t) break;
    t = next;
  }
  if (t.length > max) t = `${t.slice(0, max - 1).trimEnd()}…`;
  return redactionProblems(t).length ? '' : t;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const safeId = (v, fallback) => {
  const s = String(v ?? '').slice(0, 64);
  return ID.test(s) ? s : fallback;
};
const ms = v => (Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0);
const msOrNull = v => (Number.isFinite(v) && v >= 0 ? Math.trunc(v) : null);

function tool(t) {
  if (!t || typeof t.name !== 'string' || !t.name) return null;
  return { name: clean(t.name, 64) || 'tool', hint: clean(t.hint, 60), since: ms(t.since) };
}

function agent(a) {
  return {
    id: safeId(a.id, 'agent'),
    type: clean(a.type, 64) || 'agent',
    description: clean(a.description, 120),
    model: clean(a.model, 64),
    startedAt: ms(a.startedAt),
    finishedAt: msOrNull(a.finishedAt),
    lastActivity: ms(a.lastActivity),
    tool: a.finishedAt == null ? tool(a.tool) : null,
    area: safeId(a.area, 'lobby'),
    depth: Number.isInteger(a.depth) && a.depth >= 1 ? a.depth : 1,
    workflow: a.workflow ? clean(a.workflow, 64) || null : null,
  };
}

function workflow(w) {
  const id = safeId(w.id, null);
  if (!id) return null;
  return {
    id,
    name: clean(w.name, 60) || id.slice(0, 60),
    status: clean(w.status, 32) || 'unknown',
    agents: Number.isInteger(w.agents) && w.agents >= 0 ? w.agents : 0,
    startedAt: ms(w.startedAt),
  };
}

function tokens(t) {
  if (!t) return null;
  return { in: ms(t.in), out: ms(t.out), cacheRead: ms(t.cacheRead) };
}

function session(s) {
  const agents = (s.agents || [])
    .slice()
    .sort((x, y) => (x.finishedAt != null) - (y.finishedAt != null) || ms(x.startedAt) - ms(y.startedAt) || String(x.id).localeCompare(String(y.id)))
    .slice(0, 200)
    .map(agent);
  return {
    id: safeId(s.id, 'session'),
    name: clean(s.name, 120),
    title: clean(s.title, 120),
    cwd: clean(path.posix.basename(toPosix(String(s.cwd || ''))), 120).replace(/[/~\\:]/g, ''),
    branch: s.branch ? clean(s.branch, 120) : null,
    status: STATUS.includes(s.status) ? s.status : 'idle',
    startedAt: ms(s.startedAt),
    busySince: msOrNull(s.busySince),
    lastActivity: ms(s.lastActivity),
    model: s.model ? clean(s.model, 64) || null : null,
    effort: s.effort ? clean(s.effort, 16) || null : null,
    costUSD: Number.isFinite(s.costUSD) && s.costUSD >= 0 ? s.costUSD : null,
    tokens: tokens(s.tokens),
    tool: tool(s.tool),
    area: safeId(s.area, 'lobby'),
    areaWhy: clean(s.areaWhy, 120),
    agents,
    workflows: (s.workflows || []).map(workflow).filter(Boolean).slice(0, 20),
  };
}

export function problemsOf(snap, schema = snapshotSchema) {
  return [...validate(schema, snap), ...redactionProblems(snap)];
}

const SESSION_REF = { $ref: '#/$defs/session' };
const sessionProblems = s => [...validate(SESSION_REF, s, snapshotSchema), ...redactionProblems(s)];

// "$.agents[2].description: …" → set that string to `value`. False when the path is not a string.
function blankAt(obj, problem) {
  const where = problem.slice(0, problem.indexOf(': '));
  const keys = [...where.matchAll(/\.([A-Za-z0-9_]+)|\[(\d+)\]/g)].map(m => m[1] ?? Number(m[2]));
  if (!keys.length) return false;
  let o = obj;
  for (const k of keys.slice(0, -1)) {
    o = o?.[k];
    if (o === null || typeof o !== 'object') return false;
  }
  const last = keys.at(-1);
  if (typeof o[last] !== 'string') return false;
  o[last] = '';
  return true;
}

// A session that fails: blank the offending strings; if it still fails, it is dropped.
function repair(s, problems) {
  for (const p of problems) blankAt(s, p);
  if (s.type === '') s.type = 'agent';
  for (const a of s.agents || []) if (a.type === '') a.type = 'agent';
  for (const w of s.workflows || []) if (w.name === '') w.name = w.id;
  return sessionProblems(s).length ? null : s;
}

// Keep the serialised snapshot under MAX_BYTES: finished agents go first, then the
// oldest-active agents of the largest crews, then (only if nothing else is left) sessions.
export function fitSize(snap, max = MAX_BYTES) {
  let size = Buffer.byteLength(JSON.stringify(snap));
  if (size < max) return 0;
  let dropped = 0;
  const cost = a => Buffer.byteLength(JSON.stringify(a)) + 1;
  for (const s of snap.sessions) {
    const keep = s.agents.filter(a => a.finishedAt === null);
    for (const a of s.agents) if (a.finishedAt !== null) { size -= cost(a); dropped++; }
    s.agents = keep;
  }
  while (size >= max) {
    const crew = snap.sessions.reduce((big, s) => (s.agents.length > (big?.agents.length ?? 0) ? s : big), null);
    if (!crew) break;
    let oldest = 0;
    crew.agents.forEach((a, i) => { if (a.startedAt < crew.agents[oldest].startedAt) oldest = i; });
    size -= cost(crew.agents[oldest]);
    crew.agents.splice(oldest, 1);
    dropped++;
  }
  while (Buffer.byteLength(JSON.stringify(snap)) >= max && snap.sessions.length) {
    snap.sessions.shift();
    dropped++;
  }
  return dropped;
}

// config: a normalised lab config (or WORKSHOP); sessions: raw records.
// Returns { snapshot, problems } — problems lists what was repaired or dropped (for one log
// line); snapshot is null only if the wing-level fields themselves are invalid.
export function buildSnapshot(config, sessions, at) {
  const problems = [];
  const built = [];
  for (const raw of sessions.slice().sort((a, b) => ms(a.startedAt) - ms(b.startedAt) || String(a.id).localeCompare(String(b.id)))) {
    const s = session(raw);
    const p = sessionProblems(s);
    if (!p.length) { built.push(s); continue; }
    problems.push(...p.map(x => `session ${s.id} ${x}`));
    const fixed = repair(s, p);
    if (fixed) built.push(fixed);
    else problems.push(`session ${s.id} dropped`);
  }
  const snap = {
    v: 1,
    project: config.id,
    label: clean(config.label, 60) || config.id,
    colour: config.colour,
    at: ms(at),
    areas: config.areas.slice(0, 12).map(a => ({ id: a.id, label: clean(a.label, 60) || a.id, tint: a.tint })),
    sessions: built.slice(0, 60),
  };
  const dropped = fitSize(snap);
  if (dropped) problems.push(`size: dropped ${dropped} agents/sessions to stay under ${MAX_BYTES} bytes`);
  const final = problemsOf(snap);
  if (final.length) return { snapshot: null, problems: [...problems, ...final] };
  return { snapshot: snap, problems };
}

export function countsOf(snap) {
  const c = { busy: 0, idle: 0, stalled: 0, error: 0, agents: 0 };
  for (const s of snap.sessions) {
    c[s.status]++;
    c.agents += s.agents.filter(a => a.finishedAt === null).length;
  }
  return c;
}

// projectAt(snapshot) is the feed's freshness for that project (index.schema.json $comment):
// locally the collector's last successful tick.
export function buildIndex(snapshots, at, projectAt = s => s.at) {
  return {
    v: 1,
    at: ms(at),
    projects: snapshots.slice(0, 30).map(s => ({ id: s.project, label: s.label, colour: s.colour, at: ms(projectAt(s)), counts: countsOf(s) })),
  };
}

// Equal ignoring `at` — the pusher and the store only care when the content moved.
export function sameContent(a, b) {
  if (!a || !b) return a === b;
  return JSON.stringify({ ...a, at: 0 }) === JSON.stringify({ ...b, at: 0 });
}
