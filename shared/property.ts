// Phố Lớn ("Big Street"): an original property-trading board game around Vietnam.
// Pure rules over a plain state object; the server runs them. Nothing is hidden in this game.

export type SpaceKind = 'start' | 'city' | 'lucky' | 'rest' | 'toll' | 'jam' | 'festival' | 'tax';
export interface Space {
  name: string;
  kind: SpaceKind;
  price?: number;
  group?: number;
}

const city = (name: string, group: number, price: number): Space => ({ name, kind: 'city', group, price });

/** The 24 spaces, clockwise from Start. Cities come in pairs that share a colour. */
export const SPACES: Space[] = [
  { name: 'Start', kind: 'start' },
  city('Hà Giang', 0, 60),
  city('Cao Bằng', 0, 80),
  { name: 'Lucky envelope', kind: 'lucky' },
  city('Sa Pa', 1, 100),
  city('Hạ Long', 1, 120),
  { name: 'Tea break', kind: 'rest' },
  city('Hải Phòng', 2, 140),
  city('Ninh Bình', 2, 160),
  { name: 'Road toll', kind: 'toll' },
  city('Huế', 3, 180),
  city('Hội An', 3, 200),
  { name: 'Traffic jam', kind: 'jam' },
  city('Đà Nẵng', 4, 220),
  city('Nha Trang', 4, 240),
  { name: 'Lucky envelope', kind: 'lucky' },
  city('Đà Lạt', 5, 260),
  city('Vũng Tàu', 5, 280),
  { name: 'Festival', kind: 'festival' },
  city('Cần Thơ', 6, 300),
  city('Phú Quốc', 6, 320),
  { name: 'Market tax', kind: 'tax' },
  city('Hà Nội', 7, 360),
  city('Sài Gòn', 7, 400),
];

export const GROUP_COLORS = ['#8d6e63', '#4fc3f7', '#ec407a', '#ffa726', '#ef5350', '#ffee58', '#66bb6a', '#5c6bc0'];
export const TOKEN_COLORS = ['#e4572e', '#3a86ff', '#76b041', '#f3a712', '#8338ec', '#29a19c'];

export const START_CASH = 1500;
export const PASS_START = 200;
export const TOLL = 100;
export const FESTIVAL = 100;
export const MAX_LEVEL = 3;
export const LEVEL_NAMES = ['', 'stall', 'shop', 'tower'];
const RENT_MULT = [1, 3, 6, 10];
export const PHO_MIN = 2;
export const PHO_MAX = 6;

export const PHO_RULES = [
  `For ${PHO_MIN} to ${PHO_MAX} players. Everyone starts with ${START_CASH} and takes turns rolling one die.`,
  'Land on a city nobody owns and you may buy it. Land on someone else’s city and you pay them rent.',
  'Own both cities of a colour and the rent doubles. You can then build on them: stall, shop, tower.',
  `Passing Start pays ${PASS_START}. Lucky envelopes can go either way. A traffic jam costs you a turn.`,
  'If you can’t pay, your buildings and then your cities are sold off. Run out completely and you are out.',
  'Last player standing wins, or anyone can end the game early and the richest player wins.',
];

interface Lucky {
  text: string;
  apply(g: PhoGame, pid: string): void;
}

export interface PhoGame {
  phase: 'lobby' | 'roll' | 'buy' | 'end' | 'over';
  /** Player ids in turn order; people who go bust are removed. */
  order: string[];
  names: Record<string, string>;
  /** Token colour index for each player, fixed for the whole game. */
  token: Record<string, number>;
  cash: Record<string, number>;
  pos: Record<string, number>;
  owner: Record<number, string>;
  level: Record<number, number>;
  skip: Record<string, boolean>;
  turn: number;
  die: number | null;
  log: string[];
  winner: string | null;
}

export type PhoAction =
  | { k: 'start' }
  | { k: 'roll' }
  | { k: 'buy'; yes: boolean }
  | { k: 'build'; space: number }
  | { k: 'end' }
  | { k: 'finish' };

export const newPho = (): PhoGame => ({
  phase: 'lobby',
  order: [],
  names: {},
  token: {},
  cash: {},
  pos: {},
  owner: {},
  level: {},
  skip: {},
  turn: 0,
  die: null,
  log: [],
  winner: null,
});

const playing = (g: PhoGame) => g.phase === 'roll' || g.phase === 'buy' || g.phase === 'end';
export const phoCurrent = (g: PhoGame) => g.order[g.turn];
const say = (g: PhoGame, line: string) => {
  g.log.push(line);
  if (g.log.length > 40) g.log.shift();
};

export const ownsGroup = (g: PhoGame, pid: string, group: number) =>
  SPACES.every((s, i) => s.group !== group || g.owner[i] === pid);

export function rentFor(g: PhoGame, i: number): number {
  const s = SPACES[i];
  const base = s.price! / 10;
  const level = g.level[i] ?? 0;
  if (level > 0) return base * RENT_MULT[level];
  return ownsGroup(g, g.owner[i], s.group!) ? base * 2 : base;
}

export const upgradeCost = (i: number) => SPACES[i].price! / 2;

export function netWorth(g: PhoGame, pid: string): number {
  let total = g.cash[pid] ?? 0;
  for (const [i, owner] of Object.entries(g.owner)) {
    if (owner === pid) total += SPACES[+i].price! + (g.level[+i] ?? 0) * upgradeCost(+i);
  }
  return total;
}

export function canBuild(g: PhoGame, pid: string, i: number): boolean {
  const s = SPACES[i];
  return (
    s.kind === 'city' &&
    g.owner[i] === pid &&
    ownsGroup(g, pid, s.group!) &&
    (g.level[i] ?? 0) < MAX_LEVEL &&
    g.cash[pid] >= upgradeCost(i)
  );
}

export function phoStart(g: PhoGame, players: { id: string; name: string }[]): boolean {
  if (playing(g) || players.length < PHO_MIN || players.length > PHO_MAX) return false;
  Object.assign(g, newPho(), { phase: 'roll', order: players.map((p) => p.id) });
  players.forEach((p, i) => {
    g.names[p.id] = p.name;
    g.token[p.id] = i;
    g.cash[p.id] = START_CASH;
    g.pos[p.id] = 0;
  });
  say(g, `The game begins. ${g.names[phoCurrent(g)]} rolls first.`);
  return true;
}

function finishWith(g: PhoGame, winner: string, why: string) {
  g.phase = 'over';
  g.winner = winner;
  say(g, `${g.names[winner]} wins ${why}!`);
}

/** Remove a player who is bust or has left. Their cities go back to the bank. */
function remove(g: PhoGame, pid: string) {
  const i = g.order.indexOf(pid);
  if (i < 0) return;
  for (const [space, owner] of Object.entries(g.owner)) {
    if (owner === pid) {
      delete g.owner[+space];
      delete g.level[+space];
    }
  }
  const wasTurn = i === g.turn;
  g.order.splice(i, 1);
  if (g.order.length === 1) return finishWith(g, g.order[0], 'as the last player standing');
  if (i < g.turn) g.turn--;
  g.turn %= g.order.length;
  if (wasTurn) {
    // The seat that held the turn is gone, so the same index is now the next player.
    g.phase = 'roll';
    g.die = null;
  }
}

/** Take money from a player, selling their things if needed. Returns what was actually paid. */
function charge(g: PhoGame, pid: string, amount: number, to: string | null): number {
  if (g.cash[pid] < amount) {
    // Sell buildings first (for half what they cost), then cities (for half their price), dearest first.
    const mine = Object.keys(g.owner)
      .map(Number)
      .filter((i) => g.owner[i] === pid)
      .sort((a, b) => SPACES[b].price! - SPACES[a].price!);
    for (const i of mine) {
      while (g.cash[pid] < amount && (g.level[i] ?? 0) > 0) {
        g.level[i]--;
        g.cash[pid] += upgradeCost(i) / 2;
        say(g, `${g.names[pid]} sells a building in ${SPACES[i].name}.`);
      }
    }
    for (const i of mine) {
      if (g.cash[pid] >= amount) break;
      delete g.owner[i];
      delete g.level[i];
      g.cash[pid] += SPACES[i].price! / 2;
      say(g, `${g.names[pid]} sells ${SPACES[i].name} back to the bank.`);
    }
  }
  const paid = Math.min(amount, g.cash[pid]);
  g.cash[pid] -= paid;
  if (to && g.order.includes(to)) g.cash[to] += paid;
  if (paid < amount) {
    say(g, `${g.names[pid]} can't pay and is out of the game.`);
    remove(g, pid);
  }
  return paid;
}

const LUCKY: Lucky[] = [
  { text: 'Lì xì from grandma: collect 100.', apply: (g, p) => void (g.cash[p] += 100) },
  { text: 'Sold bánh mì all morning: collect 150.', apply: (g, p) => void (g.cash[p] += 150) },
  { text: 'Motorbike repair: pay 80.', apply: (g, p) => void charge(g, p, 80, null) },
  { text: 'Wedding gift: pay 50.', apply: (g, p) => void charge(g, p, 50, null) },
  {
    text: `Flight home for Tết: go to Start and collect ${PASS_START}.`,
    apply: (g, p) => {
      g.pos[p] = 0;
      g.cash[p] += PASS_START;
    },
  },
  {
    text: 'Your birthday: every other player gives you 25.',
    apply: (g, p) => {
      for (const other of [...g.order]) if (other !== p) charge(g, other, 25, p);
    },
  },
  {
    text: 'You buy a round of cà phê: pay every other player 25.',
    apply: (g, p) => {
      for (const other of [...g.order]) if (other !== p && g.order.includes(p)) charge(g, p, 25, other);
    },
  },
];
export const LUCKY_COUNT = LUCKY.length;

/** Deal with wherever the current player has landed. */
function land(g: PhoGame, pid: string, lucky?: number) {
  const i = g.pos[pid];
  const s = SPACES[i];
  const name = g.names[pid];
  switch (s.kind) {
    case 'city': {
      const owner = g.owner[i];
      if (!owner) {
        if (g.cash[pid] >= s.price!) {
          g.phase = 'buy';
          return;
        }
        say(g, `${name} can't afford ${s.name}.`);
      } else if (owner !== pid) {
        const rent = rentFor(g, i);
        say(g, `${name} pays ${rent} rent to ${g.names[owner]} for ${s.name}.`);
        charge(g, pid, rent, owner);
      }
      break;
    }
    case 'toll':
      say(g, `${name} pays a ${TOLL} road toll.`);
      charge(g, pid, TOLL, null);
      break;
    case 'tax': {
      const tax = Math.ceil(g.cash[pid] / 100) * 10;
      say(g, `${name} pays ${tax} market tax.`);
      charge(g, pid, tax, null);
      break;
    }
    case 'festival':
      g.cash[pid] += FESTIVAL;
      say(g, `${name} enjoys the festival and collects ${FESTIVAL}.`);
      break;
    case 'jam':
      g.skip[pid] = true;
      say(g, `${name} is stuck in traffic and will miss a turn.`);
      break;
    case 'lucky': {
      const card = LUCKY[lucky ?? Math.floor(Math.random() * LUCKY.length)];
      say(g, `${name} opens a lucky envelope. ${card.text}`);
      card.apply(g, pid);
      break;
    }
    default:
      break;
  }
  if (playing(g) && phoCurrent(g) === pid) g.phase = 'end';
}

/** Roll and move. `die` and `lucky` are only passed by tests; normally both are random. */
export function phoRoll(g: PhoGame, pid: string, die?: number, lucky?: number): boolean {
  if (g.phase !== 'roll' || phoCurrent(g) !== pid) return false;
  const roll = die ?? 1 + Math.floor(Math.random() * 6);
  g.die = roll;
  const from = g.pos[pid];
  g.pos[pid] = (from + roll) % SPACES.length;
  if (g.pos[pid] < from) {
    g.cash[pid] += PASS_START;
    say(g, `${g.names[pid]} rolls ${roll}, passes Start and collects ${PASS_START}.`);
  } else {
    say(g, `${g.names[pid]} rolls ${roll} and lands on ${SPACES[g.pos[pid]].name}.`);
  }
  land(g, pid, lucky);
  return true;
}

export function phoBuy(g: PhoGame, pid: string, yes: boolean): boolean {
  if (g.phase !== 'buy' || phoCurrent(g) !== pid) return false;
  const i = g.pos[pid];
  if (yes) {
    g.cash[pid] -= SPACES[i].price!;
    g.owner[i] = pid;
    say(g, `${g.names[pid]} buys ${SPACES[i].name} for ${SPACES[i].price}.`);
  }
  g.phase = 'end';
  return true;
}

export function phoBuild(g: PhoGame, pid: string, i: number): boolean {
  if (g.phase !== 'end' || phoCurrent(g) !== pid || !Number.isInteger(i) || !SPACES[i] || !canBuild(g, pid, i)) return false;
  g.cash[pid] -= upgradeCost(i);
  g.level[i] = (g.level[i] ?? 0) + 1;
  say(g, `${g.names[pid]} builds a ${LEVEL_NAMES[g.level[i]]} in ${SPACES[i].name}.`);
  return true;
}

export function phoEnd(g: PhoGame, pid: string): boolean {
  if (g.phase !== 'end' || phoCurrent(g) !== pid) return false;
  g.die = null;
  g.phase = 'roll';
  // Move to the next player, passing over anyone stuck in traffic (which uses up their jam).
  for (let n = 0; n < g.order.length; n++) {
    g.turn = (g.turn + 1) % g.order.length;
    const next = phoCurrent(g);
    if (!g.skip[next]) break;
    g.skip[next] = false;
    say(g, `${g.names[next]} is still in traffic and misses this turn.`);
  }
  return true;
}

/** End the game now: the richest player (cash plus cities and buildings) wins. */
export function phoFinish(g: PhoGame, pid: string): boolean {
  if (!playing(g) || !g.order.includes(pid)) return false;
  const richest = [...g.order].sort((a, b) => netWorth(g, b) - netWorth(g, a))[0];
  finishWith(g, richest, `with ${netWorth(g, richest)} in cash and property`);
  return true;
}

export function phoLeave(g: PhoGame, pid: string) {
  if (!playing(g) || !g.order.includes(pid)) return;
  say(g, `${g.names[pid]} left the game.`);
  remove(g, pid);
}
