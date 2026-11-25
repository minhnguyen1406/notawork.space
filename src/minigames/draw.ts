import * as THREE from 'three';
import { GAME_ZONES } from '../../shared/minigames';
import {
  DRAW_MIN, FINAL_MS, MAX_INK, MAX_MSG_POINTS, MAX_STROKES, PALETTE, REVEAL_MS, TURN_MS, WIDTHS,
  type DrawAction, type DrawMsg, type DrawView, type Stroke, drawRanking, drawWinners,
} from '../../shared/minigames/draw';
import type { ClientGame, GameCtx } from './api';
import './draw.css';

let ctx: GameCtx;
let view: DrawView | null = null;
/** When the current view arrived, to run its countdown locally. */
let viewAt = 0;
/** The panel only shows for people who opened it or are playing. */
let open = false;
/** The word, if I am the drawer of that turn. */
let secret: { turn: number; word: string } | null = null;
/** The picture as I know it, and the turn it belongs to. */
let strokes: Stroke[] = [];
let strokesTurn = 0;
/** The turn I have drawn in myself. My own copy is ahead of the server's echoes, so those are ignored. */
let ownTurn = 0;
/** Drawing actions waiting to go out, a few at a time so the server's rate limit is never hit. */
let queue: DrawAction[] = [];
let lastFlush = 0;
let lastSync = 0;
let drawing = false;
let colour = 0;
let width = 1;

// One canvas is both the picture in the panel and the texture of the board in the room.
const canvas = document.createElement('canvas');
canvas.width = 960;
canvas.height = 560;
const pen = canvas.getContext('2d')!;
let texture: THREE.CanvasTexture | null = null;
const touched = () => {
  if (texture) texture.needsUpdate = true;
};

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
const send = (a: DrawAction) => ctx.send(a);
const inGame = () => !!view?.players.some((p) => p.id === ctx.myId());
const amDrawer = () => view?.phase === 'turn' && view.drawer === ctx.myId();
const inkUsed = () => strokes.reduce((n, s) => n + s.pts.length / 2, 0);

// ---------------------------------------------------------------- painting

/** Paint a stroke from point `from` on (joining it to the point before). */
function paint(s: Stroke, from = 0) {
  const W = canvas.width;
  const H = canvas.height;
  const n = s.pts.length / 2;
  if (from >= n) return;
  pen.strokeStyle = pen.fillStyle = PALETTE[s.c] ?? PALETTE[0];
  pen.lineWidth = (WIDTHS[s.w] ?? WIDTHS[0]) * W;
  pen.lineCap = pen.lineJoin = 'round';
  if (from === 0) {
    // A tap leaves a dot, which a line of no length would not.
    pen.beginPath();
    pen.arc(s.pts[0] * W, s.pts[1] * H, pen.lineWidth / 2, 0, Math.PI * 2);
    pen.fill();
  }
  const start = Math.max(0, from - 1);
  pen.beginPath();
  pen.moveTo(s.pts[start * 2] * W, s.pts[start * 2 + 1] * H);
  for (let i = start + 1; i < n; i++) pen.lineTo(s.pts[i * 2] * W, s.pts[i * 2 + 1] * H);
  pen.stroke();
  touched();
}
function repaint() {
  pen.fillStyle = '#ffffff';
  pen.fillRect(0, 0, canvas.width, canvas.height);
  for (const s of strokes) paint(s);
  touched();
}
/** What the board shows between games, so passers-by know what it is. */
function paintIdle() {
  pen.fillStyle = '#ffffff';
  pen.fillRect(0, 0, canvas.width, canvas.height);
  pen.fillStyle = '#b9b2c2';
  pen.textAlign = 'center';
  pen.font = '700 64px system-ui, sans-serif';
  pen.fillText('Draw and guess', canvas.width / 2, canvas.height / 2 - 10);
  pen.font = '400 30px system-ui, sans-serif';
  pen.fillText('Press E at the sign to play', canvas.width / 2, canvas.height / 2 + 44);
  touched();
}

// ---------------------------------------------------------------- drawing with the pointer

function addPoint(e: PointerEvent) {
  const s = strokes[strokes.length - 1];
  if (!s || inkUsed() >= MAX_INK) return;
  const r = canvas.getBoundingClientRect();
  const clamp = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000;
  const x = clamp((e.clientX - r.left) / r.width);
  const y = clamp((e.clientY - r.top) / r.height);
  const n = s.pts.length;
  // Skip points that barely moved: they cost ink and add nothing.
  if (n && Math.hypot(x - s.pts[n - 2], y - s.pts[n - 1]) < 0.004) return;
  s.pts.push(x, y);
  paint(s, n / 2);
  const last = queue[queue.length - 1];
  if (last?.k === 'draw' && last.pts.length < MAX_MSG_POINTS * 2) last.pts.push(x, y);
  else queue.push({ k: 'draw', n: false, c: s.c, w: s.w, pts: [x, y] });
}
function penDown(e: PointerEvent) {
  if (!amDrawer() || !view || strokes.length >= MAX_STROKES || inkUsed() >= MAX_INK) return;
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
  drawing = true;
  ownTurn = strokesTurn = view.turn;
  strokes.push({ c: colour, w: width, pts: [] });
  // An empty "new stroke" message; addPoint fills it before it is sent.
  queue.push({ k: 'draw', n: true, c: colour, w: width, pts: [] });
  addPoint(e);
}
function penUp() {
  drawing = false;
}
/** Undo or Clear: done here at once, and sent in order behind any points still waiting. */
function edit(k: 'undo' | 'clear') {
  if (!amDrawer() || !view || !strokes.length) return;
  drawing = false;
  ownTurn = strokesTurn = view.turn;
  if (k === 'undo') strokes.pop();
  else strokes = [];
  queue.push({ k });
  repaint();
}
/** Ask for the whole picture again, but not in a flood. */
function resync() {
  const now = performance.now();
  if (now - lastSync < 1000) return;
  lastSync = now;
  send({ k: 'sync' });
}

// ---------------------------------------------------------------- the panel
// Built once and then updated, so the canvas and a half-typed guess survive each new view.

const ui = {
  close: button('Close', () => {
    open = false;
    if (inGame()) send({ k: 'leave' });
    render();
  }, 'mg-close'),
  status: el('p', 'mg-status'),
  word: el('p', 'mg-draw-word'),
  clock: el('div', 'mg-draw-clock'),
  bar: el('i'),
  tools: el('div', 'mg-draw-tools'),
  chips: el('div', 'mg-players'),
  feed: el('div', 'mg-draw-feed'),
  form: el('form', 'mg-draw-guess'),
  input: el('input'),
  row: el('div', 'mg-row'),
};

function build() {
  ui.clock.append(ui.bar);
  const pick = (group: string, b: HTMLElement) => {
    for (const x of ui.tools.querySelectorAll(`.${group}`)) x.classList.toggle('on', x === b);
  };
  PALETTE.forEach((hex, i) => {
    const b = button('', () => {
      colour = i;
      pick('mg-draw-colour', b);
    }, `mg-draw-colour${i === colour ? ' on' : ''}`);
    b.style.background = hex;
    b.title = i === PALETTE.length - 1 ? 'Rubber' : 'Colour';
    ui.tools.append(b);
  });
  WIDTHS.forEach((_, i) => {
    const b = button('', () => {
      width = i;
      pick('mg-draw-width', b);
    }, `mg-draw-width${i === width ? ' on' : ''}`);
    const dot = el('i');
    dot.style.width = dot.style.height = `${5 + i * 6}px`;
    b.append(dot);
    b.title = 'Line width';
    ui.tools.append(b);
  });
  ui.tools.append(button('Undo', () => edit('undo')), button('Clear', () => edit('clear')));

  ui.input.type = 'text';
  ui.input.maxLength = 40;
  ui.input.placeholder = 'Type your guess…';
  ui.input.autocomplete = 'off';
  const go = el('button', 'primary', 'Guess');
  go.type = 'submit';
  ui.form.append(ui.input, go);
  ui.form.onsubmit = (e) => {
    e.preventDefault();
    const text = ui.input.value.trim();
    if (text) send({ k: 'guess', text });
    ui.input.value = '';
  };

  canvas.addEventListener('pointerdown', penDown);
  canvas.addEventListener('pointermove', (e) => {
    if (drawing && amDrawer()) addPoint(e);
  });
  canvas.addEventListener('pointerup', penUp);
  canvas.addEventListener('pointercancel', penUp);

  const stage = el('div', 'mg-draw-stage');
  stage.append(canvas, ui.tools);
  const side = el('div', 'mg-draw-side');
  side.append(ui.chips, ui.feed, ui.form);
  const main = el('div', 'mg-draw-main');
  main.append(stage, side);
  ctx.panel.replaceChildren(ui.close, el('h2', '', 'Draw and guess'), ui.status, ui.word, ui.clock, main, ui.row);
}

function render() {
  const p = ctx.panel;
  if (!open && !inGame()) {
    p.hidden = true;
    return;
  }
  p.className = 'mg mg-sheet mg-draw';
  const v: DrawView = view ?? { t: 'state', players: [], phase: 'lobby', drawer: null, turn: 0, done: 0, turns: 0, left: 0, hint: '', guessed: [], feed: [], word: null };
  const me = ctx.myId();
  const playing = inGame();
  const name = (id: string | null) => v.players.find((x) => x.id === id)?.name ?? 'Someone';
  const drawer = amDrawer();
  const gotIt = v.guessed.includes(me);

  const scores = v.phase !== 'lobby' || v.players.some((x) => x.score);
  ui.chips.replaceChildren(
    ...v.players.map((pl) => {
      const chip = el('span', `mg-chip${pl.id === me ? ' me' : ''}${pl.id === v.drawer && v.phase === 'turn' ? ' turn' : ''}`, pl.name);
      if (scores) chip.append(el('b', '', ` ${pl.score}`));
      if (v.guessed.includes(pl.id)) chip.append(' ✓');
      return chip;
    }),
  );
  if (!v.players.length) ui.chips.append(el('span', 'mg-muted', 'Nobody has joined yet.'));

  let status = '';
  let word = '';
  if (v.phase === 'turn') {
    const count = `turn ${v.done + 1} of ${v.turns}`;
    if (drawer) {
      status = `Your turn to draw (${count}). No letters or numbers!`;
      word = secret?.turn === v.turn ? `Draw: ${secret.word}` : '';
    } else {
      status = gotIt ? 'You got it! Waiting for the others…' : `${name(v.drawer)} is drawing (${count}).${playing ? '' : ' Join to guess.'}`;
      word = `${[...v.hint].join(' ')} · ${v.hint.length} letters`;
    }
  } else if (v.phase === 'reveal') {
    status = `The word was "${v.word ?? ''}".`;
  } else if (v.phase === 'final') {
    const top = drawWinners(v);
    status = top.length === 1 ? `${top[0].name} wins with ${top[0].score} points!` : `A tie on ${top[0]?.score ?? 0} points: ${top.map((x) => x.name).join(' and ')}!`;
  } else {
    status = v.players.length < DRAW_MIN ? `Needs ${DRAW_MIN} or more to play.` : 'Press Start. Everyone takes one turn drawing while the rest type guesses.';
  }
  ui.status.textContent = status;
  ui.word.textContent = word;
  ui.clock.hidden = v.phase === 'lobby';

  if (v.phase === 'final') {
    // The final ranking takes the place of the guesses.
    const list = el('ol', 'mg-draw-rank');
    for (const pl of drawRanking(v)) list.append(el('li', pl.id === me ? 'me' : '', `${pl.name} · ${pl.score}`));
    ui.feed.replaceChildren(list);
  } else {
    ui.feed.replaceChildren(...v.feed.map((f) => el('p', f.ok ? 'ok' : '', f.ok ? `${f.name} guessed it` : `${f.name}: ${f.text ?? ''}`)));
    if (!v.feed.length && v.phase === 'turn') ui.feed.append(el('p', 'mg-muted', 'Guesses show up here.'));
  }

  ui.tools.hidden = !drawer;
  canvas.classList.toggle('can-draw', !!drawer);
  ui.form.hidden = !(v.phase === 'turn' && playing && !drawer && !gotIt);

  ui.row.replaceChildren();
  if (playing && (v.phase === 'lobby' || v.phase === 'final')) {
    const start = button(v.phase === 'final' ? 'Play again' : 'Start', () => send({ k: 'start' }), 'primary');
    start.disabled = v.players.length < DRAW_MIN;
    ui.row.append(start);
  }
  ui.row.append(playing ? button('Leave', () => send({ k: 'leave' })) : button('Join', () => send({ k: 'join' }), 'primary'));
  p.hidden = false;
}

function onState(next: DrawView) {
  const before = view;
  view = next;
  viewAt = performance.now();
  const me = ctx.myId();
  const live = view.phase === 'turn' || view.phase === 'reveal';
  if (!amDrawer()) {
    // Not (or no longer) drawing: nothing of mine should still be going out.
    queue = [];
    drawing = false;
  }
  if (!live) {
    strokes = [];
    strokesTurn = 0;
    if (!before || before.phase === 'turn' || before.phase === 'reveal') paintIdle();
  } else if (view.turn !== strokesTurn) resync(); // I missed this turn's picture
  if (view.phase === 'turn' && before?.turn !== view.turn && view.drawer === me) ctx.play('tada');
  if (view.guessed.length > (before?.turn === view.turn ? before.guessed.length : 0)) ctx.play('pop');
  if (view.phase === 'final' && before && before.phase !== 'final' && drawWinners(view).some((p) => p.id === me)) {
    ctx.play('tada');
    ctx.confetti();
  }
  render();
}

export const game: ClientGame = {
  init(c) {
    ctx = c;
    build();
    paintIdle();
    // The board in the room: a dark frame on the north wall with the picture on it, facing south.
    const z = GAME_ZONES.drawBoard;
    texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    // It is repainted many times a second while someone draws, so skip the mipmaps.
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    const frame = new THREE.Mesh(new THREE.BoxGeometry(z.w + 0.36, z.h + 0.36, 0.12), new THREE.MeshStandardMaterial({ color: '#1b1620', roughness: 0.8 }));
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
    const m = raw as DrawMsg;
    if (m.t === 'state') onState(m);
    else if (m.t === 'word') {
      secret = { turn: m.turn, word: m.word };
      render();
    } else if (m.t === 'strokes') {
      if (m.turn === ownTurn) return; // my own picture is the newer one
      strokes = m.strokes;
      strokesTurn = m.turn;
      repaint();
    } else if (m.t === 'ink') {
      if (m.turn === ownTurn) return; // an echo of what I drew
      const last = strokes[strokes.length - 1];
      if (m.turn !== strokesTurn) resync();
      else if (m.i === strokes.length && m.o === 0) {
        strokes.push({ c: m.c, w: m.w, pts: [...m.pts] });
        paint(strokes[m.i]);
      } else if (m.i === strokes.length - 1 && last && last.pts.length / 2 === m.o) {
        last.pts.push(...m.pts);
        paint(last, m.o);
      } else resync(); // out of step: fetch the whole picture
    }
  },
  open() {
    open = true;
    // Make sure the picture is up to date for someone opening the panel mid-turn.
    if (!amDrawer()) send({ k: 'sync' });
    render();
  },
  frame() {
    const now = performance.now();
    if (queue.length && now - lastFlush >= 50) {
      // One message every 50 ms keeps well under the server's limit; points drawn meanwhile start the next one.
      const a = queue.shift()!;
      if (a.k !== 'draw' || a.pts.length) {
        lastFlush = now;
        send(a);
      }
    }
    if (ctx.panel.hidden || !view || view.phase === 'lobby') return;
    const total = view.phase === 'turn' ? TURN_MS : view.phase === 'reveal' ? REVEAL_MS : FINAL_MS;
    ui.bar.style.width = `${(Math.max(0, view.left - (now - viewAt)) / total) * 100}%`;
  },
  key(code) {
    if (code === 'Escape' && !ctx.panel.hidden && !inGame()) {
      open = false;
      render();
      return true;
    }
    return false;
  },
  reset() {
    view = null;
    secret = null;
    strokes = [];
    queue = [];
    strokesTurn = ownTurn = 0;
    drawing = false;
    open = false;
    ui.input.value = '';
    paintIdle();
    render();
  },
};
