// Sumo ring with two browsers. Needs `npm run dev`. Run: node tests/browser/minigames/sumo.mjs
import { check, done, open, sleep, until } from '../lib.mjs';

const a = await open('Ann');
const b = await open('Bao');
const P = '.mg-sumo';
const ring = await a.evaluate(async () => (await import('/shared/minigames.ts')).GAME_ZONES.sumo);
const fromCentre = async (page) => {
  const [x, z] = await page.pos();
  return Math.hypot(x - ring.x, z - ring.z);
};
const apart = async () => {
  const [ax, az] = await a.pos();
  const [bx, bz] = await b.pos();
  return Math.hypot(ax - bx, az - bz);
};
const status = (page) => page.text(`${P} .mg-status`);

await a.openGame('sumo');
check('E at the signpost opens the game', (await a.text(`${P} h2`)) === 'Sumo ring');
check('it says how many are needed', (await status(a)).includes('Needs 2 to 8'));
await a.press(P, 'Join');
check('one player cannot start', !(await a.press(P, 'Start')));
await b.openGame('sumo');
await b.press(P, 'Join');
check('both players are listed for both, with no wins', await until(async () => (await a.text(`${P} .mg-players`)) === 'Ann0Bao0' && (await b.text(`${P} .mg-players`)) === 'Ann0Bao0'));

// Round 1: the countdown puts both in the ring and roots them.
check('anyone in the game can start', await b.press(P, 'Start'));
check('a countdown begins', await until(async () => (await status(a)).includes('get ready')));
check('both are put inside the ring, well apart', await until(async () => (await fromCentre(a)) < ring.r && (await fromCentre(b)) < ring.r && (await apart()) > 2));
const [x0, z0] = await a.pos();
await a.keyboard.down('KeyW');
await sleep(600);
await a.keyboard.up('KeyW');
const [x1, z1] = await a.pos();
check('players are rooted during the countdown', Math.hypot(x1 - x0, z1 - z0) < 0.05);
check('then the bout starts', await until(async () => (await status(a)).includes('push!') && (await status(b)).includes('push!')));
// A short step only: a long walk could carry Ann over the rim.
await a.keyboard.down('KeyW');
await sleep(250);
await a.keyboard.up('KeyW');
const [x2, z2] = await a.pos();
check('and walking keys work again with the panel showing', Math.hypot(x2 - x1, z2 - z1) > 0.1);

// Stand almost on top of each other in the middle: the server pushes them apart.
await a.tp(ring.x - 0.2, ring.z);
await b.tp(ring.x + 0.2, ring.z);
check('players who overlap are pushed apart', await until(async () => (await apart()) > 1.1));
check('and neither was thrown out by it', (await fromCentre(a)) < ring.r && (await fromCentre(b)) < ring.r);

// Bao steps out: Ann takes the round.
await b.tp(ring.x, ring.z + ring.r + 0.6);
check('leaving the ring loses the round', await until(async () => (await status(a)).includes('Ann wins round 1')));
check('the win is on the scoreboard', await until(async () => (await b.text(`${P} .mg-players`)) === 'Ann1Bao0'));
check('the loser is stood outside the ring', (await fromCentre(b)) > ring.r);

// Round 2 starts by itself; Bao steps out again and Ann has the match.
check('round 2 counts down, back inside the ring', await until(async () => (await status(b)).includes('Round 2') && (await fromCentre(b)) < ring.r, 15000));
check('round 2 starts', await until(async () => (await status(b)).includes('push!')));
await b.tp(ring.x, ring.z + ring.r + 0.6);
check('two rounds win the match', await until(async () => (await status(a)).includes('Ann won the match') && (await status(b)).includes('Ann won the match')));
check('and it is back in the lobby, ready to start again', await until(async () => (await a.text(`${P} .mg-row`)).includes('Start')));

// Leaving mid-match calls it off rather than leaving the other player stuck.
await a.press(P, 'Start');
check('a second match starts with the score wiped', await until(async () => (await a.text(`${P} .mg-players`)) === 'Ann0Bao0' && (await status(a)).includes('Round 1')));
await b.press(P, 'Leave');
check('leaving with two players drops back to waiting', await until(async () => (await status(a)).includes('Needs 2 to 8')));
await sleep(300);
const [x3, z3] = await a.pos();
await a.keyboard.down('KeyS');
await sleep(500);
await a.keyboard.up('KeyS');
const [x4, z4] = await a.pos();
check('and the player left behind is not still rooted', Math.hypot(x4 - x3, z4 - z3) > 0.2);
await done();
