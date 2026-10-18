// The lab's pure logic: which figures a snapshot asks for, what each one is doing, and where the
// floor puts things. No three.js and no DOM here, so tests/site/model.test.mjs runs it in node.

export const MAX_FIGURES = 40;          // the performance budget (docs/PLAN.md step 4)
export const STALL_MS = 15 * 60_000;    // busy and silent this long = stalled (the collector's rule)
export const WAIT_MS = 2 * 60_000;      // an agent with no tool, or silent this long, is waiting

// Floor dimensions, in metres. A figure is 1.75 m.
// A cell is one pod, blender/podWorkspace/pod.glb, at 1:1: 5.6 wide, 4.2 deep, its floor raised.
export const CELL_W = 5.6;
export const CELL_D = 4.2;
export const POD_FLOOR = 0.16;          // the pod's tiled floor stands this high off the ground
export const AISLE = 1.6;
export const POD_ROW = 3;              // pods per row
// The pod's bench runs front to back along its left side (the owner, 2026-10-17); its workers stand
// on its right, facing it (yaw -π/2: three.js figures face +z at yaw 0).
export const BENCH_LEN = 2.15;
export const BENCH_D = 0.72;
export const BENCH_YAW = -Math.PI / 2;

// ── the pod ─────────────────────────────────────────────────────────────────────────────────────
// Pod-local metres, three.js axes: x right, z toward the camera (front), the pod's centre at 0.
// These mirror blender/podWorkspace/build_pod.py (Blender x = x, Blender y = -z): move a prop
// there and move its footprint here.
const FACE_BACK = Math.PI;              // facing the chalkboard (-z)
export const POD_PROPS = {
  bench: { minX: -2.74, maxX: -2.02, minZ: -0.3, maxZ: 1.85 },
  rack: { minX: -2.66, maxX: -2.1, minZ: -1.78, maxZ: -0.42 },
  board: { minX: -2.8, maxX: 2.8, minZ: -2.1, maxZ: -1.7 },      // frame, sign, board, lamp post
  chest: { minX: 0.63, maxX: 1.47, minZ: -1.67, maxZ: -1.09 },
  locker: { minX: 1.64, maxX: 2.26, minZ: -1.78, maxZ: -1.19 },
  plant: { minX: 2.22, maxX: 2.74, minZ: -1.1, maxZ: -0.6 },
};
// Where workers stand, in the order a pod fills: the first at the bench, then the chalkboard, the
// bins and the tool chest by the locker (the owner, 2026-10-17), then more of each. `clip` pins the
// work clip: hands high at the board and the bins, low at the chest; null alternates.
const STATIONS = [
  { x: -1.6, z: 0.6, yaw: BENCH_YAW, at: 'bench', clip: null },
  { x: -0.4, z: -1.2, yaw: FACE_BACK, at: 'board', clip: 'high' },
  { x: -1.62, z: -1.2, yaw: BENCH_YAW, at: 'bins', clip: 'high' },
  { x: 1.05, z: -0.62, yaw: FACE_BACK, at: 'chest', clip: 'low' },
  { x: -1.6, z: 1.2, yaw: BENCH_YAW, at: 'bench', clip: null },
  { x: 0.35, z: -1.2, yaw: FACE_BACK, at: 'board', clip: 'high' },
  { x: -1.62, z: -0.65, yaw: BENCH_YAW, at: 'bins', clip: 'high' },
  { x: -1.6, z: 0.05, yaw: BENCH_YAW, at: 'bench', clip: null },
  { x: -1.05, z: -1.25, yaw: FACE_BACK, at: 'board', clip: 'high' },
];
// ── the hallway ─────────────────────────────────────────────────────────────────────────────────
// blender/lobbyHallway/hallway.glb at 1:1: one row of pods long, centred on the grid, its back wall
// toward the pods. Hallway-local metres, three.js axes (x along it, z toward the camera, its centre
// at 0), measured from the GLB: move a prop there and move it here.
export const HALL_D = 4.0;
export const HALL_W = 20;
// The walkway between the pods and the hallway's back wall: one aisle wide. The wall that holds the
// doors is clear plexiglass in the lab (the owner, 2026-10-17), so it hides nothing behind it.
export const HALL_GAP = AISLE;
const HALL_LANE = -0.2;                   // the walking line, between the furniture and the plants
const HALL_DOOR_W = 1.5;                  // a door's clear opening
export const HALL_DOORS = [-3.6, 3.6];    // on the aisles between a row of three pods (CELL_W, AISLE)
const HALL_ENTRY = { z: 0.2, w: 1.5 };    // the entrance, in the end wall at -x
const HALL_WALL = { back: [-2.0, -1.8], end: [-10.0, -9.8] };
const HALL_PROPS = {
  cooler: { minX: -8.8, maxX: -6.96, minZ: -1.8, maxZ: -1.25 },      // water cooler, bin, a cactus
  table: { minX: -1.82, maxX: -0.77, minZ: -1.06, maxZ: -0.44 },
  sofa: { minX: -0.13, maxX: 1.63, minZ: -1.74, maxZ: -1.45 },       // its back: people sit on the seat
  desks: { minX: 4.62, maxX: 7.38, minZ: -1.75, maxZ: -1.13 },       // the stools in front are seats
  coats: { minX: 9.16, maxX: 9.54, minZ: -1.54, maxZ: -1.15 },
  plants: { minX: 7.5, maxX: 9.95, minZ: 0.05, maxZ: 1.95 },         // the cluster at the open end
};
// The lounge: where idle leads, and agents with no area, wait (the owner, 2026-10-17: the hallway's
// desks, sofa and water cooler, not a strip of grey desks). Seats first; then the things people stand
// at; then two rows of standing room along the front half, facing out. `lift` raises a sitter to the
// seat's height (the seated pose sits at 0.3 m); `yaw` 0 faces the camera, π the back wall.
const LOUNGE = [
  { x: 5.1, z: -0.69, yaw: Math.PI, seated: true, lift: 0.33, at: 'desk' },
  { x: 6.7, z: -0.69, yaw: Math.PI, seated: true, lift: 0.33, at: 'desk' },
  { x: 0.38, z: -1.22, yaw: 0, seated: true, lift: 0.18, at: 'sofa' },
  { x: 1.12, z: -1.22, yaw: 0, seated: true, lift: 0.18, at: 'sofa' },
  { x: -7.8, z: -0.85, yaw: Math.PI, seated: false, lift: 0, at: 'cooler' },
  { x: -1.3, z: -0.05, yaw: Math.PI, seated: false, lift: 0, at: 'table' },
  { x: -2.6, z: -1.35, yaw: Math.PI, seated: false, lift: 0, at: 'glass' },   // looking in at the pods
];
const STAND_XS = Array.from({ length: 19 }, (_, k) => -8.6 + k * 0.85), STAND_ZS = [0.85, 1.5];
export const LOUNGE_PLACES = LOUNGE.length + STAND_XS.length * STAND_ZS.length;

// A crowded pod: the rest stand on the open floor in rows, facing the board. Past those, places are shared.
const FLOOR_XS = [-0.95, -0.3, 0.35, 1.0, 1.65], FLOOR_ZS = [-0.35, 0.3, 0.95];
export const POD_PLACES = STATIONS.length + FLOOR_XS.length * FLOOR_ZS.length;
// Workers walk in along this lane, just inside the pod's front edge, from the right-hand aisle.
const LANE_Z = 1.65;

/** A session lead's pose: busy works at the area's bench, idle sits at the lobby desk. */
export function leadState(session) {
  switch (session.status) {
    case 'busy': return 'work';
    case 'stalled': return 'stalled';
    case 'error': return 'error';
    default: return 'wait';
  }
}

/** A running agent's pose, from its own timestamps and its session's status. */
export function agentState(agent, session, now) {
  if (agent.finishedAt !== null && agent.finishedAt !== undefined) return 'done';
  if (session.status === 'error') return 'error';
  const quiet = now - (agent.lastActivity || agent.startedAt || now);
  if (quiet > STALL_MS) return 'stalled';
  if (!agent.tool || quiet > WAIT_MS) return 'wait';
  return 'work';
}

/** The word the page shows for a state. Colour is never the only carrier. */
export const STATE_WORD = { work: 'busy', wait: 'idle', stalled: 'stalled', error: 'error', done: 'done', leave: 'leaving' };

export const leadKey = s => `s:${s.id}`;
export const agentKey = (s, a) => `a:${s.id}/${a.id}`;
export const groupKey = s => `g:${s.id}`;

const RANK = { busy: 0, stalled: 1, error: 2, idle: 3 };

/**
 * The figures a snapshot asks for. `known` is the set of keys already on the floor: an agent that
 * is already finished is spawned only if it is known (so it can play its leave), never fresh.
 * Past MAX_FIGURES, the agents of the busiest sessions collapse into one figure with a count.
 * Returns { specs, hiddenSessions } where each spec is
 * { key, kind: 'lead'|'agent'|'group', sessionId, agentId, agentIds, count, area, state }.
 */
/**
 * Where an agent works: its own area when the collector placed it in one of this wing's areas;
 * otherwise its session's area (an agent the classifier could not place still works for that
 * session); otherwise none ('lobby': it stands behind its lead's desk).
 */
export function agentArea(agent, session, areaIds) {
  if (areaIds.has(agent.area)) return agent.area;
  if (areaIds.has(session.area)) return session.area;
  return 'lobby';
}

export function figureSpecs(snapshot, known = new Set(), now = Date.now()) {
  const areaIds = new Set((snapshot?.areas || []).map(a => a.id));
  let sessions = Array.isArray(snapshot?.sessions) ? snapshot.sessions : [];
  let hiddenSessions = 0;
  if (sessions.length > MAX_FIGURES) {
    // Keep the most active sessions; the rest are counted, not drawn.
    sessions = [...sessions].sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9) || b.lastActivity - a.lastActivity);
    hiddenSessions = sessions.length - MAX_FIGURES;
    sessions = sessions.slice(0, MAX_FIGURES);
  }

  const leads = sessions.map(s => ({
    key: leadKey(s), kind: 'lead', sessionId: s.id, agentId: null, agentIds: null, count: 1,
    area: s.area, state: leadState(s),
  }));

  // Running agents per session, and the finished ones still on the floor.
  const running = new Map(), leaving = [];
  for (const s of sessions) {
    const list = [];
    for (const a of s.agents || []) {
      const key = agentKey(s, a);
      const state = agentState(a, s, now);
      if (state === 'done') {
        if (known.has(key)) leaving.push({ key, kind: 'agent', sessionId: s.id, agentId: a.id, agentIds: null, count: 1, area: agentArea(a, s, areaIds), state });
        continue;
      }
      list.push({ key, kind: 'agent', sessionId: s.id, agentId: a.id, agentIds: null, count: 1, area: agentArea(a, s, areaIds), state });
    }
    running.set(s.id, list);
  }

  // Collapse the largest crews first until the running figures fit the budget.
  const budget = MAX_FIGURES - leads.length;
  const collapsed = new Set();
  const total = () => [...running.entries()].reduce((n, [id, list]) => n + (collapsed.has(id) ? Math.min(1, list.length) : list.length), 0);
  while (total() > budget) {
    let pick = null, size = 1;
    for (const [id, list] of running) if (!collapsed.has(id) && list.length > size) { pick = id; size = list.length; }
    if (pick === null) break;
    collapsed.add(pick);
  }

  let agents = [];
  for (const s of sessions) {
    const list = running.get(s.id);
    if (!list.length) continue;
    if (!collapsed.has(s.id)) { agents.push(...list); continue; }
    agents.push({
      key: groupKey(s), kind: 'group', sessionId: s.id, agentId: null, agentIds: list.map(a => a.agentId),
      count: list.length, area: mostCommon(list.map(a => a.area)), state: groupState(list),
    });
  }
  // Still over (more than budget sessions with crews): the quietest crews are not drawn.
  if (agents.length > budget) agents = agents.slice(0, Math.max(0, budget));

  return { specs: [...leads, ...agents, ...leaving], hiddenSessions };
}

function mostCommon(list) {
  const n = new Map();
  for (const v of list) n.set(v, (n.get(v) || 0) + 1);
  let best = list[0], top = 0;
  for (const [v, c] of n) if (c > top) { best = v; top = c; }
  return best;
}

function groupState(list) {
  for (const s of ['work', 'wait', 'stalled', 'error']) if (list.some(a => a.state === s)) return s;
  return 'wait';
}

/** Counts for a project tab, from a snapshot (the index carries the same). */
export function countsOf(snapshot) {
  const c = { busy: 0, idle: 0, stalled: 0, error: 0, agents: 0 };
  for (const s of snapshot.sessions || []) {
    if (s.status in c) c[s.status]++;
    for (const a of s.agents || []) if (a.finishedAt === null) c.agents++;
  }
  return c;
}

/**
 * The floor plan: areas in rows of POD_ROW (a row fills before the next starts, the owner,
 * 2026-10-17), the rows running away from the camera (-z), the lobby
 * desk rows in front (+z), the door at the lobby's left. Positions are cell centres.
 */
export function floorPlan(areas) {
  const n = areas.length;
  const cols = Math.max(1, Math.min(POD_ROW, n));
  const rows = Math.max(1, Math.ceil(n / cols));
  const width = cols * CELL_W + (cols - 1) * AISLE;
  const cells = new Map();
  areas.forEach((a, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const x = -width / 2 + CELL_W / 2 + col * (CELL_W + AISLE);
    const z = -(row * (CELL_D + AISLE)) - CELL_D / 2;
    cells.set(a.id, { id: a.id, index: i, x, z, w: CELL_W, d: CELL_D, benchX: x + (POD_PROPS.bench.minX + POD_PROPS.bench.maxX) / 2, benchZ: z + (POD_PROPS.bench.minZ + POD_PROPS.bench.maxZ) / 2 });
  });
  const front = 0;                      // the grid's front edge
  const back = -(rows * CELL_D + (rows - 1) * AISLE);
  // In front of the grid: the walkway, then the hallway, which is also the lobby.
  const hall = { x: 0, z: front + HALL_GAP + HALL_D / 2, w: HALL_W, d: HALL_D };
  const corridorZ = hall.z + HALL_LANE;
  // The outer walls (blender/outerWalls): one aisle outside the pods on each side and behind the
  // last row, open at the hallway's front edge.
  const room = { xi: Math.max(width, HALL_W) / 2 + AISLE, back: back - AISLE, front: hall.z + HALL_D / 2 };
  // Figures come in from outside, through the outer entrance and the hallway's, in a straight line
  // along the corridor; they leave the same way.
  const door = { x: -room.xi - 0.9, z: corridorZ };
  return {
    cols, rows, cells, width, front, back, hall, corridorZ, room, door,
    bounds: { minX: door.x - 0.4, maxX: room.xi + 0.4, minZ: room.back - 0.4, maxZ: room.front + 0.6 },
  };
}

/** Where a bench stands, as a box on the floor. */
export function benchRect(cell) {
  return { minX: cell.benchX - BENCH_D / 2, maxX: cell.benchX + BENCH_D / 2, minZ: cell.benchZ - BENCH_LEN / 2, maxZ: cell.benchZ + BENCH_LEN / 2 };
}

/** Every prop's footprint in a pod, as boxes on the floor (world metres). */
export function podProps(cell) {
  return Object.fromEntries(Object.entries(POD_PROPS).map(([k, r]) =>
    [k, { minX: cell.x + r.minX, maxX: cell.x + r.maxX, minZ: cell.z + r.minZ, maxZ: cell.z + r.maxZ }]));
}

/** Where worker `i` works in a pod: { x, z, yaw, at, clip }. */
export function podSlot(cell, i) {
  if (i < STATIONS.length) {
    const s = STATIONS[i];
    return { x: cell.x + s.x, z: cell.z + s.z, yaw: s.yaw, at: s.at, clip: s.clip };
  }
  const j = (i - STATIONS.length) % (FLOOR_XS.length * FLOOR_ZS.length);
  return { x: cell.x + FLOOR_XS[j % FLOOR_XS.length], z: cell.z + FLOOR_ZS[Math.floor(j / FLOOR_XS.length)], yaw: FACE_BACK, at: 'floor', clip: null };
}

/** Lounge place `i` in the hallway (world): { x, z, yaw, seated, lift, at }. Past the last, places are shared. */
export function loungeSlot(plan, i) {
  const h = plan.hall;
  if (i < LOUNGE.length) { const p = LOUNGE[i]; return { ...p, x: h.x + p.x, z: h.z + p.z }; }
  const j = (i - LOUNGE.length) % (STAND_XS.length * STAND_ZS.length);
  return { x: h.x + STAND_XS[j % STAND_XS.length], z: h.z + STAND_ZS[Math.floor(j / STAND_XS.length)], yaw: 0, seated: false, lift: 0, at: 'hall' };
}

/** Stable slot numbers per group: a figure keeps its place while others come and go. */
export class SlotBook {
  constructor() { this.groups = new Map(); }
  take(group, key) {
    let m = this.groups.get(group);
    if (!m) this.groups.set(group, m = new Map());
    if (m.has(key)) return m.get(key);
    const used = new Set(m.values());
    let i = 0;
    while (used.has(i)) i++;
    m.set(key, i);
    return i;
  }
  free(key) {
    for (const m of this.groups.values()) m.delete(key);
  }
  clear() { this.groups.clear(); }
}

/** A small stable hash for per-figure variety (variant, phase). */
export function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** "45s", "12m 04s", "3h 12m", "2d 4h". */
export function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** 902114 → "902k", 88400222 → "88.4M". */
export function fmtCount(n) {
  if (!Number.isFinite(n)) return '–';
  if (n < 1000) return String(n);
  if (n < 1e6) return `${Math.round(n / 1000)}k`;
  return `${(n / 1e6).toFixed(n < 1e7 ? 2 : 1)}M`;
}

// ── walking routes ──────────────────────────────────────────────────────────────────────────────
// Figures walk the aisles, never across another area, a bench or a desk: out of where they are
// (an area's side, or the gap between lobby desks), along the front aisle between the grid and the
// lobby, up the aisle beside the area they want, in along the pod's front lane and back to their
// place. Every leg is straight along x or z.

/** The area a point stands in, or null. */
export function cellAt(plan, p) {
  for (const c of plan.cells.values()) {
    if (Math.abs(p.x - c.x) <= c.w / 2 && Math.abs(p.z - c.z) <= c.d / 2) return c;
  }
  return null;
}

/** x of every aisle running front to back: one each side of each column. */
export function aisleXs(plan) {
  const xs = [];
  for (let j = 0; j <= plan.cols; j++) xs.push(-plan.width / 2 - AISLE / 2 + j * (CELL_W + AISLE));
  return xs;
}

// The walk between areas and the lobby runs along the hallway's corridor (it used to be the aisle
// in front of the grid).
const frontAisle = plan => plan.corridorZ;

/** Whether a point stands inside the hallway (on its raised floor). */
export function inHall(plan, p) {
  const h = plan.hall;
  return Math.abs(p.x - h.x) <= h.w / 2 && Math.abs(p.z - h.z) <= h.d / 2;
}

/** The height of the floor under a point: a pod's and the hallway's are raised, the rest is ground. */
export function floorY(plan, p) {
  return cellAt(plan, p) || inHall(plan, p) ? POD_FLOOR : 0;
}

/**
 * The hallway's solid parts as boxes on the floor (world metres): its walls, split round the doors
 * and the entrance, and its furniture. Routes must not cross any of them.
 */
export function hallObstacles(plan) {
  const h = plan.hall, at = (minX, maxX, minZ, maxZ) => ({ minX: h.x + minX, maxX: h.x + maxX, minZ: h.z + minZ, maxZ: h.z + maxZ });
  const out = [];
  const [bz0, bz1] = HALL_WALL.back, [ex0, ex1] = HALL_WALL.end;
  let x = -HALL_W / 2;
  for (const d of HALL_DOORS) { out.push(at(x, d - HALL_DOOR_W / 2, bz0, bz1)); x = d + HALL_DOOR_W / 2; }
  out.push(at(x, HALL_W / 2, bz0, bz1));
  out.push(at(ex0, ex1, bz1, HALL_ENTRY.z - HALL_ENTRY.w / 2), at(ex0, ex1, HALL_ENTRY.z + HALL_ENTRY.w / 2, HALL_D / 2));
  for (const r of Object.values(HALL_PROPS)) out.push(at(r.minX, r.maxX, r.minZ, r.maxZ));
  return out;
}

/** Where the hallway's doors are (world): the two aisle doors, then the entrance. */
export function hallDoors(plan) {
  const h = plan.hall;
  return [
    ...HALL_DOORS.map(x => ({ x: h.x + x, z: h.z + (HALL_WALL.back[0] + HALL_WALL.back[1]) / 2 })),
    { x: h.x + (HALL_WALL.end[0] + HALL_WALL.end[1]) / 2, z: h.z + HALL_ENTRY.z },
  ];
}

/** The aisle a pod is entered and left by: its right one — the bench stands along its left side. */
function sideAisle(plan, cell) {
  return cell.x + cell.w / 2 + AISLE / 2;
}

/** From `p` to the corridor. */
function outTo(plan, p) {
  const zf = frontAisle(plan);
  const cell = cellAt(plan, p);
  if (cell) {
    // Out to the pod's front lane, along it to the right-hand aisle: never through a prop.
    const xa = sideAisle(plan, cell), zl = cell.z + LANE_Z;
    return [{ x: p.x, z: zl }, { x: xa, z: zl }, { x: xa, z: zf }];
  }
  if (p.z < plan.front) {
    // In an aisle inside the grid: along it to the nearest front-to-back aisle, then out.
    const xa = aisleXs(plan).reduce((best, x) => (Math.abs(x - p.x) < Math.abs(best - p.x) ? x : best));
    return [{ x: xa, z: p.z }, { x: xa, z: zf }];
  }
  return [{ x: p.x, z: zf }];
}

/**
 * Waypoints from `from` to `to` (both {x, z}) along the aisles, ending with `to`. Within one area
 * it is a straight step.
 */
export function routeBetween(plan, from, to) {
  const a = cellAt(plan, from), b = cellAt(plan, to);
  if (a && a === b) return [{ x: to.x, z: to.z }];
  const out = outTo(plan, from);
  const into = outTo(plan, to).reverse();
  const pts = [...out, ...into, { x: to.x, z: to.z }];
  // Drop repeats, then any point on a straight line between its neighbours.
  const same = (p, q) => Math.abs(p.x - q.x) < 1e-6 && Math.abs(p.z - q.z) < 1e-6;
  const route = [];
  for (const p of pts) if (!route.length || !same(route[route.length - 1], p)) route.push(p);
  if (route.length && same(route[0], from)) route.shift();
  for (let i = route.length - 2; i >= 0; i--) {
    const p = i === 0 ? from : route[i - 1], q = route[i], r = route[i + 1];
    if ((Math.abs(p.x - q.x) < 1e-6 && Math.abs(q.x - r.x) < 1e-6) || (Math.abs(p.z - q.z) < 1e-6 && Math.abs(q.z - r.z) < 1e-6)) route.splice(i, 1);
  }
  return route;
}

// ── animation loops ─────────────────────────────────────────────────────────────────────────────

/**
 * The largest jump, in degrees, between a looping clip's last and first rotation keyframes.
 * `tracks` are [{ values: Float32Array of xyzw quaternions }]. A clean loop is ~0°.
 */
export function loopSeamDegrees(tracks) {
  let worst = 0;
  for (const { values } of tracks) {
    const n = values.length / 4;
    if (n < 2) continue;
    let d = 0;
    for (let j = 0; j < 4; j++) d += values[j] * values[(n - 1) * 4 + j];
    worst = Math.max(worst, 2 * Math.acos(Math.min(1, Math.abs(d))) * 180 / Math.PI);
  }
  return worst;
}

/**
 * How a clip loops: a clip whose ends do not meet (seam over 3°) plays back and forth, so the figure
 * never snaps at the loop point — KimodoWorkHigh jumps 10.7° at its right hand every 1.33 s, which
 * reads as a twitch. Walks keep repeating: a walk played backwards moonwalks.
 */
export function loopFor(name, seamDeg) {
  if (/walk|jog|run/i.test(name)) return 'repeat';
  return seamDeg > 3 ? 'pingpong' : 'repeat';
}

// ── whiteboards ────────────────────────────────────────────────────────────────────────────────

/** What each area's board lists: busy and stalled sessions working there, and running agents in it. */
export function boardLines(snapshot) {
  const out = new Map();
  const areaIds = new Set((snapshot.areas || []).map(a => a.id));
  const add = (area, text) => { if (!out.has(area)) out.set(area, []); if (text && !out.get(area).includes(text)) out.get(area).push(text); };
  for (const s of snapshot.sessions || []) {
    if (s.status === 'busy' || s.status === 'stalled') add(s.area, s.title || s.name);
    for (const a of s.agents || []) if (a.finishedAt === null) add(agentArea(a, s, areaIds), a.description || a.type);
  }
  return out;
}

// ── the outer walls ─────────────────────────────────────────────────────────────────────────────
// blender/outerWalls/walls.glb is a kit of modules, each built along +x with its room side toward
// +z. This is build_walls.py's layout() (its README, "The layout rule"): where each module goes for
// a floor with any number of pod rows. `facing` is where a wall's room side looks; `length`
// stretches a run (WallRun, PipeRun), always post to post so its stretched ends stay hidden.
const DOOR_L = 2.44;                      // the outer entrance module, along the wall
const DOOR_HINGES = [0.47, 1.97];         // its leaves' hinges, in its frame: the opening between

/** Where the outer entrance's opening is: the left wall, in line with the hallway's entrance. */
export function roomDoor(plan) {
  const entry = plan.hall.z + HALL_ENTRY.z;
  return { x: -plan.room.xi, z: entry, z0: entry - DOOR_L / 2 + DOOR_HINGES[0], z1: entry - DOOR_L / 2 + DOOR_HINGES[1] };
}

/** Every module placement: [{ name, x, z, facing: 'back' | 'left' | 'right', length }]. */
export function wallLayout(plan) {
  const { xi, back, front } = plan.room;
  const rows = plan.rows, hallBack = plan.hall.z - HALL_D / 2;
  const entry = roomDoor(plan).z;
  const out = [];
  const put = (name, x, z, facing, length = null) => out.push({ name, x, z, facing, length });
  const sidePosts = [...new Set([...Array.from({ length: rows - 1 }, (_, k) => -((k + 1) * (CELL_D + AISLE) - AISLE / 2)), 0, hallBack, front])].sort((a, b) => a - b);
  const door0 = entry - DOOR_L / 2, door1 = entry + DOOR_L / 2;
  for (const [side, sx] of [['left', -xi], ['right', xi]]) {
    const stops = [back, ...sidePosts];
    for (let i = 0; i < stops.length - 1; i++) {
      const z0 = stops[i], z1 = stops[i + 1];
      if (side === 'left' && z0 <= door0 && door1 <= z1) {
        put('WallRun', sx, z0, side, door0 - z0);
        for (const m of ['WallDoor', 'ExitLight', 'DoorL', 'DoorR']) put(m, sx, door0, side);
        put('WallRun', sx, door1, side, z1 - door1);
      } else put('WallRun', sx, z0, side, z1 - z0);
    }
    for (const z of sidePosts) put('Post', sx, z, side);
    put('PipeRun', sx, back, side, AISLE / 2 - back);
    put('PipeDrop', sx, AISLE / 2, side);
    for (let k = 0; k < rows; k++) put('Sconce', sx, -(k * (CELL_D + AISLE)) - CELL_D / 2, side);
    put('Fan', sx, back + AISLE / 2, side);
    if (side === 'right') { put('Sconce', sx, entry, side); put('EBox', sx, hallBack + 0.7, side); }
  }
  const width = POD_ROW * CELL_W + (POD_ROW - 1) * AISLE;
  const aisles = Array.from({ length: POD_ROW - 1 }, (_, k) => -width / 2 + CELL_W + AISLE / 2 + k * (CELL_W + AISLE));
  const stops = [-xi, ...aisles, xi];
  for (let i = 0; i < stops.length - 1; i++) put('WallRun', stops[i], back, 'back', stops[i + 1] - stops[i]);
  put('PipeRun', -xi, back, 'back', 2 * xi);
  for (const x of aisles) put('Post', x, back, 'back');
  for (let k = 0; k < POD_ROW; k++) put('Sconce', -width / 2 + CELL_W / 2 + k * (CELL_W + AISLE), back, 'back');
  put('BackDuct', 0, back, 'back'); put('EBox', -1.9, back, 'back');
  put('Corner', -xi, back, 'back'); put('Corner', xi, back, 'right');
  put('PipeElbow', -xi, back, 'back'); put('PipeElbow', xi, back, 'right');
  return out;
}

/**
 * The outer walls as boxes on the floor (world metres), the entrance left open, padded by what
 * stands out at floor level (posts' feet, the pipe drops' flanges): walks keep clear of them.
 */
export function roomObstacles(plan) {
  const { xi, back, front } = plan.room, d = roomDoor(plan), pad = 0.4;
  return [
    { minX: -xi - 0.3, maxX: -xi + pad, minZ: back, maxZ: d.z0 },
    { minX: -xi - 0.3, maxX: -xi + pad, minZ: d.z1, maxZ: front },
    { minX: xi - pad, maxX: xi + 0.3, minZ: back, maxZ: front },
    { minX: -xi, maxX: xi, minZ: back - 0.3, maxZ: back + pad },
  ];
}
