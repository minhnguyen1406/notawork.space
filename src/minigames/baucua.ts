import { BAUCUA_MAX, BET_MS, CHIP_SIZES, SHOW_MS, START_CHIPS, SYMBOLS, type BauCuaAction, type BauCuaView } from '../../shared/minigames/baucua';
import type { ClientGame, GameCtx } from './api';
import './baucua.css';

let ctx: GameCtx;
let view: BauCuaView | null = null;
/** When the current view arrived, to run its countdown locally. */
let viewAt = 0;
/** The panel only shows for people who opened it or are playing. */
let open = false;
/** The chip size my next click on the board will stack. Only a convenience: the server checks it. */
let chip: number = CHIP_SIZES[0];
/** The dice tumble until this moment (browser clock); results stay hidden until then. */
let tumbleUntil = 0;
let lastShuffle = 0;
const TUMBLE_MS = 900;

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
const send = (a: BauCuaAction) => ctx.send(a);
const mine = () => view?.players.find((p) => p.id === ctx.myId()) ?? null;
const inGame = () => !!mine();
const n = (x: number) => x.toLocaleString('en-US');
const rolling = () => performance.now() < tumbleUntil;

function statusText(v: BauCuaView): string {
  const me = mine();
  if (!me) return v.players.length >= BAUCUA_MAX ? `The table is full (${BAUCUA_MAX}).` : `Join to play. 1 to ${BAUCUA_MAX} players, all against the house.`;
  if (v.phase === 'wait') return 'Nobody bet, so the dice are resting. Place a bet to start the countdown.';
  if (v.phase === 'bet') {
    if (v.topped.includes(me.id)) return `You ran out, so the house has topped you back up to ${n(START_CHIPS)} play chips. Good luck!`;
    return 'Place your bets: pick a chip size, then click symbols.';
  }
  if (v.phase === 'show') {
    if (rolling()) return 'Rolling…';
    if (me.net === null) return 'You sat this roll out.';
    if (me.net > 0) return `You won ${n(me.net)} play chips!`;
    if (me.net < 0) return `You lost ${n(-me.net)} play chips. Better luck next roll.`;
    return 'You broke even.';
  }
  return '';
}

function render() {
  const p = ctx.panel;
  if (!open && !inGame()) {
    p.hidden = true;
    return;
  }
  p.className = 'mg mg-sheet mg-baucua';
  const v: BauCuaView = view ?? { players: [], phase: 'idle', left: 0, dice: null, round: 0, topped: [] };
  const me = mine();
  const canBet = !!me && (v.phase === 'bet' || v.phase === 'wait');
  const shown = v.phase === 'show' && !rolling() ? v.dice : null;

  const dice = el('div', 'mg-baucua-dice');
  for (let i = 0; i < 3; i++) {
    const face = v.phase === 'show' && v.dice ? SYMBOLS[v.dice[i]].icon : '?';
    const d = el('span', `mg-baucua-die${v.phase === 'show' && rolling() ? ' tumble' : ''}`, face);
    d.style.animationDelay = `${i * 90}ms`;
    dice.append(d);
  }

  const board = el('div', 'mg-baucua-board');
  SYMBOLS.forEach((s, i) => {
    const hits = shown ? shown.filter((d) => d === i).length : 0;
    const b = el('button', `mg-baucua-cell${hits ? ' hit' : ''}${shown && !hits ? ' miss' : ''}`);
    b.type = 'button';
    b.dataset.sym = String(i);
    b.disabled = !canBet || (me?.chips ?? 0) < chip;
    b.onclick = () => send({ k: 'bet', sym: i, chip });
    const stake = me?.bets[i] ?? 0;
    const table = v.players.reduce((t, x) => t + x.bets[i], 0);
    b.append(
      el('span', 'mg-baucua-icon', s.icon),
      el('span', 'mg-baucua-name', s.name),
      el('span', 'mg-muted', s.english),
      el('span', `mg-baucua-stake${stake ? ' on' : ''}`, `Your stake: ${n(stake)}`),
      el('span', 'mg-muted', `Table: ${n(table)}`),
    );
    if (hits) b.append(el('span', 'mg-baucua-hits', `×${hits}`));
    board.append(b);
  });

  const row = el('div', 'mg-row');
  if (me) {
    row.append(el('span', 'mg-muted', 'Chip:'));
    for (const c of CHIP_SIZES)
      row.append(
        button(String(c), () => {
          chip = c;
          render();
        }, `mg-baucua-size${c === chip ? ' on' : ''}`),
      );
    const clear = button('Clear', () => send({ k: 'clear' }));
    clear.disabled = !canBet || !me.bets.some((x) => x > 0);
    row.append(clear, el('span', 'mg-baucua-chips', `Your chips: ${n(me.chips)}`), button('Leave', () => send({ k: 'leave' })));
  } else {
    const join = button('Join', () => send({ k: 'join' }), 'primary');
    join.disabled = v.players.length >= BAUCUA_MAX;
    row.append(join);
  }

  const ranks = el('ol', 'mg-baucua-ranks');
  for (const pl of [...v.players].sort((a, b) => b.worth - a.worth)) {
    const li = el('li', pl.id === me?.id ? 'me' : '');
    const bets = pl.bets.map((x, i) => (x ? `${SYMBOLS[i].icon}${n(x)}` : '')).filter(Boolean).join(' ');
    li.append(el('span', 'mg-baucua-who', pl.name), el('span', 'mg-baucua-bets', bets), el('span', 'mg-baucua-worth', n(pl.worth)));
    if (shown && pl.net !== null) li.append(el('span', `mg-baucua-net${pl.net > 0 ? ' up' : pl.net < 0 ? ' down' : ''}`, `${pl.net > 0 ? '+' : pl.net < 0 ? '−' : ''}${n(Math.abs(pl.net))}`));
    ranks.append(li);
  }
  const side = el('div', 'mg-baucua-side');
  side.append(el('h3', '', 'Chip leaderboard'), v.players.length ? ranks : el('p', 'mg-muted', 'Nobody is at the table yet.'));

  const clock = el('div', 'mg-baucua-clock');
  clock.append(el('i'));
  const main = el('div', 'mg-baucua-main');
  main.append(el('p', 'mg-status', statusText(v)), el('p', 'mg-muted mg-baucua-left'), clock, dice, board, row);
  const cols = el('div', 'mg-baucua-cols');
  cols.append(main, side);

  const close = button('Close', () => {
    open = false;
    if (inGame()) send({ k: 'leave' });
    render();
  }, 'mg-close');
  p.replaceChildren(close, el('h2', '', 'Bầu cua'), el('p', 'mg-muted', `A Tết dice game for 1 to ${BAUCUA_MAX}. Play chips only, no real money. A symbol on 1, 2 or 3 dice pays 1, 2 or 3 times your stake.`), cols);
  p.hidden = false;
  countdown();
}

/** Run the clock locally from the time left in the last view. */
function countdown() {
  const label = ctx.panel.querySelector<HTMLElement>('.mg-baucua-left');
  const bar = ctx.panel.querySelector<HTMLElement>('.mg-baucua-clock i');
  if (!label || !bar || !view) return;
  const timed = view.phase === 'bet' || view.phase === 'show';
  const left = timed ? Math.max(0, view.left - (performance.now() - viewAt)) : 0;
  const secs = Math.ceil(left / 1000);
  const text = view.phase === 'bet' ? `Betting closes in ${secs}s` : view.phase === 'show' ? `Next round in ${secs}s` : view.phase === 'wait' ? 'No countdown until someone bets' : '';
  if (label.textContent !== text) label.textContent = text;
  bar.style.width = `${timed ? (left / (view.phase === 'bet' ? BET_MS : SHOW_MS)) * 100 : 0}%`;
}

export const game: ClientGame = {
  init(c) {
    ctx = c;
  },
  onView(v) {
    const before = view;
    const was = mine();
    view = v as BauCuaView;
    viewAt = performance.now();
    const me = mine();
    // Tumble only for a roll I watched happen, not when arriving halfway through the reveal.
    if (view.phase === 'show' && before && before.phase === 'bet' && (open || me)) {
      tumbleUntil = performance.now() + TUMBLE_MS;
      ctx.play('pop');
    } else if (view.phase !== 'show') tumbleUntil = 0;
    if (me && view.phase === 'bet' && view.topped.includes(me.id) && (before?.round !== view.round || !was)) ctx.toast(`Topped back up to ${n(START_CHIPS)} play chips.`);
    render();
  },
  open() {
    open = true;
    render();
  },
  frame() {
    if (ctx.panel.hidden || !view) return;
    countdown();
    if (!tumbleUntil) return;
    const now = performance.now();
    if (now < tumbleUntil) {
      // Flick through faces while the dice are in the air.
      if (now - lastShuffle < 70) return;
      lastShuffle = now;
      for (const d of ctx.panel.querySelectorAll('.mg-baucua-die')) d.textContent = SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)].icon;
    } else {
      // Landed: show the real faces and the results.
      tumbleUntil = 0;
      const net = mine()?.net ?? null;
      if (net !== null && net > 0) ctx.play('tada');
      render();
    }
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
    open = false;
    tumbleUntil = 0;
    chip = CHIP_SIZES[0];
    render();
  },
};
