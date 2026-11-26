import { expect, test } from 'vitest';
import {
  FORCE_AFTER_MS,
  newWolf,
  rolesFor,
  wolfForce,
  wolfLeave,
  wolfNight,
  wolfStart,
  wolfVote,
  type Role,
  type WolfGame,
} from '../shared/werewolf';

const people = (n: number) =>
  ['Ann', 'Bao', 'Chi', 'Dung', 'Em', 'Giang', 'Hoa', 'Khanh', 'Lan', 'Minh', 'Nga', 'Oanh', 'Phuc']
    .slice(0, n)
    .map((name) => ({ id: name.toLowerCase(), name }));

// Ann is the werewolf, Bao the seer, Chi the doctor, Dung and Em villagers.
const FIVE: Role[] = ['werewolf', 'seer', 'doctor', 'villager', 'villager'];
const start = (roles = FIVE) => {
  const g = newWolf();
  wolfStart(g, people(roles.length), 0, roles);
  return g;
};
const alive = (g: WolfGame) => g.players.filter((p) => p.alive).map((p) => p.id);
const last = (g: WolfGame) => g.log[g.log.length - 1];

test('roles scale with the number of players', () => {
  const count = (n: number, role: Role) => rolesFor(n).filter((r) => r === role).length;
  expect(rolesFor(5)).toHaveLength(5);
  expect([count(5, 'werewolf'), count(7, 'werewolf'), count(8, 'werewolf'), count(12, 'werewolf')]).toEqual([1, 1, 2, 3]);
  expect([count(5, 'seer'), count(5, 'doctor'), count(5, 'villager')]).toEqual([1, 1, 2]);
});

test('needs between five and twelve players', () => {
  expect(wolfStart(newWolf(), people(4), 0)).toBe(false);
  expect(wolfStart(newWolf(), people(13), 0)).toBe(false);
  const g = newWolf();
  expect(wolfStart(g, people(5), 0)).toBe(true);
  expect(g.phase).toBe('night');
  expect(g.players.map((p) => p.role).sort()).toEqual([...FIVE].sort());
});

test('a game cannot be restarted while it is running', () => {
  const g = start();
  expect(wolfStart(g, people(5), 0)).toBe(false);
});

test('night waits for every role, then the victim dies and their role is revealed', () => {
  const g = start();
  expect(wolfNight(g, 'ann', 'dung', 1)).toBe(true);
  expect(g.phase).toBe('night');
  expect(wolfNight(g, 'bao', 'ann', 2)).toBe(true);
  expect(g.phase).toBe('night');
  expect(wolfNight(g, 'chi', 'em', 3)).toBe(true);
  expect(g.phase).toBe('day');
  expect(alive(g)).toEqual(['ann', 'bao', 'chi', 'em']);
  expect(last(g)).toBe('Morning. Dung was killed in the night. They were a villager.');
});

test('the doctor saves the victim', () => {
  const g = start();
  wolfNight(g, 'ann', 'dung', 1);
  wolfNight(g, 'bao', 'chi', 2);
  wolfNight(g, 'chi', 'dung', 3);
  expect(alive(g)).toHaveLength(5);
  expect(last(g)).toBe('Morning. Nobody died last night.');
});

test('the seer learns the truth, privately and once a night', () => {
  const g = start();
  expect(wolfNight(g, 'bao', 'bao', 1)).toBe(false); // not yourself
  wolfNight(g, 'bao', 'ann', 1);
  expect(g.notes).toEqual(['Night 1: Ann is a WEREWOLF.']);
  expect(wolfNight(g, 'bao', 'chi', 2)).toBe(false);
  expect(g.log.join(' ')).not.toContain('WEREWOLF');
});

test('night actions are limited by role', () => {
  const g = start();
  expect(wolfNight(g, 'dung', 'ann', 1)).toBe(false); // villagers do nothing
  expect(wolfNight(g, 'ann', 'ann', 1)).toBe(false); // wolves can't pick a wolf
  expect(wolfNight(g, 'ann', 'nobody', 1)).toBe(false);
  expect(wolfVote(g, 'ann', 'bao', 1)).toBe(false); // no voting at night
});

test('the village wins by voting out the last werewolf', () => {
  const g = start();
  wolfNight(g, 'ann', 'dung', 1);
  wolfNight(g, 'bao', 'ann', 1);
  wolfNight(g, 'chi', 'chi', 1);
  expect(wolfVote(g, 'dung', 'ann', 2)).toBe(false); // the dead don't vote
  expect(wolfVote(g, 'bao', 'bao', 2)).toBe(false); // not for yourself
  wolfVote(g, 'bao', 'ann', 2);
  wolfVote(g, 'chi', 'ann', 2);
  wolfVote(g, 'em', 'skip', 2);
  expect(g.phase).toBe('day'); // still waiting for Ann
  wolfVote(g, 'ann', 'bao', 2);
  expect(g.phase).toBe('over');
  expect(g.winner).toBe('village');
  expect(g.log).toContain('The village voted out Ann. They were a werewolf.');
});

test('a tied vote puts nobody out and night falls', () => {
  const g = start();
  wolfNight(g, 'ann', 'dung', 1);
  wolfNight(g, 'bao', 'chi', 1);
  wolfNight(g, 'chi', 'chi', 1);
  wolfVote(g, 'ann', 'bao', 2);
  wolfVote(g, 'bao', 'ann', 2);
  wolfVote(g, 'chi', 'skip', 2);
  wolfVote(g, 'em', 'skip', 2);
  expect(alive(g)).toHaveLength(4);
  expect(g.phase).toBe('night');
  expect(g.round).toBe(2);
  expect(g.kills).toEqual({});
  expect(g.inspected).toBe(false);
});

test('votes can be changed until everyone has voted', () => {
  const g = start();
  wolfNight(g, 'ann', 'dung', 1);
  wolfNight(g, 'bao', 'chi', 1);
  wolfNight(g, 'chi', 'chi', 1);
  wolfVote(g, 'bao', 'chi', 2);
  wolfVote(g, 'bao', 'ann', 2);
  expect(g.votes.bao).toBe('ann');
});

test('the werewolves win once they are half of those left', () => {
  const g = start();
  wolfNight(g, 'ann', 'dung', 1);
  wolfNight(g, 'bao', 'chi', 1);
  wolfNight(g, 'chi', 'chi', 1); // 4 left
  for (const id of ['ann', 'bao', 'chi']) wolfVote(g, id, 'em', 2);
  wolfVote(g, 'em', 'ann', 2); // Em out: 3 left, night 2
  expect(g.phase).toBe('night');
  wolfNight(g, 'ann', 'bao', 3);
  wolfNight(g, 'bao', 'chi', 3);
  wolfNight(g, 'chi', 'chi', 3); // Bao dies: Ann and Chi left
  expect(g.phase).toBe('over');
  expect(g.winner).toBe('werewolves');
});

test('with several werewolves the most-picked victim dies', () => {
  const roles: Role[] = ['werewolf', 'werewolf', 'seer', 'doctor', 'villager', 'villager', 'villager', 'villager'];
  const g = start(roles);
  wolfNight(g, 'ann', 'em', 1);
  expect(g.phase).toBe('night');
  wolfNight(g, 'bao', 'em', 1);
  wolfNight(g, 'chi', 'ann', 1);
  wolfNight(g, 'dung', 'giang', 1);
  expect(alive(g)).not.toContain('em');
  expect(alive(g)).toHaveLength(7);
});

test('a stalled night can be moved on, but only after the wait', () => {
  const g = start();
  wolfNight(g, 'ann', 'dung', 1);
  expect(wolfForce(g, 'bao', FORCE_AFTER_MS - 1)).toBe(false);
  expect(wolfForce(g, 'bao', FORCE_AFTER_MS)).toBe(true);
  expect(g.phase).toBe('day');
  expect(alive(g)).not.toContain('dung');
  expect(wolfForce(g, 'dung', FORCE_AFTER_MS * 3)).toBe(false); // the dead can't push things on
});

test('forcing a night with no werewolf choice kills nobody', () => {
  const g = start();
  wolfForce(g, 'bao', FORCE_AFTER_MS);
  expect(alive(g)).toHaveLength(5);
});

test('leaving reveals your role, and the last werewolf leaving ends the game', () => {
  const g = start();
  wolfLeave(g, 'dung', 1);
  expect(last(g)).toBe('Dung left the game. They were a villager.');
  expect(g.phase).toBe('night');
  wolfLeave(g, 'ann', 2);
  expect(g.winner).toBe('village');
});

test("someone leaving doesn't leave the night waiting on them", () => {
  const g = start();
  wolfNight(g, 'ann', 'dung', 1);
  wolfNight(g, 'bao', 'ann', 1);
  wolfLeave(g, 'chi', 2); // the doctor was the last one to act
  expect(g.phase).toBe('day');
});

// ---- regressions found by tests/sim/werewolf.sim.test.ts

test('regression: a doctor who leaves takes their protection with them', () => {
  const g = start();
  wolfNight(g, 'chi', 'dung', 1); // the doctor protects Dung...
  wolfLeave(g, 'chi', 2); // ...and then walks away from the table
  expect(g.protect).toBeNull();
  wolfNight(g, 'ann', 'dung', 3);
  wolfNight(g, 'bao', 'ann', 4);
  expect(g.phase).toBe('day');
  expect(alive(g)).not.toContain('dung'); // only a living doctor's choice counts
});

test('regression: a broken clock cannot force the night on early', () => {
  const g = start();
  expect(wolfForce(g, 'bao', NaN)).toBe(false);
  expect(g.phase).toBe('night');
});
