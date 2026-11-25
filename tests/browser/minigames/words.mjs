// Word clues with four browsers (two a side). Needs `npm run dev`. Run: node tests/browser/minigames/words.mjs
import { check, done, open, sleep, until } from '../lib.mjs';

const P = '.mg-words';
const names = ['Ann', 'Bao', 'Chi', 'Dan'];
const pages = [];
for (const n of names) pages.push(await open(n));
const [ann, bao, chi, dan] = pages;

/** Card classes as this browser shows them: one string per card. */
const cards = (page) => page.evaluate((s) => [...document.querySelectorAll(`${s} .mg-words-cell`)].map((b) => b.className), P);
/** Index of the first face-down card for which `pick(class)` is true, read from this browser. */
const find = async (page, pick) => (await cards(page)).findIndex((c) => !c.includes(' open') && c.includes(pick));
/** Click card i if this browser lets it. */
const click = (page, i) => page.evaluate((s, n) => { const b = document.querySelectorAll(`${s} .mg-words-cell`)[n]; if (b && !b.disabled) b.click(); return !!b && !b.disabled; }, P, i);
const opened = async (page) => (await cards(page)).filter((c) => c.includes(' open')).length;
const tinted = async (page) => (await cards(page)).filter((c) => / s-(red|blue|neutral|trap)/.test(c)).length;

await ann.openGame('words');
check('E at the signpost opens the game', (await ann.text(`${P} h2`)) === 'Word clues');
check('it says how many are needed', (await ann.text(`${P} .mg-status`)).includes('Needs 4'));
// One at a time, so the deal is known: Ann and Bao give clues, Chi (red) and Dan (blue) guess.
for (const page of pages) {
  if (page !== ann) await page.openGame('words');
  await page.press(P, 'Join');
  await sleep(400);
}
check('four players are dealt two a side', await until(async () => (await dan.text(`${P} .mg-words-team.red`)).includes('Ann · clue-giver') && (await dan.text(`${P} .mg-words-team.red`)).includes('Chi') && (await dan.text(`${P} .mg-words-team.blue`)).includes('Bao · clue-giver') && (await dan.text(`${P} .mg-words-team.blue`)).includes('Dan')));
check('a guesser can volunteer as clue-giver', (await chi.press(P, 'Be clue-giver')) && (await until(async () => (await ann.text(`${P} .mg-words-team.red`)).includes('Chi · clue-giver'))));
await ann.press(P, 'Be clue-giver');
check('and the first one can take it back', await until(async () => (await chi.text(`${P} .mg-words-team.red`)).includes('Ann · clue-giver')));

check('anyone playing can start', await dan.press(P, 'Start'));
check('everyone gets a grid of 25 words', await until(async () => (await Promise.all(pages.map(async (p) => (await cards(p)).length))).every((n) => n === 25)));
check('the clue-givers see every card tinted', (await tinted(ann)) === 25 && (await tinted(bao)) === 25);
check('the guessers see no colours at all', (await tinted(chi)) === 0 && (await tinted(dan)) === 0 && (await opened(chi)) === 0);
const map = await cards(ann);
const count = (k) => map.filter((c) => c.includes(` s-${k}`)).length;
check('the map is 9, 8, 7 and 1', [count('red'), count('blue')].sort().join() === '8,9' && count('neutral') === 7 && count('trap') === 1);

const redFirst = (await ann.text(`${P} .mg-words-turn`)).startsWith('Red');
const team = redFirst ? 'red' : 'blue';
const [giver, guesser, otherGiver, otherGuesser] = redFirst ? [ann, chi, bao, dan] : [bao, dan, ann, chi];
check('the team with nine words goes first', count(team) === 9);
check('nobody can guess before the clue', !(await click(guesser, 0)) && !(await click(otherGuesser, 0)));
check('only the clue-giver whose turn it is has the clue box', (await giver.$(`${P} .mg-words-input`)) !== null && (await otherGiver.$(`${P} .mg-words-input`)) === null && (await guesser.$(`${P} .mg-words-input`)) === null);

await giver.type(`${P} .mg-words-input`, 'two words');
await giver.press(P, 'Give clue');
await sleep(500);
check('a clue of two words is refused', (await giver.$(`${P} .mg-words-input`)) !== null);
await giver.$eval(`${P} .mg-words-input`, (e) => { e.value = ''; e.dispatchEvent(new Event('input')); });
await giver.type(`${P} .mg-words-input`, 'qqzzy');
await giver.select(`${P} .mg-words-num`, '2');
await giver.press(P, 'Give clue');
check('everyone sees the clue and three guesses', await until(async () => (await otherGuesser.text(`${P} .mg-words-clue`)) === 'QQZZY · 2' && (await otherGuesser.text(`${P} .mg-words-left`)).startsWith('3 guesses')));
check('End turn waits for a first guess', !(await guesser.press(P, 'End turn')));
check('the other team and the clue-giver cannot click cards', !(await click(otherGuesser, 0)) && !(await click(giver, 0)));

const own = await find(giver, ` s-${team}`);
check('a guesser can click a word', await click(guesser, own));
check('a right guess shows its colour to everyone and the turn goes on', await until(async () => (await cards(otherGuesser))[own].includes(`open k-${team}`) && (await guesser.text(`${P} .mg-words-left`)).startsWith('2 guesses')));
check('guessers still see only what has been turned over', (await tinted(guesser)) === 0 && (await opened(guesser)) === 1);

const neutral = await find(giver, ' s-neutral');
await click(guesser, neutral);
const next = redFirst ? 'Blue' : 'Red';
check('a neutral word ends the turn', await until(async () => (await ann.text(`${P} .mg-words-turn`)).startsWith(next) && (await cards(dan))[neutral].includes('open k-neutral')));

await otherGiver.type(`${P} .mg-words-input`, 'qqzzy');
await otherGiver.press(P, 'Give clue');
await until(async () => (await otherGuesser.text(`${P} .mg-words-clue`)).startsWith('QQZZY'));
const trap = await find(otherGiver, ' s-trap');
await click(otherGuesser, trap);
check('the trap ends the game for the team that hit it', await until(async () => (await guesser.text(`${P} .mg-words-result`)).includes(`${redFirst ? 'Red' : 'Blue'} team wins`)));
check('and the whole map is shown to everyone', (await tinted(guesser)) + (await opened(guesser)) === 25 && (await cards(guesser))[trap].includes('open k-trap'));
check('back in the lobby, they can play again', await guesser.press(P, 'Play again'));
await until(async () => (await tinted(ann)) === 25);
check('a new game hides the map from guessers again', (await tinted(chi)) === 0 && (await opened(chi)) === 0);

await chi.press(P, 'Leave');
check('a team left with one player ends the game', await until(async () => (await dan.text(`${P} .mg-words-result`)).includes('ran short')));
await done();
