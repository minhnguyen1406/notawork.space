// Tiến lên with two browsers. Needs `npm run dev`. Run: node tests/browser/minigames/tienlen.mjs
import { check, done, open, until } from '../lib.mjs';

const a = await open('Ann');
const b = await open('Bao');
const P = '.mg-tienlen';
const HAND = `${P} .mg-tienlen-hand`;
/** The labels of the cards in this page's hand, in the order shown. */
const hand = (page) => page.evaluate((s) => [...document.querySelectorAll(`${s} button`)].map((x) => x.textContent), HAND);
const reds = (page) => page.evaluate((s) => [...document.querySelectorAll(`${s} button.red`)].map((x) => x.textContent), HAND);
const status = (page) => page.text(`${P} .mg-status`);

await a.openGame('tienlen');
check('E at the signpost opens the game', (await a.text(`${P} h2`)) === 'Tiến lên');
check('it says how many are needed', (await status(a)).includes('Needs 2 to 4'));
await a.press(P, 'Join');
check('one player cannot deal', await until(async () => (await a.text(`${P} .mg-players`)).includes('Ann')) && !(await a.press(P, 'Deal')));
await b.openGame('tienlen');
await b.press(P, 'Join');
check('both players are listed for both', await until(async () => (await a.text(`${P} .mg-players`)) === 'AnnBao' && (await b.text(`${P} .mg-players`)) === 'AnnBao'));
await a.press(P, 'Deal');
check('each player gets 13 cards', await until(async () => (await hand(a)).length === 13 && (await hand(b)).length === 13));
const ha = await hand(a);
const hb = await hand(b);
check('the two hands share no card', ha.every((c) => !hb.includes(c)));
check('red cards are exactly the diamonds and hearts', (await reds(a)).join() === ha.filter((c) => /[♦♥]/.test(c)).join());
check('opponent card counts are shown', (await a.text(`${P} .mg-players`)).includes('Bao · 13 cards'));

const first = (await status(a)).startsWith('Your turn') ? a : b;
const second = first === a ? b : a;
check('exactly one player is on turn', (await status(first)).startsWith('Your turn') && !(await status(second)).startsWith('Your turn'));
check('the opener is told which card to include', (await status(first)).includes((await hand(first))[0]));
check('Play is disabled with nothing selected, and nobody can pass a lead', !(await first.press(P, 'Play')) && !(await first.press(P, 'Pass')) && !(await second.press(P, 'Pass')));
// Select the lowest card (the first in the hand) and play it.
const low = (await hand(first))[0];
await first.press(HAND, low);
check('a selected card is marked', await until(async () => (await first.text(`${HAND} .sel`)) === low));
check('playing the lowest card puts it on the table for both', (await first.press(P, 'Play')) && (await until(async () => (await second.text(`${P} .mg-tienlen-play`)) === low && (await first.text(`${P} .mg-tienlen-play`)) === low)));
check('the hand shrinks and the count updates', await until(async () => (await hand(first)).length === 12 && (await second.text(`${P} .mg-players`)).includes('· 12 cards')));
check('the turn moves on', await until(async () => (await status(second)).startsWith('Your turn')));
check('the player who just played cannot act out of turn', !(await first.press(P, 'Pass')));
check('the other player can pass', await second.press(P, 'Pass'));
check('after everyone else passes the table clears and the same player leads', await until(async () => (await status(first)).includes('lead anything') && (await first.text(`${P} .mg-tienlen-table`)).includes('clear')));
await second.press(P, 'Leave');
check('a player leaving ends the hand for the one who is left', await until(async () => (await status(first)).includes('wins the hand')));
check('and the panel closes for the one who left', (await second.text(`${P} h2`)) === '');
await done();
