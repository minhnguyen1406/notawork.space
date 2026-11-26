// Word clues: two teams, a 5-by-5 grid of words, and one clue-giver a side who knows which words
// are whose and hints at several of them with a single word.
// Rules only: no browser or server code in this file.

/** Common, concrete nouns: single words, lower case, letters only. Very short words that hide inside
 *  many others ("ant", "ear") are left out, because a clue may not contain a word on the grid. */
export const WORD_LIST = [
  // animals
  'dog', 'horse', 'pig', 'sheep', 'goat', 'chicken', 'duck', 'goose', 'rabbit', 'mouse',
  'lion', 'tiger', 'bear', 'wolf', 'fox', 'deer', 'monkey', 'elephant', 'giraffe', 'zebra',
  'camel', 'whale', 'dolphin', 'shark', 'octopus', 'crab', 'frog', 'snake', 'turtle', 'lizard',
  'eagle', 'parrot', 'penguin', 'spider', 'butterfly', 'squirrel', 'hedgehog', 'cow',
  // food and drink
  'apple', 'banana', 'orange', 'lemon', 'grape', 'cherry', 'peach', 'pear', 'melon', 'coconut',
  'tomato', 'potato', 'carrot', 'onion', 'pepper', 'mushroom', 'corn', 'rice', 'bread', 'cheese',
  'butter', 'egg', 'milk', 'honey', 'sugar', 'salt', 'cake', 'cookie', 'pizza', 'noodle',
  'soup', 'sandwich', 'chocolate', 'coffee', 'juice', 'pumpkin',
  // around the house
  'house', 'door', 'window', 'roof', 'wall', 'floor', 'stairs', 'kitchen', 'garden', 'fence',
  'table', 'chair', 'bed', 'sofa', 'lamp', 'mirror', 'clock', 'carpet', 'curtain', 'pillow',
  'blanket', 'shelf', 'drawer', 'oven', 'fridge', 'sink', 'bath', 'towel', 'soap', 'broom',
  'bucket', 'lock', 'candle', 'bottle', 'cup', 'plate', 'bowl', 'fork', 'knife', 'spoon',
  'kettle', 'basket', 'lantern',
  // outdoors
  'sun', 'moon', 'star', 'cloud', 'rain', 'snow', 'wind', 'storm', 'river', 'lake',
  'ocean', 'beach', 'island', 'mountain', 'hill', 'valley', 'forest', 'tree', 'leaf', 'flower',
  'grass', 'rock', 'sand', 'desert', 'cave', 'volcano', 'bridge', 'road', 'field', 'feather',
  // travel and places
  'bus', 'train', 'plane', 'boat', 'ship', 'bicycle', 'truck', 'rocket', 'tractor', 'wheel',
  'engine', 'anchor', 'tunnel', 'station', 'airport', 'harbour', 'market', 'school', 'hospital', 'library',
  'museum', 'castle', 'tower', 'church', 'farm', 'hotel', 'bank', 'theatre', 'park', 'wagon',
  // things
  'book', 'pencil', 'paper', 'letter', 'stamp', 'map', 'camera', 'phone', 'radio', 'guitar',
  'piano', 'drum', 'violin', 'trumpet', 'ball', 'kite', 'doll', 'puzzle', 'balloon', 'ticket',
  'coin', 'wallet', 'ring', 'crown', 'sword', 'shield', 'arrow', 'hammer', 'nail', 'saw',
  'ladder', 'rope', 'chain', 'needle', 'thread', 'button', 'scissors', 'umbrella', 'glasses', 'watch',
  'helmet', 'compass',
  // clothes and the body
  'scarf', 'glove', 'shoe', 'boot', 'sock', 'shirt', 'jacket', 'dress', 'belt', 'pocket',
  'hand', 'foot', 'nose', 'tooth', 'heart', 'bone',
  // people
  'robot', 'ghost', 'king', 'queen', 'pirate', 'doctor', 'farmer', 'pilot', 'painter', 'baker',
];

/** Two a side: a clue-giver and at least one guesser each. */
export const WORDS_MIN = 4;
export const WORDS_MAX = 20;
export const GRID = 25;
/** How the 25 cards are split: the team that goes first has one more to find. */
export const DEAL = { first: 9, second: 8, neutral: 7, trap: 1 };
export const CLUE_MS = 90_000;
export const GUESS_MS = 120_000;
export const CLUE_MAX_LEN = 20;
/** This many turns in a row timing out with no clue or guess accepted means everyone has walked away: the game is abandoned. */
export const IDLE_TURNS = 4;

export type Team = 'red' | 'blue';
/** What a card secretly is. */
export type Kind = Team | 'neutral' | 'trap';
export const otherTeam = (t: Team): Team => (t === 'red' ? 'blue' : 'red');

export interface WordsPlayer {
  id: string;
  name: string;
  team: Team;
  /** The team's clue-giver, who sees the secret map. */
  giver: boolean;
}

export interface WordsGame {
  /** Who is playing, in the order they joined. */
  players: WordsPlayer[];
  phase: 'lobby' | 'clue' | 'guess';
  /** The 25 words, row by row. Empty until the first game is dealt. */
  grid: string[];
  /** SECRET while a game is on: what each card is. Only the clue-givers may be sent it. */
  map: Kind[];
  /** Which cards have been turned over. */
  revealed: boolean[];
  /** Whose turn it is. */
  turn: Team;
  /** Who went first (and so has nine words). */
  first: Team;
  clue: { word: string; n: number } | null;
  /** Guesses made so far this turn. */
  guesses: number;
  /** When the current phase times out (server clock). */
  until: number;
  /** Turns that have timed out in a row since the last clue or guess. */
  idle: number;
  /** How the last game ended, shown in the lobby. `winner` is null if it was abandoned (a team ran short, or everyone went idle). */
  result: { winner: Team | null; reason: 'all' | 'trap' | 'short' } | null;
}

export const newWords = (): WordsGame => ({
  players: [], phase: 'lobby', grid: [], map: [], revealed: [], turn: 'red', first: 'red', clue: null, guesses: 0, until: 0, idle: 0, result: null,
});

const find = (g: WordsGame, id: string) => g.players.find((p) => p.id === id);
const team = (g: WordsGame, t: Team) => g.players.filter((p) => p.team === t);
/** A team with people in it always has exactly one clue-giver: the longest-standing member steps up. */
function fixGivers(g: WordsGame) {
  for (const t of ['red', 'blue'] as const) {
    const m = team(g, t);
    if (m.length && !m.some((p) => p.giver)) m[0].giver = true;
  }
}
function shuffle<T>(a: T[], rnd: () => number): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
/** Words of this kind still face down. */
export const wordsLeft = (g: WordsGame, k: Kind) => g.map.filter((m, i) => m === k && !g.revealed[i]).length;

/** Join in the lobby: dealt to the smaller team, and made clue-giver if that team has none. */
export function wordsJoin(g: WordsGame, p: { id: string; name: string }): boolean {
  // Not mid-game: the teams are set, and someone who has seen the map could come back as a guesser.
  if (g.phase !== 'lobby' || g.players.length >= WORDS_MAX || find(g, p.id)) return false;
  const t: Team = team(g, 'blue').length < team(g, 'red').length ? 'blue' : 'red';
  g.players.push({ id: p.id, name: p.name, team: t, giver: false });
  fixGivers(g);
  return true;
}

/** Change sides (lobby only). You arrive as a guesser unless the team has no clue-giver. */
export function wordsSwitch(g: WordsGame, id: string): boolean {
  const p = find(g, id);
  if (g.phase !== 'lobby' || !p) return false;
  p.team = otherTeam(p.team);
  p.giver = false;
  // Go to the back of the queue, so "longest-standing member" means on this team.
  g.players.splice(g.players.indexOf(p), 1);
  g.players.push(p);
  fixGivers(g);
  return true;
}

/** Volunteer to be your team's clue-giver (lobby only). */
export function wordsVolunteer(g: WordsGame, id: string): boolean {
  const p = find(g, id);
  if (g.phase !== 'lobby' || !p || p.giver) return false;
  for (const m of team(g, p.team)) m.giver = m === p;
  return true;
}

/** Each team needs a clue-giver and at least one guesser. */
export const wordsReady = (g: WordsGame) => (['red', 'blue'] as const).every((t) => team(g, t).length >= 2 && team(g, t).some((p) => p.giver));

/** Deal a fresh grid and start. `rnd` is injectable so tests are repeatable. */
export function wordsStart(g: WordsGame, by: string, now: number, rnd: () => number = Math.random): boolean {
  if (g.phase !== 'lobby' || !find(g, by) || !wordsReady(g)) return false;
  g.grid = shuffle([...WORD_LIST], rnd).slice(0, GRID);
  g.first = g.turn = rnd() < 0.5 ? 'red' : 'blue';
  const kinds: Kind[] = [];
  const add = (k: Kind, n: number) => { for (let i = 0; i < n; i++) kinds.push(k); };
  add(g.first, DEAL.first);
  add(otherTeam(g.first), DEAL.second);
  add('neutral', DEAL.neutral);
  add('trap', DEAL.trap);
  g.map = shuffle(kinds, rnd);
  g.revealed = g.map.map(() => false);
  g.result = null;
  g.idle = 0;
  beginClue(g, now);
  return true;
}

function beginClue(g: WordsGame, now: number) {
  g.phase = 'clue';
  g.clue = null;
  g.guesses = 0;
  g.until = now + CLUE_MS;
}
function passTurn(g: WordsGame, now: number) {
  g.turn = otherTeam(g.turn);
  beginClue(g, now);
}
/** Back to the lobby. The map stays in the state: once the game is over it is no longer secret. */
function finish(g: WordsGame, winner: Team | null, reason: 'all' | 'trap' | 'short') {
  g.phase = 'lobby';
  g.clue = null;
  g.guesses = 0;
  g.until = 0;
  g.result = { winner, reason };
}

/** Why a clue is not allowed, in words for the player, or null if it is fine. */
export function clueProblem(grid: string[], clue: unknown): string | null {
  if (typeof clue !== 'string') return 'Type a one-word clue.';
  const w = clue.trim().toLowerCase();
  if (!w) return 'Type a one-word clue.';
  if (w.length > CLUE_MAX_LEN) return `Keep the clue to ${CLUE_MAX_LEN} letters.`;
  if (!/^[a-z]+$/.test(w)) return 'One word, letters only.';
  const hit = grid.find((x) => w.includes(x.toLowerCase()));
  return hit ? `A clue cannot be or contain a word on the grid ("${hit}").` : null;
}

/** The clue-giver of the team whose turn it is gives a word and a number from 1 to 9. */
export function wordsClue(g: WordsGame, by: string, word: unknown, n: unknown, now: number): boolean {
  const p = find(g, by);
  if (g.phase !== 'clue' || !p || !p.giver || p.team !== g.turn) return false;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 9) return false;
  if (typeof word !== 'string' || clueProblem(g.grid, word)) return false;
  g.clue = { word: word.trim().toUpperCase(), n };
  g.idle = 0;
  g.guesses = 0;
  g.phase = 'guess';
  g.until = now + GUESS_MS;
  return true;
}

/** A guesser on the team whose turn it is turns a card over. Returns what it was, or null if not allowed. */
export function wordsGuess(g: WordsGame, by: string, i: unknown, now: number): Kind | null {
  const p = find(g, by);
  if (g.phase !== 'guess' || !g.clue || !p || p.giver || p.team !== g.turn) return null;
  if (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i >= GRID || g.revealed[i]) return null;
  g.revealed[i] = true;
  g.idle = 0;
  const k = g.map[i];
  const them = otherTeam(g.turn);
  if (k === 'trap') finish(g, them, 'trap');
  else if (k === g.turn) {
    g.guesses++;
    if (!wordsLeft(g, g.turn)) finish(g, g.turn, 'all');
    // One more than the number, to catch up on a word missed in an earlier turn.
    else if (g.guesses > g.clue.n) passTurn(g, now);
  } else if (k === them && !wordsLeft(g, them)) finish(g, them, 'all'); // found the other team's last word for them
  else passTurn(g, now);
  return k;
}

/** A guesser stops the turn early, after at least one guess. */
export function wordsEndTurn(g: WordsGame, by: string, now: number): boolean {
  const p = find(g, by);
  if (g.phase !== 'guess' || !p || p.giver || p.team !== g.turn || g.guesses < 1) return false;
  passTurn(g, now);
  return true;
}

/** Someone left the game or the room. Returns true if anything changed. */
export function wordsLeave(g: WordsGame, id: string): boolean {
  const i = g.players.findIndex((p) => p.id === id);
  if (i < 0) return false;
  g.players.splice(i, 1);
  // A team cannot play without both a clue-giver and a guesser.
  if (g.phase !== 'lobby' && (team(g, 'red').length < 2 || team(g, 'blue').length < 2)) finish(g, null, 'short');
  // If the clue-giver went, a guesser is promoted (and, mid-game, the server sends them the map).
  fixGivers(g);
  return true;
}

/**
 * Time passing: an idle clue-giver or idle guessers lose the turn. Returns true if anything changed.
 * A game nobody is playing must not hold the table for ever (nobody can join while it is on), so after
 * IDLE_TURNS timed-out turns in a row it is abandoned, like a game a team walked out of.
 */
export function wordsTick(g: WordsGame, now: number): boolean {
  if (g.phase === 'lobby' || now < g.until) return false;
  if (++g.idle >= IDLE_TURNS) finish(g, null, 'short');
  else passTurn(g, now);
  return true;
}

export interface WordsView {
  players: WordsPlayer[];
  phase: WordsGame['phase'];
  /** `kind` is set only for cards turned over, until the game ends and every card shows. `open` is whether it was turned over in play. */
  cells: { word: string; kind: Kind | null; open: boolean }[];
  /** The whole map: only ever present in the view sent to a clue-giver while a game is on. */
  secret: Kind[] | null;
  turn: Team;
  clue: { word: string; n: number } | null;
  /** Guesses the team may still make this turn. */
  guessesLeft: number;
  guesses: number;
  /** Words each team still has to find. */
  remaining: { red: number; blue: number };
  /** Milliseconds left in this phase. */
  left: number;
  result: WordsGame['result'];
}

/** What `viewer` may see. Pass null for the view that is safe to broadcast to everyone. */
export function wordsView(g: WordsGame, now: number, viewer: string | null = null): WordsView {
  const over = g.phase === 'lobby';
  const isGiver = !over && !!viewer && !!find(g, viewer)?.giver;
  return {
    players: g.players,
    phase: g.phase,
    cells: g.grid.map((word, i) => ({ word, kind: over || g.revealed[i] ? g.map[i] : null, open: !!g.revealed[i] })),
    secret: isGiver ? [...g.map] : null,
    turn: g.turn,
    clue: g.clue,
    guesses: g.guesses,
    guessesLeft: g.phase === 'guess' && g.clue ? g.clue.n + 1 - g.guesses : 0,
    remaining: { red: wordsLeft(g, 'red'), blue: wordsLeft(g, 'blue') },
    left: over ? 0 : Math.max(0, g.until - now),
    result: g.result,
  };
}

/** What a browser may send. */
export type WordsAction =
  | { k: 'join' }
  | { k: 'leave' }
  | { k: 'switch' }
  | { k: 'giver' }
  | { k: 'start' }
  | { k: 'clue'; word: string; n: number }
  | { k: 'guess'; i: number }
  | { k: 'end' };
