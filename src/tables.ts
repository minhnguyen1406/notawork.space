import { Chess, type Square } from 'chess.js';
import { RULES, canPlay, rankOf, suitOf, SUITS, type Card, type CardsGame, type Suit } from '../shared/cards';
import type { CardsAction, CardsView, ChessAction, ChessView, PokerView, TableId } from '../shared/tables';
import { POKER_RULES, type PokerAction } from '../shared/poker';

const PIECE: Record<string, string> = { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚' };
const SUIT_SYMBOL: Record<Suit, string> = { S: '♠', H: '♥', D: '♦', C: '♣' };
const SUIT_NAME: Record<Suit, string> = { S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' };
const FILES = 'abcdefgh';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

function cardEl(card: Card): HTMLElement {
  const suit = suitOf(card);
  const c = el('div', `card ${suit === 'H' || suit === 'D' ? 'red' : 'black'}`);
  const rank = rankOf(card) === 'T' ? '10' : rankOf(card);
  c.append(el('span', 'rank', rank), el('span', 'suit', SUIT_SYMBOL[suit]));
  return c;
}

/** Draws whichever sit-down game you are at, and turns clicks into actions for the server. */
export class TableUI {
  private selected: Square | null = null;
  private choosingSuitFor: Card | null = null;
  private current: { table: TableId; view: unknown } | null = null;

  constructor(
    private root: HTMLElement,
    private send: (table: TableId, a: ChessAction | CardsAction | PokerAction) => void,
  ) {}

  clear() {
    this.current = null;
    this.selected = null;
    this.choosingSuitFor = null;
    this.root.replaceChildren();
    this.root.hidden = true;
  }

  show(table: TableId, view: unknown) {
    if (this.current?.table !== table) {
      this.selected = null;
      this.choosingSuitFor = null;
    }
    this.current = { table, view };
    this.root.hidden = false;
    this.root.replaceChildren();
    if (!view) {
      this.root.append(el('p', 'game-status', 'Setting up the table…'));
      return;
    }
    if (table === 'chess') this.chess(view as ChessView);
    else if (table === 'cards') this.cards(view as CardsView);
    else this.poker(view as PokerView);
  }

  private redraw() {
    if (this.current) this.show(this.current.table, this.current.view);
  }

  // ------------------------------------------------------------ chess

  private chess(v: ChessView) {
    const game = new Chess(v.fen);
    const turn = game.turn();
    const myTurn = v.status === 'playing' && v.you === turn;
    if (!myTurn) this.selected = null;

    const side = (c: 'w' | 'b') => (c === 'w' ? 'White' : 'Black');
    let status: string;
    if (v.status === 'checkmate') status = `Checkmate. ${side(turn === 'w' ? 'b' : 'w')} wins.`;
    else if (v.status === 'stalemate') status = 'Stalemate. It is a draw.';
    else if (v.status === 'draw') status = 'Draw.';
    else if (!v.white || !v.black) status = `Waiting for someone to sit as ${!v.white ? 'White' : 'Black'}.`;
    else status = (myTurn ? 'Your move' : `${side(turn)} to move`) + (game.isCheck() ? ' — check!' : '');

    const head = el('div', 'game-head');
    head.append(
      el('h2', '', 'Chess'),
      el('p', 'game-players', `White: ${v.white ?? 'empty seat'}  ·  Black: ${v.black ?? 'empty seat'}`),
      el('p', 'game-status', status),
    );

    const targets = new Set<string>(
      this.selected ? game.moves({ square: this.selected, verbose: true }).map((m) => m.to) : [],
    );
    const board = el('div', 'chess-board');
    const flip = v.you === 'b';
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const file = flip ? 7 - col : col;
        const rank = flip ? row + 1 : 8 - row;
        const sq = `${FILES[file]}${rank}` as Square;
        const piece = game.get(sq);
        const cell = el('button', `sq ${(file + rank) % 2 ? 'light' : 'dark'}`);
        cell.type = 'button';
        cell.setAttribute('aria-label', `${sq}${piece ? ` ${side(piece.color)} ${piece.type}` : ''}`);
        if (piece) cell.append(el('span', `piece ${piece.color}`, PIECE[piece.type]));
        if (v.last && (v.last.from === sq || v.last.to === sq)) cell.classList.add('last');
        if (this.selected === sq) cell.classList.add('selected');
        if (targets.has(sq)) cell.classList.add('target');
        if (piece?.type === 'k' && piece.color === turn && game.isCheck()) cell.classList.add('check');
        cell.onclick = () => {
          if (!myTurn) return;
          if (this.selected && targets.has(sq)) {
            this.send('chess', { k: 'move', from: this.selected, to: sq });
            this.selected = null;
          } else {
            this.selected = piece && piece.color === v.you ? sq : null;
          }
          this.redraw();
        };
        board.append(cell);
      }
    }

    const foot = el('div', 'game-foot');
    if (v.you) {
      const again = el('button', '', v.status === 'playing' ? 'Restart game' : 'New game');
      again.type = 'button';
      again.onclick = () => this.send('chess', { k: 'new' });
      foot.append(again);
    } else {
      foot.append(el('p', 'game-note', 'You are watching. Sit in a player chair to play.'));
    }
    foot.append(el('p', 'game-note', 'Click a piece, then where it goes. Pawns promote to queens.'));
    this.root.append(head, board, foot);
  }

  // ------------------------------------------------------------ Last Card

  private cards(v: CardsView) {
    const head = el('div', 'game-head');
    head.append(el('h2', '', 'Last Card'));
    const myTurn = v.phase === 'play' && v.turn === v.you;
    const inGame = v.players.some((p) => p.id === v.you);

    if (v.phase !== 'play') {
      if (v.phase === 'over') head.append(el('p', 'game-status', `${v.winner} won!`));
      else head.append(el('p', 'game-status', `${v.players.length} at the table. It needs at least two.`));
      const start = el('button', 'primary', v.phase === 'over' ? 'Deal again' : 'Deal the cards');
      start.type = 'button';
      start.onclick = () => this.send('cards', { k: 'start' });
      const rules = el('ul', 'game-rules');
      for (const r of RULES) rules.append(el('li', '', r));
      this.root.append(head, start, rules);
      return;
    }

    const turnName = v.players.find((p) => p.id === v.turn)?.name ?? '';
    let status = myTurn ? 'Your turn' : `${turnName}'s turn`;
    if (!inGame) status += ' — you joined mid-game and will be dealt in next time';
    if (myTurn && v.pending) status += ` — play a 2 or draw ${v.pending}`;
    head.append(el('p', 'game-status', status));

    const others = el('div', 'card-players');
    for (const p of v.players) {
      const chip = el('div', `card-player${p.id === v.turn ? ' turn' : ''}`);
      chip.append(el('span', '', p.id === v.you ? `${p.name} (you)` : p.name), el('span', 'count', `${p.count}`));
      others.append(chip);
    }
    others.append(el('div', 'card-dir', v.dir === 1 ? 'Order: left to right →' : 'Order: right to left ←'));

    const middle = el('div', 'card-middle');
    const pile = el('button', 'card back', v.pending ? `Draw ${v.pending}` : 'Draw');
    pile.type = 'button';
    pile.disabled = !myTurn;
    pile.onclick = () => this.send('cards', { k: 'draw' });
    middle.append(pile);
    if (v.top) middle.append(cardEl(v.top));
    if (v.suit && v.top && v.suit !== suitOf(v.top)) {
      middle.append(el('div', 'card-suit-call', `Suit is ${SUIT_SYMBOL[v.suit]} ${SUIT_NAME[v.suit]}`));
    }

    // canPlay only reads these three things, so a view is enough to decide what is playable.
    const rulesState = { pending: v.pending, suit: v.suit!, discard: [v.top!] } as unknown as CardsGame;
    const hand = el('div', 'card-hand');
    const order = [...v.hand].sort((a, b) => SUITS.indexOf(suitOf(a)) - SUITS.indexOf(suitOf(b)) || a.localeCompare(b));
    for (const card of order) {
      const c = cardEl(card);
      const playable = myTurn && canPlay(rulesState, card);
      const btn = el('button', `card-btn${playable ? ' playable' : ''}`);
      btn.type = 'button';
      btn.disabled = !playable;
      btn.append(c);
      btn.onclick = () => {
        if (rankOf(card) === '8') {
          this.choosingSuitFor = card;
          this.redraw();
        } else {
          this.send('cards', { k: 'play', card });
        }
      };
      hand.append(btn);
    }

    this.root.append(head, others, middle, hand);

    if (this.choosingSuitFor && myTurn && v.hand.includes(this.choosingSuitFor)) {
      const chooser = el('div', 'suit-chooser');
      chooser.append(el('span', '', 'Choose the suit:'));
      for (const s of SUITS) {
        const b = el('button', s === 'H' || s === 'D' ? 'red' : 'black', `${SUIT_SYMBOL[s]} ${SUIT_NAME[s]}`);
        b.type = 'button';
        b.onclick = () => {
          this.send('cards', { k: 'play', card: this.choosingSuitFor!, suit: s });
          this.choosingSuitFor = null;
        };
        chooser.append(b);
      }
      this.root.append(chooser);
    } else {
      this.choosingSuitFor = null;
    }
  }

  // ------------------------------------------------------------ poker

  private raiseTo = 0;

  private poker(v: PokerView) {
    const chips = (n: number) => n.toLocaleString('en-US');
    const head = el('div', 'game-head');
    head.append(el('h2', '', "Texas Hold'em"));
    const dealing = v.phase === 'lobby' || v.phase === 'showdown';
    const myTurn = v.turn === v.you;
    const me = v.players.find((p) => p.id === v.you);

    if (v.phase === 'lobby') {
      head.append(el('p', 'game-status', `${v.seated} at the table. It needs at least two.`));
    } else if (v.phase === 'showdown') {
      for (const line of v.results) head.append(el('p', 'game-status', line));
    } else {
      const who = v.players.find((p) => p.id === v.turn)?.name ?? '';
      let status = myTurn ? 'Your turn' : `${who}'s turn`;
      if (!me) status += ' — you will be dealt in next hand';
      head.append(el('p', 'game-status', status));
    }
    this.root.append(head);

    if (v.phase !== 'lobby') {
      const seats = el('div', 'card-players');
      for (const p of v.players) {
        const chip = el('div', `poker-seat${p.id === v.turn ? ' turn' : ''}${p.folded ? ' folded' : ''}`);
        const name = el('div', 'poker-name', (p.dealer ? 'Ⓓ ' : '') + (p.id === v.you ? `${p.name} (you)` : p.name));
        const stack = el('div', 'poker-stack', `${chips(p.chips)} chips${p.allIn ? ' · all in' : p.folded ? ' · folded' : ''}`);
        chip.append(name, stack);
        if (p.bet > 0) chip.append(el('div', 'poker-bet', `bet ${chips(p.bet)}`));
        if (p.hole && p.id !== v.you) {
          const shown = el('div', 'poker-hole small');
          for (const c of p.hole) shown.append(cardEl(c));
          chip.append(shown);
        }
        seats.append(chip);
      }
      const board = el('div', 'card-middle');
      for (const c of v.board) board.append(cardEl(c));
      for (let i = v.board.length; i < 5; i++) board.append(el('div', 'card empty'));
      this.root.append(seats, board, el('p', 'poker-pot', `Pot: ${chips(v.pot)}`));

      if (me?.hole) {
        const hole = el('div', 'poker-hole');
        for (const c of me.hole) hole.append(cardEl(c));
        if (me.folded) hole.classList.add('folded');
        this.root.append(hole);
      }
    }

    if (dealing) {
      const deal = el('button', 'primary', v.phase === 'lobby' ? 'Deal a hand' : 'Deal the next hand');
      deal.type = 'button';
      deal.disabled = v.seated < 2;
      deal.onclick = () => this.send('poker', { k: 'deal' });
      this.root.append(deal);
      if (v.phase === 'lobby') {
        const rules = el('ul', 'game-rules');
        for (const r of POKER_RULES) rules.append(el('li', '', r));
        this.root.append(rules);
      }
    } else if (myTurn) {
      const actions = el('div', 'poker-actions');
      const fold = el('button', '', 'Fold');
      fold.type = 'button';
      fold.onclick = () => this.send('poker', { k: 'fold' });
      const call = el('button', 'primary', v.toCall > 0 ? `Call ${chips(v.toCall)}` : 'Check');
      call.type = 'button';
      call.onclick = () => this.send('poker', { k: 'call' });
      actions.append(fold, call);
      if (v.raise) {
        const { min, max } = v.raise;
        this.raiseTo = Math.max(min, Math.min(max, this.raiseTo || min));
        const input = el('input', 'poker-amount');
        input.type = 'number';
        input.min = `${min}`;
        input.max = `${max}`;
        input.step = '10';
        input.value = `${this.raiseTo}`;
        input.setAttribute('aria-label', 'Raise to');
        input.oninput = () => (this.raiseTo = Math.max(min, Math.min(max, Math.floor(+input.value) || min)));
        const raise = el('button', '', 'Raise to');
        raise.type = 'button';
        raise.onclick = () => this.send('poker', { k: 'raise', to: this.raiseTo });
        const allIn = el('button', '', `All in (${chips(max)})`);
        allIn.type = 'button';
        allIn.onclick = () => this.send('poker', { k: 'raise', to: max });
        actions.append(raise, input, allIn);
      }
      this.root.append(actions);
    } else {
      this.raiseTo = 0;
    }
    if (v.waiting.length && v.phase !== 'lobby') {
      this.root.append(el('p', 'game-note', `Waiting for the next hand: ${v.waiting.join(', ')}`));
    }
  }
}
