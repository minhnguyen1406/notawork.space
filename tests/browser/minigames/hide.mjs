// Hide and seek with two browsers. Needs `npm run dev`. Run: node tests/browser/minigames/hide.mjs
// Takes a little over half a minute: the hiding phase is a real 30 seconds.
import { check, done, open, sleep, until } from '../lib.mjs';

const a = await open('Ann');
const b = await open('Bao');
const P = '.mg-hide';
/** How many name tags this browser has switched off (the panel publishes it for this test). */
const tagsOff = (page) => page.evaluate((s) => Number(document.querySelector(s)?.dataset.tagsOff ?? 0), P);

await a.openGame('hide');
check('E at the signpost opens the game', (await a.text(`${P} h2`)) === 'Hide and seek');
check('it says how many are needed', (await a.text(`${P} .mg-status`)).includes('Needs 2'));
await a.press(P, 'Join');
await b.openGame('hide');
await b.press(P, 'Join');
check('both players are listed for both', await until(async () => (await a.text(`${P} .mg-players`)) === 'AnnBao' && (await b.text(`${P} .mg-players`)) === 'AnnBao'));

check('anyone in the game can start', await b.press(P, 'Start'));
check('the round starts with someone seeking', await until(async () => ((await a.text(`${P} .mg-status`)) + (await b.text(`${P} .mg-status`))).includes('You are the seeker')));
const seeker = (await a.text(`${P} .mg-status`)).includes('You are the seeker') ? a : b;
const hider = seeker === a ? b : a;
check('the seeker is blindfolded with a countdown', (await seeker.text(`${P} .mg-hide-blind h3`)) === 'No peeking' && Number(await seeker.text(`${P} .mg-hide-count-down`)) > 20);
check('the blindfold covers the whole window', await seeker.evaluate((s) => {
  const r = document.querySelector(`${s} .mg-hide-blind`).getBoundingClientRect();
  return r.left <= 0 && r.top <= 0 && r.right >= innerWidth && r.bottom >= innerHeight;
}, P));
check('the hider is not blindfolded and is told to hide', !(await hider.text(`${P} .mg-hide-blind`)) && (await hider.text(`${P} .mg-status`)).includes('You are hiding'));
check('one of one is still hidden', (await hider.text(`${P} .mg-hide-count`)).includes('1 of 1 still hidden'));
check("the hider's name tag is off in both browsers", await until(async () => (await tagsOff(a)) === 1 && (await tagsOff(b)) === 1));

// The seeker is rooted: walking does nothing while the count runs.
const before = await seeker.pos();
await seeker.keyboard.down('KeyW');
await sleep(800);
await seeker.keyboard.up('KeyW');
const after = await seeker.pos();
check('the seeker cannot walk while counting', Math.hypot(after[0] - before[0], after[1] - before[1]) < 0.2);

// The hider runs nine metres along the row of signposts.
const [sx, sz] = await seeker.pos();
await hider.tp(sx + 9, sz);
check('the seeker is released after thirty seconds', await until(async () => (await seeker.text(`${P} .mg-status`)).includes('Go and find them'), 40000));
check('the blindfold is gone', !(await seeker.text(`${P} .mg-hide-blind`)));
await sleep(1000);
check('nine metres away is still hidden', (await seeker.text(`${P} .mg-hide-count`)).includes('1 of 1 still hidden') && (await hider.text(`${P} .mg-status`)).includes('You are hidden'));
check('the clock is counting down from three minutes', /^2:\d\d$/.test(await hider.text(`${P} .mg-hide-clock`)));

// Walking up to the hider finds them, which with one hider ends the round.
const [hx, hz] = await hider.pos();
await seeker.tp(hx - 1, hz);
check('the seeker wins by getting within two metres', await until(async () => (await a.text(`${P} .mg-hide-result`)).includes('found everyone') && (await b.text(`${P} .mg-hide-result`)).includes('found everyone')));
check('the last one found is named', (await a.text(`${P} .mg-hide-result`)).includes(`${hider === a ? 'Ann' : 'Bao'} was the last one found`));
check('name tags are back', await until(async () => (await tagsOff(a)) === 0 && (await tagsOff(b)) === 0));
check('it is back in the lobby with both players', (await a.text(`${P} .mg-players`)) === 'AnnBao');

// A second round, ended by the seeker walking out.
check('and can be played again', await a.press(P, 'Play again'));
await until(async () => ((await a.text(`${P} .mg-status`)) + (await b.text(`${P} .mg-status`))).includes('You are the seeker'));
const seeker2 = (await a.text(`${P} .mg-status`)).includes('You are the seeker') ? a : b;
const hider2 = seeker2 === a ? b : a;
await seeker2.press(P, 'Leave');
check('the seeker leaving ends the round', await until(async () => (await hider2.text(`${P} .mg-hide-result`)).includes('called off') && (await hider2.text(`${P} .mg-status`)).includes('Needs 2')));
const freed = await seeker2.pos();
await seeker2.keyboard.down('KeyW');
await sleep(800);
await seeker2.keyboard.up('KeyW');
const moved = await seeker2.pos();
check('and the seeker can walk again', Math.hypot(moved[0] - freed[0], moved[1] - freed[1]) > 0.2);
await done();
