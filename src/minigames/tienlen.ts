import { TL_MAX, TL_MIN, TURN_MS, cardName, isRed, tlIllegal, type TlAction, type TlView } from '../../shared/minigames/tienlen';
import type { ClientGame, GameCtx } from './api';
import './tienlen.css';

let ctx: GameCtx;
let view: TlView | null = null;
/** When the current view arrived, to run its countdown locally. */
let viewAt = 0;
/** The panel only shows for people who opened it or are playing. */
let open = false;
/** Cards I have clicked but not yet played. */
const picked = new Set<number>();

const EMPTY: TlView = { phase: 'lobby', players: [], turn: null, table: null, mustInclude: null, left: 0, winner: null, reveal: null, note: null, hand: null };

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
const send = (a: TlAction) => ctx.send(a);
const inGame = () => !!view?.players.some((p) => p.id === ctx.myId());

/** One card face. A button when it is mine to click, otherwise a plain tile. */
function face(c: number, onClick?: () => void) {
  const cls = `mg-tienlen-card${isRed(c) ? ' red' : ''}${onClick && picked.has(c) ? ' sel' : ''}`;
  const e = onClick ? button(cardName(c), onClick, cls) : el('span', cls, cardName(c));
  e.dataset.card = String(c);
  return e;
}
const fan = (cards: number[], cls: string) => {
  const d = el('div', `mg-tienlen-cards ${cls}`);
  d.append(...cards.map((c) => face(c)));
  return d;
};

function render() {
  const p = ctx.panel;
  if (!open && !inGame()) {
    p.hidden = true;
    return;
  }
  p.className = 'mg mg-sheet mg-tienlen';
  const v = view ?? EMPTY;
  const me = ctx.myId();
  const playing = inGame();
  const myTurn = v.phase === 'play' && v.turn === me;
  const name = (id: string | null) => v.players.find((x) => x.id === id)?.name ?? 'Someone';
  const hand = v.hand ?? [];
  for (const c of [...picked]) if (!hand.includes(c)) picked.delete(c);

  // Everyone at the table, how many cards they hold, and whose turn it is.
  const chips = el('div', 'mg-players');
  for (const pl of v.players) {
    const cards = v.phase === 'play' ? ` · ${pl.count} ${pl.count === 1 ? 'card' : 'cards'}${pl.passed ? ' · passed' : ''}` : '';
    const chip = el('span', `mg-chip${pl.id === me ? ' me' : ''}${pl.id === v.turn ? ' turn' : ''}${pl.passed ? ' mg-tienlen-out' : ''}`, pl.name + cards);
    chip.dataset.count = String(pl.count);
    chips.append(chip);
  }
  if (!v.players.length) chips.append(el('span', 'mg-muted', 'Nobody is at the table yet.'));

  const body: HTMLElement[] = [];
  const row = el('div', 'mg-row');
  const dealer = (label: string) => {
    if (!playing) return;
    const deal = button(label, () => send({ k: 'deal' }), 'primary');
    deal.disabled = v.players.length < TL_MIN;
    row.append(deal);
  };

  if (v.phase === 'play') {
    let status: string;
    if (!myTurn) status = `${name(v.turn)}'s turn${v.table ? '' : ' to lead'}.`;
    else if (v.mustInclude !== null) status = `Your turn: open the hand with a play that includes the ${cardName(v.mustInclude)}.`;
    else if (!v.table) status = 'Your turn: lead anything.';
    else status = 'Your turn: beat the table or pass.';
    body.push(el('p', 'mg-status', status));
    const clock = el('div', 'mg-tienlen-clock');
    clock.append(el('i'));
    body.push(clock);

    const table = el('div', 'mg-tienlen-table');
    if (v.table) table.append(el('div', 'mg-muted', `${v.table.by === me ? 'You' : v.table.name} played`), fan(v.table.cards, 'mg-tienlen-play'));
    else table.append(el('div', 'mg-muted', 'The table is clear.'));
    body.push(table);
    if (v.note) body.push(el('p', 'mg-muted mg-tienlen-note', v.note));

    if (v.hand) {
      const mine = el('div', 'mg-tienlen-cards mg-tienlen-hand');
      for (const c of hand)
        mine.append(
          face(c, () => {
            if (!picked.delete(c)) picked.add(c);
            render();
          }),
        );
      body.push(mine);
      const cards = [...picked].sort((a, b) => a - b);
      const why = !myTurn ? 'Wait for your turn.' : cards.length ? tlIllegal(hand, v.table?.cards ?? null, v.mustInclude, cards) : 'Click cards to select them.';
      const play = button('Play', () => {
        send({ k: 'play', cards });
        picked.clear();
      }, 'primary');
      play.disabled = why !== null;
      const pass = button('Pass', () => send({ k: 'pass' }));
      pass.disabled = !myTurn || !v.table;
      row.append(play, pass);
      body.push(el('p', 'mg-muted mg-tienlen-why', why ?? ''));
    } else body.push(el('p', 'mg-muted', 'A hand is being played. You can join when it ends.'));
  } else if (v.phase === 'ended') {
    body.push(el('p', 'mg-status', v.note ?? `${v.winner?.name ?? 'Someone'} wins the hand.`));
    if (v.table) {
      const table = el('div', 'mg-tienlen-table');
      table.append(el('div', 'mg-muted', `Last play, by ${v.table.name}`), fan(v.table.cards, 'mg-tienlen-play'));
      body.push(table);
    }
    // Everyone's leftover cards, face up.
    const left = el('div', 'mg-tienlen-reveal');
    for (const r of v.reveal ?? []) {
      if (!r.cards.length) continue;
      const line = el('div', 'mg-tienlen-left');
      line.append(el('span', 'mg-muted', `${r.name} (${r.cards.length})`), fan(r.cards, 'mg-tienlen-small'));
      left.append(line);
    }
    body.push(left);
    dealer('Deal again');
  } else {
    body.push(el('p', 'mg-status', v.players.length < TL_MIN ? `Needs ${TL_MIN} to ${TL_MAX} players.` : `Ready: ${v.players.length} of up to ${TL_MAX} players. Deal when everyone is in.`));
    body.push(el('p', 'mg-muted', 'Get rid of your 13 cards first. Beat the table with the same kind of play, only higher, or pass. 2 is the top rank; hearts is the top suit.'));
    dealer('Deal');
  }
  if (!playing && v.phase !== 'play') {
    const join = button('Join', () => send({ k: 'join' }), 'primary');
    join.disabled = v.players.length >= TL_MAX;
    row.append(join);
  }

  // Closing the sheet gives up your seat: a card game cannot wait on someone who has walked away.
  const close = button(playing ? 'Leave' : 'Close', () => {
    open = false;
    if (inGame()) send({ k: 'leave' });
    render();
  }, 'mg-close');
  p.replaceChildren(close, el('h2', '', 'Tiến lên'), chips, ...body, row);
  p.hidden = false;
}

export const game: ClientGame = {
  init(c) {
    ctx = c;
  },
  onView(v) {
    const before = view;
    view = v as TlView;
    viewAt = performance.now();
    const me = ctx.myId();
    // A sound when the turn comes to me, and a fuss when I win.
    if (view.phase === 'play' && view.turn === me && before?.turn !== me) ctx.play('pop');
    if (view.phase === 'ended' && before?.phase === 'play' && view.winner?.id === me) {
      ctx.play('tada');
      ctx.confetti();
    }
    if (view.phase !== 'play') picked.clear();
    render();
  },
  open() {
    open = true;
    render();
  },
  frame() {
    const bar = ctx.panel.querySelector<HTMLElement>('.mg-tienlen-clock i');
    if (bar && view?.phase === 'play') bar.style.width = `${(Math.max(0, view.left - (performance.now() - viewAt)) / TURN_MS) * 100}%`;
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
    picked.clear();
    render();
  },
};
