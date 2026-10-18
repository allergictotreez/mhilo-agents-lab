// Every read under the Claude home goes through here, for two reasons:
// 1. HARNESS.md §1 in code: only the registry (sessions/*.json), state/*, transcripts
//    (projects/**/*.jsonl), subagent meta (agent-*.meta.json) and workflow run state
//    (projects/<dir>/<sid>/workflows/wf_*.json) may be opened. Anything else — sessions/*.key,
//    ide/*.lock, settings, credentials — throws before a byte is read. Both the path as named and
//    its realpath must pass, so a symlink cannot smuggle a forbidden file in under an allowed name.
// 2. A byte counter, so the "reads only what changed" claim is measurable.

import fs from 'node:fs';
import path from 'node:path';

export const counters = { bytes: 0, opens: 0, refused: 0 };

const ALLOWED = [
  /^sessions\/[^/]+\.json$/,
  /^state\/[^/]+$/,
  /^projects\/.+\.jsonl$/,
  /^projects\/.+\/agent-[^/]+\.meta\.json$/,
  /^projects\/[^/]+\/[^/]+\/workflows\/wf_[^/]+\.json$/,
];

function allowedRel(base, file) {
  const rel = path.relative(base, file).split(path.sep).join('/');
  if (rel === '' || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) return false;
  return ALLOWED.some(re => re.test(rel));
}

const realHomes = new Map();
function realHome(home) {
  let r = realHomes.get(home);
  if (!r) {
    try { r = fs.realpathSync(home); } catch { r = path.resolve(home); }
    realHomes.set(home, r);
  }
  return r;
}

// True when `file` may be opened: it is inside `home`, matches the allow-list, and — when it
// exists — its realpath is inside the (real) home and matches the allow-list too.
export function mayRead(home, file) {
  const abs = path.resolve(file);
  if (!allowedRel(path.resolve(home), abs)) return false;
  let real;
  try {
    real = fs.realpathSync(abs);
  } catch {
    return true; // does not exist: the open will fail on its own
  }
  return allowedRel(realHome(home), real);
}

export function guard(home, file) {
  if (!mayRead(home, file)) {
    counters.refused++;
    throw new Error(`refusing to read outside the allow-list: ${path.basename(file)}`);
  }
}

// Reads a small whole file under the home (registry, state, meta, workflow). Capped so a
// surprise giant file cannot stall a tick.
export function readSmall(home, file, cap = 256 * 1024) {
  guard(home, file);
  const fd = fs.openSync(file, 'r');
  counters.opens++;
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, cap);
    const buf = Buffer.alloc(len);
    const n = len ? fs.readSync(fd, buf, 0, len, 0) : 0;
    counters.bytes += n;
    return { text: buf.subarray(0, n).toString('utf8'), truncated: size > cap };
  } finally {
    fs.closeSync(fd);
  }
}

export function statOrNull(file) {
  try { return fs.statSync(file); } catch { return null; }
}

export function readdirOrEmpty(dir, opts) {
  try { return fs.readdirSync(dir, opts); } catch { return []; }
}
