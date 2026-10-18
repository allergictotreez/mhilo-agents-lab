// The live registry (~/.claude/sessions/*.json), the heartbeat state files
// (~/.claude/state/<sessionId>), the lab configs (lab/*.json) and cwd → project matching.
// Every whole-file read is cached by (mtime, size): a tick re-reads only what changed.

import fs from 'node:fs';
import path from 'node:path';
import { readSmall, readdirOrEmpty, statOrNull } from './io.mjs';
import { WORKSHOP, MIN_AREAS, globToRegExp } from './classify.mjs';
import { toPosix, isAbsoluteAny } from './paths.mjs';

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

// process.kill(pid, 0): ESRCH → gone; EPERM → exists but not ours, which is still alive.
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// A cache of parsed small files keyed by path, invalidated by mtime + size.
class FileCache {
  constructor(home, parse) {
    this.home = home;
    this.parse = parse;
    this.map = new Map();
  }

  get(file) {
    const st = statOrNull(file);
    if (!st || !st.isFile()) {
      this.map.delete(file);
      return null;
    }
    const hit = this.map.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
    let value = null;
    try {
      value = this.parse(readSmall(this.home, file).text, st);
    } catch {
      value = null;
    }
    this.map.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
    return value;
  }

  prune(keep) {
    for (const k of this.map.keys()) if (!keep.has(k)) this.map.delete(k);
  }
}

function parseRegistry(text) {
  const r = JSON.parse(text);
  if (!r || typeof r !== 'object') return null;
  if (!Number.isInteger(r.pid) || typeof r.sessionId !== 'string' || !SESSION_ID.test(r.sessionId)) return null;
  if (typeof r.cwd !== 'string' || !isAbsoluteAny(r.cwd)) return null;
  return {
    pid: r.pid,
    sessionId: r.sessionId,
    cwd: r.cwd,
    name: typeof r.name === 'string' ? r.name : '',
    nameByUser: r.nameSource === 'user',   // the owner named it (vs 'derived')
    status: ['busy', 'idle', 'error'].includes(r.status) ? r.status : null,
    startedAt: Number.isFinite(r.startedAt) ? Math.trunc(r.startedAt) : null,
    updatedAt: Number.isFinite(r.updatedAt) ? Math.trunc(r.updatedAt) : null,
    statusUpdatedAt: Number.isFinite(r.statusUpdatedAt) ? Math.trunc(r.statusUpdatedAt) : null,
  };
}

// "<busy|idle|error> <epoch> <transcript>" — epoch in seconds (ms tolerated).
export function parseState(text) {
  const [status, epoch, ...rest] = text.trim().split(/\s+/);
  if (!['busy', 'idle', 'error'].includes(status)) return null;
  let at = Number(epoch);
  if (!Number.isFinite(at) || at <= 0) at = null;
  else if (at < 1e12) at = Math.trunc(at * 1000);
  else at = Math.trunc(at);
  return { status, at, transcript: rest.join(' ') || null };
}

export class Registry {
  constructor({ home, alive = isAlive }) {
    this.home = home;
    this.alive = alive;
    this.sessions = new FileCache(home, text => parseRegistry(text));
    this.states = new FileCache(home, text => parseState(text));
  }

  // Live sessions: registry entries whose pid is alive, one per sessionId (newest wins).
  list() {
    const dir = path.join(this.home, 'sessions');
    const files = readdirOrEmpty(dir).filter(n => n.endsWith('.json')).map(n => path.join(dir, n));
    this.sessions.prune(new Set(files));
    const bySession = new Map();
    for (const f of files) {
      const r = this.sessions.get(f);
      if (!r || !this.alive(r.pid)) continue;
      const prev = bySession.get(r.sessionId);
      if (!prev || (r.updatedAt ?? 0) > (prev.updatedAt ?? 0)) bySession.set(r.sessionId, r);
    }
    return [...bySession.values()];
  }

  state(sessionId) {
    if (!SESSION_ID.test(sessionId)) return null;
    return this.states.get(path.join(this.home, 'state', sessionId));
  }

  pruneStates(liveIds) {
    this.states.prune(new Set([...liveIds].map(id => path.join(this.home, 'state', id))));
  }
}

// ~/.claude/projects/<cwd with every non-alphanumeric → '-'>/<sessionId>.jsonl, else the
// transcript named by the state file (only if it is inside projects/ and named for this session),
// else a scan of projects/*/ for <sessionId>.jsonl.
export function transcriptPath(home, cwd, sessionId, stateTranscript = null, scanCache = new Map(), scan = true) {
  const projects = path.join(home, 'projects');
  const direct = path.join(projects, cwd.replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`);
  if (statOrNull(direct)) return direct;
  if (stateTranscript) {
    const p = path.resolve(stateTranscript);
    if (p.startsWith(projects + path.sep) && path.basename(p) === `${sessionId}.jsonl` && statOrNull(p)) return p;
  }
  const cached = scanCache.get(sessionId);
  if (cached && statOrNull(cached)) return cached;
  if (!scan) return null;
  for (const d of readdirOrEmpty(projects)) {
    const p = path.join(projects, d, `${sessionId}.jsonl`);
    if (statOrNull(p)) {
      scanCache.set(sessionId, p);
      return p;
    }
  }
  return null;
}

// lab/*.json (files starting with "_" are templates). Reloaded when a file changes.
export class LabConfigs {
  constructor(labDir, log = () => {}) {
    this.dir = labDir;
    this.log = log;
    this.cache = new Map();
    this.list = [];
  }

  load() {
    const files = readdirOrEmpty(this.dir).filter(n => n.endsWith('.json') && !n.startsWith('_')).sort();
    const out = [];
    const seen = new Set();
    for (const n of files) {
      const f = path.join(this.dir, n);
      seen.add(f);
      const st = statOrNull(f);
      if (!st) continue;
      const hit = this.cache.get(f);
      if (hit && hit.mtimeMs === st.mtimeMs) {
        if (hit.config) out.push(hit.config);
        continue;
      }
      let config = null;
      try {
        config = normaliseConfig(JSON.parse(fs.readFileSync(f, 'utf8')));
      } catch (e) {
        this.log(`lab config ${n} ignored: ${e.message}`);
      }
      this.cache.set(f, { mtimeMs: st.mtimeMs, config });
      if (config) out.push(config);
    }
    for (const k of this.cache.keys()) if (!seen.has(k)) this.cache.delete(k);
    this.list = out;
    return out;
  }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const HEX = /^#[0-9A-Fa-f]{6}$/;

export function normaliseConfig(c) {
  if (!c || typeof c.id !== 'string' || !ID.test(c.id) || c.id.length > 64) throw new Error('bad id');
  if (!Array.isArray(c.areas)) throw new Error('no areas');
  const areas = c.areas.slice(0, 12).filter(a => a && typeof a.id === 'string' && ID.test(a.id)).map(a => ({
    id: a.id.slice(0, 64),
    label: String(a.label || a.id).slice(0, 60),
    tint: HEX.test(a.tint) ? a.tint : '#8FA3BB',
    keywords: Array.isArray(a.keywords) ? a.keywords.filter(k => typeof k === 'string' && k) : [],
    paths: Array.isArray(a.paths) ? a.paths.filter(p => typeof p === 'string' && p) : [],
  }));
  // Every wing has at least three pods; a smaller config is ignored (logged) and its sessions stand in the Workshop.
  if (areas.length < MIN_AREAS) throw new Error(`${areas.length} areas: a wing needs at least ${MIN_AREAS}`);
  const globs = (c.match?.cwd || []).filter(g => typeof g === 'string').map(globToRegExp);
  return {
    id: c.id,
    label: String(c.label || c.id).slice(0, 60),
    colour: HEX.test(c.color ?? c.colour) ? c.color ?? c.colour : '#8FA3BB',   // `color` in lab files; `colour` still read
    match: { cwd: c.match?.cwd || [] },
    cwdGlobs: globs,
    ...(areas.some(a => a.id === c.fallback) ? { fallback: c.fallback } : {}),
    areas,
  };
}

// Names a checkout answers to: its own basename, plus the repository's basename when the cwd is
// a Claude Code worktree (<repo>/.claude/worktrees/<name>).
export function checkoutNames(cwd) {
  cwd = toPosix(cwd);
  const names = [path.posix.basename(cwd)];
  const i = cwd.indexOf('/.claude/worktrees/');
  if (i > 0) names.push(path.posix.basename(cwd.slice(0, i)));
  return names;
}

export function projectFor(cwd, configs) {
  const names = checkoutNames(cwd);
  for (const c of configs) {
    if (c.cwdGlobs.some(re => names.some(n => re.test(n)))) return c;
  }
  return WORKSHOP;
}
