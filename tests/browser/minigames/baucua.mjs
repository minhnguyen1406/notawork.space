// Bầu cua with two browsers. Needs `npm run dev`. Run: node tests/browser/minigames/baucua.mjs
// Takes about a minute: it sits through a 15 second betting round twice.
import { check, done, open, sleep, until } from '../lib.mjs';

const a = await open('Ann');
const b = await open('Bao');
const P = '.mg-baucua';
/** Click a symbol on the board (0 deer, 1 gourd, 2 rooster, 3 fish, 4 crab, 5 shrimp). */
const bet = (page, sym) => page.evaluate((s) => { const c = document.querySelector(s); if (c && !c.disabled) c.click(); return !!c && !c.disabled; }, `${P} .mg-baucua-cell[data-sym="${sym}"]`);
const chips = async (page) => Number((await page.text(`${P} .mg-baucua-chips`)).replace(/\D/g, ''));

await a.openGame('baucua');
check('E at the signpost opens the game', (await a.text(`${P} h2`)) === 'Bầu cua');
check('it says play chips and how many can play', (await a.text(P)).includes('Play chips only') && (await a.text(`${P} .mg-status`)).includes('1 to 20'));
check('the board has six symbols with Vietnamese names', (await a.evaluate((s) => [...document.querySelectorAll(s)].map((e) => e.textContent).join(','), `${P} .mg-baucua-name`)) === 'Nai,Bầu,Gà,Cá,Cua,Tôm');
check('nobody can bet before joining', !(await bet(a, 4)));
await a.press(P, 'Join');
check('joining gives 1,000 chips and starts the betting clock', await until(async () => (await chips(a)) === 1000 && (await a.text(`${P} .mg-baucua-left`)).includes('Betting closes')));
await b.openGame('baucua');
await b.press(P, 'Join');
check('both are on the leaderboard for both', await until(async () => (await a.text(`${P} .mg-baucua-ranks`)).includes('Bao') && (await b.text(`${P} .mg-baucua-ranks`)).includes('Ann')));

await a.press(P, '50');
await sleep(200);
check('a click stacks the chosen chip on a symbol', (await bet(a, 4)) && (await until(async () => (await a.text(`${P} .mg-baucua-cell[data-sym="4"] .mg-baucua-stake`)).includes('50') && (await chips(a)) === 950)));
check('the other player sees the bet as it is placed', await until(async () => (await b.text(`${P} .mg-baucua-ranks`)).includes('🦀50')));
check('Clear takes it back', (await a.press(P, 'Clear')) && (await until(async () => (await chips(a)) === 1000)));
await bet(a, 4);
check('the bet can be placed again', await until(async () => (await chips(a)) === 950));

check('the dice are rolled when betting closes and the result is shown', await until(async () => /You (won|lost)/.test(await a.text(`${P} .mg-status`)), 25000));
const faces = await a.evaluate((s) => [...document.querySelectorAll(s)].map((e) => e.textContent), `${P} .mg-baucua-die`);
const hits = faces.filter((f) => f === '🦀').length;
check('three dice show symbols', faces.length === 3 && faces.every((f) => ['🦌', '🍐', '🐓', '🐟', '🦀', '🦐'].includes(f)));
check('both players see the same dice', (await b.evaluate((s) => [...document.querySelectorAll(s)].map((e) => e.textContent), `${P} .mg-baucua-die`)).join() === faces.join());
check(`the payout matches the dice (${hits} crab)`, (await chips(a)) === (hits ? 1000 + 50 * hits : 950));
check('the player with no bet sat it out and kept their chips', await until(async () => (await b.text(`${P} .mg-status`)).includes('sat this roll out') && (await chips(b)) === 1000, 4000));

check('a new betting round starts by itself', await until(async () => (await a.text(`${P} .mg-baucua-left`)).includes('Betting closes'), 10000));
check('with no bets the roll is skipped and the table waits', await until(async () => (await a.text(`${P} .mg-status`)).includes('dice are resting'), 25000));
check('a bet wakes the table up', (await bet(b, 0)) && (await until(async () => (await a.text(`${P} .mg-baucua-left`)).includes('Betting closes'))));
await b.press(P, 'Leave');
check('leaving returns the stake and removes them from the leaderboard', await until(async () => !(await a.text(`${P} .mg-baucua-ranks`)).includes('Bao')));
await b.press(P, 'Join');
check('chips are remembered on rejoining', await until(async () => (await chips(b)) === 1000));
await a.press(P, 'Leave');
await b.press(P, 'Leave');
check('after leaving, the panel offers Join again', await until(async () => (await a.text(`${P} .mg-status`)).includes('Join to play')));
await done();
