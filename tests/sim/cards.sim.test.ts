// Randomised Last Card simulation: whole games played through the pure rules with a seeded generator,
// mixing sensible play with illegal actions, walk-outs, skips and rematches, and checking invariants
// after every step.
//
//   SIM_RUNS=50000 npx vitest run tests/sim/cards.sim.test.ts     play at least that many games
//   SIM_SEED=1234 SIM_RUNS=1 npx vitest run tests/sim/cards.sim.test.ts     replay one failing session
import { expect, test } from 'vitest';
import {
  RANKS,
  SKIP_AFTER_MS,
  SUITS,
  canPlay,
  cardsSkipIn,
  currentPlayer,
  drawCard,
  playCard,
  removePlayer,
  skipTurn,
  startCards,
  topCard,
  type Card,
  type CardsGame,
} from '../../shared/cards';

// No Node typings in this project, so reach for the environment by hand.
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const RUNS = Math.max(1, Number(env.SIM_RUNS) || 3000);
const SEED = Number(env.SIM_SEED) || 1;

/** A small seeded generator (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FULL_DECK: Card[] = [];
for (const s of SUITS) for (const r of RANKS) FULL_DECK.push(r + s);

interface Stats {
  games: number;
  steps: number;
  plays: number;
  draws: number;
  refused: number;
  won: number;
  abandoned: number;
  leaves: number;
  skips: number;
  reshuffles: number;
  penalties: number;
  biggestPenalty: number;
  emptyDraws: number;
  twoDecks: number;
  longestGame: number;
}

/** Steps after which everyone plays a card whenever they can, so the game has to finish. */
const SENSIBLE_AFTER = 400;
/** The most steps a game may take before the test calls it stuck. */
const STEP_LIMIT = 6000;

function session(seed: number, stats: Stats) {
  const rnd = rng(seed);
  const int = (n: number) => Math.floor(rnd() * n);
  const pick = <T>(list: T[]) => list[int(list.length)];
  const trail: string[] = [];
  let g: CardsGame = null as unknown as CardsGame;
  let now = 1_000_000 + int(1000);
  let game = 0;

  const fail = (msg: string): never => {
    throw new Error(
      `Last Card sim failed, seed ${seed} (replay: SIM_SEED=${seed} SIM_RUNS=1), game ${game}: ${msg}\nlast steps:\n  ${trail.slice(-25).join('\n  ')}\nstate: ${JSON.stringify(g)}`,
    );
  };
  const must = (ok: boolean, msg: string) => {
    if (!ok) fail(msg);
  };
  const refused = (what: string, run: () => boolean) => {
    const before = JSON.stringify(g);
    let ok: boolean;
    try {
      ok = run();
    } catch (e) {
      return fail(`${what} threw: ${(e as Error).message}`);
    }
    trail.push(`refused? ${what} -> ${ok}`);
    must(ok === false, `${what} was accepted`);
    must(JSON.stringify(g) === before, `${what} was refused but changed the game`);
    stats.refused++;
  };

  const pool = Array.from({ length: 2 + int(pick([2, 4, 7])) }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
  // Each session has its own temper: how often people walk out, get skipped, or draw when they could play.
  const pLeave = pick([0, 0.003, 0.01, 0.04]);
  const pSkip = pick([0.01, 0.05, 0.15]);
  const pDraw = pick([0, 0.1, 0.3, 0.7, 0.97]);
  let decks = 1;
  /** Everybody sitting at the table, including people waiting for the next game. */
  let seated = new Set<string>();

  /** Every card, wherever it is: must always be exactly the deck (or two) the game started with. */
  const checkCards = () => {
    const all = [...g.drawPile, ...g.discard, ...Object.values(g.hands).flat()];
    must(all.length === 52 * decks, `${all.length} cards in the game, expected ${52 * decks}`);
    const count = new Map<string, number>();
    for (const c of all) count.set(c, (count.get(c) ?? 0) + 1);
    for (const c of FULL_DECK) must(count.get(c) === decks, `${count.get(c) ?? 0} copies of ${c}, expected ${decks}`);
  };

  const check = () => {
    stats.steps++;
    checkCards();
    must(g.discard.length >= 1, 'empty discard pile');
    must((SUITS as readonly string[]).includes(g.suit), `suit to follow is ${g.suit}`);
    must(g.dir === 1 || g.dir === -1, `direction ${g.dir}`);
    must(Number.isInteger(g.pending) && g.pending >= 0 && g.pending % 2 === 0 && g.pending <= 8 * decks, `${g.pending} cards owed`);
    // A penalty only ever stands while the 2 that caused it is on top.
    if (g.pending > 0) must(topCard(g)[0] === '2', `${g.pending} cards owed but the top card is ${topCard(g)}`);
    if (topCard(g)[0] !== '8') must(g.suit === topCard(g)[1], `suit to follow is ${g.suit} on a ${topCard(g)}`);
    must(new Set(g.order).size === g.order.length, 'someone is in the turn order twice');
    must(Object.keys(g.hands).length === g.order.length && g.order.every((id) => Array.isArray(g.hands[id])), 'hands and turn order disagree');
    must(g.order.every((id) => seated.has(id)), 'someone in the turn order is not at the table');
    must(cardsSkipIn(g, now) >= 0 && cardsSkipIn(g, now) <= SKIP_AFTER_MS, 'skip countdown out of range');
    if (g.phase === 'play') {
      must(g.winner === null, 'a winner during play');
      must(g.order.length >= 2, 'a game going on with fewer than two players');
      must(Number.isInteger(g.turn) && g.turn >= 0 && g.turn < g.order.length, `turn ${g.turn} of ${g.order.length}`);
      for (const id of g.order) must(g.hands[id].length > 0, `${id} has no cards but the game goes on`);
      must(g.turnSince <= now, 'turn clock is in the future');
    } else {
      must(g.phase === 'over', `phase ${g.phase}`);
      must(g.winner !== null && g.order.includes(g.winner) && g.hands[g.winner].length === 0, 'the winner still holds cards');
      for (const id of g.order) if (id !== g.winner) must(g.hands[id].length > 0, `${id} also has no cards`);
      must(cardsSkipIn(g, now) === 0, 'skip countdown running after the game');
    }
  };

  /** Who should be next, worked out independently of the rules: `steps` seats on from seat `from`. */
  const seatAfter = (order: string[], from: number, dir: number, steps: number) => order[(((from + dir * steps) % order.length) + order.length) % order.length];

  const playGame = () => {
    game++;
    // People come and go between games.
    for (const p of pool) if (rnd() < 0.15) seated.has(p.id) ? seated.delete(p.id) : seated.add(p.id);
    while (seated.size < 2) seated.add(pick(pool).id);
    const players = pool.filter((p) => seated.has(p.id));
    decks = players.length > 5 ? 2 : 1;
    g = startCards(players, now);
    trail.push(`deal to ${players.map((p) => p.id).join(' ')}`);
    stats.games++;
    if (decks === 2) stats.twoDecks++;
    must(g.phase === 'play' && g.turn === 0 && g.pending === 0 && g.dir === 1, 'bad opening state');
    must(g.order.length === players.length && players.every((p) => g.order.includes(p.id)), 'not everyone was dealt in');
    must(g.order.every((id) => g.hands[id].length === (decks === 2 ? 5 : 7)), 'wrong opening hand size');
    must(g.discard.length === 1 && !['2', '8', 'J', 'A'].includes(topCard(g)[0]), `the game opens on ${topCard(g)}`);
    must(g.turnSince === now, 'turn clock not started at the deal');
    check();

    let steps = 0;
    let abandoned = false;
    while (g.phase === 'play' && !abandoned) {
      if (++steps > STEP_LIMIT) fail(`the game did not end within ${STEP_LIMIT} steps`);
      now += rnd() < 0.5 ? int(3000) : int(70_000);
      const sensible = steps > SENSIBLE_AFTER;
      const me = currentPlayer(g);
      const hand = g.hands[me];
      const top = topCard(g);
      // What may be played, decided here rather than by the rules.
      const legal = (c: Card) => (g.pending > 0 ? c[0] === '2' : c[0] === '8' || c[1] === g.suit || c[0] === top[0]);
      const playable = hand.filter(legal);
      for (const c of hand) must(canPlay(g, c) === legal(c), `canPlay(${c}) on ${top} (suit ${g.suit}, owed ${g.pending}) is ${canPlay(g, c)}`);
      const roll = sensible ? 1 : rnd();
      const drawAnyway = !sensible && rnd() < pDraw;
      const snap = { order: [...g.order], turn: g.turn, dir: g.dir, pending: g.pending, since: g.turnSince, n: g.order.length };
      const available = g.drawPile.length + g.discard.length - 1;

      if (roll < pLeave) {
        // Somebody walks away: sometimes the player whose turn it is.
        const who = rnd() < 0.4 ? me : pick(g.order);
        const others = g.order.filter((id) => id !== who).map((id) => [id, [...g.hands[id]].sort().join()] as const);
        const theirs = g.hands[who].length;
        const pileBefore = g.discard.length;
        seated.delete(who);
        const goesOn = removePlayer(g, who, now);
        trail.push(`${who} leaves -> ${goesOn}`);
        stats.leaves++;
        must(goesOn === snap.n > 2, `removePlayer said ${goesOn} with ${snap.n - 1} left`);
        must(!g.order.includes(who) && !(who in g.hands), 'a player who left is still in the game');
        for (const [id, cards] of others) must([...g.hands[id]].sort().join() === cards, `${id}'s hand changed when ${who} left`);
        must(g.discard.length === pileBefore + theirs && topCard(g) === top, 'the cards of a player who left did not go under the pile');
        must(g.pending === snap.pending && g.dir === snap.dir, 'a walk-out changed the penalty or the direction');
        checkCards();
        if (!goesOn) {
          // Not enough people: the table goes back to the lobby.
          abandoned = true;
          stats.abandoned++;
          break;
        }
        if (who === me) {
          must(currentPlayer(g) === seatAfter(snap.order, snap.turn, snap.dir, 1), 'the turn did not pass to the next player when the player to act left');
          must(g.turnSince === now, 'turn clock not restarted after the player to act left');
        } else {
          must(currentPlayer(g) === me, 'the turn moved when someone else left');
          must(g.turnSince === snap.since, 'someone else leaving restarted the turn clock');
        }
        refused('a move by someone who left', () => (rnd() < 0.5 ? drawCard(g, who, now) : playCard(g, who, pick(FULL_DECK), undefined, now)));
        refused('leaving twice', () => !removePlayer(g, who, now));
      } else if (roll < pLeave + 0.02) {
        seated.add(pick(pool).id); // sits down mid-game and waits
        trail.push('someone sits down');
      } else if (roll < pLeave + 0.12) {
        const kind = int(13);
        const other = pick(g.order.filter((id) => id !== me));
        if (kind === 0) refused(`${other} playing out of turn`, () => playCard(g, other, pick(g.hands[other]), pick([...SUITS, undefined]), now));
        else if (kind === 1) refused(`${other} drawing out of turn`, () => drawCard(g, other, now));
        else if (kind === 2) refused('a stranger playing', () => playCard(g, pick(['', 'nobody', 'toString', '__proto__']), pick(FULL_DECK), undefined, now));
        else if (kind === 3) refused('a stranger drawing', () => drawCard(g, pick(['', 'nobody', 'constructor']), now));
        else if (kind === 4) {
          const notHeld = FULL_DECK.filter((c) => !hand.includes(c));
          refused('playing a card not held', () => playCard(g, me, pick(notHeld), undefined, now));
        } else if (kind === 5) {
          const bad = hand.filter((c) => !legal(c));
          if (bad.length) refused('playing a card that does not match', () => playCard(g, me, pick(bad), pick([...SUITS, undefined]), now));
        } else if (kind === 6) refused('playing garbage', () => playCard(g, me, pick([null, undefined, 42, '', 'ZZ', '8', {}, ['8S'], '8SS']) as unknown as Card, 'S', now));
        else if (kind === 7) refused('skipping too early', () => skipTurn(g, other, g.turnSince + int(SKIP_AFTER_MS), [...seated]));
        else if (kind === 8) refused('skipping yourself', () => skipTurn(g, me, g.turnSince + SKIP_AFTER_MS + int(100_000), [...seated]));
        else if (kind === 9) refused('a skip from someone not at the table', () => skipTurn(g, other, g.turnSince + SKIP_AFTER_MS + int(100_000), [...seated].filter((id) => id !== other)));
        else if (kind === 10) refused('a skip from a stranger', () => skipTurn(g, 'nobody', g.turnSince + SKIP_AFTER_MS + 1, [...seated]));
        else if (kind === 11) refused('a skip with a garbage clock', () => skipTurn(g, other, pick([NaN, -1, undefined as unknown as number, 0]), [...seated]));
        else refused('a skip with no table list', () => skipTurn(g, other, g.turnSince + SKIP_AFTER_MS, undefined as unknown as string[]));
      } else if (roll < pLeave + 0.12 + pSkip || playable.length === 0 || drawAnyway) {
        // Draw: by choice, because nothing can be played, or because someone else skips this player.
        const skipped = roll < pLeave + 0.12 + pSkip;
        const owed = g.pending || 1;
        const had = hand.length;
        const others = g.order.filter((id) => id !== me).map((id) => [id, g.hands[id].join()] as const);
        const pileBefore = g.drawPile.length;
        if (skipped) {
          // Anyone else sitting at the table may do it, including someone waiting for the next game.
          const by = pick([...seated].filter((id) => id !== me));
          now = Math.max(now, g.turnSince + SKIP_AFTER_MS + (rnd() < 0.3 ? 0 : int(60_000)));
          must(cardsSkipIn(g, now) === 0, 'skip countdown not finished');
          must(skipTurn(g, by, now, [...seated]) === true, `a late skip of ${me} by ${by} was refused`);
          trail.push(`${by} skips ${me} (draws ${owed})`);
          stats.skips++;
        } else {
          must(drawCard(g, me, now) === true, `${me} could not draw`);
          trail.push(`${me} draws ${owed}`);
          stats.draws++;
        }
        const got = g.hands[me].length - had;
        must(got === Math.min(owed, available), `${me} drew ${got}, owed ${owed} with ${available} available`);
        if (got < owed) stats.emptyDraws++;
        if (pileBefore < owed && available > pileBefore) stats.reshuffles++;
        if (snap.pending) {
          stats.penalties++;
          stats.biggestPenalty = Math.max(stats.biggestPenalty, snap.pending);
        }
        must(g.pending === 0, 'the penalty was not cleared by drawing');
        must(topCard(g) === top && g.dir === snap.dir, 'drawing changed the top card or the direction');
        for (const [id, cards] of others) must(g.hands[id].join() === cards, `${id}'s hand changed when ${me} drew`);
        must(currentPlayer(g) === seatAfter(snap.order, snap.turn, snap.dir, 1), 'the turn did not pass to the next player after a draw');
        must(g.turnSince === now, 'turn clock not restarted after a draw');
      } else {
        const card = pick(playable);
        const chosen = pick([...SUITS, ...SUITS, undefined, 'X', '', 'spades']) as string | undefined;
        const had = hand.length;
        must(playCard(g, me, card, chosen, now) === true, `${me} could not play ${card} on ${top} (suit ${g.suit}, owed ${snap.pending})`);
        trail.push(`${me} plays ${card}${card[0] === '8' ? ` as ${chosen}` : ''} on ${top}`);
        stats.plays++;
        must(topCard(g) === card && g.hands[me].length === had - 1, 'the played card did not go on the pile');
        const wild = card[0] === '8' && (SUITS as readonly string[]).includes(chosen ?? '');
        must(g.suit === (wild ? chosen : card[1]), `suit to follow is ${g.suit} after ${card} with choice ${chosen}`);
        if (had === 1) {
          must((g.phase as string) === 'over' && g.winner === me, 'playing the last card did not win');
        } else {
          must((g.phase as string) === 'play', 'the game ended with cards still held');
          must(g.pending === snap.pending + (card[0] === '2' ? 2 : 0), 'wrong penalty after the play');
          must(g.dir === (card[0] === 'A' ? -snap.dir : snap.dir), 'wrong direction after the play');
          // A Jack skips one player. An Ace turns the order round; with two players that means you go again.
          const steps2 = card[0] === 'J' ? 2 : card[0] === 'A' && snap.n === 2 ? 0 : 1;
          must(currentPlayer(g) === seatAfter(snap.order, snap.turn, g.dir, steps2), `wrong player to act after ${card}`);
          must(g.turnSince === now, 'turn clock not restarted after a play');
        }
      }
      check();
    }
    stats.longestGame = Math.max(stats.longestGame, steps);
    if (g.phase === 'over') {
      stats.won++;
      const anyone = pick(g.order);
      refused('playing after the game', () => playCard(g, anyone, pick(FULL_DECK), undefined, now));
      refused('drawing after the game', () => drawCard(g, anyone, now));
      refused('skipping after the game', () => skipTurn(g, anyone, now + 10 * SKIP_AFTER_MS, [...seated]));
    }
  };

  // Shuffles use Math.random: make them repeatable for this seed.
  const realRandom = Math.random;
  Math.random = rnd;
  try {
    seated = new Set(pool.filter(() => rnd() < 0.8).map((p) => p.id));
    const games = 1 + int(4);
    for (let i = 0; i < games; i++) playGame();
  } finally {
    Math.random = realRandom;
  }
}

test(`Last Card: at least ${RUNS} random games keep every invariant (first seed ${SEED})`, () => {
  const stats: Stats = { games: 0, steps: 0, plays: 0, draws: 0, refused: 0, won: 0, abandoned: 0, leaves: 0, skips: 0, reshuffles: 0, penalties: 0, biggestPenalty: 0, emptyDraws: 0, twoDecks: 0, longestGame: 0 };
  const started = Date.now();
  let sessions = 0;
  while (stats.games < RUNS) session(SEED + sessions++, stats);
  console.log(`Last Card sim: ${stats.games} games in ${sessions} sessions, ${((Date.now() - started) / 1000).toFixed(1)}s`, JSON.stringify(stats));
  expect(stats.won + stats.abandoned).toBe(stats.games);
  // The simulation is only worth something if it reaches the interesting situations.
  if (RUNS >= 1000) {
    expect(stats.won).toBeGreaterThan(RUNS / 4);
    expect(stats.abandoned).toBeGreaterThan(0);
    expect(stats.reshuffles).toBeGreaterThan(0);
    expect(stats.penalties).toBeGreaterThan(RUNS / 2);
    expect(stats.biggestPenalty).toBeGreaterThanOrEqual(4);
    expect(stats.emptyDraws).toBeGreaterThan(0);
    expect(stats.skips).toBeGreaterThan(RUNS / 2);
    expect(stats.leaves).toBeGreaterThan(RUNS / 10);
    expect(stats.twoDecks).toBeGreaterThan(0);
  }
}, 600_000);
