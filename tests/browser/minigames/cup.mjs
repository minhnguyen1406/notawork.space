// Football match with three browsers. Needs `npm run dev`. Run: node tests/browser/minigames/cup.mjs
// It plays a kick-off, a walked-in goal and a forfeit; the full four minutes are covered by the rule tests.
import { check, done, open, sleep, until } from '../lib.mjs';

const a = await open('Ann');
const b = await open('Bao');
const c = await open('Chi');
const P = '.mg-cup';
const PITCH = await a.evaluate(async () => (await import('/shared/layout.ts')).PITCH);

await a.openGame('cup');
check('E at the signpost opens the game', (await a.text(`${P} h2`)) === 'Football match');
check('it says how many are needed', (await a.text(`${P} .mg-status`)).includes('Needs 2'));
await a.press(P, 'Join');
check('one player cannot kick off', await until(async () => (await a.text(`${P} .mg-cup-red`)).includes('Ann')) && !(await a.press(P, 'Kick off')));
await b.openGame('cup');
await b.press(P, 'Join');
check('the second player goes to the other side', await until(async () => (await a.text(`${P} .mg-cup-red`)).includes('Ann') && (await a.text(`${P} .mg-cup-blue`)).includes('Bao')));
check('one a side cannot switch', !(await a.press(P, 'Switch sides')));
await c.openGame('cup');
await c.press(P, 'Join');
check('the third joins Red, two against one', await until(async () => (await b.text(`${P} .mg-cup-red`)).includes('Chi')));
check('with two against one, a Red player can switch', await c.press(P, 'Switch sides'));
check('and everyone sees the switch', await until(async () => (await a.text(`${P} .mg-cup-blue`)).includes('Chi')));
await c.press(P, 'Switch sides');
await until(async () => (await a.text(`${P} .mg-cup-red`)).includes('Chi'));
check('Shuffle keeps the sides within one', (await b.press(P, 'Shuffle')) && (await until(async () => /\((1|2)\).*\((1|2)\)/.test(await a.text(`${P} .mg-cup-teams`)))));

// Kick off: score 0-0, everyone in their own half, rooted for the countdown.
await sleep(300);
const redNow = async (page) => (await page.text(`${P} .mg-cup-red`)).includes(await page.evaluate(() => document.querySelector('.mg-cup .mg-chip.me')?.textContent.replace(/ ⚽.*/, '') ?? '?'));
await a.press(P, 'Kick off');
check('kick-off shows the score and a countdown to everyone', await until(async () => (await b.text(`${P} .mg-cup-score`)) === 'Red 0 – 0 Blue' && (await b.text(`${P} .mg-status`)).includes('Kick-off in')));
check('the clock starts at four minutes', (await a.text(`${P} .mg-cup-clock`)) === '4:00');
for (const page of [a, b, c]) {
  const red = await redNow(page);
  const [x, z] = await page.pos();
  check(`${red ? 'a Red' : 'a Blue'} player starts in their own half`, (red ? x < PITCH.cx : x > PITCH.cx) && z > PITCH.z1 && z < PITCH.z2);
}
const [x0, z0] = await a.pos();
await a.keyboard.down('KeyW');
await sleep(600);
await a.keyboard.up('KeyW');
const [x1, z1] = await a.pos();
check('players are rooted during the countdown', Math.hypot(x1 - x0, z1 - z0) < 0.05);
check('play starts and the clock runs', await until(async () => /^3:5\d$/.test(await a.text(`${P} .mg-cup-clock`))));
await a.keyboard.down('KeyW');
await sleep(600);
await a.keyboard.up('KeyW');
const [x2, z2] = await a.pos();
check('and then they can walk, with the panel still showing', Math.hypot(x2 - x1, z2 - z1) > 0.3 && (await a.text(`${P} .mg-cup-score`)) !== '');
check('no button holds the keyboard, so Space stays the room’s key', await a.evaluate(() => !(document.activeElement instanceof HTMLButtonElement)));

// A goal: someone dribbles the ball from the centre spot into a goal by walking through it.
const ball = async () => a.evaluate(() => window.__debug.ball());
const scoreNow = () => a.text(`${P} .mg-cup-score`);
let scored = false;
for (let tries = 0; tries < 4 && !scored; tries++) {
  // Stand just west of the ball and run east, pushing it towards Blue's goal.
  const at = await ball();
  await a.tp(at.x - 1.2, at.z);
  await a.keyboard.down('KeyD');
  scored = await until(async () => (await scoreNow()) !== 'Red 0 – 0 Blue', 9000);
  await a.keyboard.up('KeyD');
}
check('a goal is counted on the panel', scored);
if (scored) {
  check('the goal names the scorer and holds a kick-off pause', await until(async () => /Ann (scored|put it)/.test(await b.text(`${P} .mg-status`)) && (await b.text(`${P} .mg-status`)).includes('Kick-off in'), 3000));
  const [bx, bz] = [await ball()].map((s) => [s.x, s.z])[0];
  check('the ball is back on the centre spot', Math.hypot(bx - PITCH.cx, bz - PITCH.cz) < 1);
  check('play restarts after the pause', await until(async () => !(await b.text(`${P} .mg-status`)).includes('Kick-off in')));
}

// Forfeit: whoever is alone on their side leaves, and the other side wins.
const aRed = await redNow(a);
const bRed = await redNow(b);
const cRed = await redNow(c);
const alone = aRed !== bRed && aRed !== cRed ? a : bRed !== aRed && bRed !== cRed ? b : c;
const stayer = alone === a ? b : a;
await alone.press(P, 'Leave');
check('a side with nobody left forfeits and the match ends', await until(async () => (await stayer.text(`${P} .mg-cup-last`)).includes('by forfeit')));
check('back in the lobby, ready to kick off again', await until(async () => (await stayer.text(`${P} .mg-row`)).includes('Kick off')));
const [fx, fz] = await stayer.pos();
await stayer.keyboard.down('KeyW');
await sleep(600);
await stayer.keyboard.up('KeyW');
const [gx, gz] = await stayer.pos();
check('nobody is left rooted afterwards', Math.hypot(gx - fx, gz - fz) > 0.3);
await done();
