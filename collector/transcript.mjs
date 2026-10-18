// Folds parsed transcript lines into the little a snapshot needs: title, model, effort, branch,
// cost, tokens, the current tool (name + a short hint), the last N file paths touched, and for
// a subagent whether it has handed back and when its current run began. Nothing else from a
// line is kept — no prompt text, no tool input beyond the hint and the paths (which only feed
// the classifier).

import path from 'node:path';
import { toPosix } from './paths.mjs';

export const RECENT_PATHS = 20;
export const RUN_GAP_MS = 30 * 60_000; // a gap this long between lines starts a new run
const MAX_COMMAND = 2048; // a command is cut to this before any regex runs over it
const PATH_TOOLS = { Read: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', Write: 'file_path', NotebookEdit: 'notebook_path' };

export function newModel() {
  return {
    title: null,
    customTitle: null, // the owner's own name for the session (a rename); wins over the AI title
    model: null,
    effort: null,
    branch: null,
    costUSD: null, // only from a cost-state line: a whole-session total
    costTokens: null, // likewise
    usage: { in: 0, out: 0, cacheRead: 0 }, // summed from the lines read — a total only if the whole file was read
    lastMsgId: null,
    tool: null,
    paths: [],
    handbackAt: null,
    firstAt: null, // first timestamp folded in
    resumedAt: null, // a run that began after a handback or a long gap
    lastAt: null,
  };
}

// The tailer restarted the file (truncated, rotated): what was summed from it is stale.
export function resetUsage(m) {
  m.usage = { in: 0, out: 0, cacheRead: 0 };
  m.lastMsgId = null;
  m.firstAt = null;
}

const ts = v => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
};
const nonNeg = v => (Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0);

// Path-shaped token → its basename when absolute, home-relative or climbing out.
function tame(token) {
  const t = toPosix(token);
  if (/^[~/]/.test(t) || t.includes('../')) return path.posix.basename(t.replace(/\/+$/, '')) || '';
  return token;
}

const CREDENTIAL_SHAPES = [
  /^(AKIA|ASIA)[A-Z0-9]{8,}/, /^xox[abposr]-/i, /^gh[pousr]_/, /^github_pat_/, /^glpat-/, /^eyJ[A-Za-z0-9_-]{6,}/,
  /^sk-/, /^AIza/, /^npm_[A-Za-z0-9]{10,}/, /^Bearer$/i, /^Basic$/i,
];
// -H/-u/-i/-p (header, user, identity file, password) with or without a glued value — a bare
// `-p` as in `mkdir -p` is lost too, fewer words beat `docker login -p <secret>` — and any long
// option that names a secret anywhere in it (--password, --with-token, --api-key, ...).
const SHORT_SECRET = /^-[Hupi]/;
const LONG_SECRET = /^--?[\w-]*(pass(word)?|passwd|token|header|user|auth|key|secret|cookie|bearer|credential)/i;

function entropy(s) {
  const counts = {};
  for (const c of s) counts[c] = (counts[c] || 0) + 1;
  let h = 0;
  for (const n of Object.values(counts)) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

// A token that might be, or introduce, a credential: the hint stops before it.
export function riskyToken(tok) {
  if (/[@:=]/.test(tok)) return true; // user@host, scheme://, user:pass, key=value
  if (SHORT_SECRET.test(tok) || LONG_SECRET.test(tok)) return true;
  if (CREDENTIAL_SHAPES.some(re => re.test(tok))) return true;
  if (/[0-9a-f]{24,}/i.test(tok)) return true;
  const bare = tok.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
  if (bare.length >= 20 && /[A-Za-z]/.test(bare) && /\d/.test(bare) && entropy(bare) >= 3.5) return true;
  return false;
}

// A Bash command's first words: the first segment that is not a bare `cd`/`export`, leading
// VAR=value assignments dropped, stopped at the first quoted, substituted or risky token (see
// riskyToken), at most four words, paths reduced to basenames. Fewer words beat a leak.
export function commandHint(cmd) {
  if (typeof cmd !== 'string') return '';
  const first = cmd.slice(0, MAX_COMMAND).split('\n')[0];
  const segments = first.split(/\s*(?:&&|\|\||;|\|)\s*/).map(s => s.trim()).filter(Boolean);
  const seg = segments.find(s => !/^(cd|pushd|popd|export|set|source|\.)(\s|$)/.test(s)) ?? segments[0] ?? '';
  const tokens = seg.split(/\s+/);
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
  const out = [];
  for (const raw of tokens) {
    if (out.length >= 4) break;
    if (!raw || /^["'`$<(>]/.test(raw) || raw.includes('$(') || raw.includes('`')) break;
    if (riskyToken(raw)) break;
    const t = tame(raw);
    if (t) out.push(t);
  }
  return out.join(' ');
}

// Glob: the pattern's basename once trailing all-wildcard segments are dropped
// ("Weather/**" → "Weather", "src/**/*.ts" → "*.ts").
function globHint(pattern) {
  if (typeof pattern !== 'string') return '';
  const segs = toPosix(pattern.slice(0, MAX_COMMAND)).split('/').filter(Boolean);
  while (segs.length > 1 && /^\*+$/.test(segs.at(-1))) segs.pop();
  return segs.length && !/^\*+$/.test(segs.at(-1)) ? segs.at(-1) : '';
}

export function toolHint(name, input) {
  if (!input || typeof input !== 'object') return '';
  const base = v => (typeof v === 'string' && v ? path.posix.basename(toPosix(v.slice(0, MAX_COMMAND)).replace(/\/+$/, '')) : '');
  switch (name) {
    case 'Bash': return commandHint(input.command);
    case 'Read': case 'Edit': case 'MultiEdit': case 'Write': return base(input.file_path);
    case 'NotebookEdit': return base(input.notebook_path);
    case 'Glob': return globHint(input.pattern);
    case 'Grep': return base(input.path);
    case 'Skill': return typeof input.skill === 'string' ? input.skill.slice(0, 64) : '';
    case 'Agent': case 'Task': return typeof input.subagent_type === 'string' ? input.subagent_type.slice(0, 64) : '';
    default: return '';
  }
}

const hasText = msg => Array.isArray(msg?.content) && msg.content.some(b => b?.type === 'text');

export function applyLine(m, o) {
  if (!o || typeof o !== 'object') return;
  const at = ts(o.timestamp);
  if (at !== null) {
    // A new run: activity after a handback (the agent was resumed), or after a long silence.
    const resumed = m.handbackAt !== null && at > m.handbackAt && (o.type === 'assistant' || (o.type === 'user' && hasText(o.message)));
    if (resumed) m.handbackAt = null;
    if (resumed || (m.lastAt !== null && at - m.lastAt > RUN_GAP_MS)) m.resumedAt = at;
    if (m.firstAt === null) m.firstAt = at;
    if (m.lastAt === null || at > m.lastAt) m.lastAt = at;
  }
  if (typeof o.gitBranch === 'string' && o.gitBranch) m.branch = o.gitBranch;

  switch (o.type) {
    case 'ai-title':
      if (typeof o.aiTitle === 'string' && o.aiTitle.trim()) m.title = o.aiTitle;
      return;
    case 'custom-title':
      // An empty rename clears it: the AI title shows again.
      if (typeof o.customTitle === 'string') m.customTitle = o.customTitle.trim() || null;
      return;
    case 'cost-state': {
      if (Number.isFinite(o.totalCostUSD) && o.totalCostUSD >= 0) m.costUSD = o.totalCostUSD;
      if (o.modelUsage && typeof o.modelUsage === 'object') {
        const t = { in: 0, out: 0, cacheRead: 0 };
        for (const u of Object.values(o.modelUsage)) {
          if (!u || typeof u !== 'object') continue;
          t.in += nonNeg(u.inputTokens);
          t.out += nonNeg(u.outputTokens);
          t.cacheRead += nonNeg(u.cacheReadInputTokens);
        }
        m.costTokens = t;
      }
      return;
    }
    case 'assistant':
      break;
    default:
      return;
  }

  const msg = o.message;
  if (!msg || typeof msg !== 'object') return;
  if (typeof msg.model === 'string' && msg.model && !msg.model.startsWith('<')) m.model = msg.model;
  if (typeof o.effort === 'string' && o.effort) m.effort = o.effort;
  // One API response is written as one line per content block, each repeating the usage.
  if (msg.usage && msg.id !== m.lastMsgId) {
    m.lastMsgId = msg.id ?? null;
    m.usage.in += nonNeg(msg.usage.input_tokens);
    m.usage.out += nonNeg(msg.usage.output_tokens);
    m.usage.cacheRead += nonNeg(msg.usage.cache_read_input_tokens);
  }
  if (!Array.isArray(msg.content)) return;
  for (const b of msg.content) {
    if (!b || b.type !== 'tool_use' || typeof b.name !== 'string') continue;
    const since = at ?? m.lastAt ?? 0;
    m.tool = { name: b.name, hint: toolHint(b.name, b.input), since };
    const key = PATH_TOOLS[b.name];
    if (key && typeof b.input?.[key] === 'string') {
      m.paths.push(b.input[key].slice(0, 4096));
      if (m.paths.length > RECENT_PATHS) m.paths.splice(0, m.paths.length - RECENT_PATHS);
    }
    if (b.name === 'SubagentHandback') m.handbackAt = since;
  }
}

export function applyLines(m, lines, { sidechain = null } = {}) {
  for (const o of lines) {
    if (sidechain !== null && typeof o?.isSidechain === 'boolean' && o.isSidechain !== sidechain) continue;
    applyLine(m, o);
  }
  return m;
}

// Totals only when they are totals: a cost-state line (cumulative), or usage summed over a
// transcript read from byte 0. A tail-seeked partial sum is unknown, not small.
export function tokensOf(m, wholeFile) {
  return m.costTokens ?? (wholeFile ? { ...m.usage } : null);
}
