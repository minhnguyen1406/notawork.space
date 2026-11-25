import { DICE_MAX, DICE_MIN, FACES, REVEAL_MS, TURN_MS, diceLegal, diceLowest, type DiceAction, type DiceView } from '../../shared/minigames/dice';
import type { ClientGame, GameCtx } from './api';
import './dice.css';

let ctx: GameCtx;
let view: DiceView | null = null;
/** My own dice this round. They come in a private copy of the view; the public copy has none. */
let mine: number[] = [];
/** When the current view arrived, to run its countdown locally. */
let viewAt = 0;
/** The panel only shows for people who opened it or are playing. */
let open = false;
/** The bid being put together in the picker. */
let pick = { n: 1, face: 1 };

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
const send = (a: DiceAction) => ctx.send(a);
const inGame = () => !!view?.players.some((p) => p.id === ctx.myId());
const face = (f: number) => FACES[f - 1] ?? '?';
const dice = (list: number[], cls: string, lit = 0) => {
  const row = el('div', cls);
  for (const d of list) row.append(el('span', `mg-dice-die${d === lit ? ' hit' : ''}`, face(d)));
  return row;
};

/** The quantity and face picker, offering only bids the server would accept. */
function picker(v: DiceView): HTMLElement[] {
  const low = diceLowest(v.bid, v.total);
  if (!low) return [el('p', 'mg-muted', 'No higher bid is possible: you have to call.')];
  if (!diceLegal(v.bid, v.total, pick.n, pick.face)) pick = { ...low };
  const set = (n: number, f: number) => {
    // Changing the quantity can make the chosen face illegal: fall back to the lowest face that works.
    pick = diceLegal(v.bid, v.total, n, f) ? { n, face: f } : { n, face: [1, 2, 3, 4, 5, 6].find((x) => diceLegal(v.bid, v.total, n, x)) ?? f };
    render();
  };
  const qty = el('div', 'mg-row mg-dice-qty');
  const less = button('−', () => set(pick.n - 1, pick.face));
  less.disabled = pick.n - 1 < low.n;
  const more = button('+', () => set(pick.n + 1, pick.face));
  more.disabled = pick.n + 1 > v.total;
  qty.append(el('span', 'mg-muted', 'How many'), less, el('b', 'mg-dice-n', String(pick.n)), more);
  const faces = el('div', 'mg-row mg-dice-faces');
  for (let f = 1; f <= 6; f++) {
    const b = button(face(f), () => set(pick.n, f), f === pick.face ? 'on' : '');
    b.disabled = !diceLegal(v.bid, v.total, pick.n, f);
    faces.append(b);
  }
  return [qty, faces];
}

function render() {
  const p = ctx.panel;
  if (!open && !inGame()) {
    p.hidden = true;
    return;
  }
  p.className = 'mg mg-sheet mg-dice';
  const v: DiceView = view ?? { players: [], phase: 'lobby', round: 0, turn: null, bid: null, total: 0, left: 0, reveal: null, winner: null };
  const me = ctx.myId();
  const name = (id: string | null) => v.players.find((x) => x.id === id)?.name ?? 'Someone';
  const playing = v.phase !== 'lobby';

  const chips = el('div', 'mg-players');
  for (const pl of v.players) {
    const chip = el('span', `mg-chip${pl.id === me ? ' me' : ''}${pl.id === v.turn ? ' turn' : ''}${playing && !pl.count ? ' out' : ''}`, pl.name);
    if (playing) chip.append(el('b', 'mg-dice-count', pl.count ? ` 🎲 ${pl.count}` : ' out'));
    chips.append(chip);
  }
  if (!v.players.length) chips.append(el('span', 'mg-muted', 'Nobody has joined yet.'));

  const body: HTMLElement[] = [];
  const row = el('div', 'mg-row');
  const clock = el('div', 'mg-dice-clock');
  clock.append(el('i'));

  if (v.phase === 'bid') {
    const myTurn = v.turn === me;
    body.push(el('p', 'mg-status', myTurn ? (v.bid ? 'Your turn: raise the bid or call Liar!' : 'Your turn: open the bidding.') : `${name(v.turn)} is thinking…`));
    const bid = el('div', 'mg-dice-bid');
    if (v.bid) bid.append(el('span', 'mg-muted', `${v.bid.by === me ? 'You' : v.bid.name} bid at least`), el('b', '', `${v.bid.n} × ${face(v.bid.face)}`), el('span', 'mg-muted', `among all ${v.total} dice`));
    else bid.append(el('span', 'mg-muted', `No bid yet · ${v.total} dice on the table`));
    body.push(bid, clock);
    if (mine.length) body.push(el('p', 'mg-muted', 'Your dice (only you can see them)'), dice(mine, 'mg-dice-mine', v.bid?.face));
    else if (inGame()) body.push(el('p', 'mg-muted', 'You are out of dice. Watch how it ends.'));
    if (myTurn) {
      body.push(...picker(v));
      const ok = diceLegal(v.bid, v.total, pick.n, pick.face);
      const go = button(`Bid ${pick.n} × ${face(pick.face)}`, () => send({ k: 'bid', n: pick.n, face: pick.face }), 'primary');
      go.disabled = !ok;
      const liar = button('Liar!', () => send({ k: 'liar' }), 'mg-dice-liar');
      liar.disabled = !v.bid;
      row.append(go, liar);
    }
  } else if (v.phase === 'reveal' && v.reveal) {
    const r = v.reveal;
    const who = (x: { id: string; name: string }) => (x.id === me ? 'You' : x.name);
    body.push(
      el('p', 'mg-status', `${who(r.caller)} called Liar! on ${r.bid.by === me ? 'your' : `${r.bid.name}'s`} bid of ${r.bid.n} × ${face(r.bid.face)}.`),
      el('p', 'mg-dice-result', `There ${r.count === 1 ? 'was' : 'were'} ${r.count}. ${r.truth ? 'The bid was true' : 'The bid was a bluff'}: ${r.loser ? `${who(r.loser)} ${r.loser.id === me ? 'lose' : 'loses'} a die.` : 'the bidder has gone, so nobody loses a die.'}`),
    );
    const hands = el('div', 'mg-dice-hands');
    for (const h of r.hands) {
      const line = el('div', 'mg-dice-hand');
      line.append(el('span', '', h.name), dice(h.dice, 'mg-dice-shown', r.bid.face));
      hands.append(line);
    }
    body.push(hands, clock);
  } else {
    if (v.winner) body.push(el('p', 'mg-dice-result', `🏆 ${v.winner} won the last game.`));
    body.push(
      el('p', 'mg-status', v.players.length < DICE_MIN ? `Needs ${DICE_MIN} to ${DICE_MAX} to play.` : `${v.players.length} ready (${DICE_MIN} to ${DICE_MAX} can play). Anyone in can start.`),
      el('p', 'mg-muted', 'Everyone rolls five dice in secret. Take turns bidding how many of one face are on the whole table, or call Liar! on the last bid. Whoever is wrong loses a die.'),
    );
    if (inGame()) {
      const start = button('Start', () => send({ k: 'start' }), 'primary');
      start.disabled = v.players.length < DICE_MIN;
      row.append(start);
    }
  }
  if (inGame()) row.append(button('Leave', () => send({ k: 'leave' })));
  else if (playing) row.append(el('span', 'mg-muted', 'A game is going. You can join when it ends.'));
  else {
    const join = button('Join', () => send({ k: 'join' }), 'primary');
    join.disabled = v.players.length >= DICE_MAX;
    row.append(join);
  }

  const close = button('Close', () => {
    open = false;
    if (inGame()) send({ k: 'leave' });
    render();
  }, 'mg-close');
  p.replaceChildren(close, el('h2', '', "Liar's dice"), chips, ...body, row);
  p.hidden = false;
}

export const game: ClientGame = {
  init(c) {
    ctx = c;
  },
  onView(raw) {
    const before = view;
    const v = raw as DiceView;
    // The public copy has no dice in it: keep the ones I was dealt for as long as the round lasts.
    if (v.mine) mine = v.mine;
    else if (v.phase !== 'bid' || v.round !== before?.round) mine = [];
    view = v;
    viewAt = performance.now();
    const me = ctx.myId();
    if (v.phase === 'bid' && v.turn === me && (before?.turn !== me || before.round !== v.round)) ctx.play('pop');
    if (v.phase === 'reveal' && before?.phase === 'bid') ctx.play('horn');
    // The game has just ended with a winner: celebrate for everyone who was at the table or watching.
    if (v.phase === 'lobby' && v.winner && before && before.phase !== 'lobby' && (open || inGame())) {
      ctx.confetti(['🎲', '⚅', '🏆']);
      ctx.play('tada');
    }
    render();
  },
  open() {
    open = true;
    render();
  },
  frame() {
    const bar = ctx.panel.querySelector<HTMLElement>('.mg-dice-clock i');
    if (!bar || !view || view.phase === 'lobby') return;
    const whole = view.phase === 'bid' ? TURN_MS : REVEAL_MS;
    bar.style.width = `${(Math.max(0, view.left - (performance.now() - viewAt)) / whole) * 100}%`;
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
    mine = [];
    open = false;
    pick = { n: 1, face: 1 };
    render();
  },
};
