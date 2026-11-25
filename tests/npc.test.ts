import { expect, test } from 'vitest';
import { Npc, commandIn, type NpcIO } from '../worker/src/npc';
import type { PlayerInfo } from '../shared/protocol';

test('only messages addressed to Claude are commands', () => {
  expect(commandIn('/claude chess')).toBe('chess');
  expect(commandIn('/claude play chess with me')).toBe('play chess with me');
  expect(commandIn('/Claude')).toBe('');
  expect(commandIn('hey claude, come here')).toBe('come here');
  expect(commandIn('@claude dance')).toBe('dance');
  expect(commandIn('claude: joke')).toBe('joke');
  expect(commandIn('I think claude is winning')).toBeNull();
  expect(commandIn('/claudette chess')).toBeNull();
  expect(commandIn('anyone for chess?')).toBeNull();
});

function room() {
  const minh: PlayerInfo = { id: 'p1', name: 'Minh', color: '#fff', look: 'male-a', x: 0, z: 12, ry: 0, seat: null };
  const said: string[] = [];
  const emotes: string[] = [];
  const taken = new Set<string>();
  const presence: boolean[] = [];
  let npc!: Npc;
  const io: NpcIO = {
    people: () => [minh],
    seatTaken: (s) => taken.has(s),
    say: (t) => said.push(t),
    emote: (k) => emotes.push(k),
    sit: (s) => {
      if (npc.info.seat) taken.delete(npc.info.seat);
      npc.info.seat = s;
      if (s) taken.add(s);
    },
    present: (h) => presence.push(h),
  };
  npc = new Npc(io);
  const run = (seconds: number) => {
    for (let i = 0; i < seconds * 10; i++) npc.tick(0.1);
  };
  return { npc, minh, said, emotes, taken, presence, run };
}
const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

test('ordinary chat is ignored', () => {
  const r = room();
  expect(r.npc.hears(r.minh, 'what a goal')).toBe(false);
  expect(r.said).toEqual([]);
});

test('"/claude" alone lists what it can do', () => {
  const r = room();
  expect(r.npc.hears(r.minh, '/claude')).toBe(true);
  expect(r.said.join(' ')).toContain('/claude chess');
});

test('"come" walks over and stops a couple of steps short', () => {
  const r = room();
  r.minh.x = 4;
  r.minh.z = 16;
  r.npc.hears(r.minh, '/claude come here');
  r.run(15);
  const d = dist(r.npc.info, r.minh);
  expect(d).toBeGreaterThan(1);
  expect(d).toBeLessThan(2.6);
});

test('"follow" keeps up as the person moves, and "stop" ends it', () => {
  const r = room();
  r.npc.hears(r.minh, '/claude follow me');
  r.run(6);
  r.minh.x = 8;
  r.minh.z = 16;
  r.run(8);
  expect(dist(r.npc.info, r.minh)).toBeLessThan(3);
  r.npc.hears(r.minh, '/claude stop');
  const at = { ...r.npc.info };
  r.minh.x = -10;
  r.run(5);
  expect(dist(r.npc.info, at)).toBe(0);
});

test('"chess" walks to the table and takes Black, leaving White for the guest', () => {
  const r = room();
  r.npc.hears(r.minh, '/claude play chess with me');
  expect(r.said[0]).toContain('chess table');
  r.run(30);
  expect(r.npc.info.seat).toBe('chess:1');
  r.npc.hears(r.minh, '/claude chess');
  expect(r.said.at(-1)).toContain('already');
});

test('chess takes White if Black is occupied, and declines if both are', () => {
  const r = room();
  r.taken.add('chess:1');
  r.npc.hears(r.minh, '/claude chess');
  r.run(30);
  expect(r.npc.info.seat).toBe('chess:0');

  const full = room();
  full.taken.add('chess:0');
  full.taken.add('chess:1');
  full.npc.hears(full.minh, '/claude chess');
  full.run(30);
  expect(full.npc.info.seat).toBeNull();
  expect(full.said.at(-1)).toContain('taken');
});

test('being sent somewhere else gets it out of its chair', () => {
  const r = room();
  r.npc.hears(r.minh, '/claude chess');
  r.run(30);
  r.npc.hears(r.minh, '/claude go to the cinema');
  expect(r.npc.info.seat).toBeNull();
  r.run(30);
  expect(r.npc.info.z).toBeLessThan(0);
});

test('"bye" sends it away and any command brings it back', () => {
  const r = room();
  r.npc.hears(r.minh, '/claude bye');
  expect(r.npc.here).toBe(false);
  expect(r.presence).toEqual([false]);
  expect(r.npc.tick(0.1)).toBe(false);
  r.npc.hears(r.minh, '/claude dance');
  expect(r.npc.here).toBe(true);
  expect(r.presence).toEqual([false, true]);
  expect(r.emotes).toContain('dance');
});

test('small commands answer in chat, and nonsense gets a polite pointer to help', () => {
  const r = room();
  r.npc.hears(r.minh, '/claude flip a coin');
  expect(r.said.at(-1)).toMatch(/heads|tails/);
  r.npc.hears(r.minh, '/claude roll');
  expect(r.said.at(-1)).toMatch(/rolls a [1-6]\./);
  r.npc.hears(r.minh, '/claude pick someone');
  expect(r.said.at(-1)).toContain('Minh');
  r.npc.hears(r.minh, '/claude what is the meaning of life');
  expect(r.said.at(-1)).toContain('/claude help');
});

test('greets newcomers, but not in a flood', () => {
  const r = room();
  r.npc.greet('Lan', 100_000);
  r.npc.greet('Bao', 101_000);
  expect(r.said).toHaveLength(1);
  r.npc.greet('Chi', 130_000);
  expect(r.said).toHaveLength(2);
});
