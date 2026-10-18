// The area scorer (docs/PLAN.md "Area classification"). Pure: config + evidence in, area out.
//
// Score per area = number of its keywords found in the text (title, or agent description +
// type; case-insensitive, whole words, plural s/es allowed) + number of distinct recent file
// paths that match one of its globs (relative to the checkout; paths outside it never count).
// Highest score wins. A tie between top areas goes to "research" (or the first tied area if the
// config has no research area). No score at all goes to the config's `fallback` area, or to
// "lobby" when it names none. A project with no config is the Workshop wing: three broad areas,
// and whatever matches none of them is built in Build.
//
// Every wing has at least MIN_AREAS pods (the owner, 2026-10-17), titled after the work done there.

import path from 'node:path';
import { toPosix } from './paths.mjs';

export const LOBBY = 'lobby';
export const RESEARCH = 'research';
export const MIN_AREAS = 3;

export const WORKSHOP = Object.freeze({
  id: 'workshop',
  label: 'Workshop',
  colour: '#8FA3BB',
  workshop: true,
  match: { cwd: [] },
  fallback: 'build',
  areas: [
    { id: 'build', label: 'Build', tint: '#4FF2E0',
      keywords: ['build', 'fix', 'bug', 'test', 'code', 'implement', 'feature', 'refactor', 'deploy', 'api', 'server', 'script', 'error'],
      paths: ['src/**', 'lib/**', 'app/**', 'server/**', 'api/**', 'tests/**', 'test/**', 'scripts/**', 'tools/**', '.github/**'] },
    { id: 'design', label: 'Design', tint: '#FFB703',
      keywords: ['design', 'ui', 'ux', 'css', 'style', 'layout', 'colour', 'color', 'font', 'typography', 'image', 'art', 'logo', 'brand', 'mockup', 'figma', 'icon'],
      paths: ['design/**', '**/*.css', 'assets/**', 'images/**', 'public/**'] },
    { id: 'research', label: 'Research', tint: '#8FA3BB',
      keywords: ['research', 'explore', 'investigate', 'plan', 'find', 'how', 'why', 'review', 'compare', 'docs', 'read'],
      paths: ['docs/**', '**/*.md'] },
  ],
});

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Glob → RegExp over a posix relative path: `**/` any number of leading dirs (including none),
// `**` anything, `*` anything but '/', `?` one char but '/'.
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += escape(c);
  }
  return new RegExp(`^${re}$`);
}

// A path relative to the checkout, or null when it is outside it.
export function relativeTo(root, p) {
  if (typeof p !== 'string' || p === '') return null;
  root = toPosix(root);
  p = toPosix(p);
  let rel;
  if (path.posix.isAbsolute(p)) {
    if (!root) return null;
    const base = root.endsWith('/') ? root : `${root}/`;
    if (!p.startsWith(base)) return null;
    rel = p.slice(base.length);
  } else {
    rel = p;
  }
  rel = path.posix.normalize(rel);
  if (rel === '.' || rel === '..' || rel.startsWith('../') || path.posix.isAbsolute(rel)) return null;
  return rel;
}

const compiled = new WeakMap();
function compile(config) {
  let c = compiled.get(config);
  if (!c) {
    c = (config.areas || []).map(a => ({
      id: a.id,
      keywords: (a.keywords || []).map(k => ({
        word: k,
        re: new RegExp(`(?:^|[^a-z0-9])${escape(k.toLowerCase())}(?:s|es)?(?:$|[^a-z0-9])`, 'i'),
      })),
      globs: (a.paths || []).map(globToRegExp),
    }));
    compiled.set(config, c);
  }
  return c;
}

function summarisePath(rel) {
  const dir = path.posix.dirname(rel);
  return dir === '.' ? rel : `${dir}/*`;
}

// evidence: { text, paths (absolute or checkout-relative), cwd (the checkout, absolute) }
// → { area, why, scores }
export function classify(config, { text = '', paths = [], cwd = '' } = {}) {
  config = config || WORKSHOP;

  const rels = [...new Set(paths.map(p => relativeTo(cwd, p)).filter(Boolean))];
  const areas = compile(config);
  const scores = {};
  const evidence = {};
  for (const a of areas) {
    const words = a.keywords.filter(k => k.re.test(text)).map(k => k.word);
    const hits = rels.filter(r => a.globs.some(g => g.test(r)));
    scores[a.id] = words.length + hits.length;
    evidence[a.id] = { words, hits };
  }

  const top = Math.max(0, ...Object.values(scores));
  if (top === 0) {
    const fallback = areas.some(a => a.id === config.fallback) ? config.fallback : LOBBY;
    return { area: fallback, why: fallback === LOBBY ? '' : 'nothing matched: the wing\'s fallback', scores };
  }
  const tied = areas.filter(a => scores[a.id] === top).map(a => a.id);
  if (tied.length > 1) {
    const area = tied.includes(RESEARCH) || areas.some(a => a.id === RESEARCH) ? RESEARCH : tied[0];
    return { area, why: `tie: ${tied.join(', ')}`, scores };
  }
  const { words, hits } = evidence[tied[0]];
  const parts = [...new Set(hits.map(summarisePath))].slice(0, 2).concat(words.slice(0, 2));
  return { area: tied[0], why: parts.join(', '), scores };
}
