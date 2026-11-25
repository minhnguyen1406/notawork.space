import * as THREE from 'three';
import {
  BARRIERS,
  BOARD_SIZE,
  FINISH_X,
  LANE,
  MID_Z,
  START_X,
  barrierAt,
  barrierHit,
  fmtTime,
  type ObstacleAction,
  type ObstacleEnd,
  type ObstacleView,
} from '../../shared/minigames/obstacle';
import type { ClientGame, GameCtx } from './api';
import './obstacle.css';

let ctx: GameCtx;
let view: ObstacleView | null = null;
/** The panel shows for people who opened it, and for me while I run. */
let open = false;
/** My run, if I'm on one. `goAt` is when the clock starts, on this browser's clock (performance.now()). */
let run: { goAt: number; started: boolean; staggerUntil: number; claimedAt: number } | null = null;
/** How my last run ended, in words. */
let result = '';
const meshes: THREE.Mesh[] = [];

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};
const button = (text: string, on: () => void, cls = '') => {
  const b = el('button', cls, text);
  b.type = 'button';
  b.onclick = on;
  return b;
};
const send = (a: ObstacleAction) => ctx.send(a);

/** The course: lines, kerbs and barriers. All of it can be walked through; touching is judged in frame(). */
function build() {
  const course = new THREE.Group();
  course.userData.walkThrough = true;
  const slab = (w: number, h: number, d: number, color: string, x: number, z: number, glow = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: glow, roughness: 0.7 }));
    m.position.set(x, h / 2 + 0.01, z);
    course.add(m);
    return m;
  };
  const len = LANE.x2 - LANE.x1;
  const wide = LANE.z2 - LANE.z1;
  // Low kerbs along both long sides show where the lane is.
  slab(len, 0.14, 0.14, '#f3a712', (LANE.x1 + LANE.x2) / 2, LANE.z1);
  slab(len, 0.14, 0.14, '#f3a712', (LANE.x1 + LANE.x2) / 2, LANE.z2);
  // Start line, and a chequered finish line.
  slab(0.16, 0.02, wide, '#ffffff', START_X, MID_Z);
  const sq = 0.31;
  for (let row = 0; row < 2; row++) {
    for (let i = 0; i < Math.round(wide / sq); i++) slab(sq, 0.02, sq, (i + row) % 2 ? '#ffffff' : '#1c1622', FINISH_X + (row + 0.5) * sq, LANE.z1 + (i + 0.5) * sq);
  }
  // Bright boxes about chest height.
  for (const b of BARRIERS) {
    const m = slab(b.hw * 2, 1.15, b.hd * 2, b.color, b.x, b.z, 0.35);
    m.castShadow = true;
    meshes.push(m);
  }
  ctx.scene.add(course);
}

function endRun() {
  if (!run) return;
  run = null;
  ctx.freeze(false);
}

const endText = (e: ObstacleEnd) => {
  if (e.why === 'finish') {
    const place = e.record ? 'A new best!' : e.rank ? `Number ${e.rank} on the board.` : 'Not on the board this time.';
    return `Finished in ${fmtTime(e.ms)}s. ${place}`;
  }
  if (e.why === 'left') return 'You left the lane, so the run was cancelled.';
  if (e.why === 'false-start') return 'False start. Wait for the go.';
  if (e.why === 'too-fast') return 'That time is not possible, so it does not count.';
  if (e.why === 'timeout') return 'Out of time.';
  return 'Run stopped.';
};

function render() {
  const p = ctx.panel;
  if (!open && !run) {
    p.hidden = true;
    return;
  }
  p.className = 'mg mg-card mg-obstacle';
  const best = view?.best ?? [];
  const others = (view?.runners ?? []).filter((id) => id !== ctx.myId()).length;

  const board = el('ol', 'mg-obstacle-board');
  for (const b of best.slice(0, BOARD_SIZE)) {
    const li = el('li', b.name === ctx.me()?.info.name ? 'me' : '');
    li.append(el('span', '', b.name), el('b', '', `${fmtTime(b.ms)}s`));
    board.append(li);
  }

  const body: HTMLElement[] = [];
  const row = el('div', 'mg-row');
  if (run) {
    body.push(el('div', 'mg-obstacle-clock', ''), el('p', 'mg-status', 'Run east to the chequered line. Touch a barrier and it is back to the start.'));
    row.append(button('Stop', () => send({ k: 'stop' })));
  } else {
    body.push(el('p', 'mg-status', result || 'A solo run against the clock. Any number can run at once.'));
    body.push(best.length ? board : el('p', 'mg-muted', 'No times yet. Be the first.'));
    if (others) body.push(el('p', 'mg-muted', others === 1 ? '1 other person is running now.' : `${others} others are running now.`));
    row.append(
      button(result ? 'Run again' : 'Run', () => {
        if (ctx.me()?.seat) ctx.toast('Stand up first.');
        else send({ k: 'run' });
      }, 'primary'),
    );
  }
  const close = button('Close', () => {
    open = false;
    if (run) send({ k: 'stop' });
    render();
  }, 'mg-close');
  p.replaceChildren(close, el('h2', '', 'Obstacle dash'), ...body, row);
  p.hidden = false;
}

export const game: ClientGame = {
  init(c) {
    ctx = c;
    build();
  },
  onView(v) {
    view = v as ObstacleView;
    if (view.start) {
      // The server has put me on the start line and started my clock: root me for the 3-2-1.
      run = { goAt: performance.now() - view.start.t, started: false, staggerUntil: 0, claimedAt: 0 };
      result = '';
      open = true;
      ctx.freeze(true);
      ctx.me()?.faceTowards(LANE.x2, MID_Z);
    } else if (view.end) {
      endRun();
      result = endText(view.end);
      if (view.end.why === 'finish') {
        ctx.play('tada');
        if (view.end.record) ctx.confetti();
      }
    } else if (run && !view.runners.includes(ctx.myId())) {
      // The server no longer has me running (I missed how it ended).
      endRun();
      result = 'Run stopped.';
    }
    render();
  },
  open() {
    open = true;
    render();
  },
  frame() {
    const now = performance.now();
    // A runner sees the barriers on their own run's clock; everyone else just sees them moving.
    const t = (run ? now - run.goAt : now) / 1000;
    BARRIERS.forEach((b, i) => {
      const c = barrierAt(b, t);
      meshes[i].position.x = c.x;
      meshes[i].position.z = c.z;
    });
    if (!run) return;
    const clock = ctx.panel.querySelector<HTMLElement>('.mg-obstacle-clock');
    if (t < 0) {
      if (clock) clock.textContent = String(Math.ceil(-t));
      return;
    }
    if (!run.started) {
      run.started = true;
      ctx.freeze(false);
      ctx.play('pop');
    }
    if (clock) clock.textContent = `${fmtTime(t * 1000)}s`;
    if (run.staggerUntil) {
      if (now < run.staggerUntil) return;
      run.staggerUntil = 0;
      ctx.freeze(false);
    }
    const me = ctx.me();
    if (!me) return;
    if (barrierHit(me.x, me.z, t) >= 0) {
      // Back to the start, rooted for the length of the stagger. The clock keeps running.
      ctx.put(START_X, MID_Z);
      me.act('emote-no', 600);
      ctx.freeze(true);
      run.staggerUntil = now + 600;
    } else if (me.x >= FINISH_X && now - run.claimedAt > 400) {
      // Tell the server; it checks where I am and times the run itself. Ask again if it wasn't convinced yet.
      run.claimedAt = now;
      send({ k: 'finish' });
    }
  },
  key(code) {
    if (code !== 'Escape' || ctx.panel.hidden) return false;
    if (run) send({ k: 'stop' });
    else {
      open = false;
      render();
    }
    return true;
  },
  reset() {
    view = null;
    open = false;
    result = '';
    run = null;
    ctx.freeze(false);
    render();
  },
};
