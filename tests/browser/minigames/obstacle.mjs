// Obstacle dash with two browsers. Needs `npm run dev`. Run: node tests/browser/minigames/obstacle.mjs
import { check, done, open, sleep, until } from '../lib.mjs';

const a = await open('Ann');
const b = await open('Bao');
const P = '.mg-obstacle';
const rules = (page) => page.evaluate(async () => {
  const m = await import('/shared/minigames/obstacle.ts');
  return { START_X: m.START_X, FINISH_X: m.FINISH_X, MID_Z: m.MID_Z, LANE: m.LANE, COUNTDOWN_MS: m.COUNTDOWN_MS };
});
const { START_X, FINISH_X, MID_Z, LANE, COUNTDOWN_MS } = await rules(a);
const near = (p, x, z, d = 0.3) => !!p && Math.hypot(p[0] - x, p[1] - z) < d;
/** Hop east in small steps, only into spots no barrier is touching on this browser's own run clock. */
const dash = (page) => page.evaluate(async (finish, z) => {
  const m = await import('/shared/minigames/obstacle.ts');
  const clock = () => parseFloat(document.querySelector('.mg-obstacle-clock')?.textContent ?? '');
  for (const end = Date.now() + 60000; Date.now() < end; ) {
    const [x] = window.__debug.pos();
    if (x >= finish + 0.3) return true;
    const t = clock();
    const nx = Math.min(x + 0.45, finish + 0.4);
    // Clear now and for the next third of a second, so nothing sweeps in between hops.
    const clear = [0, 0.1, 0.2, 0.3].every((d) => m.barrierHit(nx, z, t + d, 0.6) < 0);
    if (Number.isFinite(t) && clear) window.__debug.tp(nx, z);
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}, FINISH_X, LANE.z1 + 0.6);

await a.openGame('obstacle');
check('E at the signpost opens the game', (await a.text(`${P} h2`)) === 'Obstacle dash');
check('it says it is a solo run and the board is empty', (await a.text(`${P} .mg-status`)).includes('solo run') && (await a.text(P)).includes('No times yet'));

check('there is a Run button', await a.press(P, 'Run'));
check('Run moves you to the start line', await until(async () => near(await a.pos(), START_X, MID_Z)));
check('and shows a countdown', await until(async () => ['3', '2', '1'].includes(await a.text(`${P} .mg-obstacle-clock`)), 2000));
await a.keyboard.down('KeyW');
await sleep(600);
await a.keyboard.up('KeyW');
check('you are rooted during the countdown', near(await a.pos(), START_X, MID_Z));
check('then the clock runs', await until(async () => (await a.text(`${P} .mg-obstacle-clock`)).endsWith('s'), COUNTDOWN_MS + 3000));

// Stand in a barrier's path: it sends you back to the start and the clock keeps going.
const sweeper = await a.evaluate(async () => (await import('/shared/minigames/obstacle.ts')).BARRIERS[0].x);
await a.tp(sweeper, MID_Z);
check('touching a barrier sends you back to the start', await until(async () => near(await a.pos(), START_X, MID_Z), 6000));
const before = parseFloat(await a.text(`${P} .mg-obstacle-clock`));
await sleep(700);
check('and the clock keeps running', parseFloat(await a.text(`${P} .mg-obstacle-clock`)) > before);

// Bao is not running: the barriers do nothing to him, and he sees no clock.
await b.tp(sweeper, MID_Z);
await sleep(3000);
check('barriers ignore someone who is not running', near(await b.pos(), sweeper, MID_Z));
await b.openGame('obstacle');
check('a watcher is told someone is running', await until(async () => (await b.text(P)).includes('1 other person is running')));

check('the runner reaches the finish', await dash(a));
check('the server accepts the finish and times it', await until(async () => (await a.text(`${P} .mg-status`)).startsWith('Finished in')));
check('it is a new best', (await a.text(`${P} .mg-status`)).includes('new best'));
check('both see the time on the board', await until(async () => (await a.text(`${P} .mg-obstacle-board`)).startsWith('Ann') && (await b.text(`${P} .mg-obstacle-board`)).startsWith('Ann')));

check('Bao starts a run', await b.press(P, 'Run'));
check('Bao is put on the start line too', await until(async () => near(await b.pos(), START_X, MID_Z)));
await until(async () => (await b.text(`${P} .mg-obstacle-clock`)).endsWith('s'), COUNTDOWN_MS + 3000);

// Both run at once, each on their own clock.
check('Ann runs again while Bao is running', await a.press(P, 'Run again'));
check('Ann gets her own countdown', await until(async () => ['3', '2', '1'].includes(await a.text(`${P} .mg-obstacle-clock`)), 2000));
check('Bao is already timing', (await b.text(`${P} .mg-obstacle-clock`)).endsWith('s'));

// Stop cancels; walking out of the lane cancels.
check('Stop cancels the run', (await b.press(P, 'Stop')) && (await until(async () => (await b.text(`${P} .mg-status`)).includes('stopped'))));
await until(async () => (await a.text(`${P} .mg-obstacle-clock`)).endsWith('s'), COUNTDOWN_MS + 3000);
await a.tp(LANE.x1 + 3, LANE.z2 + 4);
check('walking out of the lane cancels the run', await until(async () => (await a.text(`${P} .mg-status`)).includes('left the lane')));
check('the board still has one time per name', (await b.text(`${P} .mg-obstacle-board`)).startsWith('Ann') && !(await b.text(`${P} .mg-obstacle-board`)).includes('Bao'));

// After a stop you are free to move.
const b0 = await b.pos();
await b.keyboard.down('KeyW');
await sleep(500);
await b.keyboard.up('KeyW');
const b1 = await b.pos();
check('you are not left rooted after a run ends', Math.hypot(b1[0] - b0[0], b1[1] - b0[1]) > 0.3);
await done();
