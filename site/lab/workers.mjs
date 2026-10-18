// The lab's workers: one template per character GLB, a SkeletonUtils clone per figure, one
// AnimationMixer each. Figures are keyed by session / agent id, so a new snapshot moves the
// figures already on the floor instead of rebuilding them.
//
// Recolouring: every vertex colour in the mechanic exports is one of the builder's material
// colours, so a vertex's ROLE (jersey, trim, cap) is recovered from its colour once per template
// (the table is evracer/tools/bake-rigged-teams.mjs's) and stored as a `role` attribute on the
// shared geometry. Each figure's material swaps those roles for uniforms: the jersey becomes the
// lab coat, the cap takes the project colour, the trim the area's tint. Geometry stays shared;
// changing a figure's colours is three uniform writes.
import {
  AnimationMixer, BufferAttribute, Color, DoubleSide, LoopOnce, LoopPingPong, LoopRepeat, Mesh,
  MeshBasicMaterial, MeshLambertMaterial, RingGeometry, Vector3,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { MAX_FIGURES, SlotBook, floorY, podSlot, loungeSlot, hash, routeBetween, loopSeamDegrees, loopFor } from './model.mjs';

export const SCALE = 0.356;                 // the 4.91-unit mechanic at 1.75 m
const WALK_SPEED = 5 * SCALE;               // 5 mechanic units a second (docs/PLAN.md)
const TURN_RATE = 8;                        // how fast a figure swings round, per second
const CHEER_S = 2;
const COAT = '#FFFDF7';                     // the house lab-coat white (docs/PLAN.md "Characters")

// The builder's colours by role (bake-rigged-teams.mjs ROLES; identical for both variants here).
const ROLE_COLOURS = { 1: ['#224C82'], 2: ['#254C7B', '#32638E'], 3: ['#204574', '#2B5B89', '#234569'] };

// What each state plays, and what to use if an export ever lacks a clip.
const FALLBACK = { KimodoWorkHigh: 'Working', SitStand: 'Waiting', Frustrated: 'Waiting', Bored: 'Waiting', Cheering: 'Waiting', Working: 'Waiting' };

/** Fetch and prepare the character templates. */
export async function loadCharacters(urls) {
  const loader = new GLTFLoader();
  const loaded = await Promise.all(urls.map(u => loader.loadAsync(u)));
  return loaded.map(prepare);
}

function prepare(gltf) {
  let mesh = null;
  gltf.scene.traverse(o => { if (o.isSkinnedMesh && !mesh) mesh = o; });
  if (!mesh) throw new Error('character has no skinned mesh');
  const colour = mesh.geometry.attributes.color;
  const roles = new Float32Array(colour.count);
  const refs = [];
  for (const [id, hexes] of Object.entries(ROLE_COLOURS)) for (const h of hexes) refs.push([Number(id), new Color(h)]);
  const counts = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (let i = 0; i < colour.count; i++) {
    const r = colour.getX(i), g = colour.getY(i), b = colour.getZ(i);
    let best = 0, bestD = Infinity;
    for (const [id, c] of refs) {
      const d = (r - c.r) ** 2 + (g - c.g) ** 2 + (b - c.b) ** 2;
      if (d < bestD) { bestD = d; best = id; }
    }
    roles[i] = bestD < 1e-5 ? best : 0;
    counts[roles[i]]++;
  }
  mesh.geometry.setAttribute('role', new BufferAttribute(roles, 1));
  const clips = Object.fromEntries(gltf.animations.map(c => [c.name, c]));
  // Measured once: a clip whose ends do not meet loops back and forth instead of snapping.
  const loops = Object.fromEntries(gltf.animations.map(c => [c.name,
    loopFor(c.name, loopSeamDegrees(c.tracks.filter(t => t.ValueTypeName === 'quaternion')))]));
  return { scene: gltf.scene, clips, loops, roleCounts: { coat: counts[1], trim: counts[2], cap: counts[3], other: counts[0] } };
}

function figureMaterial() {
  const material = new MeshLambertMaterial({ vertexColors: true, side: DoubleSide });
  const uniforms = { uCoat: { value: new Color(COAT) }, uTrim: { value: new Color() }, uCap: { value: new Color() } };
  material.userData.uniforms = uniforms;
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float role;\nuniform vec3 uCoat;\nuniform vec3 uTrim;\nuniform vec3 uCap;')
      .replace('#include <color_vertex>', '#include <color_vertex>\n\tif ( role > 0.5 ) vColor.rgb = role < 1.5 ? uCoat : ( role < 2.5 ? uTrim : uCap );');
  };
  // Every figure material compiles to the same program.
  material.customProgramCacheKey = () => 'mhilo-figure-v1';
  return material;
}

const angleTo = (from, to) => {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};

class Figure {
  constructor(char, key) {
    this.key = key;
    this.char = char;
    this.root = clone(char.scene);
    this.root.scale.setScalar(SCALE);
    this.root.traverse(o => {
      if (o.isSkinnedMesh) { this.mesh = o; o.frustumCulled = false; }
    });
    this.material = figureMaterial();
    this.mesh.material = this.material;
    this.head = this.root.getObjectByName('head') || this.root;
    this.mixer = new AnimationMixer(this.root);
    this.actions = new Map();
    this.current = null;
    this.clipName = null;
    this.seed = hash(key);
    this.phase = (this.seed % 1000) / 1000;
    this.yaw = 0;
    this.faceYaw = 0;
    this.dest = new Vector3();
    this.route = [];              // waypoints before dest, {x, z}, along the aisles
    this.mode = 'settled';        // walk | settled | cheer | exit
    this.state = null;            // work | wait | stalled | error | done | leave
    this.seated = false;
    this.lift = 0;                // a seated figure's seat height above the floor's (a lounge seat)
    this.workTimer = 4 + (this.seed % 7);
    this.workAlt = false;
    this.workClip = null;         // 'high' | 'low' pins the work clip (a pod station); null alternates
    this.cheerTimer = 0;
    this.gone = false;
    this.spec = null;
    this.slotGroup = null;
  }

  colours(capColour, trimColour) {
    this.material.userData.uniforms.uCap.value.copy(capColour);
    this.material.userData.uniforms.uTrim.value.copy(trimColour);
  }

  play(name, { fade = 0.25, phase = this.phase, pause = false, once = false } = {}) {
    let clipName = name;
    while (!this.char.clips[clipName] && FALLBACK[clipName]) clipName = FALLBACK[clipName];
    const clip = this.char.clips[clipName];
    if (!clip) return;
    if (this.clipName === clipName && !once && !pause && this.current?.timeScale !== 0) return;
    let action = this.actions.get(clipName);
    if (!action) { action = this.mixer.clipAction(clip); this.actions.set(clipName, action); }
    action.reset();
    action.setLoop(once ? LoopOnce : this.char.loops?.[clipName] === 'pingpong' ? LoopPingPong : LoopRepeat, once ? 1 : Infinity);
    action.clampWhenFinished = once;
    action.time = pause ? 0 : phase * clip.duration;
    action.timeScale = pause ? 0 : 1;
    action.play();
    if (this.current && this.current !== action) {
      if (fade > 0) this.current.crossFadeTo(action, fade, false);
      else this.current.stop();
    }
    this.current = action;
    this.clipName = clipName;
  }

  /** Walk to `dest` by way of `route` (waypoints before it; routeBetween's last point is dest). */
  walkTo(dest, faceYaw = 0, clip = 'KimodoWalk', route = []) {
    this.dest.copy(dest);
    this.route = route.slice(0, -1);
    this.faceYaw = faceYaw;
    if (!this.route.length && this.root.position.distanceToSquared(dest) < 0.0025) { this.mode = 'settled'; this.pose(); return; }
    this.mode = 'walk';
    this.seated = false;
    this.play(clip);
  }

  place(dest, faceYaw = 0) {
    this.root.position.copy(dest);
    this.dest.copy(dest);
    this.route = [];
    this.yaw = this.faceYaw = faceYaw;
    this.root.rotation.y = faceYaw;
    this.mode = 'settled';
    this.pose(0);
  }

  /** The settled clip for the current state. */
  pose(fade = 0.25) {
    switch (this.state) {
      case 'work': this.play((this.workClip ?? (this.workAlt ? 'high' : 'low')) === 'high' ? 'KimodoWorkHigh' : 'Working', { fade }); break;
      case 'wait':
        if (this.seated) this.play('SitStand', { fade, pause: true });   // frame 0 of SitStand is seated
        else this.play('Waiting', { fade });
        break;
      case 'stalled': this.play('Frustrated', { fade }); break;
      case 'error': this.play('Bored', { fade }); break;
      default: this.play('Waiting', { fade });
    }
  }

  update(dt) {
    this.mixer.update(dt);
    const p = this.root.position;
    if (this.mode === 'walk' || this.mode === 'exit') {
      // Along the route's waypoints, then to dest; a step that passes a waypoint carries on.
      let step = WALK_SPEED * dt;
      while (step > 0) {
        const goal = this.route[0] || this.dest;
        const dx = goal.x - p.x, dz = goal.z - p.z;
        const dist = Math.hypot(dx, dz);
        if (dist > step) {
          p.x += dx / dist * step; p.z += dz / dist * step;
          this.targetYaw = Math.atan2(dx, dz);
          break;
        }
        p.x = goal.x; p.z = goal.z;
        step -= dist;
        if (this.route.length) { this.route.shift(); continue; }
        if (this.mode === 'exit') { this.gone = true; return; }
        this.mode = 'settled';
        this.pose();
        break;
      }
    } else if (this.mode === 'cheer') {
      this.cheerTimer -= dt;
      // KimodoWalk, not WalkingAway: that clip is authored facing away (its root turned 180°), so
      // a figure turned toward the door walked out backwards (tests/site/static.test.mjs).
      if (this.cheerTimer <= 0) { this.mode = 'exit'; this.play('KimodoWalk'); }
    } else if (this.state === 'work') {
      this.workTimer -= dt;
      if (this.workTimer <= 0) {
        this.workAlt = !this.workAlt;
        this.workTimer = 6 + ((this.seed >> 3) % 7);
        this.pose(0.4);
      }
    }
    const want = this.mode === 'walk' || this.mode === 'exit' ? (this.targetYaw ?? this.yaw) : this.faceYaw;
    this.yaw += angleTo(this.yaw, want) * Math.min(1, TURN_RATE * dt);
    this.root.rotation.y = this.yaw;
  }

  dispose() {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
    this.root.removeFromParent();
    this.material.dispose();
    // Geometry belongs to the shared template; the skeleton's bone texture (if any) is the clone's own.
    this.mesh.skeleton?.dispose();
  }
}

/** The pool of figures on the floor. */
export class Workers {
  constructor(parent, characters, colours) {
    this.parent = parent;
    this.chars = characters;
    this.c = colours;                       // { coat?, accent } as Colors
    this.figures = new Map();
    this.slots = new SlotBook();
    this.plan = null;
    this.capColour = new Color();
    this.tints = new Map();
    this.selected = null;
    this.ring = new Mesh(new RingGeometry(0.42, 0.52, 40), new MeshBasicMaterial({ color: colours.accent, transparent: true, opacity: 0.9, depthWrite: false }));
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.03;
    this.ring.visible = false;
    parent.add(this.ring);
    this._v = new Vector3();
  }

  get count() { return this.figures.size; }

  /** A new floor (a project switch or a change of areas): every figure goes. */
  setFloor(plan, areas, projectColour) {
    for (const f of this.figures.values()) f.dispose();
    this.figures.clear();
    this.slots.clear();
    this.plan = plan;
    this.capColour.set(projectColour);
    this.tints = new Map(areas.map(a => [a.id, new Color(a.tint)]));
  }

  /** Where a session's lead is now (an agent walks in from there), or the door. */
  leadOf(sessionId) {
    for (const f of this.figures.values()) if (f.spec?.kind === 'lead' && f.spec.sessionId === sessionId) return f.root.position.clone().setY(0);
    return new Vector3(this.plan.door.x, 0, this.plan.door.z);
  }

  /** Which set of places a spec's figure belongs to: an area's pod, or the hallway's lounge. */
  groupFor(spec) {
    if (spec.kind === 'lead' && !(spec.state === 'work' || spec.state === 'stalled')) return 'lounge';
    if (this.plan.cells.has(spec.area)) return `pod:${spec.area}`;
    return 'lounge';
  }

  /** Where a spec's figure belongs, and whether it sits there. */
  destination(spec) {
    const group = this.groupFor(spec);
    if (group === 'lounge') {
      // Idle leads sit where there is a seat; anyone else at a lounge place stands.
      const s = loungeSlot(this.plan, this.slots.take(group, spec.key));
      const seated = s.seated && spec.state === 'wait';
      return { pos: new Vector3(s.x, 0, s.z), group, seated, lift: seated ? s.lift : 0, yaw: s.yaw };
    }
    const s = podSlot(this.plan.cells.get(spec.area), this.slots.take(group, spec.key));
    return { pos: new Vector3(s.x, 0, s.z), group, seated: false, yaw: s.yaw, clip: s.clip };
  }

  /**
   * Bring the floor in line with a list of specs (model.figureSpecs). `instant` places figures
   * where they belong (first sight of a project); otherwise new ones walk in and changed ones walk over.
   */
  sync(specs, { instant = false } = {}) {
    const seen = new Set();
    for (const spec of specs) {
      seen.add(spec.key);
      let f = this.figures.get(spec.key);
      const fresh = !f;
      if (fresh) {
        if (spec.state === 'done') continue;   // never spawn a figure only to have it leave
        const variant = this.chars[hash(spec.key) % this.chars.length];
        f = new Figure(variant, spec.key);
        this.figures.set(spec.key, f);
        this.parent.add(f.root);
      }
      if (f.state === 'done' || f.state === 'leave') continue;   // already on its way out
      f.spec = spec;
      f.colours(this.capColour, this.tints.get(spec.area) || this.capColour);

      if (spec.state === 'done') { this.finish(f); continue; }

      const prevState = f.state;
      f.state = spec.state;
      if (f.slotGroup && f.slotGroup !== this.groupFor(spec)) this.slots.free(spec.key);
      const d = this.destination(spec);
      f.slotGroup = d.group;
      f.workClip = d.clip ?? null;
      f.lift = d.lift ?? 0;
      if (fresh && instant) {
        f.seated = d.seated;
        f.place(d.pos, d.yaw ?? 0);
      } else if (fresh) {
        // Walk in: a lead from the door, an agent from wherever its lead is.
        const from = spec.kind === 'lead' ? new Vector3(this.plan.door.x, 0, this.plan.door.z) : this.leadOf(spec.sessionId);
        f.root.position.copy(from);
        f.seated = d.seated;
        f.walkTo(d.pos, d.yaw ?? 0, 'KimodoWalk', routeBetween(this.plan, from, d.pos));
      } else if (f.dest.distanceToSquared(d.pos) > 0.0025) {
        f.seated = d.seated;
        f.walkTo(d.pos, d.yaw ?? 0, 'KimodoWalk', routeBetween(this.plan, f.root.position, d.pos));
      } else if (prevState !== f.state || f.seated !== d.seated) {
        f.seated = d.seated;
        if (f.mode === 'settled') f.pose();
      }
    }
    for (const [key, f] of this.figures) {
      if (seen.has(key) || f.state === 'done' || f.state === 'leave') continue;
      this.leave(f);
    }
    // The cap counts every figure on the floor, the ones walking out included: when new arrivals
    // would push past it, the longest-departing figures are fast-forwarded out (removed now).
    let excess = this.figures.size - MAX_FIGURES;
    if (excess > 0) {
      const going = [...this.figures.values()].filter(f => f.state === 'leave' || f.state === 'done')
        .sort((a, b) => (a.state === 'leave' ? 0 : 1) - (b.state === 'leave' ? 0 : 1));
      for (const f of going) {
        if (excess <= 0) break;
        f.dispose();
        this.figures.delete(f.key);
        if (this.selected === f.key) this.selected = null;
        excess--;
      }
    }
  }

  /** A finished agent: cheer for two seconds, then walk out of the door. */
  finish(f) {
    f.state = 'done';
    this.slots.free(f.key);
    f.mode = 'cheer';
    f.cheerTimer = CHEER_S;
    f.faceYaw = 0;
    f.play('Cheering', { phase: 0 });
    this.toDoor(f);
  }

  /** Gone from the snapshot without finishing (a session ended, a crew collapsed): walk out. */
  leave(f) {
    f.state = 'leave';
    this.slots.free(f.key);
    this.toDoor(f);
    f.mode = 'exit';
    f.play('KimodoWalk');
  }

  /** Out by the aisles to the door. */
  toDoor(f) {
    f.dest.set(this.plan.door.x, 0, this.plan.door.z);
    f.route = routeBetween(this.plan, f.root.position, this.plan.door).slice(0, -1);
  }

  select(key) {
    this.selected = key && this.figures.has(key) ? key : null;
  }

  update(dt) {
    for (const [key, f] of this.figures) {
      f.update(dt);
      // On a pod's or the hallway's raised floor, stand on it; in the aisles and the lobby, on the ground.
      const p = f.root.position;
      p.y = (this.plan ? floorY(this.plan, p) : 0) + (f.seated && f.mode === 'settled' ? f.lift : 0);
      if (f.gone) {
        f.dispose();
        this.figures.delete(key);
        if (this.selected === key) this.selected = null;
      }
    }
    const sel = this.selected && this.figures.get(this.selected);
    this.ring.visible = !!sel;
    if (sel) this.ring.position.set(sel.root.position.x, sel.root.position.y + 0.03, sel.root.position.z);
  }

  /** The figure nearest a screen point, within `radius` px (for tap / click picking). */
  pick(x, y, camera, width, height, radius = 44) {
    let best = null, bestD = radius * radius;
    for (const [key, f] of this.figures) {
      if (f.state === 'leave') continue;
      for (const h of [0.5, 1.2]) {
        this._v.copy(f.root.position); this._v.y = h;
        this._v.project(camera);
        if (this._v.z > 1) continue;
        const sx = (this._v.x + 1) / 2 * width, sy = (1 - this._v.y) / 2 * height;
        const d = (sx - x) ** 2 + (sy - y) ** 2;
        if (d < bestD) { bestD = d; best = key; }
      }
    }
    return best;
  }

  dispose() {
    for (const f of this.figures.values()) f.dispose();
    this.figures.clear();
    this.ring.geometry.dispose();
    this.ring.material.dispose();
    this.ring.removeFromParent();
  }
}
