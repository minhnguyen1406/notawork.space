import { CHESS_TABLE, COLLIDERS, LOUNGE, PITCH, SPAWN, WHEEL, type Collider } from '../../shared/layout';
import type { PlayerInfo } from '../../shared/protocol';
import { NPC_ID } from '../../shared/fun';

/** What the character needs from the room around it. */
export interface NpcIO {
  /** The real people in the room. */
  people(): PlayerInfo[];
  seatTaken(seat: string): boolean;
  say(text: string): void;
  emote(k: string): void;
  /** Sit in a seat, or stand up with null. */
  sit(seat: string | null): void;
  /** Appear in, or vanish from, everyone's room. */
  present(here: boolean): void;
}

interface Point {
  x: number;
  z: number;
}

const WALK = 4.4; // metres a second
const BODY = 0.38;
const HOME: Point = { x: LOUNGE.x + 4.6, z: LOUNGE.z + 4.4 }; // beside the fire, out of the way
const HUB: Point = { x: SPAWN.x, z: SPAWN.z + 4 }; // open deck in the middle; long walks go via here

/** Named places you can send the character to, with the route in from the open deck. */
const PLACES: Record<string, { via: Point[]; at: Point; words: string[] }> = {
  fire: { via: [], at: HOME, words: ['fire', 'lounge', 'home'] },
  cinema: { via: [], at: { x: 0, z: -2.6 }, words: ['cinema', 'screen', 'movie', 'film'] },
  kitchen: { via: [], at: { x: 10.2, z: 8 }, words: ['kitchen', 'cook', 'food'] },
  pitch: { via: [{ x: PITCH.cx, z: PITCH.z1 - 2.5 }], at: { x: PITCH.cx, z: PITCH.z1 + 4 }, words: ['pitch', 'football', 'field', 'soccer', 'ball'] },
  wheel: { via: [{ x: -16, z: 14 }, { x: -24, z: 8 }], at: { x: WHEEL.x + 2.6, z: WHEEL.z + 1.4 }, words: ['wheel', 'spin'] },
};
const CHESS_ROUTE: Point[] = [{ x: 7.5, z: 14 }, { x: 7.5, z: 20 }, { x: CHESS_TABLE.x - 1.5, z: CHESS_TABLE.z - 2.2 }];

const JOKES = [
  'My out-of-office reply has an out-of-office reply.',
  'I told my calendar I needed space. It booked me a room.',
  'This could have been a meeting. Luckily it is a rooftop.',
  'I put "rooftop" on my timesheet. Nobody has questioned it.',
  'Why did the spreadsheet go to therapy? Too many unresolved cells.',
  'I would tell you a joke about deadlines, but I never finished it.',
  'Reply all: the only horror story that fits in two words.',
];
const HELP = [
  'Things you can ask me: /claude chess · come · follow · stop · dance · wave · joke',
  'Also: /claude go fire | cinema | kitchen | pitch | wheel · flip · roll · pick · bye',
];

const pick = <T>(list: T[]) => list[Math.floor(Math.random() * list.length)];
const inside = (c: Collider, x: number, z: number) => Math.abs(x - c.x) < c.hw + BODY && Math.abs(z - c.z) < c.hd + BODY;
const blocked = (x: number, z: number, fromX: number, fromZ: number) => COLLIDERS.some((c) => inside(c, x, z) && !inside(c, fromX, fromZ));

/** The words after "/claude", or null if the message isn't for the character. */
export function commandIn(text: string): string | null {
  const m = /^\s*(?:\/claude\b|@claude\b|(?:hey |hi |ok |yo )?claude\b[,:!]?)\s*(.*)$/i.exec(text);
  return m ? m[1].trim().toLowerCase() : null;
}

/**
 * "Claude", a character that lives in the room and does what people ask in chat. It follows a few
 * fixed commands; it does not understand free conversation.
 */
export class Npc {
  readonly info: PlayerInfo = { id: NPC_ID, name: 'Claude', color: '#f2efe6', x: HOME.x, z: HOME.z, ry: Math.PI, seat: null };
  here = true;
  private route: Point[] = [];
  private arrive: (() => void) | null = null;
  private following: string | null = null;
  private stuck = 0;
  private lastGreet = 0;

  constructor(private io: NpcIO) {}

  /** Back to the starting state, for when the room empties. */
  reset() {
    this.route = [];
    this.arrive = null;
    this.following = null;
    this.info.seat = null;
    Object.assign(this.info, { x: HOME.x, z: HOME.z, ry: Math.PI });
    this.here = true;
  }

  /** Someone just came in. */
  greet(name: string, now: number) {
    if (!this.here || now - this.lastGreet < 20_000) return;
    this.lastGreet = now;
    this.io.emote('👋');
    this.io.say(`Hi ${name}! I'm Claude. Type /claude to see what I can do.`);
  }

  private stand() {
    if (this.info.seat) this.io.sit(null);
  }

  private goTo(points: Point[], then: (() => void) | null = null) {
    this.stand();
    this.following = null;
    // Long walks go by way of the open deck, which avoids most of the furniture.
    const far = Math.hypot(points[0].x - this.info.x, points[0].z - this.info.z) > 14;
    this.route = far ? [HUB, ...points] : [...points];
    this.arrive = then;
    this.stuck = 0;
  }

  /** Handle a chat message. Returns true if it was addressed to the character. */
  hears(from: PlayerInfo, text: string): boolean {
    const cmd = commandIn(text);
    if (cmd === null) return false;
    if (!this.here) {
      if (/^(bye|leave|go away)/.test(cmd)) return true;
      this.reset();
      this.info.x = SPAWN.x + 2;
      this.info.z = SPAWN.z + 2;
      this.io.present(true);
    }
    const has = (...words: string[]) => words.some((w) => cmd.includes(w));

    if (cmd === '' || has('help', 'what can you', 'commands')) {
      for (const line of HELP) this.io.say(line);
    } else if (has('chess')) {
      this.chess(from);
    } else if (has('follow')) {
      this.stand();
      this.route = [];
      this.following = from.id;
      this.io.say(`Right behind you, ${from.name}. Say /claude stop when you've had enough.`);
    } else if (has('stop', 'stay', 'wait', 'stand')) {
      this.following = null;
      this.route = [];
      this.stand();
      this.io.say('Staying put.');
    } else if (has('come', 'here')) {
      this.io.say('On my way.');
      this.goTo([this.near(from)]);
    } else if (has('dance')) {
      this.stand();
      this.io.emote('dance');
    } else if (has('wave', 'hello', 'hi', 'hey')) {
      this.io.emote('👋');
      this.io.say(`Hello, ${from.name}!`);
    } else if (has('joke', 'funny')) {
      this.io.say(pick(JOKES));
      this.io.emote('😂');
    } else if (has('flip', 'coin')) {
      this.io.say(`${from.name} flips a coin: ${Math.random() < 0.5 ? 'heads' : 'tails'}.`);
    } else if (has('roll', 'dice', 'die')) {
      this.io.say(`${from.name} rolls a ${1 + Math.floor(Math.random() * 6)}.`);
    } else if (has('pick', 'choose', 'who')) {
      const names = this.io.people().map((p) => p.name);
      this.io.say(names.length ? `I pick… ${pick(names)}!` : 'There is nobody to pick.');
    } else if (has('bye', 'leave', 'go away')) {
      this.stand();
      this.io.say('Off I go. Type /claude when you want me back.');
      this.io.emote('👋');
      this.route = [];
      this.following = null;
      this.here = false;
      this.io.present(false);
    } else {
      const place = Object.values(PLACES).find((p) => p.words.some((w) => cmd.includes(w)));
      if (place) {
        this.io.say('On my way.');
        this.goTo([...place.via, place.at]);
      } else {
        this.io.say("I only know a few commands and can't hold a real conversation in here. Type /claude help for the list.");
      }
    }
    return true;
  }

  /** A spot a couple of steps short of someone, on the side the character is coming from. */
  private near(p: Point): Point {
    const dx = this.info.x - p.x;
    const dz = this.info.z - p.z;
    const d = Math.hypot(dx, dz) || 1;
    return { x: p.x + (dx / d) * 1.8, z: p.z + (dz / d) * 1.8 };
  }

  private chess(from: PlayerInfo) {
    if (this.info.seat === 'chess:0' || this.info.seat === 'chess:1') {
      this.io.say(`I'm at the board already, ${from.name}. Sit opposite me and make a move.`);
      return;
    }
    // Black by choice, so the guest gets the first move.
    const seat = !this.io.seatTaken('chess:1') ? 'chess:1' : !this.io.seatTaken('chess:0') ? 'chess:0' : null;
    if (!seat) {
      this.io.say('Both chess seats are taken. Ask me again when one is free.');
      return;
    }
    this.io.say(`You're on, ${from.name}. Meet me at the chess table in the games lounge.`);
    this.goTo(CHESS_ROUTE, () => {
      const free = !this.io.seatTaken(seat) ? seat : !this.io.seatTaken('chess:0') ? 'chess:0' : !this.io.seatTaken('chess:1') ? 'chess:1' : null;
      if (free) this.io.sit(free);
      else this.io.say('Someone beat me to the seat. I will watch from here.');
    });
  }

  /** Advance by `dt` seconds. Returns true if the character moved. */
  tick(dt: number): boolean {
    if (!this.here || this.info.seat) return false;
    let target: Point | null = this.route[0] ?? null;
    if (this.following) {
      const leader = this.io.people().find((p) => p.id === this.following);
      if (!leader) this.following = null;
      else target = Math.hypot(leader.x - this.info.x, leader.z - this.info.z) > 2.4 ? leader : null;
    }
    if (!target) return false;

    const me = this.info;
    const dx = target.x - me.x;
    const dz = target.z - me.z;
    const d = Math.hypot(dx, dz);
    if (!this.following && d < 0.25) {
      this.route.shift();
      if (!this.route.length && this.arrive) {
        const then = this.arrive;
        this.arrive = null;
        then();
      }
      return false;
    }
    const step = Math.min(d, WALK * dt);
    const nx = me.x + (dx / d) * step;
    const nz = me.z + (dz / d) * step;
    const beforeX = me.x;
    const beforeZ = me.z;
    // Slide round furniture the same way a player does; if truly stuck for a while, step through.
    if (!blocked(nx, me.z, me.x, me.z) || this.stuck > 12) me.x = nx;
    if (!blocked(me.x, nz, me.x, me.z) || this.stuck > 12) me.z = nz;
    const progress = Math.hypot(me.x - beforeX, me.z - beforeZ);
    this.stuck = progress < step * 0.3 ? this.stuck + 1 : 0;
    me.ry = Math.atan2(dx, dz);
    return progress > 0;
  }
}
