import * as THREE from 'three';
import { GAME_ZONES } from '../../shared/minigames';
import { FULL_N, TABLES, TABLE_TITLES, TOP_N, boardRows, cleanName, type BoardAction, type BoardView, type TableId } from '../../shared/minigames/board';
import type { ClientGame, GameCtx } from './api';
import './board.css';

const FONT = 'ui-rounded, system-ui, sans-serif';
/** How long the board on the wall shows each table. */
const PAGE_SECONDS = 8;
// The canvas keeps the board's 3.4 by 4.2 shape.
const W = 816;
const H = 1008;

let ctx: GameCtx;
/** The top five, which everyone is sent: what the board on the wall shows. */
let top: BoardView | null = null;
/** The top twenty, sent only to me when I ask: what the panel shows. */
let full: BoardView | null = null;
let open = false;

let pen: CanvasRenderingContext2D | null = null;
let texture: THREE.CanvasTexture | null = null;
/** The table on the wall right now, and whether it needs painting again. */
let page = -1;
let stale = true;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};
const send = (a: BoardAction) => ctx.send(a);
const EMPTY: BoardView = { n: TOP_N, duel: [], goal: [], lap: [], chess: [], serve: [] };
/** Only take something shaped like a view; anything else is ignored. */
const isView = (v: unknown): v is BoardView => !!v && typeof v === 'object' && typeof (v as BoardView).n === 'number' && TABLES.every((id) => Array.isArray((v as BoardView)[id]));

/** Shorten a name until it fits the width given. */
function fit(p: CanvasRenderingContext2D, text: string, max: number) {
  if (p.measureText(text).width <= max) return text;
  let s = text;
  while (s.length > 1 && p.measureText(`${s}…`).width > max) s = s.slice(0, -1);
  return `${s}…`;
}

/** Paint one table onto the board on the wall. */
function paint(id: TableId) {
  if (!pen || !texture) return;
  const p = pen;
  p.fillStyle = '#0d0b14';
  p.fillRect(0, 0, W, H);
  p.fillStyle = '#f3a712';
  p.fillRect(0, 0, W, 120);
  p.textBaseline = 'middle';
  p.textAlign = 'center';
  p.fillStyle = '#0d0b14';
  p.font = `800 72px ${FONT}`;
  p.fillText('LEADERBOARDS', W / 2, 64);

  p.fillStyle = '#f3a712';
  p.font = `800 64px ${FONT}`;
  p.fillText(TABLE_TITLES[id], W / 2, 196);

  const rows = boardRows(top ?? EMPTY, id).slice(0, TOP_N);
  if (!rows.length) {
    p.fillStyle = '#b9a998';
    p.font = `600 48px ${FONT}`;
    p.fillText('Nothing yet.', W / 2, 500);
    p.fillText('Be the first!', W / 2, 570);
  }
  rows.forEach((r, i) => {
    const y = 320 + i * 126;
    if (i % 2 === 0) {
      p.fillStyle = 'rgba(255, 233, 201, 0.07)';
      p.fillRect(24, y - 56, W - 48, 112);
    }
    p.textAlign = 'left';
    p.fillStyle = i === 0 ? '#f3a712' : '#b9a998';
    p.font = `800 56px ${FONT}`;
    p.fillText(String(i + 1), 44, y);
    p.textAlign = 'right';
    p.fillStyle = '#f3a712';
    p.font = `700 50px ${FONT}`;
    p.fillText(r.score, W - 44, y);
    const scoreW = p.measureText(r.score).width;
    p.textAlign = 'left';
    p.fillStyle = '#f6ecdd';
    p.font = `700 56px ${FONT}`;
    p.fillText(fit(p, r.name, W - 44 - scoreW - 30 - 112), 112, y);
  });

  // Dots along the bottom show which of the tables this is.
  const at = TABLES.indexOf(id);
  TABLES.forEach((_, i) => {
    p.fillStyle = i === at ? '#f3a712' : 'rgba(255, 233, 201, 0.25)';
    p.beginPath();
    p.arc(W / 2 + (i - (TABLES.length - 1) / 2) * 44, H - 48, 11, 0, Math.PI * 2);
    p.fill();
  });
  texture.needsUpdate = true;
}

function render() {
  const p = ctx.panel;
  if (!open) {
    p.hidden = true;
    return;
  }
  p.className = 'mg mg-sheet mg-board';
  // Until the longer tables arrive, show the short ones everyone already has.
  const v = full ?? top ?? EMPTY;
  const me = cleanName(ctx.me()?.info.name);

  const grid = el('div', 'mg-board-grid');
  for (const id of TABLES) {
    const box = el('section', 'mg-board-table');
    box.append(el('h3', '', TABLE_TITLES[id]));
    const rows = boardRows(v, id).slice(0, FULL_N);
    if (!rows.length) box.append(el('p', 'mg-muted', 'Nothing yet.'));
    else {
      const list = el('ol');
      rows.forEach((r, i) => {
        const li = el('li', r.name === me ? 'me' : '');
        li.append(el('span', 'mg-board-rank', `${i + 1}.`), el('span', 'mg-board-name', r.name), el('span', 'mg-board-score', r.score));
        list.append(li);
      });
      box.append(list);
    }
    grid.append(box);
  }

  const close = el('button', 'mg-close', 'Close');
  close.type = 'button';
  close.onclick = () => {
    open = false;
    render();
  };
  p.replaceChildren(close, el('h2', '', 'Leaderboards'), el('p', 'mg-muted', `Since the room last restarted. Top ${FULL_N} of each, counted by name.`), grid);
  p.hidden = false;
}

export const game: ClientGame = {
  init(c) {
    ctx = c;
    // The board in the room: a dark frame on the north wall with the tables on it, facing south.
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    pen = canvas.getContext('2d');
    texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    const z = GAME_ZONES.leaderBoard;
    const frame = new THREE.Mesh(new THREE.BoxGeometry(z.w + 0.36, z.h + 0.36, 0.12), new THREE.MeshStandardMaterial({ color: '#17131f', roughness: 0.6 }));
    frame.position.set(z.x, z.y, z.z + 0.07);
    const sheet = new THREE.Mesh(new THREE.PlaneGeometry(z.w, z.h), new THREE.MeshBasicMaterial({ map: texture }));
    sheet.position.set(z.x, z.y, z.z + 0.14);
    const board = new THREE.Group();
    board.add(frame, sheet);
    // It hangs flat on the wall, well above the floor: nothing to bump into.
    board.userData.walkThrough = true;
    ctx.scene.add(board);
  },
  onView(raw) {
    if (!isView(raw)) return;
    if (raw.n > TOP_N) full = raw;
    else {
      top = raw;
      stale = true;
      // Something changed while I am reading the long tables: ask for them again.
      if (open) send({ k: 'full' });
    }
    render();
  },
  open() {
    open = true;
    send({ k: 'full' });
    render();
  },
  frame(_dt, time) {
    // Paint only when the table shown changes or new numbers arrive, not every frame.
    const now = Math.floor(time / PAGE_SECONDS) % TABLES.length;
    if (now === page && !stale) return;
    page = now;
    stale = false;
    paint(TABLES[now]);
  },
  key(code) {
    if (code === 'Escape' && open && !ctx.panel.hidden) {
      open = false;
      render();
      return true;
    }
    return false;
  },
  reset() {
    top = full = null;
    open = false;
    stale = true;
    render();
  },
};
