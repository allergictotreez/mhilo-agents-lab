// The navigation gizmo, after oddlyHelpful's container configurator (src/viewer/viewer.ts, Gizmo):
// three axes that follow the camera, a ball on each end that glides to that view, and the gizmo
// itself dragged to orbit. A floor has no underside, so the vertical axis has a top ball only.
// Beside it: a Reset button (the home view, also where the camera opens) and, for the keyboard, one button per view and
// one per area (fly to that pod) that show on focus. On a phone it folds behind one 44 px button so it does not sit on the floor.
import { Vector3 } from 'three';

/** Camera angles per named view: az round the floor (0 = from the lobby), el up from the floor. */
export const VIEWS = {
  home: { az: 0, el: 0.75 },          // straight on from the lobby, the pods' row above it (the owner, 2026-10-17)
  top: { az: 0, el: 1.5 },
  front: { az: 0, el: 0.42 },
  back: { az: Math.PI, el: 0.42 },
  right: { az: Math.PI / 2, el: 0.42 },
  left: { az: -Math.PI / 2, el: 0.42 },
};
/** One pod, close up from its front-left, high over the bench (the owner, 2026-10-17); `fill` < 1 crops in. */
export const POD_VIEW = { az: -0.48, el: 0.62, fill: 0.78 };
const NAMES = { top: 'Top', front: 'Front', back: 'Back', right: 'Right', left: 'Left' };
const HINT = 'Drag to rotate · click an axis for that view';

export class Gizmo {
  /**
   * `colours` are CSS colour strings from the tokens: x, y, z axes, the disc and the label ink.
   * `onView(name)` glides to a named view; `onOrbit(dx, dy)` turns by screen pixels.
   */
  constructor(host, colours, onView, onOrbit) {
    this.size = 96;
    this.colours = colours;
    this.el = document.createElement('div');
    this.el.className = 'gizmo';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'gizmo-canvas';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.canvas.title = HINT;
    this.ratio = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = this.canvas.height = this.size * this.ratio;

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'gizmo-reset';
    reset.setAttribute('aria-label', 'Reset view');
    reset.title = 'Reset view';
    reset.textContent = '⌂';
    reset.addEventListener('click', () => onView('home'));

    // Keyboard: the views as buttons, off screen until one of them has the focus.
    const keys = document.createElement('div');
    keys.className = 'gizmo-keys';
    keys.setAttribute('role', 'group');
    keys.setAttribute('aria-label', 'Camera views');
    for (const [view, label] of Object.entries(NAMES)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.dataset.view = view;
      b.addEventListener('click', () => onView(view));
      keys.append(b);
    }
    // Phone: one button opens and folds the gizmo (app.css shows it at ≤ 600 px only).
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'gizmo-toggle';
    toggle.setAttribute('aria-label', 'Camera views');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.textContent = '◎';
    toggle.addEventListener('click', () => {
      const open = this.el.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', String(open));
    });
    // Keyboard: one button per area, flying to its pod; filled by setAreas when a floor is built.
    this.areas = document.createElement('div');
    this.areas.className = 'gizmo-areas';
    this.areas.setAttribute('role', 'group');
    this.areas.setAttribute('aria-label', 'Fly to an area');
    this.el.append(toggle, this.canvas, reset, keys, this.areas);
    host.append(this.el);

    const { x, y, z } = colours;
    this.balls = [
      { dir: new Vector3(1, 0, 0), view: 'right', label: 'R', color: x },
      { dir: new Vector3(-1, 0, 0), view: 'left', label: '', color: x },
      { dir: new Vector3(0, 1, 0), view: 'top', label: 'T', color: y },
      { dir: new Vector3(0, 0, 1), view: 'front', label: 'F', color: z },
      { dir: new Vector3(0, 0, -1), view: 'back', label: '', color: z },
    ].map(b => ({ ...b, x: 0, y: 0, z: 0 }));
    this.v = new Vector3();

    let dragging = false, moved = false, last = { x: 0, y: 0 };
    const c = this.canvas;
    c.addEventListener('pointerdown', e => {
      dragging = true; moved = false; last = { x: e.clientX, y: e.clientY };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', e => {
      if (!dragging) {
        const b = this.hit(e);
        c.style.cursor = b ? 'pointer' : 'grab';
        c.title = b ? `${NAMES[b.view]} view` : HINT;
        return;
      }
      const dx = e.clientX - last.x, dy = e.clientY - last.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
      last = { x: e.clientX, y: e.clientY };
      if (moved) onOrbit(dx, dy);
    });
    c.addEventListener('pointerup', e => {
      if (!dragging) return;
      dragging = false;
      if (!moved) { const b = this.hit(e); if (b) onView(b.view); }
    });
    c.addEventListener('pointercancel', () => { dragging = false; });
  }

  /** The areas' buttons: [{ id, label }], each calling onArea(id). */
  setAreas(areas, onArea) {
    this.areas.replaceChildren(...areas.map(a => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = a.label;
      b.dataset.area = a.id;
      b.addEventListener('click', () => onArea(a.id));
      return b;
    }));
  }

  /** The ball under the pointer, nearest the viewer first. A finger gets a 44 px circle. */
  hit(e) {
    const r = this.canvas.getBoundingClientRect();
    const k = this.size / r.width;
    const x = (e.clientX - r.left) * k, y = (e.clientY - r.top) * k;
    const reach = (e.pointerType === 'touch' ? 22 : 12) * k;
    let best = null, bestD = Infinity;
    for (const b of this.balls) {
      const d = Math.hypot(b.x - x, b.y - y) - b.z * 2;     // in a tie, the front one wins
      if (Math.hypot(b.x - x, b.y - y) < reach && d < bestD) { best = b; bestD = d; }
    }
    return best;
  }

  /** Where each ball sits on the gizmo, in page px — for the smoke test to click. */
  positions() {
    const r = this.canvas.getBoundingClientRect(), k = r.width / this.size;
    return this.balls.map(b => ({ view: b.view, x: r.left + b.x * k, y: r.top + b.y * k, front: b.z >= 0 }));
  }

  update(camera) {
    const q = camera.quaternion.clone().invert();
    const s = this.size, c = s / 2, rad = 31;
    for (const b of this.balls) {
      this.v.copy(b.dir).applyQuaternion(q);
      b.x = c + this.v.x * rad; b.y = c - this.v.y * rad; b.z = this.v.z;
    }
    const ctx = this.canvas.getContext('2d');
    ctx.save();
    ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    ctx.clearRect(0, 0, s, s);
    ctx.beginPath(); ctx.arc(c, c, 44, 0, Math.PI * 2);
    ctx.fillStyle = this.colours.disc; ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = this.colours.hair; ctx.stroke();
    for (const b of [...this.balls].sort((p, q2) => p.z - q2.z)) {
      const front = b.z >= -0.05;
      if (b.label) {
        ctx.beginPath(); ctx.moveTo(c, c); ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = b.color; ctx.globalAlpha = front ? 0.95 : 0.35; ctx.lineWidth = 1.5; ctx.stroke();
      }
      ctx.beginPath(); ctx.arc(b.x, b.y, b.label ? 9 : 6, 0, Math.PI * 2);
      ctx.globalAlpha = front ? 1 : 0.45;
      if (b.label) {
        ctx.fillStyle = b.color; ctx.fill();
        ctx.fillStyle = this.colours.ink; ctx.font = '600 9px Barlow, system-ui, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(b.label, b.x, b.y + 0.5);
      } else {
        ctx.fillStyle = this.colours.ink; ctx.fill();
        ctx.strokeStyle = b.color; ctx.lineWidth = 1.5; ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }
}
