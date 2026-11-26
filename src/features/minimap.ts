import './minimap.css';
import type { Feature, FeatureCtx } from './api';
import {
  BOUNDS,
  CARDS_TABLE,
  CHESS_TABLE,
  DINING,
  GAMES_LOUNGE,
  GOAL_HALF,
  LOUNGE,
  PERGOLA,
  PHO_TABLE,
  PITCH,
  POKER_TABLE,
  RACE,
  RACE_R,
  SCREEN,
  STATIONS,
  STATION_HALF,
  HIDEOUTS,
  WHEEL,
  WOLF_RING,
} from '../../shared/layout';
import { GAME_SPOTS, GAME_ZONES } from '../../shared/minigames';

// ---------------------------------------------------------------- pure helpers (unit-tested)

export interface MapBounds {
  x1: number;
  x2: number;
  z1: number;
  z2: number;
}

/** How tall a map of this width is, keeping the roof's proportions. */
export const mapHeight = (width: number, b: MapBounds = BOUNDS) => (width * (b.z2 - b.z1)) / (b.x2 - b.x1);

/** A spot in the room as map pixels. North (-z) is up and east (+x) is right, at one scale both ways. */
export function worldToMap(x: number, z: number, width: number, b: MapBounds = BOUNDS): { x: number; y: number } {
  const scale = width / (b.x2 - b.x1);
  return { x: (x - b.x1) * scale, y: (z - b.z1) * scale };
}

/** The camera's heading as a canvas angle. With yaw 0 the camera looks north, which is up the map. */
export const yawToMapAngle = (yaw: number) => Math.atan2(-Math.cos(yaw), -Math.sin(yaw));

/** The biggest map that fits the window: about 70% of its height, and never wider than the screen. */
export function largeMapWidth(winW: number, winH: number, b: MapBounds = BOUNDS): number {
  const byHeight = (winH * 0.7 * (b.x2 - b.x1)) / (b.z2 - b.z1);
  return Math.max(120, Math.floor(Math.min(byHeight, winW * 0.92)));
}

export type MapMode = 'small' | 'large' | 'hidden';
/** What N does: small, then large, then hidden, then round again. */
export const nextMode = (m: MapMode): MapMode => (m === 'small' ? 'large' : m === 'large' ? 'hidden' : 'small');

// ---------------------------------------------------------------- the feature

const SMALL_W = 190;
const NARROW = 720;
const REDRAW_MS = 100;
const STORE_KEY = 'minimap';
const FONT = "ui-rounded, 'SF Pro Rounded', 'Nunito', system-ui, -apple-system, 'Segoe UI', sans-serif";

// The room's palette, turned down.
const C = {
  line: 'rgba(255, 233, 201, 0.3)',
  faint: 'rgba(255, 233, 201, 0.07)',
  soft: 'rgba(255, 233, 201, 0.14)',
  text: '#f6ecdd',
  muted: '#b9a998',
  fire: '#e4572e',
  amber: '#f3a712',
  grassA: 'rgba(118, 176, 65, 0.3)',
  grassB: 'rgba(118, 176, 65, 0.2)',
  chalk: 'rgba(246, 236, 221, 0.5)',
  halo: 'rgba(21, 18, 31, 0.9)',
};

/** Area names: [on the small map, on the large map, x, z]. An empty small name is left off the small map. */
const LABELS: [string, string, number, number][] = [
  ['Cinema', 'Cinema', 0, -15],
  ['Kitchen', 'Kitchen', (PERGOLA.x1 + PERGOLA.x2) / 2, PERGOLA.z1 - 1.5],
  ['Fire', 'Fire pit', LOUNGE.x, LOUNGE.z + 5.3],
  ['Dining', 'Dining table', DINING.x, DINING.z - 4.4],
  ['Pitch', 'Football pitch', PITCH.cx, PITCH.z1 + 2.6],
  ['', 'West half', (PITCH.x1 + PITCH.cx) / 2, PITCH.z2 - 2],
  ['', 'East half', (PITCH.x2 + PITCH.cx) / 2, PITCH.z2 - 2],
  ['Games', 'Games lounge', (GAMES_LOUNGE.x1 + GAMES_LOUNGE.x2) / 2, 0],
  ['', 'Chess', CHESS_TABLE.x, CHESS_TABLE.z + 2.2],
  ['', 'Cards', CARDS_TABLE.x, CARDS_TABLE.z + CARDS_TABLE.r + 1.1],
  ['', 'Poker', POKER_TABLE.x, POKER_TABLE.z + POKER_TABLE.r + 1.1],
  ['Race', 'Race course', WHEEL.x, -9],
  ['Wheel', 'Wheel', WHEEL.x, WHEEL.z + 3.6],
  ['Garden', 'Garden hideouts', -30, 53.4],
  ['Wolf', 'Werewolf fire', WOLF_RING.x, WOLF_RING.z - WOLF_RING.r - 1.8],
  ['Phố Lớn', 'Phố Lớn table', PHO_TABLE.x, PHO_TABLE.z - 2.4],
  ['Sumo', 'Sumo ring', GAME_ZONES.sumo.x, GAME_ZONES.sumo.z],
  ['Dash', 'Obstacle dash', (GAME_ZONES.obstacle.x1 + GAME_ZONES.obstacle.x2) / 2, (GAME_ZONES.obstacle.z1 + GAME_ZONES.obstacle.z2) / 2],
];
// "Games" sits between the chess and card tables on the small map, and above them all on the large one.
const GAMES_LABEL_Z = { small: 29.2, large: GAMES_LOUNGE.z1 + 1.6 };
/** Signposts whose zone already carries the same name. */
const UNNAMED_SIGNS = new Set(['sumo', 'obstacle']);

let ctx: FeatureCtx;
let box: HTMLDivElement;
let canvas: HTMLCanvasElement;
let button: HTMLButtonElement;
let g: CanvasRenderingContext2D | null = null;
let mode: MapMode = 'small';
/** What to go back to when the large map closes, and what is remembered between visits. */
let pref: 'small' | 'hidden' = 'small';
let lastDraw = 0;
// The size the canvas was last laid out at, so it is only resized when something changed.
let laidW = 0;
let laidDpr = 0;

function setMode(next: MapMode) {
  mode = next;
  if (next !== 'large') {
    pref = next;
    ctx.store.set(STORE_KEY, next);
  }
  box.hidden = next === 'hidden';
  box.classList.toggle('ft-minimap--large', next === 'large');
  box.title = next === 'small' ? 'Map (N)' : '';
  button.setAttribute('aria-pressed', String(next !== 'hidden'));
  draw();
}

/** Size the canvas for this mode and screen, with enough real pixels to stay sharp. */
function layout(): { w: number; h: number } | null {
  if (!g) return null;
  const w = mode === 'large' ? largeMapWidth(innerWidth, innerHeight) : SMALL_W;
  const h = Math.round(mapHeight(w));
  const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
  if (w !== laidW || dpr !== laidDpr) {
    laidW = w;
    laidDpr = dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h };
}

function draw() {
  lastDraw = performance.now();
  if (mode === 'hidden' || ctx.hud.hidden) return;
  const size = layout();
  if (!g || !size) return;
  const c = g;
  const { w, h } = size;
  const big = mode === 'large';
  const s = w / (BOUNDS.x2 - BOUNDS.x1); // pixels per metre
  const px = (x: number) => worldToMap(x, 0, w).x;
  const py = (z: number) => worldToMap(0, z, w).y;

  const rect = (x1: number, z1: number, x2: number, z2: number, fill: string | null, stroke: string | null) => {
    if (fill) {
      c.fillStyle = fill;
      c.fillRect(px(x1), py(z1), (x2 - x1) * s, (z2 - z1) * s);
    }
    if (stroke) {
      c.strokeStyle = stroke;
      c.strokeRect(px(x1), py(z1), (x2 - x1) * s, (z2 - z1) * s);
    }
  };
  const circle = (x: number, z: number, r: number, fill: string | null, stroke: string | null) => {
    c.beginPath();
    c.arc(px(x), py(z), r * s, 0, Math.PI * 2);
    if (fill) {
      c.fillStyle = fill;
      c.fill();
    }
    if (stroke) {
      c.strokeStyle = stroke;
      c.stroke();
    }
  };
  /** A dot whose size is in pixels, not metres, so it stays visible on the small map. */
  const dot = (x: number, z: number, r: number, fill: string, stroke?: string) => {
    c.beginPath();
    c.arc(px(x), py(z), r, 0, Math.PI * 2);
    c.fillStyle = fill;
    c.fill();
    if (stroke) {
      c.strokeStyle = stroke;
      c.stroke();
    }
  };
  /** Text with a dark edge so it reads over any shape, kept inside the map. */
  const text = (str: string, x: number, y: number, sizePx: number, colour: string, align: CanvasTextAlign = 'center') => {
    c.font = `600 ${sizePx}px ${FONT}`;
    c.textBaseline = 'middle';
    c.textAlign = align;
    const tw = c.measureText(str).width;
    const left = align === 'center' ? x - tw / 2 : align === 'right' ? x - tw : x;
    const shift = Math.max(3 - left, 0) + Math.min(w - 3 - (left + tw), 0);
    c.lineJoin = 'round';
    c.lineWidth = 3;
    c.strokeStyle = C.halo;
    c.strokeText(str, x + shift, y);
    c.fillStyle = colour;
    c.fillText(str, x + shift, y);
    c.lineWidth = 1;
  };

  c.clearRect(0, 0, w, h);
  c.lineWidth = 1;
  c.setLineDash([]);

  // ---- the areas
  // Cinema: the screen on the north wall and the patch of beanbags in front of it.
  rect(-7.6, -10.4, 7.6, -4.4, C.faint, null);
  rect(SCREEN.x - SCREEN.w / 2, SCREEN.z - 0.2, SCREEN.x + SCREEN.w / 2, SCREEN.z + 0.7, C.text, null);

  // Kitchen: the pergola with its stations.
  rect(PERGOLA.x1, PERGOLA.z1, PERGOLA.x2, PERGOLA.z2, C.faint, C.line);
  for (const st of STATIONS) rect(st.x - STATION_HALF, st.z - STATION_HALF, st.x + STATION_HALF, st.z + STATION_HALF, C.soft, null);

  // Fire pit and its ring of chairs; the dining table.
  circle(LOUNGE.x, LOUNGE.z, 3.4, C.faint, C.line);
  dot(LOUNGE.x, LOUNGE.z, big ? 5 : 2.5, C.fire);
  rect(DINING.x - 0.9, DINING.z - 2.9, DINING.x + 0.9, DINING.z + 2.9, C.soft, C.line);

  // Football pitch: two halves, the centre line and circle, and a goal at each end.
  rect(PITCH.x1, PITCH.z1, PITCH.cx, PITCH.z2, C.grassA, null);
  rect(PITCH.cx, PITCH.z1, PITCH.x2, PITCH.z2, C.grassB, null);
  rect(PITCH.x1, PITCH.z1, PITCH.x2, PITCH.z2, null, C.chalk);
  c.beginPath();
  c.moveTo(px(PITCH.cx), py(PITCH.z1));
  c.lineTo(px(PITCH.cx), py(PITCH.z2));
  c.stroke();
  circle(PITCH.cx, PITCH.cz, 3, null, C.chalk);
  c.lineWidth = big ? 4 : 2.5;
  c.strokeStyle = C.text;
  for (const gx of [PITCH.x1, PITCH.x2]) {
    c.beginPath();
    c.moveTo(px(gx), py(PITCH.cz - GOAL_HALF));
    c.lineTo(px(gx), py(PITCH.cz + GOAL_HALF));
    c.stroke();
  }
  c.lineWidth = 1;

  // Games lounge and its three tables.
  rect(GAMES_LOUNGE.x1, GAMES_LOUNGE.z1, GAMES_LOUNGE.x2, GAMES_LOUNGE.z2, C.faint, C.line);
  rect(CHESS_TABLE.x - 0.75, CHESS_TABLE.z - 0.75, CHESS_TABLE.x + 0.75, CHESS_TABLE.z + 0.75, C.soft, C.line);
  circle(CARDS_TABLE.x, CARDS_TABLE.z, CARDS_TABLE.r, C.soft, C.line);
  circle(POKER_TABLE.x, POKER_TABLE.z, POKER_TABLE.r, C.soft, C.line);

  // Race course: the lap as a dashed loop, a ring at each gate, the start gate filled in.
  c.setLineDash(big ? [6, 5] : [3, 3]);
  c.strokeStyle = C.line;
  c.beginPath();
  RACE.forEach((gate, i) => (i ? c.lineTo(px(gate.x), py(gate.z)) : c.moveTo(px(gate.x), py(gate.z))));
  c.closePath();
  c.stroke();
  c.setLineDash([]);
  RACE.forEach((gate, i) => {
    circle(gate.x, gate.z, RACE_R, i === 0 ? 'rgba(243, 167, 18, 0.3)' : C.faint, i === 0 ? C.amber : C.line);
    if (big) text(String(i + 1), px(gate.x), py(gate.z), 11, C.muted);
  });

  // The wheel, which stands edge-on facing east.
  // The garden's hedges, crates and tanks.
  for (const h of HIDEOUTS) {
    if (h.kind === 'tank') circle(h.x, h.z, h.w / 2, 'rgba(140, 160, 180, 0.45)', null);
    else rect(h.x - h.w / 2, h.z - h.d / 2, h.x + h.w / 2, h.z + h.d / 2, h.kind === 'hedge' ? 'rgba(95, 170, 90, 0.5)' : 'rgba(190, 140, 90, 0.5)', null);
  }
  circle(WHEEL.x, WHEEL.z, 1.7, C.soft, C.amber);
  dot(WHEEL.x, WHEEL.z, big ? 2.5 : 1.2, C.amber);

  // Werewolf fire and the Phố Lớn table.
  circle(WOLF_RING.x, WOLF_RING.z, WOLF_RING.r, C.faint, C.line);
  dot(WOLF_RING.x, WOLF_RING.z, big ? 5 : 2.5, C.fire);
  rect(PHO_TABLE.x - 2.1, PHO_TABLE.z - 0.8, PHO_TABLE.x + 2.1, PHO_TABLE.z + 0.8, C.soft, C.line);

  // Party-game zones: the sumo ring and the obstacle lane.
  const sumo = GAME_ZONES.sumo;
  circle(sumo.x, sumo.z, sumo.r, C.faint, C.line);
  const lane = GAME_ZONES.obstacle;
  c.setLineDash(big ? [6, 5] : [3, 3]);
  rect(lane.x1, lane.z1, lane.x2, lane.z2, C.faint, C.line);
  c.setLineDash([]);

  // ---- signposts
  for (const [id, spot] of Object.entries(GAME_SPOTS)) {
    dot(spot.x, spot.z, big ? 3 : 1.5, C.amber);
    if (!big || UNNAMED_SIGNS.has(id)) continue;
    if (spot.z === 18.5) {
      // The row of signs stands too close together for level names, so these lean.
      c.save();
      c.translate(px(spot.x) + 4, py(spot.z) - 5);
      c.rotate(-0.7);
      c.font = `600 10px ${FONT}`;
      c.textBaseline = 'middle';
      c.textAlign = 'left';
      c.lineJoin = 'round';
      c.lineWidth = 3;
      c.strokeStyle = C.halo;
      c.strokeText(spot.title, 0, 0);
      c.fillStyle = C.muted;
      c.fillText(spot.title, 0, 0);
      c.restore();
      c.lineWidth = 1;
    } else if (spot.x > 8) {
      text(spot.title, px(spot.x) - 7, py(spot.z), 10, C.muted, 'right'); // the kitchen is in the way on the right
    } else {
      text(spot.title, px(spot.x) + 7, py(spot.z), 10, C.muted, 'left');
    }
  }

  // ---- area names
  for (const [small, large, x, z] of LABELS) {
    const str = big ? large : small;
    if (!str) continue;
    const lz = small === 'Games' ? (big ? GAMES_LABEL_Z.large : GAMES_LABEL_Z.small) : z;
    text(str, px(x), py(lz), big ? 12 : 8.5, big ? C.text : C.muted);
  }

  // ---- the ball
  const ball = ctx.ball();
  dot(ball.x, ball.z, big ? 4 : 2.2, '#ffffff', C.halo);

  // ---- people: everyone else first, then me on top
  const mine = ctx.me();
  const myId = ctx.myId();
  for (const [id, a] of ctx.avatars) {
    if (id === myId || a === mine) continue;
    dot(a.x, a.z, big ? 5 : 3, a.info.color, C.halo);
    if (big) text(a.info.name, px(a.x) + 9, py(a.z), 11, C.text, 'left');
  }
  if (mine) {
    const mx = px(mine.x);
    const my = py(mine.z);
    // A wedge for the way the camera looks.
    const angle = yawToMapAngle(ctx.yaw());
    c.beginPath();
    c.moveTo(mx, my);
    c.arc(mx, my, big ? 30 : 15, angle - 0.5, angle + 0.5);
    c.closePath();
    c.fillStyle = 'rgba(246, 236, 221, 0.35)';
    c.fill();
    dot(mine.x, mine.z, big ? 7 : 4.5, mine.info.color, '#ffffff');
    if (big) text(mine.info.name, mx + 11, my, 11, '#ffffff', 'left');
  }
}

export const feature: Feature = {
  init(c) {
    ctx = c;
    box = document.createElement('div');
    box.className = 'ft-minimap';
    box.setAttribute('role', 'img');
    box.setAttribute('aria-label', 'Map of the roof');
    canvas = document.createElement('canvas');
    canvas.className = 'ft-minimap-canvas';
    const hint = document.createElement('div');
    hint.className = 'ft-minimap-hint';
    hint.textContent = 'N, Esc or click to close';
    box.append(canvas, hint);
    try {
      g = canvas.getContext('2d');
    } catch {
      g = null; // no canvas: the room carries on without a map
    }

    // The small map opens the large one; the large one closes on a click (there is no Escape on a phone).
    box.addEventListener('click', () => setMode(mode === 'small' ? 'large' : pref));
    // A press on the map is not the start of a camera drag.
    box.addEventListener('pointerdown', (e) => e.stopPropagation());

    // A way in for people without a keyboard.
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'ft-minimap-button';
    button.textContent = 'Map';
    button.title = 'Map (N)';
    button.addEventListener('click', () => {
      setMode(nextMode(mode));
      button.blur(); // or Enter and Space would keep pressing it instead of chatting and shooting
    });

    if (!g) return;
    ctx.hud.append(box);
    ctx.topbar.append(button);

    const saved = ctx.store.get(STORE_KEY);
    // Narrow screens have no room to spare, so the map waits to be asked for.
    setMode(innerWidth < NARROW || saved === 'hidden' ? 'hidden' : 'small');
    // Starting hidden on a phone is not a choice to remember.
    if (innerWidth < NARROW && saved !== 'hidden') {
      pref = 'small';
      ctx.store.set(STORE_KEY, 'small');
    }
  },

  frame() {
    if (!g || mode === 'hidden') return;
    if (performance.now() - lastDraw >= REDRAW_MS) draw();
  },

  key(code) {
    if (!g) return false;
    if (code === 'KeyN') {
      // N also answers "no" to a duel challenge; that comes first.
      const ask = document.getElementById('duel-ask');
      if (ask && !ask.hidden) return false;
      setMode(nextMode(mode));
      return true;
    }
    if (code === 'Escape' && mode === 'large') {
      setMode(pref);
      return true;
    }
    return false;
  },
};
