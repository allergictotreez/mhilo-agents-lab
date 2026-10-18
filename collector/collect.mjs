// One tick: registry → per live session, tail its transcript and its subagents' transcripts,
// read workflow run state → classify → one snapshot per project. Keeps the latest snapshot per
// project with live sessions, reports which ones changed (ignoring `at`), and hands back one
// empty snapshot (`sessions: []`) for each project whose last session ended — and, on the first
// tick, for each configured project with no sessions — so a hosted page never keeps ghosts.
//
// Cost per tick when nothing moved: a readdir of sessions/, one stat per registry file, state
// file, transcript, subagents dir (and its workflow dirs) and running agent. Finished agents are
// "retired" once their linger is over and only re-stat'ed every RECHECK_TICKS ticks.

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { counters, readSmall, readdirOrEmpty, statOrNull } from './io.mjs';
import { Tailer } from './tail.mjs';
import { classify, WORKSHOP } from './classify.mjs';
import { Registry, LabConfigs, isAlive, projectFor, transcriptPath } from './watch.mjs';
import { newModel, applyLines, tokensOf, resetUsage } from './transcript.mjs';
import { buildSnapshot, buildIndex, sameContent, LINGER_MS } from './snapshot.mjs';

export const STALLED_MS = 15 * 60_000; // busy and no write for 15 min (the watchdog's rule)
export const STALE_AGENT_MS = 30 * 60_000; // an agent silent this long, never handed back, is over
const RECHECK_TICKS = 15;
const AGENT_FILE = /^agent-([A-Za-z0-9][A-Za-z0-9._-]{0,63})\.jsonl$/;
const WF_DIR = /^wf_[A-Za-z0-9._-]{1,61}$/;

export function defaultHome() {
  return process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude');
}
export function defaultLabDir() {
  return process.env.AGENTS_LAB_DIR || fileURLToPath(new URL('../lab/', import.meta.url));
}

class DirCache {
  constructor() { this.map = new Map(); }
  list(dir) {
    const st = statOrNull(dir);
    if (!st || !st.isDirectory()) { this.map.delete(dir); return []; }
    const hit = this.map.get(dir);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.names;
    const names = readdirOrEmpty(dir);
    this.map.set(dir, { mtimeMs: st.mtimeMs, names });
    return names;
  }
}

export class Collector {
  constructor({ home = defaultHome(), labDir = defaultLabDir(), now = Date.now, alive = isAlive, log = () => {}, maxInitial } = {}) {
    this.home = home;
    this.now = now;
    this.log = log;
    this.registry = new Registry({ home, alive });
    this.labs = new LabConfigs(labDir, log);
    this.tailer = new Tailer({ home, ...(maxInitial ? { maxInitial } : {}) });
    this.dirs = new DirCache();
    this.small = new Map(); // meta/workflow json cache: file → { mtimeMs, size, value }
    this.sessions = new Map(); // sessionId → per-session state
    this.scanCache = new Map();
    this.current = new Map(); // projectId → snapshot (projects with live sessions)
    this.configOf = new Map(); // projectId → config, kept to build a retiring snapshot
    this.ticks = 0;
    this.lastTickAt = 0;
    this.logged = new Set();
  }

  // One log line per distinct problem, ever (bounded).
  logOnce(msg) {
    if (this.logged.has(msg)) return;
    if (this.logged.size > 2000) this.logged.clear();
    this.logged.add(msg);
    this.log(msg);
  }

  readJson(file, cap) {
    const st = statOrNull(file);
    if (!st) { this.small.delete(file); return null; }
    const hit = this.small.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
    let value = null;
    try {
      const { text, truncated } = readSmall(this.home, file, cap);
      if (!truncated) value = JSON.parse(text);
    } catch {
      value = null;
    }
    this.small.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
    return value;
  }

  // Tailer read that never throws (a refused or vanished file yields nothing).
  #tail(file, st) {
    try {
      return this.tailer.read(file, st);
    } catch (e) {
      this.logOnce(`skipped a transcript: ${e.message}`);
      return null;
    }
  }

  // Read new lines for a session/agent record `r`; if the tailer started the file afresh, what
  // was summed from earlier reads is stale. r.wholeFile: the file has been read from byte 0.
  #fold(r, file, st) {
    const lines = this.#tail(file, st);
    const info = this.tailer.info(file);
    if (info) {
      if (info.gen !== r.gen) {
        if (r.gen !== undefined) resetUsage(r.model);
        r.gen = info.gen;
      }
      r.wholeFile = info.fromStart;
    }
    return lines;
  }

  tick() {
    const now = this.now();
    this.ticks++;
    const configs = this.labs.load();
    const live = this.registry.list();
    const liveIds = new Set(live.map(r => r.sessionId));

    for (const [id, s] of this.sessions) {
      if (liveIds.has(id)) continue;
      if (s.transcript) this.tailer.forget(s.transcript);
      for (const a of s.agents.values()) this.tailer.forget(a.jsonl);
      if (s.base) {
        for (const k of this.dirs.map.keys()) if (k.startsWith(s.base)) this.dirs.map.delete(k);
        for (const k of this.small.keys()) if (k.startsWith(s.base)) this.small.delete(k);
      }
      this.sessions.delete(id);
    }
    this.registry.pruneStates(liveIds);

    const byProject = new Map();
    for (const reg of live) {
      const config = projectFor(reg.cwd, configs);
      if (!byProject.has(config.id)) byProject.set(config.id, { config, sessions: [] });
      byProject.get(config.id).sessions.push(this.#session(reg, config, now));
    }

    const changed = [];
    for (const { config, sessions } of byProject.values()) {
      this.configOf.set(config.id, config);
      const { snapshot, problems } = buildSnapshot(config, sessions, now);
      for (const p of problems) this.logOnce(`snapshot ${config.id}: ${p.replace(/\[\d+\]/g, '[]')}`);
      if (!snapshot) continue; // only if the wing's own fields are invalid; keep the last good one
      if (!sameContent(this.current.get(config.id), snapshot)) {
        this.current.set(config.id, snapshot);
        changed.push(config.id);
      }
    }

    // Retire: a project whose last session ended (and, on the first tick, every configured
    // project with no sessions, in case the hosted copy still shows ghosts from before a restart).
    const retired = [];
    const retire = config => {
      const { snapshot } = buildSnapshot(config, [], now);
      if (snapshot) retired.push(snapshot);
    };
    for (const id of [...this.current.keys()]) {
      if (byProject.has(id)) continue;
      retire(this.configOf.get(id) ?? { ...WORKSHOP, id });
      this.current.delete(id);
    }
    if (this.ticks === 1) for (const c of configs) if (!byProject.has(c.id)) retire(c);

    this.lastTickAt = now;
    return { changed, retired, at: now };
  }

  snapshot(id) {
    return this.current.get(id) ?? null;
  }

  snapshots() {
    return [...this.current.values()];
  }

  // projects[].at = the collector's last successful tick (the feed's freshness), not the content's.
  index(at = this.now()) {
    return buildIndex(this.snapshots(), at, () => this.lastTickAt);
  }

  stats() {
    return { bytes: counters.bytes, opens: counters.opens, tail: { ...this.tailer.stats }, sessions: this.sessions.size };
  }

  #session(reg, config, now) {
    let s = this.sessions.get(reg.sessionId);
    if (!s) {
      s = { model: newModel(), transcript: null, agents: new Map(), mtime: null, wholeFile: false };
      this.sessions.set(reg.sessionId, s);
    }
    const state = this.registry.state(reg.sessionId);
    if (!s.transcript || !statOrNull(s.transcript)) {
      // A brand-new session may have no transcript yet: scan projects/ for it every 5th tick only.
      const scan = this.ticks - (s.scannedAt ?? -Infinity) >= 5;
      if (scan) s.scannedAt = this.ticks;
      s.transcript = transcriptPath(this.home, reg.cwd, reg.sessionId, state?.transcript, this.scanCache, scan);
    }
    if (s.transcript) {
      const st = statOrNull(s.transcript);
      if (st) {
        const lines = this.#fold(s, s.transcript, st);
        if (lines?.length) applyLines(s.model, lines, { sidechain: false });
        s.mtime = st.mtimeMs;
      }
    }

    const base = s.transcript ? path.join(path.dirname(s.transcript), reg.sessionId) : null;
    s.base = base;
    const agents = base ? this.#agents(s, path.join(base, 'subagents'), config, reg.cwd, now) : [];
    const workflows = base ? this.#workflows(path.join(base, 'workflows'), now) : [];

    const running = agents.filter(a => a.finishedAt === null);
    const lastActivity = Math.max(s.mtime ?? 0, ...running.map(a => a.lastActivity), 0) || reg.updatedAt || reg.startedAt || now;
    let status = state?.status ?? reg.status ?? (s.mtime && now - s.mtime < 120_000 ? 'busy' : 'idle');
    let busySince = null;
    if (status === 'busy') {
      busySince = state?.status === 'busy' ? state.at : reg.status === 'busy' ? reg.statusUpdatedAt : null;
      if (now - lastActivity > STALLED_MS) status = 'stalled';
    }

    // The owner's name for a session wins: a rename in the transcript, then a registry name they
    // set; then the AI title; then the registry's derived name.
    const title = s.model.customTitle || (reg.nameByUser && reg.name) || s.model.title || reg.name || '';
    const { area, why } = classify(config, { text: title, paths: s.model.paths, cwd: reg.cwd });
    return {
      id: reg.sessionId,
      name: reg.name,
      title,
      cwd: reg.cwd,
      branch: s.model.branch,
      status,
      startedAt: reg.startedAt ?? s.model.firstAt ?? now,
      busySince,
      lastActivity,
      model: s.model.model,
      effort: s.model.effort,
      costUSD: s.model.costUSD, // only ever from a cost-state line
      tokens: tokensOf(s.model, s.wholeFile),
      tool: status === 'busy' || status === 'stalled' ? s.model.tool : null,
      area,
      areaWhy: why,
      agents,
      workflows,
    };
  }

  // Agent files: subagents/agent-<id>.jsonl and subagents/workflows/wf_*/agent-<id>.jsonl.
  #agentFiles(dir) {
    const out = [];
    const add = (d, workflow) => {
      for (const n of this.dirs.list(d)) {
        const m = AGENT_FILE.exec(n);
        if (m) out.push({ id: m[1], jsonl: path.join(d, n), meta: path.join(d, `agent-${m[1]}.meta.json`), workflow });
      }
    };
    add(dir, null);
    const wfRoot = path.join(dir, 'workflows');
    for (const wf of this.dirs.list(wfRoot)) if (WF_DIR.test(wf)) add(path.join(wfRoot, wf), wf);
    return out;
  }

  #agents(s, dir, config, cwd, now) {
    const files = this.#agentFiles(dir);
    const out = [];
    const keep = new Set();
    for (const f of files) {
      keep.add(f.id);
      let a = s.agents.get(f.id);
      if (!a) {
        a = { ...f, model: newModel(), seen: false, retired: false, retiredMtime: null, shownRunning: false, stamp: null, wholeFile: false, phase: s.agents.size % RECHECK_TICKS };
        s.agents.set(f.id, a);
      }
      if (a.retired && this.ticks % RECHECK_TICKS !== a.phase) continue;
      const st = statOrNull(f.jsonl);
      if (!st) continue;
      if (a.retired && st.mtimeMs === a.retiredMtime) continue;
      const meta = this.readJson(f.meta, 64 * 1024) || {};
      const metaDone = meta.finished === true || meta.stoppedByUser === true;
      const stale = now - st.mtimeMs > STALE_AGENT_MS;
      if (!a.seen && (stale || (metaDone && now - st.mtimeMs > LINGER_MS))) {
        // Long over before we first looked: never read it.
        a.retired = true;
        a.retiredMtime = st.mtimeMs;
        continue;
      }
      a.seen = true;
      a.retired = false;
      const lines = this.#fold(a, f.jsonl, st);
      if (lines?.length) applyLines(a.model, lines);

      // When did it finish? A handback carries its own time. A meta flag (finished or
      // stoppedByUser) or the silence heuristic does not: an agent that was on screen as running
      // is stamped with the time we noticed, so it lingers 60 s and leaves visibly.
      let finishedAt = a.model.handbackAt ?? (metaDone || stale ? Math.trunc(st.mtimeMs) : null);
      if (finishedAt === null) a.stamp = null; // running (again)
      else if (a.shownRunning && now - finishedAt > LINGER_MS) a.stamp ??= now;
      if (finishedAt !== null && a.stamp !== null) finishedAt = a.stamp;
      if (finishedAt !== null && now - finishedAt > LINGER_MS) {
        a.retired = true;
        a.retiredMtime = st.mtimeMs;
        a.shownRunning = false;
        a.stamp = null;
        continue;
      }
      a.shownRunning = finishedAt === null;

      const type = typeof meta.agentType === 'string' ? meta.agentType : 'agent';
      const description = typeof meta.description === 'string' ? meta.description : '';
      const { area } = classify(config, { text: `${description} ${type}`, paths: a.model.paths, cwd });
      const born = Math.trunc(st.birthtimeMs || st.ctimeMs || st.mtimeMs);
      out.push({
        id: f.id,
        type,
        description,
        model: typeof meta.model === 'string' ? meta.model : a.model.model ?? '',
        // The current run: a resumed agent's clock restarts at the resume, not at the file's birth.
        startedAt: a.model.resumedAt ?? (a.wholeFile ? a.model.firstAt : null) ?? born,
        finishedAt,
        lastActivity: Math.trunc(st.mtimeMs),
        tool: a.model.tool,
        area,
        depth: Number.isInteger(meta.spawnDepth) && meta.spawnDepth >= 1 ? meta.spawnDepth : 1,
        workflow: f.workflow,
      });
    }
    for (const [id, a] of s.agents) {
      if (!keep.has(id)) {
        this.tailer.forget(a.jsonl);
        this.small.delete(a.meta);
        s.agents.delete(id);
      }
    }
    return out;
  }

  // <sessionId>/workflows/wf_*.json: running ones, and finished ones for LINGER_MS.
  #workflows(dir, now) {
    const out = [];
    for (const n of this.dirs.list(dir)) {
      if (!/^wf_[A-Za-z0-9._-]+\.json$/.test(n)) continue;
      const file = path.join(dir, n);
      const w = this.readJson(file, 2 * 1024 * 1024);
      if (!w || typeof w !== 'object') continue;
      const status = typeof w.status === 'string' ? w.status : 'unknown';
      const startedAt = Number.isFinite(w.startTime) ? w.startTime : 0;
      if (status !== 'running') {
        const end = Number.isFinite(w.durationMs) && startedAt ? startedAt + w.durationMs : this.small.get(file)?.mtimeMs ?? 0;
        if (now - end > LINGER_MS) continue;
      }
      out.push({ id: n.slice(0, -5), name: typeof w.workflowName === 'string' ? w.workflowName : '', status, agents: w.agentCount, startedAt });
    }
    return out;
  }
}
