// Football match: two teams, a four-minute clock, a kick-off pause after every goal, and next-goal-wins if level.
// Rules only: no browser or server code in this file. The ball itself is the room's (shared/ball.ts).
import { PITCH } from '../layout';

export type Side = 'red' | 'blue';
export const other = (s: Side): Side => (s === 'red' ? 'blue' : 'red');

export const CUP_MIN = 2;
/** Playing time. The clock stops during the pause before each kick-off. */
export const MATCH_MS = 4 * 60_000;
/** If level at full time: this long for one more goal, which wins it. */
export const EXTRA_MS = 60_000;
/** Players are rooted for this long before every kick-off. */
export const PAUSE_MS = 3_000;

export interface CupPlayer {
  id: string;
  name: string;
  team: Side;
}
export interface CupScorer {
  name: string;
  team: Side;
  goals: number;
}
export interface CupResult {
  /** Counts up so a browser can tell a new result from one it has already shown. */
  n: number;
  winner: Side | null;
  score: [number, number];
  /** Ids of the winning team when the whistle went, for the confetti. */
  winners: string[];
  /** Names of whoever scored most (several if tied, none if nobody scored). */
  top: string[];
  topGoals: number;
  forfeit: boolean;
}

export interface CupGame {
  /** Who is playing, in the order they joined. */
  players: CupPlayer[];
  /** 'kickoff' is the rooted pause before play starts or restarts. */
  phase: 'lobby' | 'kickoff' | 'play';
  /** In 'kickoff': when the pause ends. In 'play': when the clock runs out (server clock). */
  until: number;
  /** Playing time left, kept here while the clock is stopped for a kick-off. */
  remaining: number;
  /** True once full time has passed level: the next goal wins. */
  extra: boolean;
  /** [red, blue]. Counted here, not read from the room's scoreboard. */
  score: [number, number];
  scorers: CupScorer[];
  /** The last goal, for the panel. */
  last: { by: string; side: Side; own: boolean } | null;
  result: CupResult | null;
}

export const newCup = (): CupGame => ({ players: [], phase: 'lobby', until: 0, remaining: 0, extra: false, score: [0, 0], scorers: [], last: null, result: null });

export const cupTeam = (g: CupGame, side: Side) => g.players.filter((p) => p.team === side);
const count = (g: CupGame, side: Side) => cupTeam(g, side).length;
const has = (g: CupGame, id: string) => g.players.some((p) => p.id === id);
const live = (g: CupGame) => g.phase !== 'lobby';

/** Move the most recent arrivals across until the sides are within one of each other. */
function balance(g: CupGame) {
  for (;;) {
    const r = count(g, 'red');
    const b = count(g, 'blue');
    if (Math.abs(r - b) <= 1) return;
    const big: Side = r > b ? 'red' : 'blue';
    cupTeam(g, big).pop()!.team = other(big);
  }
}

/** Join, on whichever side is short (Red if level). Allowed during a match too. */
export function cupJoin(g: CupGame, p: { id: string; name: string }): boolean {
  if (has(g, p.id)) return false;
  g.players.push({ id: p.id, name: p.name, team: count(g, 'blue') < count(g, 'red') ? 'blue' : 'red' });
  return true;
}

/** Switch sides in the lobby, if that leaves the sides within one of each other. */
export function cupSwitch(g: CupGame, id: string): boolean {
  const p = g.players.find((x) => x.id === id);
  if (!p || live(g)) return false;
  const mine = count(g, p.team) - 1;
  const theirs = count(g, other(p.team)) + 1;
  if (Math.abs(mine - theirs) > 1) return false;
  p.team = other(p.team);
  return true;
}

/** Re-deal the teams at random. `rnd` is injectable so tests are repeatable. */
export function cupShuffle(g: CupGame, by: string, rnd: () => number = Math.random): boolean {
  if (live(g) || !has(g, by) || g.players.length < 2) return false;
  const deck = [...g.players];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(rnd() * (i + 1)));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  // With an odd number, which side gets the extra player is random too.
  const first: Side = rnd() < 0.5 ? 'red' : 'blue';
  deck.forEach((p, i) => (p.team = i % 2 === 0 ? first : other(first)));
  return true;
}

/** Anyone playing may kick off, once there is at least one a side. */
export function cupKickoff(g: CupGame, by: string, now: number): boolean {
  if (live(g) || !has(g, by) || g.players.length < CUP_MIN) return false;
  balance(g);
  Object.assign(g, { phase: 'kickoff', until: now + PAUSE_MS, remaining: MATCH_MS, extra: false, score: [0, 0], scorers: [], last: null, result: null });
  return true;
}

/** Where everyone stands for a kick-off: columns in their own half, facing the centre spot. */
export function cupSpots(g: CupGame): { id: string; x: number; z: number }[] {
  const out: { id: string; x: number; z: number }[] = [];
  for (const side of ['red', 'blue'] as const) {
    const team = cupTeam(g, side);
    const cols = Math.max(1, Math.ceil(team.length / 3));
    // The half is 18 long; keep the front column 3 back from the ball and the last one off the goal line.
    const step = Math.min(4, 13 / cols);
    team.forEach((p, i) => {
      const col = Math.floor(i / 3);
      const inCol = Math.min(3, team.length - col * 3);
      const back = 3 + col * step;
      out.push({ id: p.id, x: PITCH.cx + (side === 'red' ? -back : back), z: PITCH.cz + ((i % 3) - (inCol - 1) / 2) * 4 });
    });
  }
  return out;
}

function finish(g: CupGame, winner: Side | null, forfeit = false) {
  const most = Math.max(0, ...g.scorers.map((s) => s.goals));
  g.result = {
    n: (g.result?.n ?? 0) + 1,
    winner,
    score: [g.score[0], g.score[1]],
    winners: winner ? cupTeam(g, winner).map((p) => p.id) : [],
    top: most ? g.scorers.filter((s) => s.goals === most).map((s) => s.name) : [],
    topGoals: most,
    forfeit,
  };
  Object.assign(g, { phase: 'lobby', until: 0, remaining: 0, extra: false });
  // People may have left mid-match; even the sides up for the next one.
  balance(g);
}

/**
 * The ball went in for `side`; `by` is the last kicker's name. Goals outside open play are ignored.
 * Returns 'goal' (play restarts after a pause), 'final' (it decided the match) or null (ignored).
 */
export function cupGoal(g: CupGame, side: unknown, by: unknown, now: number): 'goal' | 'final' | null {
  if (g.phase !== 'play' || (side !== 'red' && side !== 'blue')) return null;
  const name = typeof by === 'string' && by ? by : 'Someone';
  g.score[side === 'red' ? 0 : 1]++;
  // Putting it in your own net counts for the other side but not towards top scorer.
  const kicker = g.players.find((p) => p.name === name);
  const own = !!kicker && kicker.team !== side;
  if (!own) {
    const s = g.scorers.find((x) => x.name === name && x.team === side);
    if (s) s.goals++;
    else g.scorers.push({ name, team: side, goals: 1 });
  }
  g.last = { by: name, side, own };
  if (g.extra) {
    finish(g, side);
    return 'final';
  }
  g.remaining = Math.max(0, g.until - now);
  g.phase = 'kickoff';
  g.until = now + PAUSE_MS;
  return 'goal';
}

/**
 * Time passing. Returns 'play' when a kick-off pause ends, 'extra' when full time arrives level,
 * 'final' when the match is over, or null if nothing changed.
 */
export function cupTick(g: CupGame, now: number): 'play' | 'extra' | 'final' | null {
  if (g.phase === 'kickoff' && now >= g.until) {
    g.phase = 'play';
    g.until = now + g.remaining;
    return 'play';
  }
  if (g.phase !== 'play' || now < g.until) return null;
  const [r, b] = g.score;
  if (r === b && !g.extra) {
    g.extra = true;
    g.until = now + EXTRA_MS;
    return 'extra';
  }
  finish(g, r > b ? 'red' : b > r ? 'blue' : null);
  return 'final';
}

/**
 * Someone left the game or the room. Returns 'final' if that ended a match (a side with nobody
 * left forfeits), 'left' if they were simply removed, or null if they were not playing.
 */
export function cupLeave(g: CupGame, id: string): 'left' | 'final' | null {
  const i = g.players.findIndex((p) => p.id === id);
  if (i < 0) return null;
  const { team } = g.players[i];
  g.players.splice(i, 1);
  if (!live(g)) {
    balance(g);
    return 'left';
  }
  if (count(g, team)) return 'left';
  // Nobody at all left: there is no one to award it to, so just stop.
  if (!g.players.length) Object.assign(g, { phase: 'lobby', until: 0, remaining: 0, extra: false });
  else finish(g, other(team), true);
  return 'final';
}

/** The line announced at the end of a match. */
export function cupSummary(r: CupResult): string {
  const [red, blue] = r.score;
  const cap = (s: Side) => (s === 'red' ? 'Red' : 'Blue');
  const top = r.top.length ? ` Top scorer: ${r.top.join(' and ')} (${r.topGoals}).` : '';
  if (r.forfeit && r.winner) return `${cap(other(r.winner))} have nobody left, so ${cap(r.winner)} win by forfeit, Red ${red} – ${blue} Blue.${top}`;
  return `Full time: Red ${red} – ${blue} Blue. ${r.winner ? `${cap(r.winner)} win!` : 'It is a draw.'}${top}`;
}

/** What everyone sees. Nothing in this game is secret. */
export interface CupView {
  players: CupPlayer[];
  phase: CupGame['phase'];
  extra: boolean;
  score: [number, number];
  /** Milliseconds of rooted pause left before the kick-off (0 unless phase is 'kickoff'). */
  pause: number;
  /** Milliseconds of playing time left; it only runs down while phase is 'play'. */
  clock: number;
  scorers: CupScorer[];
  last: CupGame['last'];
  result: CupResult | null;
}

export const cupView = (g: CupGame, now: number): CupView => ({
  players: g.players,
  phase: g.phase,
  extra: g.extra,
  score: g.score,
  pause: g.phase === 'kickoff' ? Math.max(0, g.until - now) : 0,
  clock: g.phase === 'play' ? Math.max(0, g.until - now) : g.phase === 'kickoff' ? g.remaining : 0,
  scorers: g.scorers,
  last: g.last,
  result: g.result,
});

/** What a browser may send. */
export type CupAction = { k: 'join' } | { k: 'leave' } | { k: 'switch' } | { k: 'shuffle' } | { k: 'kickoff' };
