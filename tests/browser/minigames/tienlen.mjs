// Tiến lên with two browsers, in both regional versions. Needs `npm run dev`. Run: node tests/browser/minigames/tienlen.mjs
import { check, done, open, sleep, until } from '../lib.mjs';

const a = await open('Ann');
const b = await open('Bao');
const P = '.mg-tienlen';
const HAND = `${P} .mg-tienlen-hand`;
/** The labels of the cards in this page's hand, in the order shown. */
const hand = (page) => page.evaluate((s) => [...document.querySelectorAll(`${s} button`)].map((x) => x.textContent), HAND);
const reds = (page) => page.evaluate((s) => [...document.querySelectorAll(`${s} button.red`)].map((x) => x.textContent), HAND);
const status = (page) => page.text(`${P} .mg-status`);
const version = (page) => page.text(`${P} .mg-tienlen-variant`);
const why = (page) => page.text(`${P} .mg-tienlen-why`);
/** Deal until a hand is actually being played: a southern deal can, rarely, be won outright on the spot. */
async function deal(page) {
  for (let i = 0; i < 5; i++) {
    await page.press(P, 'Deal');
    await until(async () => (await hand(a)).length === 13 || (await status(a)).includes('tới trắng'));
    if ((await hand(a)).length === 13 && (await hand(b)).length === 13) return true;
    await sleep(300);
  }
  return false;
}

// ---- the lobby and the version switch ----
await a.openGame('tienlen');
check('E at the signpost opens the game', (await a.text(`${P} h2`)) === 'Tiến lên');
check('it says how many are needed', (await status(a)).includes('Needs 2 to 4'));
check('the version starts as Miền Nam', (await version(a)) === 'Miền Nam');
check('someone who is not seated cannot switch the version', !(await a.press(P, 'Miền Bắc')));
await a.press(P, 'Join');
check('one player cannot deal', (await until(async () => (await a.text(`${P} .mg-players`)).includes('Ann'))) && !(await a.press(P, 'Deal')));
await b.openGame('tienlen');
await b.press(P, 'Join');
check('both players are listed for both', await until(async () => (await a.text(`${P} .mg-players`)) === 'AnnBao' && (await b.text(`${P} .mg-players`)) === 'AnnBao'));
check('a seated player switches to Miền Bắc and everyone sees it', (await b.press(P, 'Miền Bắc')) && (await until(async () => (await version(a)) === 'Miền Bắc' && (await version(b)) === 'Miền Bắc')));
check('the lobby describes the northern rules', (await a.text(P)).includes('same colour'));

// ---- a northern hand ----
check('a northern deal gives each player 13 cards', await deal(a));
let ha = await hand(a);
let hb = await hand(b);
check('the two hands share no card', ha.every((c) => !hb.includes(c)));
check('red cards are exactly the diamonds and hearts', (await reds(a)).join() === ha.filter((c) => /[♦♥]/.test(c)).join());
check('opponent card counts are shown', (await a.text(`${P} .mg-players`)).includes('Bao · 13 cards'));
check('the version is shown during play and cannot be switched', (await version(b)) === 'Miền Bắc' && !(await a.press(P, 'Miền Nam')) && !(await b.press(P, 'Miền Nam')));
let first = (await status(a)).startsWith('Your turn') ? a : b;
let second = first === a ? b : a;
check('exactly one player is on turn', (await status(first)).startsWith('Your turn') && !(await status(second)).startsWith('Your turn'));
check('the northern opener leads anything', (await status(first)).includes('lead anything'));
// A northern reason, if this hand happens to hold two cards of one rank in different colours.
const mine = await hand(first);
const black = mine.find((c) => /[♠♣]/.test(c) && mine.some((d) => /[♦♥]/.test(d) && d.slice(0, -1) === c.slice(0, -1)));
if (black) {
  const red = mine.find((d) => /[♦♥]/.test(d) && d.slice(0, -1) === black.slice(0, -1));
  await first.press(HAND, black);
  await first.press(HAND, red);
  check('a mixed-colour pair gets the northern reason and cannot be played', (await until(async () => (await why(first)) === 'Miền Bắc: a pair must be the same colour.')) && !(await first.press(P, 'Play')));
  await first.press(HAND, black);
  await first.press(HAND, red);
} else console.log('SKIP no mixed-colour pair in this hand');
await second.press(P, 'Leave');
check('a player leaving ends the hand for the one who is left', await until(async () => (await status(first)).includes('wins the hand')));
check('and the panel closes for the one who left', (await second.text(`${P} h2`)) === '');
check('the results name the winner nhất', (await first.text(`${P} .mg-tienlen-results`)).includes('Nhất'));

// ---- back to the southern version, and a hand played right through ----
await second.openGame('tienlen');
await second.press(P, 'Join');
await until(async () => (await first.text(`${P} .mg-players`)).length > 5);
check('between hands the version can be switched back', (await second.press(P, 'Miền Nam')) && (await until(async () => (await version(first)) === 'Miền Nam')));
// The winner of the last hand may have changed seats; start a clean session so the lowest card opens.
await a.press(P, 'Leave');
await b.press(P, 'Leave');
await sleep(500);
await a.openGame('tienlen');
await a.press(P, 'Join');
await b.openGame('tienlen');
await b.press(P, 'Join');
check('both are seated again', await until(async () => (await a.text(`${P} .mg-players`)) === 'AnnBao' && (await b.text(`${P} .mg-players`)) === 'AnnBao'));
check('a southern deal gives each player 13 cards', await deal(a));
first = (await status(a)).startsWith('Your turn') ? a : b;
second = first === a ? b : a;
const low = (await hand(first))[0];
check('the southern opener is told which card to include', (await status(first)).includes(`includes the ${low}`));
check('Play is disabled with nothing selected, and nobody can pass a lead', !(await first.press(P, 'Play')) && !(await first.press(P, 'Pass')) && !(await second.press(P, 'Pass')));
// Select the lowest card (the first in the hand) and play it.
await first.press(HAND, low);
check('a selected card is marked', await until(async () => (await first.text(`${HAND} .sel`)) === low));
check('playing the lowest card puts it on the table for both', (await first.press(P, 'Play')) && (await until(async () => (await second.text(`${P} .mg-tienlen-play`)) === low && (await first.text(`${P} .mg-tienlen-play`)) === low)));
check('the hand shrinks and the count updates', await until(async () => (await hand(first)).length === 12 && (await second.text(`${P} .mg-players`)).includes('· 12 cards')));
check('the turn moves on', await until(async () => (await status(second)).startsWith('Your turn')));
check('the player who just played cannot act out of turn', !(await first.press(P, 'Pass')));
const leftover = await hand(second);
check('the other player can pass', await second.press(P, 'Pass'));
check('after everyone else passes the table clears and the same player leads', await until(async () => (await status(first)).includes('lead anything') && (await first.text(`${P} .mg-tienlen-table`)).includes('clear')));
// Play it out: the leader sheds a card each trick, the other always passes.
for (let i = 0; i < 40 && !(await status(first)).includes('wins the hand'); i++) {
  const before = (await status(first)) + (await status(second));
  if ((await status(second)).includes('or pass')) await second.press(P, 'Pass');
  else if ((await status(first)).startsWith('Your turn')) {
    await first.press(HAND, (await hand(first))[0]);
    await first.press(P, 'Play');
  }
  await until(async () => (await status(first)) + (await status(second)) !== before, 4000);
}
const winner = first === a ? 'Ann' : 'Bao';
check('the first player out of cards wins and the hand ends', (await status(first)).includes(`${winner} wins the hand`) && (await until(async () => (await status(second)).includes(`${winner} wins the hand`))));
const results = await second.text(`${P} .mg-tienlen-results`);
check('the results give the finishing order', results.indexOf('Nhất') >= 0 && results.indexOf('Nhất') < results.indexOf('Bét') && results.includes(`Nhất${winner}`));
check('the loser’s leftover cards are shown to everyone', leftover.every((c) => results.includes(c)) && (await first.text(`${P} .mg-tienlen-results`)) === results);
check('being left with 2s is called out, and only then', results.includes('Thối heo') === leftover.some((c) => c.startsWith('2')));
check('the loser can deal again', await deal(second));
check('the winner leads the next hand with anything', (await status(first)).includes('lead anything'));
await done();
