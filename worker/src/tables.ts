import { Chess } from 'chess.js';
import { seatGroup } from '../../shared/layout';
import {
  currentPlayer,
  drawCard,
  playCard,
  removePlayer,
  startCards,
  topCard,
  type CardsGame,
} from '../../shared/cards';
import type { CardsView, ChessView, PhoView, PokerView, WolfView } from '../../shared/tables';
import { FORCE_AFTER_MS, newWolf, wolfForce, wolfLeave, wolfNight, wolfStart, wolfVote } from '../../shared/werewolf';
import { newPho, phoBuild, phoBuy, phoEnd, phoFinish, phoLeave, phoRoll, phoStart } from '../../shared/property';
import {
  betting,
  newPoker,
  pokerAct,
  pokerLeave,
  pokerStart,
  potOf,
  type PokerAction,
} from '../../shared/poker';

export interface Sitter {
  id: string;
  name: string;
  seat: string | null;
}

/** How the tables reach the outside world; supplied by the room. */
export interface TableIO {
  /** Everyone in the room, with the seat they are in (if any). */
  sitters(): Sitter[];
  send(id: string, table: string, view: unknown): void;
  notice(text: string): void;
}

const WHITE_SEAT = 'chess:0';
const BLACK_SEAT = 'chess:1';

/** The sit-down games. The server owns every game's state and decides what each person may see. */
export class Tables {
  private chess = new Chess();
  private chessLast: { from: string; to: string } | null = null;
  private cards: CardsGame | null = null;
  private poker = newPoker();
  private wolf = newWolf();
  private pho = newPho();

  constructor(private io: TableIO) {}

  private at(group: string) {
    return this.io.sitters().filter((s) => seatGroup(s.seat) === group);
  }

  /** Send everyone at a table their current view of it. */
  refresh(group: string | null) {
    if (group === 'chess') for (const s of this.at('chess')) this.io.send(s.id, 'chess', this.chessView(s));
    if (group === 'cards') for (const s of this.at('cards')) this.io.send(s.id, 'cards', this.cardsView(s));
    if (group === 'poker') for (const s of this.at('poker')) this.io.send(s.id, 'poker', this.pokerView(s));
    if (group === 'wolf') for (const s of this.at('wolf')) this.io.send(s.id, 'wolf', this.wolfView(s));
    if (group === 'pho') for (const s of this.at('pho')) this.io.send(s.id, 'pho', this.phoView(s));
  }

  /** Call after someone sits, stands, or disconnects (with their seat already updated or cleared). */
  seatChanged(p: Sitter, before: string | null) {
    const was = seatGroup(before);
    const now = seatGroup(p.seat);
    if (was === 'cards' && now !== 'cards') this.leaveCards(p.id);
    if (was === 'poker' && now !== 'poker') pokerLeave(this.poker, p.id);
    if (was === 'wolf' && now !== 'wolf') this.announceWolf(() => wolfLeave(this.wolf, p.id, Date.now()));
    if (was === 'pho' && now !== 'pho') this.announcePho(() => phoLeave(this.pho, p.id));
    this.refresh(was);
    if (now !== was) this.refresh(now);
  }

  action(p: Sitter, table: string, a: unknown) {
    if (seatGroup(p.seat) !== table || !a || typeof a !== 'object') return;
    const act = a as Record<string, unknown>;
    if (table === 'chess') this.chessAction(p, act);
    else if (table === 'cards') this.cardsAction(p, act);
    else if (table === 'poker') this.pokerAction(p, act);
    else if (table === 'wolf') this.wolfAction(p, act);
    else if (table === 'pho') this.phoAction(p, act);
  }

  // ------------------------------------------------------------ chess

  private chessView(s: Sitter): ChessView {
    const sitters = this.at('chess');
    const c = this.chess;
    return {
      fen: c.fen(),
      white: sitters.find((x) => x.seat === WHITE_SEAT)?.name ?? null,
      black: sitters.find((x) => x.seat === BLACK_SEAT)?.name ?? null,
      last: this.chessLast,
      status: c.isCheckmate() ? 'checkmate' : c.isStalemate() ? 'stalemate' : c.isDraw() ? 'draw' : 'playing',
      you: s.seat === WHITE_SEAT ? 'w' : s.seat === BLACK_SEAT ? 'b' : null,
    };
  }

  private chessAction(p: Sitter, a: Record<string, unknown>) {
    const side = p.seat === WHITE_SEAT ? 'w' : p.seat === BLACK_SEAT ? 'b' : null;
    if (!side) return; // watchers can't touch the board
    if (a.k === 'new') {
      this.chess = new Chess();
      this.chessLast = null;
    } else if (a.k === 'move' && typeof a.from === 'string' && typeof a.to === 'string') {
      if (this.chess.turn() !== side || this.chess.isGameOver()) return;
      try {
        // Pawns reaching the last rank become queens.
        this.chess.move({ from: a.from, to: a.to, promotion: 'q' });
      } catch {
        return; // not a legal move
      }
      this.chessLast = { from: a.from, to: a.to };
      if (this.chess.isCheckmate()) this.io.notice(`${p.name} won at chess by checkmate`);
    } else {
      return;
    }
    this.refresh('chess');
  }

  // ------------------------------------------------------------ Last Card

  private cardsView(s: Sitter): CardsView {
    const g = this.cards;
    if (!g) {
      return {
        phase: 'lobby',
        players: this.at('cards').map((x) => ({ id: x.id, name: x.name, count: 0 })),
        turn: null,
        top: null,
        suit: null,
        pending: 0,
        dir: 1,
        hand: [],
        winner: null,
        you: s.id,
      };
    }
    return {
      phase: g.phase,
      players: g.order.map((id) => ({ id, name: g.names[id], count: g.hands[id]?.length ?? 0 })),
      turn: g.phase === 'play' ? currentPlayer(g) : null,
      top: topCard(g),
      suit: g.suit,
      pending: g.pending,
      dir: g.dir,
      hand: g.hands[s.id] ?? [],
      winner: g.winner ? g.names[g.winner] : null,
      you: s.id,
    };
  }

  private leaveCards(id: string) {
    const g = this.cards;
    if (!g || g.phase !== 'play' || !g.order.includes(id)) return;
    if (!removePlayer(g, id)) this.cards = null; // not enough people left: back to the lobby
  }

  private cardsAction(p: Sitter, a: Record<string, unknown>) {
    const g = this.cards;
    if (a.k === 'start') {
      if (g && g.phase === 'play') return;
      const players = this.at('cards');
      if (players.length < 2) return;
      this.cards = startCards(players.map((x) => ({ id: x.id, name: x.name })));
    } else if (a.k === 'play' && g && typeof a.card === 'string') {
      if (!playCard(g, p.id, a.card, typeof a.suit === 'string' ? a.suit : undefined)) return;
      if (g.winner) this.io.notice(`${p.name} won at Last Card`);
    } else if (a.k === 'draw' && g) {
      if (!drawCard(g, p.id)) return;
    } else {
      return;
    }
    this.refresh('cards');
  }

  // ------------------------------------------------------------ poker

  private pokerView(s: Sitter): PokerView {
    const g = this.poker;
    const seated = this.at('poker');
    const mine = g.seats.find((x) => x.id === s.id);
    const myTurn = betting(g) && g.seats[g.turn]?.id === s.id;
    const max = mine ? mine.bet + mine.chips : 0;
    return {
      phase: g.phase,
      players: g.seats.map((x, i) => ({
        id: x.id,
        name: x.name,
        chips: x.chips,
        bet: x.bet,
        folded: x.folded,
        allIn: x.allIn,
        dealer: i === g.dealer,
        hole: x.id === s.id || (g.shown && !x.folded) ? x.hole : null,
      })),
      waiting: seated.filter((x) => !g.seats.some((y) => y.id === x.id)).map((x) => x.name),
      board: g.board,
      pot: potOf(g),
      turn: betting(g) ? (g.seats[g.turn]?.id ?? null) : null,
      toCall: myTurn && mine ? Math.min(g.currentBet - mine.bet, mine.chips) : 0,
      raise: myTurn && mine && max > g.currentBet ? { min: Math.min(g.currentBet + g.minRaise, max), max } : null,
      results: g.results,
      seated: seated.length,
      you: s.id,
    };
  }

  private pokerAction(p: Sitter, a: Record<string, unknown>) {
    const g = this.poker;
    if (a.k === 'deal') {
      if (!pokerStart(g, this.at('poker').map((x) => ({ id: x.id, name: x.name })))) return;
    } else if (a.k === 'fold' || a.k === 'call' || (a.k === 'raise' && typeof a.to === 'number' && Number.isFinite(a.to))) {
      if (!pokerAct(g, p.id, a as PokerAction)) return;
    } else {
      return;
    }
    this.refresh('poker');
  }

  // ------------------------------------------------------------ Werewolf

  /** Run a change and tell the whole room if it ended the game. */
  private announceWolf(change: () => void) {
    const before = this.wolf.winner;
    change();
    if (!before && this.wolf.winner) {
      this.io.notice(this.wolf.winner === 'village' ? 'Werewolf: the village won' : 'Werewolf: the werewolves won');
    }
  }

  private wolfView(s: Sitter): WolfView {
    const g = this.wolf;
    const me = g.players.find((p) => p.id === s.id);
    const name = (id: string) => (id === 'skip' ? 'nobody' : (g.players.find((p) => p.id === id)?.name ?? '?'));
    const over = g.phase === 'over';
    const iAmWolf = me?.role === 'werewolf';
    // You may know a role if it is yours, the person is out, the game is over, you are out
    // yourself (you watch as a ghost), or you are both werewolves.
    const knows = (p: { id: string; alive: boolean; role: string }) =>
      p.id === s.id || !p.alive || over || (me && !me.alive) || (iAmWolf && p.role === 'werewolf');

    let can: WolfView['night']['can'] = null;
    let done = false;
    if (g.phase === 'night' && me?.alive) {
      if (me.role === 'werewolf') (can = 'kill'), (done = !!g.kills[me.id]);
      else if (me.role === 'seer') (can = 'look'), (done = g.inspected);
      else if (me.role === 'doctor') (can = 'protect'), (done = g.protect !== null);
    }
    return {
      phase: g.phase,
      round: g.round,
      players: g.players.map((p) => ({ id: p.id, name: p.name, alive: p.alive, role: knows(p) ? p.role : null })),
      you: s.id,
      yourRole: me?.role ?? null,
      alive: !!me?.alive,
      night: {
        can,
        done,
        // Only werewolves see which victims the pack has picked.
        picks: iAmWolf && g.phase === 'night' ? Object.entries(g.kills).map(([by, t]) => ({ by: name(by), target: name(t) })) : [],
      },
      notes: me?.role === 'seer' ? g.notes : [],
      votes: g.phase === 'day' ? Object.entries(g.votes).map(([by, t]) => ({ by: name(by), target: name(t) })) : [],
      myVote: g.votes[s.id] ?? null,
      log: g.log.slice(-8),
      winner: g.winner,
      seated: this.at('wolf').length,
      forceIn: g.phase === 'night' || g.phase === 'day' ? Math.max(0, g.since + FORCE_AFTER_MS - Date.now()) : 0,
    };
  }

  private wolfAction(p: Sitter, a: Record<string, unknown>) {
    const g = this.wolf;
    const now = Date.now();
    let ok = false;
    this.announceWolf(() => {
      if (a.k === 'start') ok = wolfStart(g, this.at('wolf').map((x) => ({ id: x.id, name: x.name })), now);
      else if (a.k === 'night' && typeof a.target === 'string') ok = wolfNight(g, p.id, a.target, now);
      else if (a.k === 'vote' && typeof a.target === 'string') ok = wolfVote(g, p.id, a.target, now);
      else if (a.k === 'force') ok = wolfForce(g, p.id, now);
    });
    if (ok) this.refresh('wolf');
  }

  // ------------------------------------------------------------ Phố Lớn

  private announcePho(change: () => void) {
    const before = this.pho.winner;
    change();
    if (!before && this.pho.winner) this.io.notice(`${this.pho.names[this.pho.winner]} won at Phố Lớn`);
  }

  private phoView(s: Sitter): PhoView {
    const g = this.pho;
    return { ...g, log: g.log.slice(-8), winner: g.winner ? g.names[g.winner] : null, you: s.id, seated: this.at('pho').length };
  }

  private phoAction(p: Sitter, a: Record<string, unknown>) {
    const g = this.pho;
    let ok = false;
    this.announcePho(() => {
      if (a.k === 'start') ok = phoStart(g, this.at('pho').map((x) => ({ id: x.id, name: x.name })));
      else if (a.k === 'roll') ok = phoRoll(g, p.id);
      else if (a.k === 'buy') ok = phoBuy(g, p.id, a.yes === true);
      else if (a.k === 'build' && typeof a.space === 'number') ok = phoBuild(g, p.id, a.space);
      else if (a.k === 'end') ok = phoEnd(g, p.id);
      else if (a.k === 'finish') ok = phoFinish(g, p.id);
    });
    if (ok) this.refresh('pho');
  }
}
