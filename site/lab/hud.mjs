// Name + elapsed labels over the figures: one <button> per figure, positioned each frame from the
// projected head bone, its timer ticked here from the snapshot's timestamps so it runs between
// polls. Every string from the API goes in with textContent, never as markup.
import { Vector3 } from 'three';
import { STATE_WORD, fmtDuration } from './model.mjs';

const TAP = 44;   // --touch-target: the tap area of a label on a touch screen
const CLASS = { work: 'busy', wait: 'idle', stalled: 'stalled', error: 'error', done: 'done', leave: 'idle' };

/** What a figure's label says, from the snapshot. */
export function labelFor(spec, sessions) {
  const s = sessions.get(spec.sessionId);
  if (!s) return null;
  if (spec.kind === 'lead') {
    const since = spec.state === 'work' ? (s.busySince || s.startedAt) : s.lastActivity;
    return { name: s.title || s.name, since, until: null, state: spec.state };
  }
  if (spec.kind === 'group') {
    const crew = (s.agents || []).filter(a => spec.agentIds.includes(a.id));
    const since = Math.min(...crew.map(a => a.startedAt));
    return { name: `${spec.count} agents`, since, until: null, state: spec.state, count: spec.count };
  }
  const a = (s.agents || []).find(x => x.id === spec.agentId);
  if (!a) return null;
  return { name: a.tool ? a.tool.name : a.type, since: a.startedAt, until: a.finishedAt, state: spec.state };
}

export class Hud {
  constructor(host, onSelect) {
    this.host = host;
    this.tags = new Map();
    this.v = new Vector3();
    this.coarse = window.matchMedia('(pointer: coarse)');
    host.addEventListener('click', e => {
      const tag = e.target.closest('[data-key]');
      // detail 0: the click came from the keyboard (Enter / Space on the focused label).
      if (tag) onSelect(tag.dataset.key, e.detail === 0);
    });
  }

  /** Create, update and remove labels to match the figures and the latest snapshot. */
  sync(figures, snapshot) {
    const sessions = new Map((snapshot?.sessions || []).map(s => [s.id, s]));
    for (const [key, f] of figures) {
      let t = this.tags.get(key);
      if (!t) {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'tag';
        el.dataset.key = key;
        const name = document.createElement('span');
        name.className = 'tag-name';
        const time = document.createElement('span');
        time.className = 'tag-time';
        el.append(name, time);
        this.host.append(el);
        t = { el, name, time, info: null, shown: true, lastText: '' };
        this.tags.set(key, t);
      }
      const state = f.state === 'done' || f.state === 'leave' ? f.state : f.spec?.state;
      const info = f.spec ? labelFor({ ...f.spec, state }, sessions) : null;
      if (info) {
        t.info = info;
        if (t.name.textContent !== info.name) { t.name.textContent = info.name; t.measured = false; }
        t.el.dataset.state = CLASS[info.state] || 'idle';
        t.el.dataset.kind = f.spec.kind;
        t.el.setAttribute('aria-label', `${info.name}, ${STATE_WORD[info.state] || ''}`);
      }
    }
    for (const [key, t] of this.tags) {
      if (!figures.has(key)) { t.el.remove(); this.tags.delete(key); }
    }
    // A crowded floor: agents' labels keep the dot and the time and drop the tool name (it is on
    // the card), so the stacks stay short enough not to bury the signs.
    const dense = figures.size > 16;
    if (dense !== this.dense) {
      this.dense = dense;
      this.host.classList.toggle('is-dense', dense);
      for (const t of this.tags.values()) t.measured = false;
    }
    this.tick(Date.now());
  }

  /** Once a second: the timers (and each label's size, which only changes with its text). */
  tick(now) {
    for (const t of this.tags.values()) {
      if (!t.info) continue;
      // Not busy: the state is said in words as well as by the dot's colour.
      const word = t.info.state === 'work' ? '' : `${STATE_WORD[t.info.state] || ''} `;
      const text = word + fmtDuration((t.info.until ?? now) - t.info.since);
      if (text !== t.lastText) { t.time.textContent = text; t.lastText = text; t.measured = false; }
    }
    for (const t of this.tags.values()) {
      if (t.measured) continue;
      t.w = t.el.offsetWidth; t.h = t.el.offsetHeight; t.measured = true;
    }
  }

  /**
   * Every rendered frame: follow the heads. Call after render, when bone matrices are current.
   * Labels that would overlap one already placed step up above it, in a fixed order (the order
   * figures arrived), so two labels never trade places as their figures bob. A label whose tap
   * area would fall under `avoid` (the gizmo, stage px) is hidden: it could not be tapped there.
   */
  frame(figures, camera, width, height, selected, avoid = null) {
    const placed = [];
    for (const [key, f] of figures) {
      const t = this.tags.get(key);
      if (!t) continue;
      f.head.getWorldPosition(this.v);
      this.v.y += 0.32;
      this.v.project(camera);
      let visible = this.v.z < 1 && this.v.x > -1.1 && this.v.x < 1.1 && this.v.y > -1.1 && this.v.y < 1.1;
      if (!visible) {
        if (t.shown) { t.el.style.visibility = 'hidden'; t.shown = false; }
        continue;
      }
      const x = Math.round((this.v.x + 1) / 2 * width);
      let y = Math.round((1 - this.v.y) / 2 * height);
      // On a touch screen each label owns a 44 px tall tap area centred on it (app.css .tag::after),
      // so labels stack by that footprint and no two tap areas overlap.
      const w = t.w || 80, h = t.h || 22;
      const pad = this.coarse.matches ? Math.max(0, TAP - h) / 2 : 0;
      for (let i = 0; i < 8; i++) {
        const hit = placed.find(p => x - w / 2 < p.r && x + w / 2 > p.l && y - h - pad < p.b && y + pad > p.t);
        if (!hit) break;
        y = hit.t - 2 - pad;
      }
      const box = { l: x - w / 2, r: x + w / 2, t: y - h - pad, b: y + pad };
      // The selected figure's label always shows: the card is about it.
      visible = key === selected || !(avoid && box.l < avoid.r && box.r > avoid.l && box.t < avoid.b && box.b > avoid.t);
      if (visible !== t.shown) { t.el.style.visibility = visible ? '' : 'hidden'; t.shown = visible; }
      if (!visible) continue;
      placed.push(box);
      t.el.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -100%)`;
      t.el.style.zIndex = key === selected ? 2000 : String(1000 - Math.round(this.v.z * 900));
      t.el.classList.toggle('is-selected', key === selected);
    }
  }

  clear() {
    for (const t of this.tags.values()) t.el.remove();
    this.tags.clear();
  }
}
