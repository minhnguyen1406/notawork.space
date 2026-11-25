import * as THREE from 'three';
import { GAME_ZONES } from '../../shared/minigames';
import { SUMO_MAX, SUMO_MIN, SUMO_WINS, type SumoAction, type SumoView } from '../../shared/minigames/sumo';
import type { ClientGame, GameCtx } from './api';
import './sumo.css';

let ctx: GameCtx;
let view: SumoView | null = null;
/** When the current view arrived, to run its clock locally. */
let viewAt = 0;
/** The panel only shows for people who opened it or are playing. */
let open = false;
/** Whether this game has me rooted, so we only ever undo our own freeze. */
let rooted = false;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};
const button = (text: string, on: () => void, cls = '') => {
  const b = el('button', cls, text);
  b.type = 'button';
  b.onclick = () => {
    // Don't keep the focus, or Space and Enter would press the button again while wrestling.
    b.blur();
    on();
  };
  return b;
};
const send = (a: SumoAction) => ctx.send(a);
const inGame = () => !!view?.players.some((p) => p.id === ctx.myId());
const left = () => (view ? Math.max(0, view.left - (performance.now() - viewAt)) : 0);
const root = (on: boolean) => {
  if (on === rooted) return;
  rooted = on;
  ctx.freeze(on);
};

function render() {
  const p = ctx.panel;
  if (!open && !inGame()) {
    p.hidden = true;
    return;
  }
  p.className = 'mg mg-card mg-sumo';
  const v: SumoView = view ?? { players: [], phase: 'lobby', alive: [], round: 0, left: 0, last: null, champion: null };
  const me = ctx.myId();
  const name = (id: string | null) => v.players.find((x) => x.id === id)?.name ?? 'Nobody';
  const playing = v.phase !== 'lobby';
  const fighting = v.phase === 'countdown' || v.phase === 'bout';

  const chips = el('div', 'mg-players');
  for (const pl of v.players) {
    const out = fighting && !v.alive.includes(pl.id);
    const won = v.phase === 'result' && v.last === pl.id;
    const chip = el('span', `mg-chip${pl.id === me ? ' me' : ''}${won ? ' turn' : ''}${out ? ' mg-sumo-out' : ''}`, pl.name);
    chip.append(el('span', 'mg-sumo-wins', `${pl.wins}`));
    chips.append(chip);
  }
  if (!v.players.length) chips.append(el('span', 'mg-muted', 'Nobody has joined yet.'));

  const status = el('p', 'mg-status');
  const clock = el('span', 'mg-sumo-clock');
  if (v.phase === 'countdown') status.append(`Round ${v.round}: get ready… `, clock);
  else if (v.phase === 'bout') status.append(v.alive.includes(me) || !inGame() ? `Round ${v.round}: push! ` : `Round ${v.round}: you are out. `, clock);
  else if (v.phase === 'result') status.textContent = v.last ? `${name(v.last)} wins round ${v.round}!` : `Nobody wins round ${v.round}.`;
  else if (v.players.length < SUMO_MIN) status.textContent = `Needs ${SUMO_MIN} to ${SUMO_MAX} to play.`;
  else if (v.champion) status.textContent = `${v.champion.name} won the match! Press Start for another.`;
  else status.textContent = 'Press Start when everyone is in.';

  const row = el('div', 'mg-row');
  if (!playing && inGame()) {
    const start = button('Start', () => send({ k: 'start' }), 'primary');
    start.disabled = v.players.length < SUMO_MIN;
    row.append(start);
  }
  if (inGame()) row.append(button('Leave', () => send({ k: 'leave' })));
  else {
    const join = button('Join', () => send({ k: 'join' }), 'primary');
    join.disabled = playing || v.players.length >= SUMO_MAX;
    row.append(join);
  }
  const hint = playing && !inGame() ? 'A match is on. You can join when it ends.' : `Walk into the others to push them out of the ring. Last one in wins the round; first to ${SUMO_WINS} rounds wins.`;

  const close = button('Close', () => {
    open = false;
    if (inGame()) send({ k: 'leave' });
    render();
  }, 'mg-close');
  p.replaceChildren(close, el('h2', '', 'Sumo ring'), chips, status, el('p', 'mg-muted', hint), row);
  p.hidden = false;
  tickClock();
}

/** The number in the status line: whole seconds left, counted down locally. */
function tickClock() {
  const c = ctx.panel.querySelector<HTMLElement>('.mg-sumo-clock');
  if (!c || !view) return;
  const text = view.phase === 'countdown' ? `${Math.max(1, Math.ceil(left() / 1000))}` : `${Math.ceil(left() / 1000)}s`;
  if (c.textContent !== text) c.textContent = text;
}

/** The ring on the floor: a flat disc with a bright rim. */
function buildRing() {
  const { x, z, r } = GAME_ZONES.sumo;
  const flat = (geo: THREE.BufferGeometry, color: string, opacity: number, y: number) => {
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, y, z);
    m.userData.walkThrough = true;
    return m;
  };
  const ring = new THREE.Group();
  ring.userData.walkThrough = true;
  // The rim's outer edge is the line: step over it and you are out.
  ring.add(flat(new THREE.CircleGeometry(r, 72), '#e9c98a', 0.55, 0.02), flat(new THREE.RingGeometry(r - 0.16, r, 96), '#ff5a3c', 0.95, 0.03), flat(new THREE.RingGeometry(0.5, 0.58, 48), '#fff3d6', 0.8, 0.03));
  ctx.scene.add(ring);
}

export const game: ClientGame = {
  init(c) {
    ctx = c;
    buildRing();
  },
  onView(v) {
    const before = view;
    view = v as SumoView;
    viewAt = performance.now();
    const me = ctx.myId();
    const mine = view.alive.includes(me);
    // Rooted to my starting spot for the countdown, and only then.
    root(view.phase === 'countdown' && mine);
    if (view.phase === 'countdown' && before?.phase !== 'countdown' && mine) {
      // The server has just put me on my spot (that message comes first): turn to face the centre.
      const a = ctx.me();
      if (a) a.place(a.x, a.z, Math.atan2(GAME_ZONES.sumo.x - a.x, GAME_ZONES.sumo.z - a.z));
      ctx.play('pop');
    }
    if (view.phase === 'bout' && before?.phase === 'countdown' && mine) ctx.play('horn');
    if (view.phase === 'bout' && before?.alive.includes(me) && !mine && inGame()) ctx.toast('You are out of the ring!');
    // The match has just been won.
    if (view.phase === 'lobby' && view.champion && before && before.phase !== 'lobby' && view.champion.id === me) {
      ctx.confetti(['🏆', '💪', '🎉', '✨']);
      ctx.play('tada');
    }
    render();
  },
  open() {
    open = true;
    render();
  },
  frame() {
    if (ctx.panel.hidden || !view) return;
    tickClock();
    // If the "go" message is late, don't stay rooted long after the countdown has run out.
    if (rooted && view.phase === 'countdown' && performance.now() - viewAt > view.left + 1500) root(false);
  },
  key(code) {
    // Only Escape, and only for someone looking on: players need every key for walking.
    if (code === 'Escape' && !ctx.panel.hidden && !inGame()) {
      open = false;
      render();
      return true;
    }
    return false;
  },
  reset() {
    view = null;
    open = false;
    root(false);
    render();
  },
};
