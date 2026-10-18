// Append-only JSONL reader. Per file it keeps { ino, offset, carry } and on each call reads only
// the bytes appended since the last one. On first sight of a big file it starts at the last
// `maxInitial` bytes and discards the partial first line. A file that shrinks or is replaced
// (new inode) is read again from 0, or from its last `maxInitial` bytes.
//
// Lines starting with {"type":"api-request (about half of a transcript's bytes) are skipped
// without JSON.parse — and, when one is still arriving, without buffering it.

import fs from 'node:fs';
import { counters, guard, statOrNull } from './io.mjs';

export const MAX_INITIAL = 2 * 1024 * 1024;
const MAX_LINE = 4 * 1024 * 1024; // a single line longer than this is dropped, not buffered
const SKIP = Buffer.from('{"type":"api-request');
const EMPTY = Buffer.alloc(0);
const NL = 0x0a;

function isSkipped(buf) {
  if (buf.length < SKIP.length) return false;
  return buf.compare(SKIP, 0, SKIP.length, 0, SKIP.length) === 0;
}

export class Tailer {
  constructor({ home = null, maxInitial = MAX_INITIAL, chunk = 256 * 1024 } = {}) {
    this.home = home;
    this.maxInitial = maxInitial;
    this.chunk = chunk;
    this.files = new Map();
    this.stats = { bytes: 0, lines: 0, skipped: 0, bad: 0, dropped: 0 };
    this.generation = 0;
  }

  info(file) {
    const s = this.files.get(file);
    return s ? { fromStart: s.fromStart, gen: s.gen } : null;
  }

  // Parsed objects appended since the last call: [] when nothing changed, null when the file is gone.
  // info(file) says whether the reading began at byte 0 and which "generation" it is: the
  // generation changes whenever the file is started afresh (first sight, truncation, rotation),
  // which tells a caller that whatever it folded from earlier reads is stale.
  read(file, st = statOrNull(file)) {
    if (!st) {
      this.files.delete(file);
      return null;
    }
    let s = this.files.get(file);
    if (!s || s.ino !== st.ino || st.size < s.offset) {
      const start = st.size > this.maxInitial ? st.size - this.maxInitial : 0;
      s = { ino: st.ino, offset: start, carry: EMPTY, skipping: false, discard: start > 0, fromStart: start === 0, gen: ++this.generation };
      this.files.set(file, s);
    }
    const out = [];
    if (st.size <= s.offset) return out;

    if (this.home) guard(this.home, file);
    const fd = fs.openSync(file, 'r');
    counters.opens++;
    try {
      const buf = Buffer.alloc(Math.min(this.chunk, st.size - s.offset));
      while (s.offset < st.size) {
        const want = Math.min(buf.length, st.size - s.offset);
        const n = fs.readSync(fd, buf, 0, want, s.offset);
        if (n <= 0) break;
        s.offset += n;
        this.stats.bytes += n;
        counters.bytes += n;
        this.#feed(s, buf.subarray(0, n), out);
      }
    } finally {
      fs.closeSync(fd);
    }
    return out;
  }

  offsetOf(file) {
    return this.files.get(file)?.offset ?? null;
  }

  forget(file) {
    this.files.delete(file);
  }

  #feed(s, buf, out) {
    let pos = 0;
    while (pos < buf.length) {
      const nl = buf.indexOf(NL, pos);
      if (nl === -1) {
        if (!s.discard && !s.skipping) {
          s.carry = s.carry.length ? Buffer.concat([s.carry, buf.subarray(pos)]) : Buffer.from(buf.subarray(pos));
          if (isSkipped(s.carry)) {
            s.skipping = true;
            s.carry = EMPTY;
          } else if (s.carry.length > MAX_LINE) {
            s.skipping = true;
            s.carry = EMPTY;
            this.stats.dropped++;
          }
        }
        return;
      }
      const piece = buf.subarray(pos, nl);
      pos = nl + 1;
      if (s.discard) {
        s.discard = false;
        s.carry = EMPTY;
        continue;
      }
      if (s.skipping) {
        s.skipping = false;
        this.stats.skipped++;
        continue;
      }
      const line = s.carry.length ? Buffer.concat([s.carry, piece]) : piece;
      s.carry = EMPTY;
      this.#line(line, out);
    }
  }

  #line(line, out) {
    if (line.length === 0) return;
    if (isSkipped(line)) {
      this.stats.skipped++;
      return;
    }
    try {
      out.push(JSON.parse(line.toString('utf8')));
      this.stats.lines++;
    } catch {
      this.stats.bad++;
    }
  }
}
