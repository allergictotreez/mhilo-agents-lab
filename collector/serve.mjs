// The local view: http://127.0.0.1:8777/ serves site/ and answers schema/api.md at
// /api.php?action=… with no password (whoami → { authed: true, local: true }). Binds 127.0.0.1
// only, and answers only requests addressed to 127.0.0.1:<port> or localhost:<port> (421
// otherwise), so a DNS-rebinding page cannot read it. `node collector/serve.mjs` runs the
// collector + this server, without pushing.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildIndex, problemsOf } from './snapshot.mjs';

export const PORT = 8777;
export const HOST = '127.0.0.1';
const MAX_PUSH = 512 * 1024;
const MAX_PUSHED = 10; // projects held in the local push store (oldest evicted)
const PHPISH = /\.(php\d*|phtml|phar|phps)(\.|$)/i;

export function defaultSiteDir() {
  return process.env.AGENTS_SITE_DIR || fileURLToPath(new URL('../site/', import.meta.url));
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

// The collector's snapshots, plus anything POSTed to push for a project the collector does not
// itself produce (lets a fixture be loaded into the local page), at most MAX_PUSHED of them.
// projects[].at is the collector's last tick for its own projects (feed freshness), and the
// snapshot's own `at` for pushed ones.
export function localStore(collector) {
  const pushed = new Map();
  return {
    pushed,
    index: () => {
      const own = collector.snapshots();
      const extra = [...pushed.values()].filter(s => !collector.snapshot(s.project));
      return buildIndex([...own, ...extra], Date.now(), s => (collector.snapshot(s.project) ? collector.lastTickAt : s.at));
    },
    snapshot: id => collector.snapshot(id) ?? pushed.get(id) ?? null,
    accept: snap => {
      if (collector.snapshot(snap.project)) return;
      pushed.delete(snap.project);
      pushed.set(snap.project, snap);
      while (pushed.size > MAX_PUSHED) pushed.delete(pushed.keys().next().value);
    },
  };
}

function json(res, status, body, extra = {}) {
  const text = body === null ? '' : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(text);
}

function readBody(req, limit) {
  return new Promise(resolve => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', c => {
      size += c.length;
      if (size > limit) over = true;
      else chunks.push(c);
    });
    req.on('end', () => resolve(over ? { over: true } : { text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => resolve({ text: '' }));
  });
}

const etagOf = text => `"${crypto.createHash('sha1').update(text).digest('hex').slice(0, 20)}"`;

async function api(req, res, url, store) {
  const action = url.searchParams.get('action');
  const method = req.method;
  const post = method === 'POST';
  const get = method === 'GET' || method === 'HEAD';
  switch (action) {
    case 'whoami':
      return get ? json(res, 200, { authed: true, local: true }) : json(res, 405, { error: 'method' });
    case 'login':
    case 'logout':
      if (!post) return json(res, 405, { error: 'method' });
      await readBody(req, 64 * 1024);
      return json(res, 200, { ok: true });
    case 'state': {
      if (!get) return json(res, 405, { error: 'method' });
      const project = url.searchParams.get('project');
      if (project === null) return json(res, 200, store.index());
      const snap = store.snapshot(project);
      if (!snap) return json(res, 404, { error: 'unknown project' });
      const text = JSON.stringify(snap);
      const etag = etagOf(text);
      const inm = req.headers['if-none-match'];
      if (inm && (inm.trim() === '*' || inm.split(',').map(s => s.trim().replace(/^W\//, '')).includes(etag))) {
        res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-store' });
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ETag: etag });
      return res.end(method === 'HEAD' ? undefined : text);
    }
    case 'push': {
      if (!post) return json(res, 405, { error: 'method' });
      const body = await readBody(req, MAX_PUSH);
      if (body.over) return json(res, 413, { error: 'too large' });
      let snap;
      try {
        snap = JSON.parse(body.text);
      } catch {
        return json(res, 400, { error: 'invalid', detail: 'not JSON' });
      }
      const problems = problemsOf(snap);
      if (problems.length) return json(res, 400, { error: 'invalid', detail: problems.slice(0, 3).join('; ').slice(0, 300) });
      store.accept?.(snap);
      return json(res, 200, { ok: true });
    }
    default:
      return json(res, 400, { error: 'unknown action' });
  }
}

// Segments that are never served, case-insensitively (APFS is): dot segments (.., .git,
// .htaccess), PHP-ish files (.php, .php5, .phtml, .phar, .phps — even mid-name, as Apache may run
// them) and, relative to the site root, data/.
function refused(segs, siteRelative) {
  if (segs.some(s => s.startsWith('.') || PHPISH.test(s))) return true;
  return siteRelative && segs.length > 0 && segs[0].toLowerCase() === 'data';
}

// Resolves a URL path to a file inside siteDir, or null. Refuses the segments above, NUL and
// backslashes. A symlink is followed only if its real path stays inside the repository
// (`repoDir`, by default the site's parent — site/tokens.css → design/tokens.css) and the real
// path passes the same refusals.
export function resolveStatic(siteDir, pathname, repoDir = null) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const segs = decoded.split('/').filter(Boolean);
  if (refused(segs, true)) return null;
  let root;
  let repo;
  try {
    root = fs.realpathSync(siteDir);
    repo = repoDir ? fs.realpathSync(repoDir) : path.dirname(root);
  } catch {
    return null;
  }
  let file = path.resolve(root, ...segs);
  if (file !== root && !file.startsWith(root + path.sep)) return null;
  let st;
  try {
    st = fs.statSync(file);
    if (st.isDirectory()) {
      file = path.join(file, 'index.html');
      st = fs.statSync(file);
    }
    if (!st.isFile()) return null;
    const real = fs.realpathSync(file);
    const inside = (dir, p) => p.startsWith(dir + path.sep);
    if (inside(root, real)) return refused(path.relative(root, real).split(path.sep), true) ? null : real;
    if (inside(repo, real)) return refused(path.relative(repo, real).split(path.sep), false) ? null : real;
    return null;
  } catch {
    return null;
  }
}

const hostOk = req => {
  const port = req.socket.localPort;
  const host = String(req.headers.host || '').toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
};

export function createServer({ siteDir = defaultSiteDir(), repoDir = null, store, log = () => {} }) {
  return http.createServer((req, res) => {
    if (!hostOk(req)) return json(res, 421, { error: 'misdirected' });
    let url;
    try {
      url = new URL(req.url, `http://${HOST}`);
    } catch {
      return json(res, 400, { error: 'bad request' });
    }
    if (url.pathname === '/api.php') {
      return api(req, res, url, store).catch(e => {
        log(`api error: ${e.message}`);
        if (!res.headersSent) json(res, 500, { error: 'server' });
        else res.end();
      });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method' });
    const file = resolveStatic(siteDir, url.pathname, repoDir);
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.end()).pipe(res);
  });
}

// Not a top-level await: main.mjs imports this module, and awaiting it here would deadlock the
// module cycle. By the time the promise resolves this module has finished evaluating.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  import('./main.mjs').then(({ run }) => run({ push: false }));
}
