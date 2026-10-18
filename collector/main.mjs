// The long-running collector (what the LaunchAgent runs): every 2 s watch → tail → classify →
// snapshot; serve the local view on 127.0.0.1:8777; push changed snapshots to a hosted site, if one
// is set up (push.mjs: AGENTS_PUSH_URL or ~/.config/mhilo-agents/push-url; otherwise local only).
// If the port is taken, collecting and pushing carry on and the bind is retried every 60 s.
//
// Environment (all optional):
//   CLAUDE_HOME          the Claude home to read (default ~/.claude)
//   AGENTS_LAB_DIR       lab configs (default <repo>/lab)
//   AGENTS_SITE_DIR      static site (default <repo>/site)
//   AGENTS_PORT          local port (default 8777; always bound to 127.0.0.1)
//   AGENTS_BIND_RETRY_MS how long to wait before re-trying a busy port (default 60000)
//   AGENTS_PUSH_URL      push endpoint (default: ~/.config/mhilo-agents/push-url; neither = no push)
//   AGENTS_PUSH_URL_FILE where that file is
//   AGENTS_TOKEN_FILE    bearer token file (default ~/.config/mhilo-agents/token)
//   AGENTS_NO_PUSH=1     run without pushing
//   AGENTS_STATS=1       log bytes read, CPU and RSS every tick

import { pathToFileURL } from 'node:url';
import { Collector } from './collect.mjs';
import { createServer, localStore, defaultSiteDir, PORT, HOST } from './serve.mjs';
import { Pusher, pushUrl } from './push.mjs';

export const TICK_MS = 2000;

export function logLine(msg) {
  console.log(`${new Date().toISOString()} ${msg}`);
}

export function run({
  push = true,
  port = Number(process.env.AGENTS_PORT || PORT),
  interval = TICK_MS,
  bindRetry = Number(process.env.AGENTS_BIND_RETRY_MS || 60_000),
  log = logLine,
  stats = process.env.AGENTS_STATS === '1',
} = {}) {
  const collector = new Collector({ log });
  const store = localStore(collector);
  const server = createServer({ siteDir: defaultSiteDir(), store, log });
  let bindTimer = null;
  let busyLogged = false;
  const listen = () => server.listen(port, HOST);
  server.on('listening', () => log(`local view on http://${HOST}:${server.address().port}/`));
  server.on('error', e => {
    if (e.code === 'EADDRINUSE' || e.code === 'EACCES') {
      if (!busyLogged) log(`port ${port} unavailable (${e.code}); collecting and pushing continue, retrying the local view every ${Math.round(bindRetry / 1000)}s`);
      busyLogged = true;
      bindTimer = setTimeout(listen, bindRetry);
      return;
    }
    log(`server error: ${e.code || e.name}`);
  });
  listen();

  const url = pushUrl();
  const pusher = push && process.env.AGENTS_NO_PUSH !== '1' && url ? new Pusher({ url, log }) : null;
  if (!pusher) log(url || !push || process.env.AGENTS_NO_PUSH === '1' ? 'push disabled' : 'push disabled: no push URL set up, so this computer only');

  let lastBytes = 0;
  let lastCpu = process.cpuUsage();
  const tick = () => {
    const t0 = performance.now();
    try {
      const { changed, retired } = collector.tick();
      if (pusher) {
        // Offer every project, not only the changed ones: offer() drops what was sent less than a
        // heartbeat ago, retries what was skipped (no token yet), and sends the 60 s heartbeat.
        for (const snap of collector.snapshots()) pusher.offer(snap);
        for (const snap of retired) pusher.retire(snap);
      }
      if (stats) {
        const s = collector.stats();
        const cpu = process.cpuUsage(lastCpu);
        lastCpu = process.cpuUsage();
        const sessions = collector.snapshots().reduce((n, x) => n + x.sessions.length, 0);
        const agents = collector.snapshots().reduce((n, x) => n + x.sessions.reduce((m, y) => m + y.agents.length, 0), 0);
        log(`tick ${collector.ticks}: read ${s.bytes - lastBytes}B, ${(performance.now() - t0).toFixed(1)}ms, cpu ${((cpu.user + cpu.system) / 1000).toFixed(1)}ms since last, rss ${(process.memoryUsage().rss / 1048576).toFixed(1)}MB, sessions ${sessions}, agents ${agents}, changed [${changed.join(',')}], retired [${retired.map(r => r.project).join(',')}]`);
        lastBytes = s.bytes;
      }
    } catch (e) {
      log(`tick failed: ${e.name}: ${e.message}`);
    }
  };
  tick();
  const timer = setInterval(tick, interval);

  const stop = () => {
    clearInterval(timer);
    clearTimeout(bindTimer);
    pusher?.stop();
    server.close();
  };
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.once(sig, () => {
      log(`${sig}: stopping`);
      stop();
      process.exit(0);
    });
  }
  return { collector, server, pusher, stop };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
