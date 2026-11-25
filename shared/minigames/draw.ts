// Draw and guess: each player takes one turn drawing a secret word while the others type guesses.
// Rules only: no browser or server code in this file.

export const WORDS = [
  // food
  'apple', 'banana', 'cherry', 'grapes', 'lemon', 'carrot', 'pumpkin', 'mushroom', 'pizza', 'burger',
  'cookie', 'cake', 'bread', 'cheese', 'egg', 'donut', 'candy', 'popcorn', 'sandwich', 'pineapple',
  // animals
  'cat', 'dog', 'fish', 'bird', 'horse', 'cow', 'pig', 'sheep', 'rabbit', 'mouse',
  'snake', 'frog', 'turtle', 'elephant', 'giraffe', 'lion', 'monkey', 'penguin', 'owl', 'duck',
  'bee', 'butterfly', 'spider', 'snail', 'whale', 'shark', 'octopus', 'crab', 'bat', 'dinosaur',
  // buildings and furniture
  'house', 'door', 'window', 'chair', 'table', 'bed', 'lamp', 'clock', 'key', 'lock',
  'ladder', 'bridge', 'castle', 'tent', 'fence', 'chimney', 'stairs', 'lighthouse', 'windmill', 'igloo',
  // getting about
  'car', 'bus', 'train', 'bicycle', 'boat', 'rocket', 'airplane', 'helicopter', 'truck', 'balloon',
  'anchor', 'wheel', 'submarine', 'tractor', 'skateboard',
  // outdoors
  'sun', 'moon', 'star', 'cloud', 'rain', 'rainbow', 'snowman', 'tree', 'flower', 'leaf',
  'mountain', 'volcano', 'island', 'river', 'fire', 'lightning', 'cactus', 'snowflake', 'tornado', 'planet',
  // things to wear
  'hat', 'shoe', 'sock', 'shirt', 'glasses', 'umbrella', 'ring', 'crown', 'glove', 'scarf',
  'button', 'backpack', 'necklace', 'belt', 'tie',
  // things to use
  'book', 'pencil', 'scissors', 'hammer', 'saw', 'brush', 'bucket', 'broom', 'candle', 'bell',
  'drum', 'guitar', 'piano', 'trumpet', 'camera', 'phone', 'television', 'computer', 'robot', 'kite',
  'ball', 'cup', 'bottle', 'spoon', 'fork', 'knife', 'plate', 'flag', 'map', 'envelope',
  'gift', 'magnet', 'telescope', 'compass', 'lightbulb',
  // body
  'eye', 'nose', 'ear', 'hand', 'foot', 'tooth', 'heart', 'bone', 'moustache', 'skeleton',
  // stories
  'ghost', 'pirate', 'dragon', 'wizard', 'feather', 'treasure', 'witch', 'unicorn', 'alien', 'mummy',
];

export const DRAW_MIN = 2;
export const TURN_MS = 75_000;
/** How long the word is shown between turns, and the ranking after the last one. */
export const REVEAL_MS = 5_000;
export const FINAL_MS = 12_000;
/** A guess is worth this at the last moment and GUESS_MIN + GUESS_SPEED at the first. */
export const GUESS_MIN = 40;
export const GUESS_SPEED = 60;
/** What the drawer earns for each person who gets it. */
export const DRAWER_POINTS = 25;

/** The only colours and widths a stroke may have. The last colour is the paper's, so it rubs out. */
export const PALETTE = ['#1d1b22', '#e5484d', '#f3a712', '#f5d90a', '#30a46c', '#3e7bfa', '#8e4ec6', '#8b5a2b', '#ffffff'];
/** Line widths as a fraction of the picture's width. */
export const WIDTHS = [0.005, 0.012, 0.03];
/** The picture is this many times wider than tall (the shape of the board in the room). */
export const ASPECT = 12 / 7;

// Limits on what a drawer's browser may send.
export const MAX_MSG_POINTS = 64;
export const MAX_MSGS_PER_SEC = 30;
/** Points on the picture at once. */
export const MAX_INK = 6000;
export const MAX_STROKES = 400;
export const MAX_GUESS = 40;
/** Guesses from one person closer together than this are dropped. */
export const GUESS_GAP_MS = 300;
const FEED = 8;

/** One line: a colour and width (indexes into PALETTE and WIDTHS) and x,y pairs, each 0..1. */
export interface Stroke {
  c: number;
  w: number;
  pts: number[];
}
/** A line in the guess list. A correct guess has no text, so the word is not given away. */
export interface FeedLine {
  name: string;
  text?: string;
  ok: boolean;
}
export interface DrawPlayer {
  id: string;
  name: string;
  score: number;
}

export interface DrawGame {
  /** Who is playing, in the order they joined. */
  players: DrawPlayer[];
  phase: 'lobby' | 'turn' | 'reveal' | 'final';
  /** Who has still to draw this game, in order. */
  queue: string[];
  drawer: string | null;
  /** The secret. Only the drawer is told it until the turn is over. */
  word: string | null;
  /** Counts up for ever: names a turn, so late stroke messages can be told apart. */
  turn: number;
  /** Turns finished this game. */
  done: number;
  startAt: number;
  /** When the current phase ends (server clock). */
  until: number;
  /** Positions in the word shown to the guessers, and how many hint times have passed. */
  hints: number[];
  hintsDue: number;
  /** Who has got it this turn. */
  guessed: string[];
  strokes: Stroke[];
  ink: number;
  /** Drawer messages in the current second. */
  rate: { at: number; n: number };
  lastGuess: Record<string, number>;
  feed: FeedLine[];
  /** Words already used, so they don't repeat until the list runs out. */
  used: string[];
}

export const newDraw = (): DrawGame => ({
  players: [], phase: 'lobby', queue: [], drawer: null, word: null, turn: 0, done: 0, startAt: 0, until: 0,
  hints: [], hintsDue: 0, guessed: [], strokes: [], ink: 0, rate: { at: 0, n: 0 }, lastGuess: {}, feed: [], used: [],
});

const playing = (g: DrawGame) => g.phase === 'turn' || g.phase === 'reveal';
const say = (g: DrawGame, line: FeedLine) => {
  g.feed.push(line);
  if (g.feed.length > FEED) g.feed.shift();
};

export function drawJoin(g: DrawGame, p: { id: string; name: string }): boolean {
  if (g.players.some((x) => x.id === p.id)) return false;
  g.players.push({ id: p.id, name: p.name, score: 0 });
  // Someone who joins part-way can guess at once and draws last.
  if (playing(g)) g.queue.push(p.id);
  return true;
}

function nextTurn(g: DrawGame, now: number, rnd: () => number) {
  Object.assign(g, { hints: [], hintsDue: 0, guessed: [], strokes: [], ink: 0, feed: [], lastGuess: {}, rate: { at: now, n: 0 } });
  const drawer = g.queue.shift();
  if (!drawer) {
    Object.assign(g, { phase: 'final', drawer: null, word: null, until: now + FINAL_MS });
    return;
  }
  let fresh = WORDS.filter((w) => !g.used.includes(w));
  if (!fresh.length) {
    g.used = [];
    fresh = WORDS;
  }
  const word = fresh[Math.floor(rnd() * fresh.length)];
  g.used.push(word);
  Object.assign(g, { phase: 'turn', drawer, word, turn: g.turn + 1, startAt: now, until: now + TURN_MS });
}

/** The turn is over: show the word for a moment. */
function endTurn(g: DrawGame, now: number) {
  g.phase = 'reveal';
  g.done++;
  g.until = now + REVEAL_MS;
}

const everyoneGuessed = (g: DrawGame) => {
  const guessers = g.players.filter((p) => p.id !== g.drawer);
  return guessers.length > 0 && guessers.every((p) => g.guessed.includes(p.id));
};

/** Start a game: everyone who has joined draws once, in the order they joined. */
export function drawStart(g: DrawGame, by: string, now: number, rnd: () => number = Math.random): boolean {
  if (playing(g) || g.players.length < DRAW_MIN || !g.players.some((p) => p.id === by)) return false;
  for (const p of g.players) p.score = 0;
  g.queue = g.players.map((p) => p.id);
  g.done = 0;
  nextTurn(g, now, rnd);
  return true;
}

/** Someone left the game or the room. Returns true if anything changed. */
export function drawLeave(g: DrawGame, id: string, now: number): boolean {
  const i = g.players.findIndex((p) => p.id === id);
  if (i < 0) return false;
  g.players.splice(i, 1);
  g.queue = g.queue.filter((x) => x !== id);
  g.guessed = g.guessed.filter((x) => x !== id);
  if (!playing(g)) return true;
  if (g.players.length < DRAW_MIN) {
    // Nobody left to play with: stop the game where it stands.
    Object.assign(g, { phase: 'lobby', drawer: null, word: null, queue: [], strokes: [], ink: 0, guessed: [], hints: [], feed: [] });
  } else if (g.phase === 'turn' && (g.drawer === id || everyoneGuessed(g))) {
    // The drawer walking off skips the rest of their turn.
    endTurn(g, now);
  }
  return true;
}

/** What a guess is worth with this much of the turn left. */
export const guessPoints = (left: number) => GUESS_MIN + Math.round(GUESS_SPEED * Math.min(1, Math.max(0, left / TURN_MS)));

/** A typed guess. 'no' means it was not accepted at all (and nothing changed). */
export function drawGuess(g: DrawGame, by: string, text: unknown, now: number): 'no' | 'wrong' | 'right' {
  const p = g.players.find((x) => x.id === by);
  // The drawer and people who already have it must not type, or they could give the word away.
  if (g.phase !== 'turn' || !p || by === g.drawer || g.guessed.includes(by) || typeof text !== 'string') return 'no';
  const shown = text.trim().replace(/\s+/g, ' ');
  if (!shown || shown.length > MAX_GUESS || now - (g.lastGuess[by] ?? -GUESS_GAP_MS) < GUESS_GAP_MS) return 'no';
  g.lastGuess[by] = now;
  if (shown.toLowerCase() !== g.word) {
    say(g, { name: p.name, text: shown, ok: false });
    return 'wrong';
  }
  p.score += guessPoints(g.until - now);
  const drawer = g.players.find((x) => x.id === g.drawer);
  if (drawer) drawer.score += DRAWER_POINTS;
  g.guessed.push(by);
  say(g, { name: p.name, ok: true });
  if (everyoneGuessed(g)) endTurn(g, now);
  return 'right';
}

/** Is this drawer allowed one more message this second? */
function allow(g: DrawGame, by: string, now: number): boolean {
  if (g.phase !== 'turn' || g.drawer !== by) return false;
  if (now - g.rate.at >= 1000 || now < g.rate.at) g.rate = { at: now, n: 0 };
  if (g.rate.n >= MAX_MSGS_PER_SEC) return false;
  g.rate.n++;
  return true;
}

const index = (v: unknown, n: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < n;

/** What is relayed for some new points: which stroke (`i`) they belong to and how many points (`o`) it had before. */
export interface Ink {
  i: number;
  o: number;
  c: number;
  w: number;
  pts: number[];
}

/**
 * The drawer sent some points: `{ n, c, w, pts }`, where `n` starts a new stroke and `pts` is x,y pairs.
 * Returns what to relay, or null if the message was refused.
 */
export function drawInk(g: DrawGame, by: string, a: { n?: unknown; c?: unknown; w?: unknown; pts?: unknown }, now: number): Ink | null {
  if (!allow(g, by, now)) return null;
  const raw = a.pts;
  if (!Array.isArray(raw) || raw.length < 2 || raw.length % 2 || raw.length > MAX_MSG_POINTS * 2) return null;
  if (!raw.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1)) return null;
  if (g.ink + raw.length / 2 > MAX_INK) return null;
  // Three decimal places are plenty for a picture this size and keep the messages short.
  const pts = (raw as number[]).map((v) => Math.round(v * 1000) / 1000);
  let s = g.strokes[g.strokes.length - 1];
  if (a.n === true || !s) {
    if (!index(a.c, PALETTE.length) || !index(a.w, WIDTHS.length) || g.strokes.length >= MAX_STROKES) return null;
    s = { c: a.c, w: a.w, pts: [] };
    g.strokes.push(s);
  }
  const o = s.pts.length / 2;
  s.pts.push(...pts);
  g.ink += pts.length / 2;
  return { i: g.strokes.length - 1, o, c: s.c, w: s.w, pts };
}

/** The drawer takes back their last stroke. */
export function drawUndo(g: DrawGame, by: string, now: number): boolean {
  if (!g.strokes.length || !allow(g, by, now)) return false;
  g.ink -= g.strokes.pop()!.pts.length / 2;
  return true;
}

/** The drawer wipes the picture. */
export function drawClear(g: DrawGame, by: string, now: number): boolean {
  if (!g.strokes.length || !allow(g, by, now)) return false;
  g.strokes = [];
  g.ink = 0;
  return true;
}

/** Time passing: hints, the end of a turn, the next turn, and back to the lobby. Returns true if anything changed. */
export function drawTick(g: DrawGame, now: number, rnd: () => number = Math.random): boolean {
  if (g.phase === 'lobby') return false;
  if (now >= g.until) {
    if (g.phase === 'turn') endTurn(g, now);
    else if (g.phase === 'reveal') nextTurn(g, now, rnd);
    else g.phase = 'lobby';
    return true;
  }
  if (g.phase !== 'turn' || !g.word) return false;
  const gone = (now - g.startAt) / TURN_MS;
  const due = gone >= 0.75 ? 2 : gone >= 0.5 ? 1 : 0;
  if (g.hintsDue >= due) return false;
  while (g.hintsDue < due) {
    g.hintsDue++;
    const hidden = [...g.word].map((_, i) => i).filter((i) => !g.hints.includes(i));
    // Always leave at least two letters to work out.
    if (hidden.length > 2) g.hints.push(hidden[Math.floor(rnd() * hidden.length)]);
  }
  return true;
}

/** Highest score first; people level on points keep the order they joined in. */
export const drawRanking = (g: { players: DrawPlayer[] }): DrawPlayer[] => [...g.players].sort((a, b) => b.score - a.score);

/** Everyone level at the top. */
export function drawWinners(g: { players: DrawPlayer[] }): DrawPlayer[] {
  const top = Math.max(0, ...g.players.map((p) => p.score));
  return g.players.filter((p) => p.score === top);
}

/** What everyone sees. The word is in it only once the turn is over. */
export interface DrawView {
  t: 'state';
  players: DrawPlayer[];
  phase: DrawGame['phase'];
  drawer: string | null;
  turn: number;
  /** Turns finished, and how many this game will have. */
  done: number;
  turns: number;
  /** Milliseconds left in this phase. */
  left: number;
  /** The word as the guessers see it: '_' for each hidden letter. Its length is the word's length. */
  hint: string;
  guessed: string[];
  feed: FeedLine[];
  word: string | null;
}

export const drawView = (g: DrawGame, now: number): DrawView => ({
  t: 'state',
  players: g.players,
  phase: g.phase,
  drawer: g.drawer,
  turn: g.turn,
  done: g.done,
  turns: g.done + g.queue.length + (g.phase === 'turn' ? 1 : 0),
  left: g.phase === 'lobby' ? 0 : Math.max(0, g.until - now),
  hint: g.phase === 'turn' && g.word ? [...g.word].map((ch, i) => (g.hints.includes(i) ? ch : '_')).join('') : '',
  guessed: g.guessed,
  feed: g.feed,
  word: g.phase === 'reveal' ? g.word : null,
});

/** Everything the server sends. `state` and `ink` go to everyone; `word` only to the drawer. */
export type DrawMsg =
  | DrawView
  | { t: 'word'; turn: number; word: string }
  /** The whole picture: at the start of a turn, after Undo or Clear, and to anyone who asks. */
  | { t: 'strokes'; turn: number; strokes: Stroke[] }
  | ({ t: 'ink'; turn: number } & Ink);

/** What a browser may send. */
export type DrawAction =
  | { k: 'join' }
  | { k: 'leave' }
  | { k: 'start' }
  | { k: 'guess'; text: string }
  | { k: 'draw'; n: boolean; c: number; w: number; pts: number[] }
  | { k: 'undo' }
  | { k: 'clear' }
  /** "Send me the picture again": on opening the panel, or after missing a message. */
  | { k: 'sync' };
