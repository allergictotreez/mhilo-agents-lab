// The demo lab: three made-up projects whose sessions arrive, work, move between pods, send out
// agents and leave. app.js shows it to a visitor outside the owner's network instead of the
// sign-in plate. Pure and seeded: no DOM, no three.js, so tests/site/sim.test.mjs runs it in node
// and validates every snapshot against schema/snapshot.schema.json. Every name, title and number
// here is invented; none of it comes from a real session.

const TICK = 1000;              // the simulation steps in whole seconds
const CATCH_UP = 60_000;        // back from a hidden tab: replay at most the last minute
const FIGURE_CAP = 17;          // sessions + running agents per wing: a lab you can read at a glance
const LINGER = 8000;            // a finished agent stays this long, so the floor plays its exit
const OPENING = 6;              // figures on the floor at the first look

// [id, label, tint, the thing being worked on, a file it lives in]
const PROJECTS = [
  {
    id: 'atlas', label: 'Atlas Maps', colour: '#7FB3FF', people: [4, 7], areas: [
      ['tiles', 'Map Tiles', '#E9C46A', 'tile cache', 'tiles.ts'],
      ['search', 'Search', '#7FB3FF', 'place search', 'search.ts'],
      ['routing', 'Routing', '#9BE7C4', 'route planner', 'route.ts'],
      ['offline', 'Offline Sync', '#8FA3BB', 'offline sync', 'sync.ts'],
      ['a11y', 'Accessibility', '#F5EBD7', 'screen reader labels', 'labels.tsx'],
      ['release', 'Release', '#F4A261', 'release build', 'deploy.yml'],
      ['research', 'Research', '#B8A9C9', 'map style options', 'notes.md'],
    ],
  },
  {
    id: 'kiln', label: 'Kiln Studio', colour: '#F4A261', people: [4, 6], areas: [
      ['booking', 'Booking', '#F4A261', 'class booking', 'booking.ts'],
      ['payments', 'Payments', '#9BE7C4', 'checkout', 'checkout.ts'],
      ['calendar', 'Calendar', '#7FB3FF', 'studio calendar', 'calendar.tsx'],
      ['email', 'Email', '#F5EBD7', 'reminder emails', 'mail.ts'],
      ['admin', 'Admin', '#8FA3BB', 'admin dashboard', 'admin.tsx'],
      ['research', 'Research', '#B8A9C9', 'pricing options', 'notes.md'],
    ],
  },
  {
    id: 'tidepool', label: 'Tidepool', colour: '#C792EA', people: [5, 8], areas: [
      ['levels', 'Levels', '#E9C46A', 'reef level', 'Reef.cs'],
      ['creatures', 'Creatures', '#9BE7C4', 'crab behavior', 'Crab.cs'],
      ['audio', 'Audio', '#F5EBD7', 'ambient mix', 'Mixer.cs'],
      ['physics', 'Physics', '#7FB3FF', 'water current', 'Current.cs'],
      ['art', 'Art', '#F4A261', 'shell textures', 'shell.png'],
      ['ui', 'UI & Menus', '#E8EEF6', 'pause menu', 'Pause.cs'],
      ['platform', 'Platform', '#8FA3BB', 'web build', 'build.sh'],
      ['online', 'Online', '#C792EA', 'leaderboard', 'Board.cs'],
      ['research', 'Research', '#B8A9C9', 'save format', 'notes.md'],
    ],
  },
];

const TITLES = [w => `Fix the ${w}`, w => `Speed up the ${w}`, w => `Tests for the ${w}`, w => `Rework the ${w}`, w => `Ship the ${w}`];
const TASKS = [
  w => `Find every caller of the ${w}`, w => `Write tests for the ${w}`, w => `Review the ${w} diff`,
  w => `Profile the ${w}`, w => `Plan the ${w} change`, w => `Check the ${w} on a phone`, w => `Clean up the ${w}`,
];
const AGENT_TYPES = [['Explore', 'haiku'], ['general-purpose', 'opus'], ['general-purpose', 'sonnet'], ['Plan', 'opus'], ['code-reviewer', 'sonnet']];
const MODELS = [['claude-opus-5-5', 'high'], ['claude-sonnet-5-5', 'medium'], ['claude-opus-5-5', 'medium']];
const BRANCHES = ['main', 'fix', 'perf', 'tests', 'next'];

/** mulberry32: a small seeded generator, so a test can replay a run exactly. */
function generator(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createSim({ seed = Date.now(), now = Date.now() } = {}) {
  const rand = generator(seed);
  const between = (lo, hi) => lo + rand() * (hi - lo);
  const int = (lo, hi) => Math.floor(between(lo, hi + 1));
  const pick = list => list[Math.floor(rand() * list.length)];
  let serial = 0;
  const nextId = () => (++serial).toString(16).padStart(7, '0');

  const wings = PROJECTS.map(p => ({
    ...p,
    sessions: [],
    hot: [],
    hotUntil: 0,
    nextArrival: 0,
    phase: rand() * Math.PI * 2,
    period: between(150_000, 260_000),
  }));

  /** How many sessions the wing wants now: a slow swell, so people keep arriving and leaving. */
  const target = (w, t) => {
    const [lo, hi] = w.people;
    return Math.round(lo + (hi - lo) * (0.5 + 0.5 * Math.sin(w.phase + (2 * Math.PI * t) / w.period)));
  };
  const figures = w => w.sessions.reduce((n, s) => n + 1 + s.agents.filter(a => a.finishedAt === null).length, 0);

  /** Two hot areas at a time draw most of the work, so some pods fill up while others stay quiet. */
  function chooseArea(w, t) {
    if (t >= w.hotUntil) {
      const ids = w.areas.map(a => a[0]);
      w.hot = [pick(ids), pick(ids)];
      w.hotUntil = t + between(40_000, 80_000);
    }
    const r = rand();
    if (r < 0.38) return pick(w.hot);
    return pick(w.areas)[0];
  }
  const areaOf = (w, id) => w.areas.find(a => a[0] === id);

  function setTool(x, w, t, quietChance = 0) {
    const [, , , , file] = areaOf(w, x.area);
    if (rand() < quietChance) { x.tool = null; x.nextToolAt = t + between(3000, 7000); return; }
    const [name, hint] = pick([['Read', file], ['Edit', file], ['Grep', ''], ['Bash', 'npm test'], ['Bash', 'git diff'], ['Write', file], ['Glob', ''], ['Bash', 'npm run lint']]);
    x.tool = { name, hint, since: t };
    x.lastActivity = t;
    x.nextToolAt = t + between(2000, 6000);
  }

  function spawnAgent(w, s, t, startedAt = t) {
    if (figures(w) >= FIGURE_CAP) return;
    const area = rand() < 0.4 ? s.area : chooseArea(w, t);
    const [type, model] = pick(AGENT_TYPES);
    const a = {
      id: nextId(), type, model, area, depth: 1, workflow: null,
      description: pick(TASKS)(areaOf(w, area)[3]),
      startedAt, finishedAt: null, lastActivity: startedAt, tool: null, nextToolAt: 0,
      endAt: startedAt + between(9000, 34_000),
    };
    setTool(a, w, t, 0.15);
    s.agents.push(a);
  }

  function goBusy(s, w, t) {
    // Back from the lobby, often to a different pod: that walk is most of the floor's traffic.
    if (rand() < 0.45) {
      s.area = chooseArea(w, t);
      s.title = pick(TITLES)(areaOf(w, s.area)[3]);
    }
    s.status = 'busy';
    s.busySince = t;
    s.nextAt = t + between(15_000, 45_000);
    setTool(s, w, t);
    const crew = pick([0, 1, 1, 1, 2]);
    for (let i = 0; i < crew; i++) spawnAgent(w, s, t);
  }

  function goIdle(s, t) {
    s.status = 'idle';
    s.busySince = null;
    s.tool = null;
    s.nextAt = t + between(9000, 26_000);
  }

  function arrive(w, t, { startedAt = t, warm = false } = {}) {
    const area = chooseArea(w, t);
    const [model, effort] = pick(MODELS);
    const s = {
      id: nextId(), name: `${w.id}-${area}`, title: pick(TITLES)(areaOf(w, area)[3]),
      cwd: w.id, branch: pick(BRANCHES), status: 'idle', startedAt, busySince: null, lastActivity: startedAt,
      model, effort, cost: 0, tokens: { in: 0, out: 0, cacheRead: 0 }, tool: null, nextToolAt: 0, area,
      agents: [], nextAt: t, leaveAt: t + between(warm ? 30_000 : 120_000, 480_000),
    };
    if (warm) {
      // Mid-session already: some spend, and a few agents out at work.
      const age = (t - startedAt) / 1000;
      s.tokens = { in: Math.round(age * 400), out: Math.round(age * 120), cacheRead: Math.round(age * 9000) };
      s.lastActivity = t - int(3000, 90_000);   // quiet for a moment, not since it started
      s.cost = age * 0.01;
      if (rand() < 0.75) {
        goBusy(s, w, t);
        s.busySince = t - int(5_000, 60_000);
        s.nextAt = t + between(1500, 25_000);
        // Out for a while already, and due back at staggered moments: the first seconds move too.
        for (const a of s.agents) { a.startedAt = a.lastActivity = t - int(2000, 30_000); a.endAt = t + between(1500, 20_000); }
      } else {
        goIdle(s, t);
        s.nextAt = t + between(1000, 15_000);
      }
    }
    w.sessions.push(s);
    return s;
  }

  function tickWing(w, t) {
    // Arrivals and departures follow the swell.
    const want = target(w, t);
    if (w.sessions.length < want && t >= w.nextArrival && figures(w) < FIGURE_CAP) {
      arrive(w, t);
      w.nextArrival = t + between(2500, 8000);
    } else if (w.sessions.length - w.sessions.filter(s => s.leaveAt <= t).length > want) {
      // Over the swell: the longest-running session that is not already on its way out wraps up.
      const oldest = w.sessions.find(s => s.leaveAt > t);
      if (oldest) oldest.leaveAt = t;
    }

    for (const s of w.sessions) {
      if (t >= s.nextAt) {
        if (s.status === 'busy') {
          if (rand() < 0.05 && t < s.leaveAt) { s.status = 'stalled'; s.tool = null; s.nextAt = t + between(10_000, 22_000); }
          else goIdle(s, t);
        } else if (s.status === 'stalled') {
          goBusy(s, w, t);
        } else if (t < s.leaveAt) {
          goBusy(s, w, t);
        }
      }
      if (s.status === 'busy') {
        if (t >= s.nextToolAt) setTool(s, w, t);
        s.tokens.in += int(150, 900);
        s.tokens.out += int(40, 300);
        s.tokens.cacheRead += int(4000, 20_000);
        s.cost += between(0.004, 0.03);
        if (rand() < 0.03) spawnAgent(w, s, t);
      }
      for (const a of s.agents) {
        if (a.finishedAt !== null) continue;
        if (t >= a.endAt) { a.finishedAt = t; a.tool = null; a.lastActivity = t; continue; }
        if (t >= a.nextToolAt) setTool(a, w, t, 0.12);
      }
      s.agents = s.agents.filter(a => a.finishedAt === null || t - a.finishedAt < LINGER);
    }
    // A session leaves once its time is up, it is in the lobby and its agents are home.
    w.sessions = w.sessions.filter(s => !(t >= s.leaveAt && s.status === 'idle' && s.agents.every(a => a.finishedAt !== null)));
  }

  // Start mid-afternoon rather than on an empty floor, one short so the door opens at once.
  let clock = Math.floor(now / TICK) * TICK;
  for (const w of wings) {
    // A first visit opens on a busy floor: on the swell's upper half, rising or falling.
    const lift = Math.asin(between(0.2, 0.95));
    w.phase = (rand() < 0.5 ? lift : Math.PI - lift) - (2 * Math.PI * clock) / w.period;
    w.nextArrival = clock + between(500, 2500);
    const n = Math.max(4, target(w, clock) - 1);
    for (let i = 0; i < n; i++) arrive(w, clock, { startedAt: clock - int(120_000, 5_400_000), warm: true });
    // However the dice fell, the first view is a busy one: at least OPENING figures on the floor.
    for (let i = 0; i < 20 && figures(w) < OPENING; i++) {
      const s = pick(w.sessions);
      if (s.status === 'idle') goBusy(s, w, clock); else spawnAgent(w, s, clock);
    }
  }
  let version = 1;

  function step(t = Date.now()) {
    const until = Math.floor(t / TICK) * TICK;
    if (until <= clock) return;
    for (let at = Math.max(clock + TICK, until - CATCH_UP); at <= until; at += TICK) for (const w of wings) tickWing(w, at);
    clock = until;
    version++;
  }

  function snapshot(id, t = Date.now()) {
    step(t);
    const w = wings.find(x => x.id === id);
    if (!w) return null;
    return {
      v: 1, project: w.id, label: w.label, colour: w.colour, at: clock,
      areas: w.areas.map(([aid, label, tint]) => ({ id: aid, label, tint })),
      sessions: w.sessions.map(s => ({
        id: s.id, name: s.name, title: s.title, cwd: s.cwd, branch: s.branch, status: s.status,
        startedAt: s.startedAt, busySince: s.busySince, lastActivity: s.lastActivity,
        model: s.model, effort: s.effort, costUSD: Math.round(s.cost * 100) / 100, tokens: { ...s.tokens },
        tool: s.tool && { ...s.tool }, area: s.area, areaWhy: `${areaOf(w, s.area)[4]}, ${areaOf(w, s.area)[3]}`,
        agents: s.agents.map(a => ({
          id: a.id, type: a.type, description: a.description, model: a.model, startedAt: a.startedAt,
          finishedAt: a.finishedAt, lastActivity: a.lastActivity, tool: a.tool && { ...a.tool },
          area: a.area, depth: a.depth, workflow: a.workflow,
        })),
        workflows: [],
      })),
    };
  }

  function index(t = Date.now()) {
    step(t);
    const projects = wings.map(w => {
      const c = { busy: 0, idle: 0, stalled: 0, error: 0, agents: 0 };
      for (const s of w.sessions) { c[s.status]++; c.agents += s.agents.filter(a => a.finishedAt === null).length; }
      return { id: w.id, label: w.label, colour: w.colour, at: clock, counts: c };
    });
    return { v: 1, at: clock, projects: projects.sort((a, b) => a.id.localeCompare(b.id)) };
  }

  return { step, snapshot, index, version: () => version, projects: () => wings.map(w => w.id) };
}

/**
 * app.js's api() answered from a simulation: the same { status, data, etag, serverDate } it gets
 * from api.php, so the page has one code path. Sign-in is not offered here (app.js links to it).
 */
export function demoApi(sim) {
  return async (action, { project, etag } = {}) => {
    const serverDate = Date.now();
    if (action === 'whoami') return { status: 200, data: { authed: true, local: false, home: false }, etag: null, serverDate };
    if (action !== 'state') return { status: 404, data: { error: 'unknown action' }, etag: null, serverDate };
    if (!project) return { status: 200, data: sim.index(serverDate), etag: null, serverDate };
    const data = sim.snapshot(project, serverDate);
    if (!data) return { status: 404, data: { error: 'unknown project' }, etag: null, serverDate };
    const tag = `"demo-${sim.version()}"`;
    return tag === etag ? { status: 304, data: null, etag: tag, serverDate } : { status: 200, data, etag: tag, serverDate };
  };
}
