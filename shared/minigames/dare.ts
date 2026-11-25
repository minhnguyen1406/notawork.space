// Truth or dare: people join, someone spins, the person picked chooses truth or dare and gets a prompt.
// Rules only: no browser or server code in this file.

export const TRUTHS = [
  'What is the most childish thing you still do?',
  'What is the worst gift you have ever pretended to like?',
  'Which of us would survive longest on a desert island, and why not you?',
  'What is a food everyone loves that you secretly cannot stand?',
  'What is the last thing you searched for on your phone?',
  'What is your most useless talent?',
  'Who here would you trust least with your phone unlocked?',
  'What is the longest you have gone without showering?',
  'What song do you know every word of but would never admit to?',
  'What is the silliest thing you have cried about?',
];
export const DARES = [
  'Speak only in questions until your next turn.',
  'Do your best impression of someone in this room.',
  'Sing the chorus of the last song you listened to.',
  'Dance (press 7) for ten seconds without stopping.',
  'Run a full lap of the roof and come back.',
  'Compliment every person here, one by one.',
  'Talk in a whisper for the next two rounds.',
  'Tell a joke. If nobody laughs, tell another.',
  'Let the group choose your character next time you join.',
  'Narrate what everyone is doing like a football commentator for one minute.',
];

export const DARE_MIN = 2;
/** How long the person picked has to choose before "truth" is chosen for them. */
export const CHOOSE_MS = 15_000;

export interface DareGame {
  /** Who is playing, in the order they joined. */
  players: { id: string; name: string }[];
  phase: 'lobby' | 'choose' | 'prompt';
  /** The person picked by the last spin. */
  picked: string | null;
  kind: 'truth' | 'dare' | null;
  prompt: string | null;
  /** When the choice times out (server clock). */
  until: number;
  /** Prompts already used, so they don't repeat until the list runs out. */
  used: string[];
}

export const newDare = (): DareGame => ({ players: [], phase: 'lobby', picked: null, kind: null, prompt: null, until: 0, used: [] });

export function dareJoin(g: DareGame, p: { id: string; name: string }): boolean {
  if (g.players.some((x) => x.id === p.id)) return false;
  g.players.push({ id: p.id, name: p.name });
  return true;
}

/** Someone left the game or the room. Returns true if anything changed. */
export function dareLeave(g: DareGame, id: string): boolean {
  const i = g.players.findIndex((p) => p.id === id);
  if (i < 0) return false;
  g.players.splice(i, 1);
  // If they were in the hot seat, or too few are left, go back to the lobby.
  if (g.picked === id || g.players.length < DARE_MIN) Object.assign(g, { phase: 'lobby', picked: null, kind: null, prompt: null });
  return true;
}

/** Spin: pick someone at random. `rnd` is injectable so tests are repeatable. */
export function dareSpin(g: DareGame, by: string, now: number, rnd: () => number = Math.random): boolean {
  if (g.phase === 'choose' || g.players.length < DARE_MIN || !g.players.some((p) => p.id === by)) return false;
  g.picked = g.players[Math.floor(rnd() * g.players.length)].id;
  g.phase = 'choose';
  g.kind = g.prompt = null;
  g.until = now + CHOOSE_MS;
  return true;
}

/** The person picked chooses truth or dare. */
export function dareChoose(g: DareGame, by: string, kind: unknown, rnd: () => number = Math.random): boolean {
  if (g.phase !== 'choose' || g.picked !== by || (kind !== 'truth' && kind !== 'dare')) return false;
  const list = kind === 'truth' ? TRUTHS : DARES;
  let fresh = list.filter((p) => !g.used.includes(p));
  if (!fresh.length) {
    g.used = g.used.filter((p) => !list.includes(p));
    fresh = list;
  }
  g.kind = kind;
  g.prompt = fresh[Math.floor(rnd() * fresh.length)];
  g.used.push(g.prompt);
  g.phase = 'prompt';
  return true;
}

/** Time passing: an unanswered choice becomes "truth". Returns true if anything changed. */
export function dareTick(g: DareGame, now: number, rnd: () => number = Math.random): boolean {
  return g.phase === 'choose' && now >= g.until && !!g.picked && dareChoose(g, g.picked, 'truth', rnd);
}

/** What everyone sees. Nothing in this game is secret. */
export interface DareView {
  players: { id: string; name: string }[];
  phase: DareGame['phase'];
  picked: string | null;
  kind: DareGame['kind'];
  prompt: string | null;
  /** Milliseconds left to choose. */
  left: number;
}

export const dareView = (g: DareGame, now: number): DareView => ({
  players: g.players,
  phase: g.phase,
  picked: g.picked,
  kind: g.kind,
  prompt: g.prompt,
  left: g.phase === 'choose' ? Math.max(0, g.until - now) : 0,
});

/** What a browser may send. */
export type DareAction = { k: 'join' } | { k: 'leave' } | { k: 'spin' } | { k: 'choose'; kind: 'truth' | 'dare' };
