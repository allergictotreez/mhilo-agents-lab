// POSTs a project's snapshot to the hosted api.php (schema/api.md):
// - when its content changed (ignoring `at`), or 60 s after the last successful push (heartbeat);
// - at most once per `minInterval` per project, exponential backoff on failure (2 s → 60 s);
// - 400 and 413 are not retried until the content changes; 401 re-reads the token and retries;
// - retire(snapshot) sends one `sessions: []` snapshot, then forgets the project.
// Logging: failures (once per distinct cause), state changes (recovered, token found/missing)
// and one summary line an hour — never a line per successful push.
// The bearer token is read from ~/.config/mhilo-agents/token at runtime, must be one printable
// ASCII word, and never appears in a log line or anywhere but the Authorization header.
// Where to push is opt-in: AGENTS_PUSH_URL, else ~/.config/mhilo-agents/push-url (tools/set-secret.sh
// writes it). With neither, nothing is pushed: a fresh install stays on this Mac.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sameContent } from './snapshot.mjs';

export const defaultTokenFile = () => process.env.AGENTS_TOKEN_FILE || path.join(os.homedir(), '.config', 'mhilo-agents', 'token');
export const defaultUrlFile = () => process.env.AGENTS_PUSH_URL_FILE || path.join(os.homedir(), '.config', 'mhilo-agents', 'push-url');

/** The push endpoint, or null (push off): AGENTS_PUSH_URL, else the push-url file's first line. */
export function pushUrl(file = defaultUrlFile()) {
  let url = process.env.AGENTS_PUSH_URL || '';
  if (!url) { try { url = fs.readFileSync(file, 'utf8').split('\n')[0].trim(); } catch { url = ''; } }
  return /^https?:\/\/[^\s]+$/.test(url) ? url : null;
}
const TOKEN_RECHECK_MS = 60_000;
const TOKEN_SHAPE = /^[\x21-\x7e]+$/;
const NOT_RETRIED = new Set([400, 413]);

export class Pusher {
  constructor({
    url = pushUrl(),
    tokenFile = defaultTokenFile(),
    log = () => {},
    minInterval = 2000,
    heartbeat = 60_000,
    baseDelay = 2000,
    maxDelay = 60_000,
    timeout = 10_000,
    summaryEvery = 3_600_000,
    fetchImpl = (...a) => fetch(...a),
    now = Date.now,
  } = {}) {
    Object.assign(this, { url, tokenFile, log, minInterval, heartbeat, baseDelay, maxDelay, timeout, fetchImpl, now });
    this.projects = new Map();
    this.token = null;
    this.tokenCheckedAt = -Infinity;
    this.tokenState = null; // 'ok' | 'missing' | 'invalid'
    this.stopped = false;
    this.tally = { ok: 0, failed: 0, rejected: 0 };
    this.summaryTimer = setInterval(() => this.#summary(), summaryEvery);
    this.summaryTimer.unref?.();
  }

  #state(id) {
    let p = this.projects.get(id);
    if (!p) {
      p = { sent: null, sentAt: -Infinity, pending: null, timer: null, inflight: false, failures: 0, lastAttempt: -Infinity, rejected: null, retiring: false, lastError: null };
      this.projects.set(id, p);
    }
    return p;
  }

  // Logs transitions only; the first successful load is silent (it is the normal case).
  #tokenStateChange(state, msg) {
    if (this.tokenState !== state && !(this.tokenState === null && state === 'ok')) this.log(msg);
    this.tokenState = state;
  }

  #readToken() {
    if (this.token) return this.token;
    const t = this.now();
    if (t - this.tokenCheckedAt < TOKEN_RECHECK_MS) return null;
    this.tokenCheckedAt = t;
    let raw;
    try {
      raw = fs.readFileSync(this.tokenFile, 'utf8');
    } catch {
      this.#tokenStateChange('missing', `push skipped: no token file at ${this.tokenFile.replace(os.homedir(), '~')} (local view still works)`);
      return null;
    }
    const tok = raw.trim();
    if (!TOKEN_SHAPE.test(tok)) {
      this.#tokenStateChange('invalid', 'push skipped: the token file is not a single printable ASCII word');
      return null;
    }
    this.#tokenStateChange('ok', 'push token loaded');
    this.token = tok;
    return tok;
  }

  // Called every tick with each project's current snapshot.
  offer(snapshot) {
    if (!snapshot || this.stopped) return;
    const p = this.#state(snapshot.project);
    if (p.retiring && snapshot.sessions.length) p.retiring = false; // a session came back
    if (p.retiring) return;
    if (p.rejected && sameContent(p.rejected, snapshot)) return;
    if (sameContent(p.sent, snapshot) && this.now() - p.sentAt < this.heartbeat) {
      p.pending = null;
      return;
    }
    p.pending = snapshot;
    this.#schedule(snapshot.project, p);
  }

  // The project's last session ended: send this (empty) snapshot once, then forget the project.
  retire(snapshot) {
    if (!snapshot || this.stopped) return;
    const p = this.#state(snapshot.project);
    p.retiring = true;
    p.rejected = null;
    p.pending = snapshot;
    this.#schedule(snapshot.project, p);
  }

  #delay(p) {
    return Math.min(this.maxDelay, this.baseDelay * 2 ** (p.failures - 1));
  }

  #schedule(id, p) {
    if (p.timer || p.inflight || !p.pending || this.stopped) return;
    const wait = p.failures ? this.#delay(p) : Math.max(0, p.lastAttempt + this.minInterval - this.now());
    p.timer = setTimeout(() => {
      p.timer = null;
      this.#send(id, p);
    }, wait);
    p.timer.unref?.();
  }

  async #send(id, p) {
    if (this.stopped || !p.pending) return;
    const token = this.#readToken();
    if (!token) {
      if (!p.retiring) p.pending = null; // offer() brings it back on the next tick
      else this.#later(id, p);
      return;
    }
    const snap = p.pending;
    p.pending = null;
    p.inflight = true;
    p.lastAttempt = this.now();
    let status = 0;
    let cause = null;
    try {
      const res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(snap),
        signal: AbortSignal.timeout(this.timeout),
      });
      await res.text().catch(() => '');
      status = res.status;
    } catch (e) {
      cause = e.name === 'TimeoutError' ? 'timeout' : String(e.cause?.code || e.code || e.name || 'error');
    }
    p.inflight = false;
    if (this.stopped) return;

    if (status >= 200 && status < 300) {
      this.tally.ok++;
      if (p.failures) this.log(`push ${id} recovered after ${p.failures} failed attempt${p.failures === 1 ? '' : 's'}`);
      p.failures = 0;
      p.lastError = null;
      p.sent = snap;
      p.sentAt = this.now();
      if (p.retiring && !p.pending) {
        this.projects.delete(id);
        return;
      }
      if (p.pending && sameContent(p.sent, p.pending)) p.pending = null;
    } else if (NOT_RETRIED.has(status)) {
      this.tally.rejected++;
      this.log(`push ${id} rejected (HTTP ${status}); not retried until the snapshot changes`);
      p.failures = 0;
      p.rejected = snap;
      if (p.retiring) this.projects.delete(id);
      return;
    } else {
      this.tally.failed++;
      p.failures++;
      if (!p.pending) p.pending = snap;
      const what = cause ?? `HTTP ${status}`;
      const secs = (this.#delay(p) / 1000).toFixed(1);
      if (status === 401) {
        this.token = null;
        this.tokenCheckedAt = -Infinity; // the retry re-reads the file
        if (p.lastError !== what) this.log(`push ${id} failed (HTTP 401); the token file will be re-read, next try in ${secs}s, backing off to ${this.maxDelay / 1000}s`);
      } else if (p.lastError !== what) {
        this.log(`push ${id} failed (${what}); next try in ${secs}s, backing off to ${this.maxDelay / 1000}s`);
      }
      p.lastError = what;
    }
    this.#schedule(id, p);
  }

  // No token while retiring: keep the retirement and try again after the token re-check window.
  #later(id, p) {
    if (p.timer) return;
    p.timer = setTimeout(() => {
      p.timer = null;
      this.#send(id, p);
    }, TOKEN_RECHECK_MS);
    p.timer.unref?.();
  }

  #summary() {
    const { ok, failed, rejected } = this.tally;
    const failing = [...this.projects].filter(([, p]) => p.failures).map(([id]) => id);
    this.log(`push summary (last hour): ${ok} ok, ${failed} failed, ${rejected} rejected${failing.length ? `; failing: ${failing.join(',')}` : ''}${this.tokenState && this.tokenState !== 'ok' ? `; token ${this.tokenState}` : ''}`);
    this.tally = { ok: 0, failed: 0, rejected: 0 };
  }

  stop() {
    this.stopped = true;
    clearInterval(this.summaryTimer);
    for (const p of this.projects.values()) if (p.timer) clearTimeout(p.timer);
  }
}
