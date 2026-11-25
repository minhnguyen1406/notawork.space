// Liar's dice with two browsers. Needs `npm run dev`. Run: node tests/browser/minigames/dice.mjs
import { check, done, open, sleep, until } from '../lib.mjs';

const a = await open('Ann');
const b = await open('Bao');
const P = '.mg-dice';
const count = (page, sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel);
const status = (page) => page.text(`${P} .mg-status`);

await a.openGame('dice');
check('E at the signpost opens the game', (await a.text(`${P} h2`)) === "Liar's dice");
check('it says how many are needed', (await status(a)).includes('Needs 2 to 8'));
await a.press(P, 'Join');
check('one player cannot start', await until(async () => (await a.text(`${P} .mg-players`)) === 'Ann') && !(await a.press(P, 'Start')));
await b.openGame('dice');
await b.press(P, 'Join');
check('both players are listed for both', await until(async () => (await a.text(`${P} .mg-players`)) === 'AnnBao' && (await b.text(`${P} .mg-players`)) === 'AnnBao'));

check('anyone in the game can start it', await b.press(P, 'Start'));
check('everyone gets five dice of their own', await until(async () => (await count(a, `${P} .mg-dice-mine .mg-dice-die`)) === 5 && (await count(b, `${P} .mg-dice-mine .mg-dice-die`)) === 5));
check('and nobody else\'s dice are on the page', (await count(a, `${P} .mg-dice-die`)) === 5 && (await count(b, `${P} .mg-dice-die`)) === 5);
check('dice counts are shown for everyone', (await b.text(`${P} .mg-players`)).replace(/\s/g, '') === 'Ann🎲5Bao🎲5');
check('the first to join opens the bidding', (await status(a)).includes('open the bidding') && (await status(b)).includes('Ann is thinking'));
check('only the player whose turn it is gets the buttons', !(await b.press(P, 'Bid')) && !(await b.press(P, 'Liar')));
check('there is nothing to call before the first bid', !(await a.press(P, 'Liar')));

// Ann bids two 3s.
await a.press(`${P} .mg-dice-qty`, '+');
await a.press(`${P} .mg-dice-faces`, '⚂');
check('the picker builds the bid', (await a.text(`${P} .mg-row:last-child`)).includes('Bid 2 × ⚂'));
await a.press(P, 'Bid');
check('everyone sees the bid, and the turn passes', await until(async () => (await b.text(`${P} .mg-dice-bid`)).includes('2 × ⚂') && (await status(b)).includes('raise the bid')));
check('the picker starts at the lowest legal raise', (await b.text(`${P} .mg-dice-n`)) === '2' && (await b.text(`${P} .mg-dice-faces .on`)) === '⚃');
check('lower faces and lower quantities are not offered', !(await b.press(`${P} .mg-dice-faces`, '⚂')) && !(await b.press(`${P} .mg-dice-faces`, '⚀')) && !(await b.press(`${P} .mg-dice-qty`, '−')));
await b.press(`${P} .mg-dice-qty`, '+');
check('with more dice any face is allowed again', await b.press(`${P} .mg-dice-faces`, '⚀'));
// Eleven 1s among ten dice cannot be bid; ten is the most.
for (let i = 0; i < 12; i++) await b.press(`${P} .mg-dice-qty`, '+');
check('the quantity stops at the number of dice on the table', (await b.text(`${P} .mg-dice-n`)) === '10');
await b.press(`${P} .mg-dice-faces`, '⚅');
await b.press(P, 'Bid');
check('after the highest possible bid the only move is to call', await until(async () => (await a.text(`${P} .mg-dice-bid`)).includes('10 × ⚅') && (await a.text(P)).includes('you have to call')));
check('Ann calls Liar!', await a.press(P, 'Liar'));

check('all dice are shown to both', await until(async () => (await count(a, `${P} .mg-dice-shown .mg-dice-die`)) === 10 && (await count(b, `${P} .mg-dice-shown .mg-dice-die`)) === 10));
const result = await b.text(`${P} .mg-dice-result`);
// Ten 6s is true only if every die is a 6: either way the result line must agree with the dice shown.
const sixes = await count(a, `${P} .mg-dice-shown .mg-dice-die.hit`);
check('the result says who was wrong', result.includes(`There ${sixes === 1 ? 'was' : 'were'} ${sixes}.`) && result.includes(sixes === 10 ? 'true' : 'bluff') && result.includes('a die'));
const loser = sixes === 10 ? a : b;
const loserName = sixes === 10 ? 'Ann' : 'Bao';
check('after a pause the next round starts, the loser one die down and opening', await until(async () => (await status(loser)).includes('open the bidding'), 15000));
check('the loser has four dice and says so to everyone', (await count(loser, `${P} .mg-dice-mine .mg-dice-die`)) === 4 && (await a.text(`${P} .mg-players`)).replace(/\s/g, '').includes(`${loserName}🎲4`));

// Someone walking off ends a two-player game in favour of the other.
await sleep(300);
await a.press(P, 'Leave');
check('leaving a two-player game hands the win to the other', await until(async () => (await b.text(`${P} .mg-dice-result`)).includes('Bao won')));
check('and it is back to waiting for players', (await status(b)).includes('Needs 2 to 8'));
await done();
