// The lab floor: renderer, camera, the wing built from a snapshot's areas, and the render loop.
// The camera opens on the home view (straight on from the lobby) with a gentle drift. Drag pans, the wheel (or a pinch)
// zooms, and the gizmo (gizmo.mjs) — or a right/Shift drag on the floor — orbits freely or glides
// to a named view. No OrbitControls, no shadows, one directional and one hemisphere light plus each
// pod's lamp, pixel ratio capped at 2, 30 fps unless ?uncapped=1, and nothing renders while the
// page is hidden.
//
// Every area is one pod, assets/pod/pod.glb (built by blender/podWorkspace/build_pod.py): its name
// on the sign, its live work on the chalkboard, its tint on the sign's rim and the floor outline.
// The outline glows and the lamp shines only while someone is in the pod.
import {
  AdditiveBlending, Box3, CanvasTexture, Color, ConeGeometry,
  DirectionalLight, DoubleSide, Fog, Group, HemisphereLight, RepeatWrapping, Mesh, MeshBasicMaterial,
  Matrix4, MeshLambertMaterial, Object3D, PerspectiveCamera, PlaneGeometry, Raycaster, SRGBColorSpace, Scene,
  ShaderMaterial, SpotLight, TextureLoader, Vector2, Vector3, WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Workers, loadCharacters } from './workers.mjs';
import { Hud } from './hud.mjs';
import { Gizmo, VIEWS, POD_VIEW } from './gizmo.mjs';
import { figureSpecs, floorPlan, boardLines, cellAt, hallDoors, roomDoor, wallLayout, POD_FLOOR } from './model.mjs';

const FRAME_MS = 1000 / 30;
const REFRESH_MS = 5000;              // re-derive wait / stalled from the clock this often
const CHARACTERS = ['assets/characters/mechanic-male-lod1.glb', 'assets/characters/mechanic-female-lod1.glb'];
const POD = 'assets/pod/pod.glb';
const HALL = 'assets/hallway/hallway.glb';
const WALLS = 'assets/walls/walls.glb';
const SIGN_FONT = '"Barlow Condensed", system-ui, sans-serif';
const EL_MIN = 0.12, EL_MAX = 1.5;    // never under the floor, never exactly overhead
const FLIGHT_MS = 520;
const ease = t => 1 - Math.pow(1 - t, 3);
const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** A colour from design/tokens.css (hex or rgb[a]; alpha is dropped — the floor is opaque). */
export function token(name) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const m = raw.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  if (m) return new Color().setRGB(m[1] / 255, m[2] / 255, m[3] / 255, SRGBColorSpace);
  return new Color(raw || '#808080');
}
const mix = (a, b, t) => a.clone().lerp(b, t);

/** Waits for a webfont, but never longer than `ms`: signage falls back rather than blocks. */
export function fontReady(spec, ms = 1500) {
  if (!document.fonts?.load) return Promise.resolve(false);
  return Promise.race([
    document.fonts.load(spec).then(list => list.length > 0, () => false),
    new Promise(resolve => setTimeout(() => resolve(false), ms)),
  ]);
}

// ── the pod ─────────────────────────────────────────────────────────────────────────────────────

const LAMP_COLOUR = new Color(1.0, 0.72, 0.45);   // the street lamp's warm light (build_pod.py)
const LAMP_CANDELA = 32;
const LAMP_ANGLE = 0.46;                           // the cone's half-angle, radians
const LAMP_AIM = new Vector3(1.0, POD_FLOOR, -0.45); // where the lamp points, pod-local: over the floor by the chest

/**
 * The pod template: the GLB with its materials swapped for Lambert (the lab's lighting model, and
 * one shader program for every pod), plus where its sign, board, outline and lamp are, measured
 * from the model so a rebuild in Blender moves them too.
 */
/** Swap a loaded model's PBR materials for Lambert: the lab's lighting model, one shader program. */
function lambertize(root) {
  const swapped = new Map();
  root.traverse(o => {
    if (!o.isMesh) return;
    const m = o.material;
    if (!swapped.has(m)) {
      const l = new MeshLambertMaterial({ name: m.name, color: m.color, emissive: m.emissive, emissiveIntensity: m.emissiveIntensity ?? 1 });
      if (m.metalness > 0.5) l.color.multiplyScalar(0.85);
      swapped.set(m, l);
      m.dispose();
    }
    o.material = swapped.get(m);
  });
  return [...swapped.values()];
}

async function loadPod() {
  const gltf = await new GLTFLoader().loadAsync(POD);
  const root = gltf.scene;
  const materials = lambertize(root);
  root.updateMatrixWorld(true);
  const box = name => {
    const o = root.getObjectByName(name);
    if (!o) throw new Error(`pod.glb has no ${name}`);
    return new Box3().setFromObject(o);
  };
  const face = b => ({ x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: b.max.z + 0.004, w: b.max.x - b.min.x, h: b.max.y - b.min.y });
  const zone = box('ZoneOutline'), bulb = box('LampBulb');
  return {
    root,
    materials,
    sign: face(box('SignPanel')),
    board: face(box('Board')),
    zone: { minX: zone.min.x, maxX: zone.max.x, minZ: zone.min.z, maxZ: zone.max.z, y: zone.max.y },
    bulb: new Vector3((bulb.min.x + bulb.max.x) / 2, bulb.min.y - 0.01, (bulb.min.z + bulb.max.z) / 2),
  };
}

// ── the hallway ─────────────────────────────────────────────────────────────────────────────────

const DOOR_SWING = 1.35;                 // how far a leaf swings open, radians (about 77°)
const DOOR_REACH = 1.6;                  // a figure this close to a door opens it, metres

/**
 * The hallway template (blender/lobbyHallway/build_hallway.py), Lambert like the pod. Its door
 * leaves, each pivoting on its hinge: the aisle doors shut at yaw 0, the entrance (turned into the
 * end wall) at 90°. A right-hand leaf opens with +yaw, a left-hand one with -yaw, both into the hallway.
 */
async function loadHall() {
  const gltf = await new GLTFLoader().loadAsync(HALL);
  const root = gltf.scene;
  lambertize(root);
  const leaves = name => ['L', 'R'].map(side => ({ name: `Door${name}${side}`, closed: name === 'Entry' ? Math.PI / 2 : 0, sign: side === 'R' ? 1 : -1 }));
  // The wall that holds the doors is clear plexiglass, so the pods and their workers show through
  // it (the owner, 2026-10-17). The TV is off it for now.
  const glass = new MeshLambertMaterial({ color: 0xd8ecff, emissive: 0x16243a, transparent: true, opacity: 0.12, depthWrite: false, side: DoubleSide });
  root.getObjectByName('BackWall')?.traverse(o => { if (o.isMesh) { o.material = glass; o.renderOrder = 3; } });
  for (const name of ['TV', 'TVScreen']) { const o = root.getObjectByName(name); if (o) o.visible = false; }
  return { root, glass, doors: ['Aisle0', 'Aisle1', 'Entry'].map(leaves) };
}

// ── the outer walls ─────────────────────────────────────────────────────────────────────────────

/** The outer-wall kit (blender/outerWalls/build_walls.py): one template per module, by name. */
async function loadWalls() {
  const gltf = await new GLTFLoader().loadAsync(WALLS);
  lambertize(gltf.scene);
  const modules = new Map();
  for (const o of [...gltf.scene.children]) modules.set(o.name, o);
  return modules;
}

/**
 * A module's placement (build_walls.py's placement(), in three.js axes): at (x, z) on the ground,
 * a back-wall module as built, a side-wall one turned to run toward the camera (and mirrored on
 * the left, so its room side faces in), a run stretched along its length.
 */
const TURN = new Matrix4().makeRotationY(-Math.PI / 2), MIRROR = new Matrix4().makeScale(1, 1, -1);
function placeModule({ x, z, facing, length }) {
  const m = new Matrix4().makeTranslation(x, 0, z);
  if (facing !== 'back') m.multiply(TURN);
  if (facing === 'left') m.multiply(MIRROR);
  if (length) m.multiply(new Matrix4().makeScale(length, 1, 1));
  return m;
}

/** A soft round falloff, white to clear: the lamp's pool on the floor. */
function poolTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const t = new CanvasTexture(canvas);
  t.colorSpace = SRGBColorSpace;
  return t;
}

/** A soft white-to-clear stripe across a strip's width: the outline's glow on the floor. */
function haloTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 4; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 64);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.5, 'rgba(255,255,255,1)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 64);
  const t = new CanvasTexture(canvas);
  t.colorSpace = SRGBColorSpace;
  return t;
}

/** The four glow strips under a zone outline, as one geometry (pod-local). */
function haloGeometry(zone, width = 0.55) {
  const w = zone.maxX - zone.minX, d = zone.maxZ - zone.minZ, cx = (zone.minX + zone.maxX) / 2, cz = (zone.minZ + zone.maxZ) / 2;
  const strip = (len, x, z, along) => {
    const g = new PlaneGeometry(len + width, width);
    g.rotateX(-Math.PI / 2);
    if (along === 'z') g.rotateY(Math.PI / 2);
    g.translate(x, 0, z);
    return g;
  };
  const parts = [strip(w, cx, zone.minZ, 'x'), strip(w, cx, zone.maxZ, 'x'), strip(d, zone.minX, cz, 'z'), strip(d, zone.maxX, cz, 'z')];
  const merged = mergeGeometries(parts);
  for (const g of parts) g.dispose();
  return merged;
}

/**
 * The lamp's light in the air: an open cone from the bulb, brightest near the bulb and along the
 * line of sight through its middle, fading to nothing at the floor. Additive, so it only adds light.
 */
function beamMaterial() {
  return new ShaderMaterial({
    uniforms: { uColour: { value: LAMP_COLOUR.clone() }, uOpacity: { value: 0 } },
    vertexShader: `
      varying float vAlong; varying vec3 vNormal; varying vec3 vView;
      void main() {
        vAlong = uv.y;                       // 1 at the bulb, 0 at the floor
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vView = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uColour; uniform float uOpacity;
      varying float vAlong; varying vec3 vNormal; varying vec3 vView;
      void main() {
        float core = pow(abs(dot(normalize(vNormal), normalize(vView))), 1.6);
        float fade = pow(vAlong, 1.4) * smoothstep(1.0, 0.9, vAlong);
        gl_FragColor = vec4(uColour, core * fade * uOpacity);
      }`,
    transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide,
  });
}

/**
 * site/art/art.json, if the owner has generated art (site/art/README.md): a floor image under the
 * wing, a backdrop behind it, and sign images per area id. Anything missing stays procedural.
 */
/** A promise, or `fallback` after `ms`: a hung art file never holds the lab up (review 2026-10-17). */
const ART_MS = 3000;
const within = (promise, ms = ART_MS, fallback = null) =>
  Promise.race([promise, new Promise(resolve => setTimeout(() => resolve(fallback), ms))]);

async function loadArt() {
  let manifest = null;
  try {
    manifest = await within((async () => {
      const r = await fetch('art/art.json', { cache: 'no-cache' });
      return r.ok ? r.json() : null;
    })());
  } catch { /* no art: procedural */ }
  if (!manifest || typeof manifest !== 'object') return { signs: {}, boards: {} };
  const ok = p => typeof p === 'string' && /^art\/[\w.-]+\.(webp|png|jpe?g)$/.test(p);
  const loader = new TextureLoader();
  const load = async p => {
    if (!ok(p)) return null;
    try {
      const t = await within(loader.loadAsync(p));
      if (!t) { console.warn(`art.json: ${p} took too long; drawn instead`); return null; }
      t.colorSpace = SRGBColorSpace;
      return t;
    } catch {
      console.warn(`art.json: ${p} did not load`);
      return null;
    }
  };
  const signs = {}, boards = {};
  await Promise.all(Object.entries(manifest.signs || {}).map(async ([id, p]) => { const t = await load(p); if (t) signs[id] = t; }));
  // Whiteboards are drawn onto a canvas (art first, live titles over it), so they load as images.
  await Promise.all(Object.entries(manifest.boards || {}).map(async ([id, p]) => {
    if (!ok(p)) return;
    try {
      const img = await within(loadImage(p));
      if (img) boards[id] = img; else console.warn(`art.json: ${p} took too long; drawn instead`);
    } catch { console.warn(`art.json: ${p} did not load`); }
  }));
  const [floor, backdrop, floorTile] = await Promise.all([load(manifest.floor), load(manifest.backdrop), load(manifest.floorTile)]);
  // A floor tile repeats (three.js clamps to the edge by default, which smears the edge pixels).
  if (floorTile) floorTile.wrapS = floorTile.wrapT = RepeatWrapping;
  const size = Number(manifest.floorTileSize);
  const tileSize = size >= 0.5 && size <= 50 ? size : 4;
  return { floor, backdrop, signs, boards, floorTile, tileSize };
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// ── the floor ───────────────────────────────────────────────────────────────────────────────────

/**
 * The procedural floor tile for areas and the lobby: 2 x 2 tiles with seams and a fine speckle,
 * drawn in light greys so the material's colour tints it (the floor stays token-coloured). One
 * canvas covers TILE x TILE world units.
 */
const TILE = 2;
function floorTileTexture() {
  const n = 256, canvas = document.createElement('canvas');
  canvas.width = canvas.height = n;
  const ctx = canvas.getContext('2d');
  const tones = [236, 228, 231, 240];
  for (let i = 0; i < 4; i++) {
    const v = tones[i];
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.fillRect((i % 2) * n / 2, Math.floor(i / 2) * n / 2, n / 2, n / 2);
  }
  // A fixed speckle (seeded), so every load looks the same.
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 1400; i++) {
    const v = 200 + Math.floor(rnd() * 50);
    ctx.fillStyle = `rgba(${v},${v},${v},0.5)`;
    ctx.fillRect(rnd() * n, rnd() * n, 1.5, 1.5);
  }
  ctx.fillStyle = 'rgb(150,150,150)';
  for (const at of [0, n / 2]) { ctx.fillRect(at, 0, 2, n); ctx.fillRect(0, at, n, 2); }
  const t = new CanvasTexture(canvas);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = t.wrapT = RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

// ── whiteboards ─────────────────────────────────────────────────────────────────────────────────

const BOARD_H = 512;                   // the width follows the pod's board (about 2.4 : 1)
const BOARD_FONT = 'Barlow, system-ui, sans-serif';
const COUNT_FONT = '"Barlow Condensed", system-ui, sans-serif';
const BOARD_LINES = 4;                 // titles on a board, the last one "+N more" when there are more

/**
 * One area's chalkboard: the owner's art if there is any (art.json "boards"), else a drawn board;
 * over its left part, in chalk, what the area is working on right now.
 */
function drawBoard(canvas, art, lines, c) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height, hex = col => `#${col.getHexString()}`;
  const ink = c.ink.getHexString();       // sRGB, as the token is written
  const chalk = a => `rgba(${parseInt(ink.slice(0, 2), 16)},${parseInt(ink.slice(2, 4), 16)},${parseInt(ink.slice(4, 6), 16)},${a})`;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = hex(c.board);
  ctx.fillRect(0, 0, w, h);
  if (art) ctx.drawImage(art, 0, 0, w, h);
  else drawSketch(ctx, w, h, chalk);
  // Over art, the list keeps to the left 45%; on a drawn board, clear of the sketch on the right.
  const listW = Math.round(w * (art ? 0.45 : 0.6));
  if (art && lines.length) {
    ctx.fillStyle = hex(c.board);
    ctx.globalAlpha = 0.86;
    ctx.fillRect(0, 0, listW, h);
    ctx.globalAlpha = 1;
  }
  ctx.save();
  ctx.translate(36, 52);
  ctx.rotate(-0.012);
  ctx.textBaseline = 'alphabetic';
  if (!lines.length) {
    ctx.fillStyle = chalk(0.5);
    ctx.font = `800 64px ${COUNT_FONT}`;
    if (!art) ctx.fillText('QUIET RIGHT NOW', 0, 60);
  } else {
    // The count is what reads from across the floor; the titles, when zoomed in.
    ctx.fillStyle = chalk(0.95);
    ctx.font = `800 104px ${COUNT_FONT}`;
    ctx.fillText(`${lines.length} WORKING`, 0, 92);
    let y = 182;
    const shown = lines.length > BOARD_LINES ? BOARD_LINES - 1 : lines.length;
    ctx.font = `600 46px ${BOARD_FONT}`;
    for (const line of lines.slice(0, shown)) {
      ctx.fillStyle = hex(c.accent);
      ctx.beginPath(); ctx.arc(10, y - 16, 8, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = chalk(0.92);
      ctx.fillText(fit(ctx, line, listW - 80), 32, y);
      y += 74;
    }
    if (shown < lines.length) {
      ctx.fillStyle = chalk(0.6);
      ctx.fillText(`+${lines.length - shown} more`, 32, y);
    }
    ctx.restore();
    return { count: lines.length, shown, more: lines.length - shown };
  }
  ctx.restore();
  return { count: 0, shown: 0, more: 0 };
}

/**
 * The pod's chalk-talk on the right of a drawn board (the same diagram as build_pod.py's render):
 * a box becomes a frame, an open box becomes a list, arrows between. Kept clear of the corners.
 */
function drawSketch(ctx, w, h, chalk) {
  const x0 = w * 0.62, sw = w * 0.35, U = u => x0 + u * sw, V = v => h * (0.08 + v * 0.8);
  ctx.save();
  ctx.strokeStyle = chalk(0.42);
  ctx.lineWidth = 4;
  ctx.lineCap = ctx.lineJoin = 'round';
  const line = (...pts) => { ctx.beginPath(); ctx.moveTo(U(pts[0]), V(pts[1])); for (let i = 2; i < pts.length; i += 2) ctx.lineTo(U(pts[i]), V(pts[i + 1])); ctx.stroke(); };
  const arrow = (u0, v0, u1, v1) => {
    line(u0, v0, u1, v1);
    const a = Math.atan2(V(v1) - V(v0), U(u1) - U(u0));
    for (const t of [a + 2.6, a - 2.6]) { ctx.beginPath(); ctx.moveTo(U(u1), V(v1)); ctx.lineTo(U(u1) + Math.cos(t) * 16, V(v1) + Math.sin(t) * 16); ctx.stroke(); }
  };
  const cube = (u, v, s, open = false) => {
    const dx = s, dy = s * 0.36 * sw / h;
    ctx.beginPath(); ctx.moveTo(U(u), V(v)); ctx.lineTo(U(u + dx), V(v - dy)); ctx.lineTo(U(u + 2 * dx), V(v)); ctx.lineTo(U(u + dx), V(v + dy)); ctx.closePath(); ctx.stroke();
    line(u, v, u, v + 0.2, u + dx, v + 0.2 + dy, u + 2 * dx, v + 0.2, u + 2 * dx, v);
    line(u + dx, v + dy, u + dx, v + 0.2 + dy);
    if (open) { line(u, v, u - 0.04, v - 0.1); line(u + 2 * dx, v, u + 2 * dx + 0.04, v - 0.1); }
  };
  cube(0.02, 0.12, 0.09);
  arrow(0.26, 0.2, 0.4, 0.2);
  ctx.strokeRect(U(0.46), V(0.02), U(0.86) - U(0.46), V(0.42) - V(0.02));
  arrow(0.58, 0.36, 0.72, 0.12);
  ctx.beginPath(); ctx.moveTo(U(0.1), V(0.42)); ctx.quadraticCurveTo(U(0.08), V(0.6), U(0.2), V(0.62)); ctx.stroke();
  cube(0.12, 0.72, 0.08, true);
  arrow(0.36, 0.84, 0.48, 0.84);
  ctx.strokeRect(U(0.52), V(0.62), U(0.92) - U(0.52), V(1.0) - V(0.62));
  line(0.58, 0.74, 0.82, 0.74);
  line(0.58, 0.86, 0.74, 0.86);
  ctx.restore();
}

function fit(ctx, text, max) {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

// ── signage ─────────────────────────────────────────────────────────────────────────────────────

/** A sign's face. `rule` draws the tint stripe and underline; a pod's sign has a tinted rim instead. */
function drawSign(canvas, text, c, tint, rule = true) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.fillStyle = `#${c.signBg.getHexString()}`;
  ctx.fillRect(0, 0, w, h);
  if (rule) {
    ctx.fillStyle = `#${tint.getHexString()}`;
    ctx.fillRect(0, 0, 22, h);
    ctx.fillRect(22, h - 8, w - 22, 8);
  }
  ctx.fillStyle = `#${c.ink.getHexString()}`;
  ctx.textBaseline = 'middle';
  let size = Math.round(h * (rule ? 0.54 : 0.7));
  const label = text.toUpperCase();
  do {
    ctx.font = `800 ${size}px ${SIGN_FONT}`;
    if (ctx.measureText(label).width <= w - 90) break;
    size -= 4;
  } while (size > 40);
  ctx.fillText(label, rule ? 56 : 40, h / 2 + 2);
}

/** A sign plate `width` wide; `height` defaults to the 16:3 sign shape. */
function sign(text, tint, c, width = 3.6, height = width * 192 / 1024, rule = true) {
  const canvas = document.createElement('canvas');
  canvas.width = rule ? 1024 : 2048;
  canvas.height = Math.round(canvas.width * height / width);
  drawSign(canvas, text, c, tint, rule);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  const mesh = new Mesh(new PlaneGeometry(width, height), new MeshBasicMaterial({ map: texture }));
  // The same face on the back, so a sign reads from behind once the camera orbits round.
  const back = new Mesh(mesh.geometry, mesh.material);
  back.rotation.y = Math.PI;
  mesh.add(back);
  mesh.userData.redraw = () => { drawSign(canvas, text, c, tint, rule); texture.needsUpdate = true; };
  return mesh;
}

// ── the lab ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Build the lab inside `host`. `state` is the object exposed as window.lab (ready, figures, ...).
 * Returns { setSnapshot, select, refit, start, stop }.
 */
export async function createLab({ host, hudHost, state, onSelect, uncapped = false }) {
  const c = {
    ground: token('--brand-ground'), ink: token('--brand-ink'), muted: token('--brand-muted'),
    dim: token('--brand-dim'), accent: token('--brand-accent'), electric: token('--brand-electric'),
    surface: token('--brand-surface'),
  };
  c.top = mix(c.dim, c.muted, 0.55);
  c.frame = mix(c.ground, c.dim, 0.7);
  c.dark = mix(c.ground, c.surface, 0.6);
  c.screen = mix(c.electric, c.ground, 0.35);
  c.crate = mix(c.accent, c.ground, 0.25);
  c.floor = mix(c.ground, c.surface, 0.9);
  c.plate = mix(c.floor, c.dim, 0.18);
  c.signBg = mix(c.surface, c.ground, 0.2);
  c.board = token('--brand-board');    // the chalkboards; chalk is c.ink
  c.hot = c.accent;                    // a hovered area's floor outline (the owner, 2026-10-17: tomato)

  const renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = false;
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.domElement.className = 'lab-canvas';
  host.prepend(renderer.domElement);
  const gl = renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  state.renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);

  const scene = new Scene();
  scene.background = c.ground.clone();
  scene.fog = new Fog(c.ground.clone(), 45, 110);
  scene.add(new HemisphereLight(c.ink, c.ground, 1.5));
  const sun = new DirectionalLight(c.ink, 1.7);
  sun.position.set(-8, 16, 11);
  scene.add(sun);

  const camera = new PerspectiveCamera(34, 1, 0.3, 220);

  const [characters, art, pod, hallway, walls] = await Promise.all([loadCharacters(CHARACTERS), loadArt(), loadPod(), loadHall(), loadWalls()]);
  if (art.backdrop) scene.background = art.backdrop;
  state.roleCounts = characters.map(ch => ch.roleCounts);
  state.loops = characters.map(ch => ch.loops);
  const workers = new Workers(scene, characters, { accent: c.accent });
  const hud = new Hud(hudHost, (key, keyboard) => select(key, true, keyboard));
  const gizmo = new Gizmo(host, {
    x: cssVar('--brand-accent'), y: cssVar('--brand-electric'), z: cssVar('--brand-success'),
    disc: cssVar('--brand-surface'), hair: cssVar('--brand-hair'), ink: cssVar('--brand-ground'),
  }, name => setView(name), (dx, dy) => orbit(dx, dy));
  // Read live, not per frame: a test reading it right after an input sees that input.
  Object.defineProperty(state, 'camera', { configurable: true, get: () => ({ az: rig.az, el: rig.el, x: rig.target.x, z: rig.target.z }) });
  Object.defineProperty(state, 'zoom', { configurable: true, get: () => rig.zoom });
  const halo = haloTexture();
  const poolMap = poolTexture();

  // Signage waits for Barlow Condensed for at most 1.5 s, then redraws if it arrives later.
  const fontSpec = `800 80px ${SIGN_FONT}`;
  await fontReady(fontSpec);
  let signs = [];
  const boards = new Map();            // area id → { canvas, tex, art, key, lines }
  const pods = new Map();              // area id → { occupied, level, set(level) }
  let doors = [];                      // the hallway's doors: { x, z, open, leaves: [{ obj, closed, sign }] }
  const floorTile = floorTileTexture();
  document.fonts?.addEventListener?.('loadingdone', () => {
    if (document.fonts.check(fontSpec)) for (const s of signs) s.userData.redraw();
    for (const b of boards.values()) { drawBoard(b.canvas, b.art, b.lines, c); b.tex.needsUpdate = true; }
  });

  // The wing: rebuilt when the project or its areas change.
  let floor = null, floorKey = '', plan = null;
  const disposables = [];
  const track = (...xs) => { disposables.push(...xs); return xs[0]; };

  function buildFloor(snapshot) {
    if (floor) {
      scene.remove(floor);
      for (const d of disposables.splice(0)) d.dispose();
    }
    floor = new Group();
    signs = [];
    const areas = snapshot.areas || [];
    plan = floorPlan(areas, snapshot.sessions?.length || 0);
    const b = plan.bounds;
    const w = b.maxX - b.minX + 30, d = b.maxZ - b.minZ + 30;
    // The ground round and between the areas: plain and dark; the areas and the lobby get a floor.
    const ground = new Mesh(track(new PlaneGeometry(w, d)), track(new MeshLambertMaterial({ color: c.floor })));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set((b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2);
    floor.add(ground);
    state.floor = { grid: false, tileArt: !!art.floorTile };
    const tileMap = (sw, sd) => {
      const t = (art.floorTile || floorTile).clone();
      const size = art.floorTile ? art.tileSize : TILE;
      t.wrapS = t.wrapT = RepeatWrapping;
      t.repeat.set(sw / size, sd / size);
      t.needsUpdate = true;
      return track(t);
    };

    if (art.floor) {
      // The owner's floor image, stretched over the wing (areas and lobby), under everything else.
      const art0 = new Mesh(track(new PlaneGeometry(b.maxX - b.minX, b.maxZ - b.minZ)), track(new MeshBasicMaterial({ map: art.floor })));
      art0.rotation.x = -Math.PI / 2;
      art0.position.set((b.minX + b.maxX) / 2, 0.006, (b.minZ + b.maxZ) / 2);
      floor.add(art0);
    }

    // The owner's floor tile, if any, lies over each pod's own tiles (which then hide).
    const cell0 = plan.cells.values().next().value;
    const plateGeo = track(new PlaneGeometry(cell0?.w || 1, cell0?.d || 1));
    const plateMat = art.floorTile ? track(new MeshBasicMaterial({ map: tileMap(cell0?.w || 1, cell0?.d || 1) })) : null;
    const haloGeo = track(haloGeometry(pod.zone));
    const beamH = pod.bulb.distanceTo(LAMP_AIM);
    const beamGeo = track(new ConeGeometry(beamH * Math.tan(LAMP_ANGLE), beamH, 40, 1, true).translate(0, -beamH / 2, 0));
    const beamTurn = new Vector3().subVectors(LAMP_AIM, pod.bulb).normalize();
    const boardGeo = track(new PlaneGeometry(pod.board.w, pod.board.h));
    const poolR = beamH * Math.tan(LAMP_ANGLE) * 1.25;
    const poolGeo = track(new PlaneGeometry(poolR * 2, poolR * 2).rotateX(-Math.PI / 2));
    boards.clear();
    pods.clear();
    for (const a of areas) {
      const cell = plan.cells.get(a.id);
      const tint = new Color(a.tint);
      const root = pod.root.clone(true);
      root.position.set(cell.x, 0, cell.z);
      floor.add(root);
      if (plateMat) {
        root.getObjectByName('Floor').visible = false;
        const plate = new Mesh(plateGeo, plateMat);
        plate.rotation.x = -Math.PI / 2;
        plate.position.set(cell.x, POD_FLOOR + 0.004, cell.z);
        floor.add(plate);
      }

      // The area's tint: the sign's rim, and the outline on the floor with its glow.
      const rim = root.getObjectByName('SignRim');
      rim.material = track(new MeshLambertMaterial({ color: tint, emissive: tint, emissiveIntensity: 0.35 }));
      const outline = root.getObjectByName('ZoneOutline');
      const outlineMat = track(new MeshBasicMaterial({ color: mix(tint, c.ink, 0.35), transparent: true, opacity: 0 }));
      // A node with several primitives loads as a Group of meshes: give every one of them the material.
      outline.traverse(o => { if (o.isMesh) { o.material = outlineMat; o.renderOrder = 2; } });
      const glowMat = track(new MeshBasicMaterial({ map: halo, color: tint, transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false }));
      const glow = new Mesh(haloGeo, glowMat);
      glow.position.y = pod.zone.y + 0.002;
      // The glow first, the line over it: added light on top would wash the line out to white.
      glow.renderOrder = 1;
      root.add(glow);

      // The lamp: a soft spotlight and its beam in the air, both off while the pod is empty.
      const bulb = root.getObjectByName('LampBulb');
      const bulbMat = track(bulb.material.clone());
      bulb.material = bulbMat;
      const lit = bulbMat.emissive.clone();
      const spot = new SpotLight(LAMP_COLOUR, 0, 7, LAMP_ANGLE, 1, 1.6);
      spot.position.copy(pod.bulb);
      const aim = new Object3D();
      aim.position.copy(LAMP_AIM);
      spot.target = aim;
      root.add(spot, aim);
      const beamMat = track(beamMaterial());
      const beam = new Mesh(beamGeo, beamMat);
      beam.position.copy(pod.bulb);
      beam.quaternion.setFromUnitVectors(new Vector3(0, -1, 0), beamTurn);
      beam.renderOrder = 2;
      // Where the beam lands: a warm pool on the floor, so the light reads even on a dim screen.
      const poolMat = track(new MeshBasicMaterial({ map: poolMap, color: LAMP_COLOUR, transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false }));
      const pool = new Mesh(poolGeo, poolMat);
      pool.position.set(LAMP_AIM.x, pod.zone.y + 0.004, LAMP_AIM.z);
      root.add(beam, pool);

      // `level` follows whether anyone is in the pod (outline and lamp); `hot` follows the pointer
      // (the outline alone, in the highlight colour, even in an empty pod).
      const line = mix(tint, c.ink, 0.35), hotLine = mix(c.hot, c.ink, 0.12);
      const state = {
        occupied: false, hover: false, level: 0, hot: 0,
        apply() {
          const k = state.level, h = state.hot, show = Math.max(k, h);
          outline.visible = glow.visible = show > 0.01;
          outlineMat.color.lerpColors(line, hotLine, h);
          outlineMat.opacity = show;
          glowMat.color.lerpColors(tint, c.hot, h);
          glowMat.opacity = 0.5 * show + 0.2 * h;
          beam.visible = pool.visible = k > 0.01;
          beamMat.uniforms.uOpacity.value = 0.55 * k;
          poolMat.opacity = 0.3 * k;
          spot.intensity = LAMP_CANDELA * k;
          bulbMat.emissive.copy(lit).multiplyScalar(0.08 + 0.92 * k);
        },
      };
      state.apply();
      pods.set(a.id, state);

      const s = sign(a.label, tint, c, pod.sign.w, pod.sign.h, false);
      track(s.geometry, s.material, s.material.map);
      if (art.signs[a.id]) {
        // The owner's sign image for this area replaces the drawn one, at its own 16:3 shape.
        s.material.map = art.signs[a.id];
        s.geometry = track(new PlaneGeometry(pod.sign.h * 1024 / 192, pod.sign.h));
        s.userData.redraw = () => {};
      }
      s.position.set(pod.sign.x, pod.sign.y, pod.sign.z);
      root.add(s);
      signs.push(s);

      // The chalkboard's face: what the area is working on, drawn live.
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(BOARD_H * pod.board.w / pod.board.h); canvas.height = BOARD_H;
      const tex = track(new CanvasTexture(canvas));
      tex.colorSpace = SRGBColorSpace;
      tex.anisotropy = 4;
      const face = new Mesh(boardGeo, track(new MeshBasicMaterial({ map: tex })));
      face.position.set(pod.board.x, pod.board.y, pod.board.z);
      root.add(face);
      const board = { id: a.id, canvas, tex, art: art.boards[a.id] || null, key: null, lines: [] };
      boards.set(a.id, board);
      drawBoard(canvas, board.art, [], c);
      tex.needsUpdate = true;
    }

    gizmo.setAreas(areas.map(a => ({ id: a.id, label: a.label })), id => focusArea(id));

    // The hallway, in front of the walkway before the grid; it is also the lobby. Its doors stand
    // on the aisles the front pods are entered by; each door's light takes that pod's tint.
    const hall = hallway.root.clone(true);
    hall.position.set(plan.hall.x, 0, plan.hall.z);
    floor.add(hall);
    hall.updateMatrixWorld(true);
    doors = hallDoors(plan).map((at, i) => ({
      ...at, open: 0,
      leaves: hallway.doors[i].map(l => ({ ...l, obj: hall.getObjectByName(l.name) })).filter(l => l.obj),
    }));
    for (const d of doors) for (const l of d.leaves) l.obj.rotation.set(0, l.closed, 0);

    // The outer walls round the pods and the hallway, laid out for this many rows. Each placement
    // is a frame; the module's own node (a door leaf on its hinge) sits in it, sharing the kit's mesh.
    const outerLeaves = [];
    for (const p of wallLayout(plan)) {
      const src = walls.get(p.name);
      if (!src) continue;
      const frame = new Group();
      frame.matrixAutoUpdate = false;
      frame.matrix.copy(placeModule(p));
      const part = src.clone(true);
      frame.add(part);
      floor.add(frame);
      if (p.name === 'DoorL' || p.name === 'DoorR') outerLeaves.push({ obj: part, closed: part.rotation.y, sign: p.name === 'DoorL' ? -1 : 1 });
    }
    const outer = roomDoor(plan);
    doors.push({ x: outer.x, z: outer.z, open: 0, leaves: outerLeaves });
    [...plan.cells.values()].slice(0, 2).forEach((cell, i) => {
      const light = hall.getObjectByName(`LightAisle${i}`);
      const tint = new Color(areas[cell.index].tint);
      light?.traverse(o => {
        if (!o.isMesh || o.material.emissive.getHex() === 0) return;
        o.material = track(o.material.clone());
        o.material.color.copy(tint);
        o.material.emissive.copy(tint);
      });
    });

    scene.add(floor);
  }

  // ── camera ──
  const rig = { target: new Vector3(), home: new Vector3(), goal: null, flight: null, dist: 30, zoom: 1, az: VIEWS.home.az, el: VIEWS.home.el, drift: !matchMedia('(prefers-reduced-motion: reduce)').matches };
  let width = 1, height = 1;
  const probe = new Vector3();

  /**
   * The nearest camera distance at which `b`'s corners (and the signs' height at its back) are in
   * frame: the whole floor by default, or one pod.
   */
  // In app.js's masthead banner the camera fills the width with the pods and the hallway's
  // corridor (the owner's framing, 2026-10-18), not the whole floor: a wide, short banner would
  // otherwise shrink the floor to fit its height.
  let banner = false;
  const fitBounds = () => (banner && plan
    ? { minX: -plan.width / 2 - 0.3, maxX: plan.width / 2 + 0.3, minZ: plan.back, maxZ: plan.corridorZ, cover: true }
    : plan?.bounds);

  function refit(b = fitBounds()) {
    if (!b) return;
    rig.home.set((b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2);
    rig.target.copy(rig.home);
    // On a narrow screen fit the depth and let the width overflow: the floor pans. `cover` fits
    // the width alone and lets the depth overflow.
    const limX = camera.aspect < 0.8 ? 2.6 : 0.97, limY = b.cover ? Infinity : 0.94;
    const corners = [[b.minX, 0, b.minZ], [b.maxX, 0, b.minZ], [b.minX, 0, b.maxZ], [b.maxX, 0, b.maxZ], [b.minX, 3.4, b.minZ], [b.maxX, 3.4, b.minZ]];
    const extent = d => {
      rig.dist = d; rig.zoom = 1;
      placeCamera(0, false);
      camera.updateMatrixWorld();
      const e = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, behind: false };
      for (const [x, y, z] of corners) {
        probe.set(x, y, z).project(camera);
        if (probe.z >= 1) e.behind = true;
        e.minX = Math.min(e.minX, probe.x); e.maxX = Math.max(e.maxX, probe.x);
        e.minY = Math.min(e.minY, probe.y); e.maxY = Math.max(e.maxY, probe.y);
      }
      return e;
    };
    const fits = d => {
      const e = extent(d);
      return !e.behind && Math.max(-e.minX, e.maxX) <= limX && Math.max(-e.minY, e.maxY) <= limY;
    };
    // Perspective puts the floor's middle off the screen's middle: fit, centre, fit again.
    for (let pass = 0; pass < 3; pass++) {
      let lo = 2, hi = 400;
      for (let i = 0; i < 22; i++) { const mid = (lo + hi) / 2; if (fits(mid)) hi = mid; else lo = mid; }
      const e = extent(hi);
      const hh = hi * Math.tan(camera.fov * Math.PI / 360), hw = hh * camera.aspect;
      const dx = camera.aspect < 0.8 ? 0 : (e.minX + e.maxX) / 2 * hw;
      // Centred; a `cover` fit taller than the screen keeps its front (the desks) on screen and
      // lets the back row's top go.
      const tall = b.cover && e.maxY - e.minY > 1.88;
      const dy = (tall ? e.minY + 0.94 : (e.minY + e.maxY) / 2) * hh / tilt();
      rig.target.x += Math.cos(rig.az) * dx - Math.sin(rig.az) * dy;
      rig.target.z += -Math.sin(rig.az) * dx - Math.cos(rig.az) * dy;
      rig.dist = hi;
    }
    rig.home.copy(rig.target);
    rig.zoom = 1;
  }

  /** Screen-to-floor stretch along the view: 1/sin(el), kept sane when the camera is low. */
  function tilt() { return Math.max(Math.sin(rig.el), 0.35); }

  /** Where refit would put the camera for these angles (and bounds): the fitted target and distance. */
  function fitAt(az, el, bounds) {
    const saved = { az: rig.az, el: rig.el, dist: rig.dist, zoom: rig.zoom, target: rig.target.clone(), home: rig.home.clone() };
    rig.az = az; rig.el = el;
    refit(bounds);
    const out = { target: rig.target.clone(), dist: rig.dist };
    Object.assign(rig, { az: saved.az, el: saved.el, dist: saved.dist, zoom: saved.zoom });
    rig.target.copy(saved.target); rig.home.copy(saved.home);
    return out;
  }

  /** Glide to a named view (VIEWS), framed to fit; instantly with reduced motion. */
  function setView(name) {
    const v = VIEWS[name];
    if (!v || !plan) return;
    focusedArea = null;
    returnView = null;
    flyTo(v.az, v.el, fitAt(v.az, v.el));
  }

  /**
   * Glide to one pod, close up from its front-left (POD_VIEW, the owner's view of 2026-10-17): the
   * pod fills the screen, its sign and board readable, the neighbours at the edges.
   */
  let focusedArea = null;
  // The view to go back to when a click lands outside every pod: the one before the first pod
  // (going pod to pod keeps it). A named view or Reset forgets it.
  let returnView = null;
  function focusArea(id) {
    const cell = plan?.cells.get(id);
    if (!cell) return;
    if (!returnView) {
      const at = rig.flight?.to ?? rig;
      returnView = { az: at.az, el: at.el, dist: at.dist, zoom: at.zoom, target: at.target.clone() };
    }
    focusedArea = id;
    flyTo(POD_VIEW.az, POD_VIEW.el, podFit(cell, POD_VIEW.az, POD_VIEW.el));
  }
  function podFit(cell, az, el) {
    const fit = fitAt(az, el, { minX: cell.x - cell.w / 2, maxX: cell.x + cell.w / 2, minZ: cell.z - cell.d / 2, maxZ: cell.z + cell.d / 2 });
    fit.dist *= POD_VIEW.fill;
    return fit;
  }

  /** Back to the view before the pod(s), from a click on an aisle or the ground. */
  function goBack() {
    const v = returnView;
    if (!v) return;
    returnView = null;
    focusedArea = null;
    flyTo(v.az, v.el, v, v.zoom);
  }

  function flyTo(azTo, el, fit, zoom = 1) {
    let az = azTo;
    // The short way round.
    while (az - rig.az > Math.PI) az -= 2 * Math.PI;
    while (az - rig.az < -Math.PI) az += 2 * Math.PI;
    const to = { az, el, dist: fit.dist, zoom, target: fit.target.clone() };
    rig.goal = null;
    if (!rig.drift) { land(to); wake(); return; }
    rig.flight = { from: { az: rig.az, el: rig.el, dist: rig.dist, zoom: rig.zoom, target: rig.target.clone() }, to, start: performance.now() };
    wake();
  }
  function land(to) {
    rig.az = wrap(to.az); rig.el = to.el; rig.dist = to.dist; rig.zoom = to.zoom;
    rig.target.copy(to.target); rig.home.copy(to.target);
    rig.flight = null;
    // A card is open: keep its figure in sight of the new view (review 2026-10-17, finding 2).
    if (workers.selected && focusRect) focusOn(workers.selected, focusRect);
  }
  function wrap(a) { return a - 2 * Math.PI * Math.round(a / (2 * Math.PI)); }

  /** Turn by screen pixels, the way the gizmo drags: across turns round the floor, down looks from higher. */
  function orbit(dx, dy) {
    rig.flight = null; rig.goal = null; focusedArea = null;
    rig.az = wrap(rig.az - dx * 0.01);
    rig.el = Math.min(EL_MAX, Math.max(EL_MIN, rig.el + dy * 0.01));
    wake();
  }

  function placeCamera(t, drift = rig.drift) {
    const az = rig.az + (drift ? 0.035 * Math.sin(t * 0.05) : 0);
    const el = rig.el + (drift ? 0.02 * Math.sin(t * 0.037) : 0);
    const d = rig.dist * rig.zoom;
    camera.position.set(rig.target.x + Math.sin(az) * Math.cos(el) * d, Math.sin(el) * d, rig.target.z + Math.cos(az) * Math.cos(el) * d);
    camera.lookAt(rig.target);
  }

  function resize() {
    width = Math.max(1, host.clientWidth);
    height = Math.max(1, host.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    // Keep where the viewer has panned and zoomed to; only the fitted distance follows the size.
    const target = rig.target.clone(), zoom = rig.zoom, panned = !rig.target.equals(rig.home);
    refit();
    if (panned) rig.target.copy(target);
    rig.zoom = zoom;
    // Looking at one pod: keep it framed at the new size.
    const cell = focusedArea && !rig.flight && plan.cells.get(focusedArea);
    if (cell) { const f = podFit(cell, rig.az, rig.el); rig.target.copy(f.target); rig.home.copy(f.target); rig.dist = f.dist; }
    if (running) render(0);
  }
  new ResizeObserver(resize).observe(host);

  // Drag pans, a right or Shift drag orbits, wheel and pinch zoom, a tap selects.
  const pointers = new Map();
  let down = null, pinch = 0;
  const canvas = renderer.domElement;
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('pointerdown', e => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    down = pointers.size === 1 ? { x: e.clientX, y: e.clientY, moved: false, orbit: e.button === 2 || e.shiftKey } : null;
    if (pointers.size === 2) pinch = spread();
  });
  canvas.addEventListener('pointermove', e => {
    const p = pointers.get(e.pointerId);
    if (!p) {
      // No button down: a mouse hovering. A finger has no hover; a tap still flies to the pod.
      if (e.pointerType !== 'touch') { hoverPx = { x: e.offsetX, y: e.offsetY }; wake(); }
      return;
    }
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (pointers.size === 2) {
      const s = spread();
      if (pinch > 0 && s > 0) zoomBy(pinch / s);
      pinch = s;
      return;
    }
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) down.moved = true;
    if (!down?.moved) return;
    if (down.orbit) { orbit(dx, dy); return; }
    rig.goal = null; rig.flight = null;   // a drag takes over from a re-frame or a glide in progress
    focusedArea = null;
    const scale = (rig.dist * rig.zoom) * 2 * Math.tan(camera.fov * Math.PI / 360) / height;
    const az = rig.az;
    rig.target.x -= Math.cos(az) * dx * scale + Math.sin(az) * dy * scale / tilt();
    rig.target.z -= -Math.sin(az) * dx * scale + Math.cos(az) * dy * scale / tilt();
    clampTarget();
    wake();
  });
  const up = e => {
    pointers.delete(e.pointerId);
    if (down && !down.moved && e.type === 'pointerup' && e.button === 0) {
      const r = canvas.getBoundingClientRect();
      const key = workers.pick(e.clientX - r.left, e.clientY - r.top, camera, width, height);
      if (key) select(key, true);
      else {
        // Not a worker: a click on an area flies to its pod.
        const id = podAt(e.clientX - r.left, e.clientY - r.top);
        if (id) focusArea(id);
        else goBack();   // an aisle or the ground: back to the view before the pod
      }
    }
    down = null;
    pinch = 0;
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointerleave', () => { hoverPx = null; });
  canvas.addEventListener('pointercancel', up);
  // The wheel zooms over the floor and over the figures' labels (they sit above the canvas and
  // would swallow it), but not over the card or the gizmo, which scroll or turn on their own.
  host.addEventListener('wheel', e => {
    if (e.target !== canvas && !e.target.closest?.('.tag')) return;
    e.preventDefault();
    zoomBy(Math.exp(e.deltaY * 0.0012));
  }, { passive: false });
  function spread() {
    const [a, b] = [...pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }
  function zoomBy(f) {
    const z = v => Math.min(1.5, Math.max(0.28, v * f));
    rig.zoom = z(rig.zoom);
    // A glide in progress keeps the zoom the viewer just asked for.
    if (rig.flight) { rig.flight.from.zoom = z(rig.flight.from.zoom); rig.flight.to.zoom = z(rig.flight.to.zoom); }
    wake();
  }
  function clampTarget(v = rig.target, margin = 0) {
    if (!plan) return;
    const b = plan.bounds;
    v.x = Math.min(b.maxX + margin, Math.max(b.minX - margin, v.x));
    v.z = Math.min(b.maxZ + margin, Math.max(b.minZ - margin, v.z));
  }

  /** Where a figure is on screen (px from the stage's top left), or null. */
  function screenOf(key) {
    const f = workers.figures.get(key);
    if (!f) return null;
    probe.copy(f.root.position);
    probe.y = 1.0;
    probe.project(camera);
    if (probe.z > 1) return null;
    return { x: (probe.x + 1) / 2 * width, y: (1 - probe.y) / 2 * height };
  }

  /**
   * Keep a selected figure in view when the card covers part of the stage: `rect` is the part
   * still visible (stage px). If the figure is outside it, the camera glides so it sits in the
   * middle of what is left (instantly with reduced motion).
   */
  let focusRect = null;
  function focusOn(key, rect) {
    focusRect = rect;
    const f = workers.figures.get(key);
    if (!f) return;
    const g = gizmo.el.getBoundingClientRect(), st = host.getBoundingClientRect();
    const underGizmo = p => p.x > g.left - st.left - 30 && p.x < g.right - st.left + 30 && p.y > g.top - st.top - 40 && p.y < g.bottom - st.top + 30;
    const saved = rig.target.clone(), goal = rig.target.clone();
    const cx = (rect.left + rect.right) / 2, cy = (rect.top + rect.bottom) / 2;
    const t = (performance.now() - t0) / 1000;
    for (let i = 0; i < 3; i++) {
      rig.target.copy(goal);
      placeCamera(t);
      camera.updateMatrixWorld();
      const p = screenOf(key);
      if (!p) break;
      if (i === 0 && p.x > rect.left + 60 && p.x < rect.right - 60 && p.y > rect.top + 70 && p.y < rect.bottom - 40 && !underGizmo(p)) { rig.target.copy(saved); placeCamera(t); return; }
      const dx = cx - p.x, dy = cy - p.y;
      const scale = (rig.dist * rig.zoom) * 2 * Math.tan(camera.fov * Math.PI / 360) / height;
      goal.x -= Math.cos(rig.az) * dx * scale + Math.sin(rig.az) * dy * scale / tilt();
      goal.z -= -Math.sin(rig.az) * dx * scale + Math.cos(rig.az) * dy * scale / tilt();
      clampTarget(goal, 8);
    }
    rig.target.copy(saved);
    placeCamera(t);
    if (rig.drift) rig.goal = goal; else rig.target.copy(goal);
    wake();
  }

  // ── the loop ──
  let snapshot = null, raf = 0, running = false, nextRender = 0, lastT = 0, lastTick = 0, lastCount = -1, lastRefresh = 0;
  // Rendering is enabled while the lab is shown; signed out, nothing (not even a visibilitychange)
  // starts it again until the app does.
  let enabled = true;
  // The page's "now" for timers and states. app.js freezes it at the last report while the feed is down.
  let clock = () => Date.now();
  let fpsFrames = 0, fpsSince = 0;
  const t0 = performance.now();

  function render(dt) {
    // Read the gizmo's box before anything on the page is written this frame (no forced layout).
    const g = gizmo.el.getBoundingClientRect(), st = host.getBoundingClientRect();
    const avoid = { l: g.left - st.left - 4, r: g.right - st.left + 4, t: g.top - st.top - 4, b: g.bottom - st.top + 4 };
    if (rig.flight) {
      const { from, to, start: s0 } = rig.flight;
      const k = ease(Math.min(1, (performance.now() - s0) / FLIGHT_MS));
      rig.az = from.az + (to.az - from.az) * k;
      rig.el = from.el + (to.el - from.el) * k;
      rig.dist = from.dist + (to.dist - from.dist) * k;
      rig.zoom = from.zoom + (to.zoom - from.zoom) * k;
      rig.target.lerpVectors(from.target, to.target, k);
      if (k >= 1) land(to);
    }
    if (rig.goal) {
      rig.target.lerp(rig.goal, 1 - Math.exp(-dt * 5));
      if (rig.target.distanceToSquared(rig.goal) < 0.0004) { rig.target.copy(rig.goal); rig.goal = null; }
    }
    workers.update(dt);
    updatePods(dt);
    updateDoors(dt);
    if (workers.count !== lastCount) { hud.sync(workers.figures, snapshot); lastCount = workers.count; state.figures = workers.count; }
    placeCamera((performance.now() - t0) / 1000);
    updateHover();
    // Fog follows the camera's distance, so a far view (top, a corner) is not lost in it.
    const d = rig.dist * rig.zoom;
    scene.fog.near = Math.max(45, d * 1.2); scene.fog.far = Math.max(110, d * 2.8);
    renderer.render(scene, camera);
    gizmo.update(camera);
    hud.frame(workers.figures, camera, width, height, workers.selected, avoid);
    state.frames++;
  }

  function loop(t) {
    raf = requestAnimationFrame(loop);
    // The 30 fps cap keeps a fixed schedule (one frame per 33.3 ms slot, 2 ms early allowed for
    // vsync jitter) so it holds 30 at 60, 120 or unthrottled refresh; a long stall resyncs.
    if (!uncapped) {
      if (nextRender && t < nextRender - 2) return;
      nextRender = nextRender && t - nextRender < FRAME_MS ? nextRender + FRAME_MS : t + FRAME_MS;
    }
    const dt = lastT ? Math.min((t - lastT) / 1000, 0.1) : 0;
    lastT = t;
    render(dt);
    fpsFrames++;
    if (t - fpsSince >= 1000) { state.fps = Math.round(fpsFrames * 1000 / (t - fpsSince)); fpsFrames = 0; fpsSince = t; }
    if (t - lastTick >= 1000) { hud.tick(clock()); lastTick = t; }
    // States that depend only on time (an agent going quiet → idle → stalled) move without a new
    // snapshot: the poll answers 304 while nothing changed.
    if (t - lastRefresh >= REFRESH_MS) { lastRefresh = t; if (snapshot) apply(snapshot, false); }
  }

  function start() {
    if (running || document.hidden || !enabled) return;
    running = true;
    lastT = 0; nextRender = 0; fpsFrames = 0; fpsSince = performance.now();
    raf = requestAnimationFrame(loop);
  }
  function stop() {
    running = false;
    cancelAnimationFrame(raf);
  }
  function wake() { if (!running) start(); }
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else start(); });

  /**
   * A pod is lit while anyone stands in it: the outline glows and the lamp comes on; empty, both
   * fade out. Eased (about half a second), so a worker stepping in turns the lights on gently.
   */
  function updatePods(dt) {
    if (!pods.size || !plan) return;
    for (const p of pods.values()) p.occupied = false;
    for (const f of workers.figures.values()) {
      const cell = cellAt(plan, f.root.position);
      const p = cell && pods.get(cell.id);
      if (p) p.occupied = true;
    }
    const toward = (v, goal, k) => (Math.abs(goal - v) < 0.01 ? goal : v + (goal - v) * k);
    const slow = 1 - Math.exp(-dt * 6), quick = 1 - Math.exp(-dt * 16);
    for (const p of pods.values()) {
      const goal = p.occupied ? 1 : 0, hot = p.hover ? 1 : 0;
      if (p.level === goal && p.hot === hot) continue;
      p.level = toward(p.level, goal, slow);
      p.hot = toward(p.hot, hot, quick);
      p.apply();
    }
  }

  /**
   * The pod under a stage point: where the pointer's ray meets a pod's floor, or the frame at its
   * back (so pointing at a sign or a board counts), nearest the camera first. Null over the aisles.
   */
  const raycaster = new Raycaster(), ndc = new Vector2();
  function podAt(x, y) {
    if (!plan || !pods.size) return null;
    ndc.set(x / width * 2 - 1, 1 - y / height * 2);
    camera.updateMatrixWorld();
    raycaster.setFromCamera(ndc, camera);
    const { origin: o, direction: d } = raycaster.ray;
    let best = null, bestT = Infinity;
    for (const id of pods.keys()) {
      const cell = plan.cells.get(id);
      if (d.y < -1e-6) {
        const t = (POD_FLOOR - o.y) / d.y;
        if (t < bestT && Math.abs(o.x + d.x * t - cell.x) <= cell.w / 2 && Math.abs(o.z + d.z * t - cell.z) <= cell.d / 2) { bestT = t; best = id; }
      }
      if (Math.abs(d.z) > 1e-6) {
        const t = (cell.z - cell.d / 2 + 0.3 - o.z) / d.z, py = o.y + d.y * t;
        if (t > 0 && t < bestT && Math.abs(o.x + d.x * t - cell.x) <= cell.w / 2 && py >= 0 && py <= 2.8) { bestT = t; best = id; }
      }
    }
    return best;
  }

  /** Which pod the (mouse) pointer is over, re-read every frame since the camera drifts. */
  let hoverPx = null, hovered = null;
  function updateHover() {
    const id = hoverPx && !down?.moved ? podAt(hoverPx.x, hoverPx.y) : null;
    if (id === hovered) return;
    hovered = id;
    for (const [k, p] of pods) p.hover = k === id;
    canvas.style.cursor = id ? 'pointer' : '';
  }

  /** A hallway door swings open while a figure is near it, and shut again behind them. */
  function updateDoors(dt) {
    if (!doors.length) return;
    const k = 1 - Math.exp(-dt * 7);
    for (const d of doors) {
      let near = false;
      for (const f of workers.figures.values()) {
        const p = f.root.position;
        if ((p.x - d.x) ** 2 + (p.z - d.z) ** 2 < DOOR_REACH * DOOR_REACH) { near = true; break; }
      }
      const goal = near ? 1 : 0;
      if (d.open === goal) continue;
      d.open = Math.abs(goal - d.open) < 0.01 ? goal : d.open + (goal - d.open) * k;
      for (const l of d.leaves) l.obj.rotation.y = l.closed + l.sign * d.open * DOOR_SWING;
    }
  }

  /** Redraw a board only when what it lists has changed. */
  function updateBoards(next) {
    const lines = boardLines(next);
    for (const board of boards.values()) {
      const list = lines.get(board.id) || [];
      const key = JSON.stringify(list);
      if (key === board.key) continue;
      board.key = key;
      board.lines = list;
      board.drawn = drawBoard(board.canvas, board.art, list, c);
      board.tex.needsUpdate = true;
    }
  }

  function apply(next, instant) {
    updateBoards(next);
    const { specs, hiddenSessions } = figureSpecs(next, new Set(workers.figures.keys()), Math.max(clock(), next.at || 0));
    workers.sync(specs, { instant });
    hud.sync(workers.figures, next);
    hud.tick(clock());
    lastCount = workers.count;
    state.figures = workers.count;
    state.hiddenSessions = hiddenSessions;
    return hiddenSessions;
  }

  function select(key, fromScene = false, keyboard = false) {
    workers.select(key);
    if (fromScene) onSelect?.(workers.selected, keyboard);
  }

  return {
    /** Show a snapshot: a new project or new areas rebuild the floor; otherwise figures move. */
    setSnapshot(next) {
      const key = JSON.stringify([next.project, next.colour, (next.areas || []).map(a => [a.id, a.label, a.tint])]);
      const instant = key !== floorKey;
      if (instant) {
        floorKey = key;
        buildFloor(next);
        workers.setFloor(plan, next.areas || [], next.colour);
        hud.clear();
        lastCount = -1;
        rig.zoom = 1;
        rig.target.copy(rig.home);
        resize();
      }
      snapshot = next;
      const hiddenSessions = apply(next, instant);
      lastRefresh = performance.now();
      start();
      return { figures: workers.count, hiddenSessions };
    },
    select,
    get selected() { return workers.selected; },
    keys: () => [...workers.figures.keys()],
    /** [key, state, mode] per figure, for the smoke test and for debugging by hand. */
    states: () => [...workers.figures].map(([k, f]) => [k, f.state, f.mode]),
    screenOf,
    focusOn,
    /** Glide to a named view: home, top, front, back, left, right. */
    view: setView,
    orbit,
    /** Each area's whiteboard: what it lists, and whether it shows the owner's art. */
    boards: () => Object.fromEntries([...boards.values()].map(b => {
      const px = [...b.canvas.getContext('2d').getImageData(b.canvas.width - 6, b.canvas.height - 6, 1, 1).data.slice(0, 3)];
      return [b.id, { lines: b.lines.slice(), art: !!b.art, corner: px, drawn: b.drawn || { count: 0, shown: 0, more: 0 } }];
    })),
    /** Each pod: whether anyone is in it, and how far its outline and lamp are lit (0..1). */
    /** The hallway's doors: where they are and how far open (0..1). */
    doors: () => doors.map(d => ({ x: d.x, z: d.z, open: Math.round(d.open * 100) / 100, leaves: d.leaves.length })),
    pods: () => Object.fromEntries([...pods].map(([id, p]) => [id, { occupied: p.occupied, lit: Math.round(p.level * 100) / 100, hover: p.hover, hot: Math.round(p.hot * 100) / 100 }])),
    /** Fly to one area's pod, close up (POD_VIEW). */
    focusArea,
    get focusedArea() { return focusedArea; },
    /** Back to the view before the pod(s), as a click on an aisle does. */
    goBack,
    /** Where a pod's floor centre is on screen (stage px), for the smoke test to point at. */
    podScreenOf(id) {
      const cell = plan?.cells.get(id);
      if (!cell) return null;
      probe.set(cell.x, POD_FLOOR, cell.z).project(camera);
      return { x: (probe.x + 1) / 2 * width, y: (1 - probe.y) / 2 * height };
    },
    /** The gizmo's balls in page px, for the smoke test. */
    gizmoBalls: () => gizmo.positions(),
    /** The clock timers and states run on (app.js freezes it while a feed is down). */
    setClock(fn) { clock = fn; hud.tick(clock()); if (snapshot) apply(snapshot, false); },
    refit() { refit(); wake(); },
    /** The masthead banner (true) frames the pods to its width; the full view, the whole floor. */
    setBanner(on) {
      if (banner === !!on) return;
      banner = !!on;
      focusedArea = null; returnView = null; rig.flight = null;
      refit(); wake();
    },
    /** Show the lab: rendering runs (while the page is visible). */
    start() { enabled = true; start(); },
    /** Behind the login plate: nothing renders until start(). */
    stop() { enabled = false; stop(); },
  };
}
