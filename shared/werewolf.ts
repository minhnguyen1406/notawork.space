// Werewolf (the classic village-versus-werewolves party game). The server plays the moderator.
// Pure rules over a plain state object.
import { shuffle } from './cards';

export type Role = 'werewolf' | 'seer' | 'doctor' | 'villager';
export const ROLE_LABEL: Record<Role, string> = {
  werewolf: 'a werewolf',
  seer: 'the seer',
  doctor: 'the doctor',
  villager: 'a villager',
};

export const WOLF_MIN = 5;
export const WOLF_MAX = 12;
/** If someone is slow or away, anyone still in the game may move things on after this long. */
export const FORCE_AFTER_MS = 45_000;

export const WOLF_RULES = [
  `For ${WOLF_MIN} to ${WOLF_MAX} players. You are secretly a villager, the seer, the doctor or a werewolf.`,
  'Night: the werewolves pick someone to kill. The seer learns whether one person is a werewolf. The doctor protects one person.',
  'Day: everyone talks it over, then votes. Whoever gets the most votes is out; a tie means nobody is.',
  'The village wins when every werewolf is out. The werewolves win when they are at least half of those left.',
  'Talk out loud. Your role and your night choice only ever appear on your own screen.',
];

export interface WolfPlayer {
  id: string;
  name: string;
  role: Role;
  alive: boolean;
}

export interface WolfGame {
  phase: 'lobby' | 'night' | 'day' | 'over';
  round: number;
  players: WolfPlayer[];
  /** Each werewolf's chosen victim tonight. */
  kills: Record<string, string>;
  protect: string | null;
  inspected: boolean;
  /** What the seer has learned; only ever shown to the seer. */
  notes: string[];
  /** Today's votes: voter id to target id, or 'skip'. */
  votes: Record<string, string>;
  /** Public history, newest last. */
  log: string[];
  winner: 'village' | 'werewolves' | null;
  /** When the current night or day began. */
  since: number;
}

export const newWolf = (): WolfGame => ({
  phase: 'lobby',
  round: 0,
  players: [],
  kills: {},
  protect: null,
  inspected: false,
  notes: [],
  votes: {},
  log: [],
  winner: null,
  since: 0,
});

export function rolesFor(n: number): Role[] {
  const wolves = n >= 12 ? 3 : n >= 8 ? 2 : 1;
  const roles: Role[] = ['seer', 'doctor'];
  for (let i = 0; i < wolves; i++) roles.push('werewolf');
  while (roles.length < n) roles.push('villager');
  return roles;
}

const find = (g: WolfGame, id: string) => g.players.find((p) => p.id === id);
const living = (g: WolfGame) => g.players.filter((p) => p.alive);
const playing = (g: WolfGame) => g.phase === 'night' || g.phase === 'day';

/** Start a game. `roles` is only passed by tests; normally roles are dealt at random. */
export function wolfStart(g: WolfGame, players: { id: string; name: string }[], now: number, roles?: Role[]): boolean {
  if (playing(g) || players.length < WOLF_MIN || players.length > WOLF_MAX) return false;
  const dealt = roles ?? shuffle(rolesFor(players.length));
  Object.assign(g, newWolf(), {
    phase: 'night',
    round: 1,
    players: players.map((p, i) => ({ id: p.id, name: p.name, role: dealt[i], alive: true })),
    log: ['Night falls on the village.'],
    since: now,
  });
  return true;
}

function checkWin(g: WolfGame): boolean {
  const wolves = living(g).filter((p) => p.role === 'werewolf').length;
  const others = living(g).length - wolves;
  if (wolves === 0) g.winner = 'village';
  else if (wolves >= others) g.winner = 'werewolves';
  else return false;
  g.phase = 'over';
  g.log.push(g.winner === 'village' ? 'Every werewolf is gone. The village wins!' : 'The werewolves have taken over. The werewolves win!');
  return true;
}

function startNight(g: WolfGame, now: number) {
  g.phase = 'night';
  g.round++;
  g.kills = {};
  g.protect = null;
  g.inspected = false;
  g.votes = {};
  g.since = now;
  g.log.push('Night falls again.');
}

function resolveNight(g: WolfGame, now: number) {
  // The werewolves' victim is whoever most of them picked; a tie is broken at random.
  const tally = new Map<string, number>();
  for (const target of Object.values(g.kills)) tally.set(target, (tally.get(target) ?? 0) + 1);
  const top = Math.max(0, ...tally.values());
  const tied = [...tally].filter(([, n]) => n === top).map(([id]) => id);
  const victim = tied.length ? find(g, tied[Math.floor(Math.random() * tied.length)]) : undefined;

  if (victim && victim.id !== g.protect) {
    victim.alive = false;
    g.log.push(`Morning. ${victim.name} was killed in the night. They were ${ROLE_LABEL[victim.role]}.`);
  } else {
    g.log.push('Morning. Nobody died last night.');
  }
  if (checkWin(g)) return;
  g.phase = 'day';
  g.votes = {};
  g.since = now;
}

function resolveDay(g: WolfGame, now: number) {
  const tally = new Map<string, number>();
  for (const target of Object.values(g.votes)) tally.set(target, (tally.get(target) ?? 0) + 1);
  const top = Math.max(0, ...tally.values());
  const tied = [...tally].filter(([, n]) => n === top).map(([id]) => id);
  const out = tied.length === 1 && tied[0] !== 'skip' ? find(g, tied[0]) : undefined;
  if (out) {
    out.alive = false;
    g.log.push(`The village voted out ${out.name}. They were ${ROLE_LABEL[out.role]}.`);
  } else {
    g.log.push('The vote was split. Nobody was voted out.');
  }
  if (checkWin(g)) return;
  startNight(g, now);
}

function nightDone(g: WolfGame) {
  const alive = living(g);
  const wolves = alive.filter((p) => p.role === 'werewolf');
  return (
    wolves.every((w) => g.kills[w.id]) &&
    (g.inspected || !alive.some((p) => p.role === 'seer')) &&
    (g.protect !== null || !alive.some((p) => p.role === 'doctor'))
  );
}

/** A night choice: the werewolves' victim, the seer's look, or the doctor's protection. */
export function wolfNight(g: WolfGame, pid: string, targetId: string, now: number): boolean {
  if (g.phase !== 'night') return false;
  const me = find(g, pid);
  const target = find(g, targetId);
  if (!me?.alive || !target?.alive) return false;

  if (me.role === 'werewolf') {
    if (target.role === 'werewolf') return false;
    g.kills[pid] = targetId;
  } else if (me.role === 'seer') {
    if (g.inspected || targetId === pid) return false;
    g.inspected = true;
    g.notes.push(`Night ${g.round}: ${target.name} is ${target.role === 'werewolf' ? 'a WEREWOLF' : 'not a werewolf'}.`);
  } else if (me.role === 'doctor') {
    if (g.protect !== null) return false;
    g.protect = targetId;
  } else {
    return false;
  }
  if (nightDone(g)) resolveNight(g, now);
  return true;
}

/** A daytime vote for who to put out, or 'skip'. You may change it until everyone has voted. */
export function wolfVote(g: WolfGame, pid: string, targetId: string, now: number): boolean {
  if (g.phase !== 'day') return false;
  const me = find(g, pid);
  if (!me?.alive) return false;
  if (targetId !== 'skip' && (!find(g, targetId)?.alive || targetId === pid)) return false;
  g.votes[pid] = targetId;
  if (living(g).every((p) => g.votes[p.id])) resolveDay(g, now);
  return true;
}

/** Move a stalled night or day on, counting only the choices made so far. */
export function wolfForce(g: WolfGame, pid: string, now: number): boolean {
  if (!playing(g) || !find(g, pid)?.alive || now - g.since < FORCE_AFTER_MS) return false;
  if (g.phase === 'night') resolveNight(g, now);
  else resolveDay(g, now);
  return true;
}

/** Someone left the table: they are out of the game and their role is revealed. */
export function wolfLeave(g: WolfGame, pid: string, now: number) {
  const me = find(g, pid);
  if (!playing(g) || !me?.alive) return;
  me.alive = false;
  g.log.push(`${me.name} left the game. They were ${ROLE_LABEL[me.role]}.`);
  delete g.kills[pid];
  delete g.votes[pid];
  for (const [k, v] of Object.entries(g.kills)) if (v === pid) delete g.kills[k];
  for (const [k, v] of Object.entries(g.votes)) if (v === pid) delete g.votes[k];
  if (g.protect === pid) g.protect = null;
  if (checkWin(g)) return;
  if (g.phase === 'night' && nightDone(g)) resolveNight(g, now);
  else if (g.phase === 'day' && living(g).every((p) => g.votes[p.id])) resolveDay(g, now);
}
