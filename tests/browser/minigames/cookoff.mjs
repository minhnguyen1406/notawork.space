// Cook-off with two browsers: the lobby, the sides, the start and the clock. Scoring is covered by the
// rule tests (serving a real dish here would take a minute). Needs `npm run dev`.
// Run: node tests/browser/minigames/cookoff.mjs
import { check, done, open, sleep, until } from '../lib.mjs';

const a = await open('Ann');
const b = await open('Bao');
const P = '.mg-cookoff';
const disabled = (page, label) => page.evaluate((s, l) => [...document.querySelectorAll(`${s} button`)].find((x) => x.textContent.trim().startsWith(l))?.disabled ?? null, P, label);
const seconds = async (page) => {
  const m = (await page.text(`${P} .mg-cookoff-clock`)).match(/^(\d):(\d\d)$/);
  return m ? +m[1] * 60 + +m[2] : -1;
};

await a.openGame('cookoff');
check('E at the signpost opens the game', (await a.text(`${P} h2`)) === 'Cook-off');
check('it says how many are needed', (await a.text(`${P} .mg-status`)).includes('Needs 2'));
check('it says the kitchen is shared', (await a.text(P)).includes('share the one kitchen'));
await a.press(P, 'Join');
check('one person cannot start', await until(async () => (await disabled(a, 'Start')) === true));
await b.openGame('cookoff');
await b.press(P, 'Join');
check('the two are dealt one to each side', await until(async () => {
  const red = await a.text(`${P} .mg-cookoff-red .mg-players`);
  const blue = await a.text(`${P} .mg-cookoff-blue .mg-players`);
  return [red, blue].sort().join() === 'Ann,Bao';
}));
check('with one a side nobody can switch', (await disabled(a, 'Switch')) === true && (await disabled(b, 'Switch')) === true);
check('either can start', await b.press(P, 'Start'));
check('everyone sees the countdown', await until(async () => (await a.text(`${P} .mg-cookoff-clock`)).startsWith('Starting in')));
check('then a three-minute clock', await until(async () => { const s = await seconds(a); return s > 170 && s <= 180; }));
check('each side has an order worth double', (await a.text(`${P} .mg-cookoff-red .mg-cookoff-order`)).includes('×2') && (await b.text(`${P} .mg-cookoff-blue .mg-cookoff-order`)).includes('×2'));
const first = await seconds(b);
await sleep(2500);
check('the clock counts down', (await seconds(b)) < first);

// The panel must not get in the way of walking.
const [x0, z0] = await a.pos();
await a.keyboard.down('KeyW');
await sleep(700);
await a.keyboard.up('KeyW');
const [x1, z1] = await a.pos();
check('walking still works with the panel up', Math.hypot(x1 - x0, z1 - z0) > 0.3);
check('and the contest is still on after pressing E and F', await (async () => {
  await a.keyboard.press('KeyE');
  await a.keyboard.press('KeyF');
  await sleep(300);
  return (await seconds(a)) > 0;
})());

await b.press(P, 'Leave');
check('a side with nobody left forfeits, back to the lobby', await until(async () => (await a.text(`${P} .mg-cookoff-result`)).includes('forfeit')));
check('and it waits for a second player again', (await a.text(`${P} .mg-status`)).includes('Needs 2'));
await done();
