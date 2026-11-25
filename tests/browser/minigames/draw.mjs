// Draw and guess with three browsers (two playing, one walking past). Needs `npm run dev`.
// Run: node tests/browser/minigames/draw.mjs
import { check, done, open, sleep, until } from '../lib.mjs';

const a = await open('Ann');
const b = await open('Bao');
const c = await open('Chi');
const P = '.mg-draw';

/** How many pixels of the picture are not white (sampled), i.e. whether anything is drawn. */
const inked = (page) => page.evaluate((s) => {
  const cv = document.querySelector(`${s} canvas`);
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 16) if (d[i] < 200 || d[i + 1] < 200 || d[i + 2] < 200) n++;
  return n;
}, P);
/** Drag the mouse across the picture, as fractions of its size. */
const drag = async (page, points) => {
  const r = await page.evaluate((s) => { const q = document.querySelector(`${s} canvas`).getBoundingClientRect(); return { x: q.left, y: q.top, w: q.width, h: q.height }; }, P);
  const at = ([x, y]) => [r.x + x * r.w, r.y + y * r.h];
  await page.mouse.move(...at(points[0]));
  await page.mouse.down();
  for (const p of points.slice(1)) await page.mouse.move(...at(p), { steps: 6 });
  await page.mouse.up();
  await sleep(600);
};
const guess = async (page, text) => {
  await page.type(`${P} .mg-draw-guess input`, text);
  await page.keyboard.press('Enter');
  await sleep(400); // also keeps guesses further apart than the server's minimum gap
};
const status = (page) => page.text(`${P} .mg-status`);
/** Everything the game is telling this person in words (not the button labels). */
const seen = async (page) => [await status(page), await page.text(`${P} .mg-draw-word`), await page.text(`${P} .mg-draw-feed`), await page.text(`${P} .mg-players`)].join(' | ').toLowerCase();

await a.openGame('draw');
check('E at the signpost opens the game', (await a.text(`${P} h2`)) === 'Draw and guess');
check('it says how many are needed', (await status(a)).includes('Needs 2'));
check('the panel is a large sheet', await a.evaluate((s) => document.querySelector(s).classList.contains('mg-sheet'), P));
await a.press(P, 'Join');
check('one player cannot start', !(await a.press(P, 'Start')));
await b.openGame('draw');
await b.press(P, 'Join');
check('both players are listed for both', await until(async () => (await a.text(`${P} .mg-players`)) === 'AnnBao' && (await b.text(`${P} .mg-players`)) === 'AnnBao'));
await c.openGame('draw'); // Chi only watches
check('someone watching sees the idle board', (await inked(c)) > 0 && (await c.text(`${P} .mg-draw-tools`)) === '');

await a.press(P, 'Start');
check('the first to join draws first', await until(async () => (await status(a)).includes('Your turn to draw')));
const word = (await a.text(`${P} .mg-draw-word`)).replace('Draw: ', '');
check('the drawer is told a word', /^[a-z]{3,}$/.test(word));
check('the guesser sees only blanks and the length', await until(async () => (await b.text(`${P} .mg-draw-word`)) === `${Array(word.length).fill('_').join(' ')} · ${word.length} letters`));
check('the word is nowhere on the guesser\'s or the watcher\'s page', !(await seen(b)).includes(word) && !(await seen(c)).includes(word));
check('only the drawer has the drawing tools', (await a.text(`${P} .mg-draw-tools`)).includes('Undo') && (await a.text(`${P} .mg-draw-guess`)) === '' && (await b.text(`${P} .mg-draw-tools`)) === '' && !(await b.press(P, 'Undo')) && !(await b.press(P, 'Clear')));
check('the sheet starts clean', (await inked(a)) === 0 && (await inked(b)) === 0);

await drag(b, [[0.2, 0.2], [0.8, 0.8]]);
check('a guesser dragging on the picture draws nothing', (await inked(b)) === 0 && (await inked(a)) === 0);
await drag(a, [[0.2, 0.3], [0.5, 0.6], [0.8, 0.3]]);
check('the drawer\'s stroke shows for the drawer', (await inked(a)) > 0);
check('and appears for the guesser and the watcher', await until(async () => (await inked(b)) > 0 && (await inked(c)) > 0));
const one = await inked(b);
await drag(a, [[0.2, 0.8], [0.8, 0.8]]);
check('a second stroke adds to it', await until(async () => (await inked(b)) > one * 1.2));
const two = await inked(b);
await a.press(P, 'Undo');
// Not compared exactly: a stroke repainted whole is smoothed a little differently from one painted bit by bit.
const back = (n) => n > 0 && n < (one + two) / 2;
check('Undo takes the last stroke back for everyone', await until(async () => back(await inked(b)) && back(await inked(a))));
await a.press(P, 'Clear');
check('Clear wipes it for everyone', await until(async () => (await inked(b)) === 0 && (await inked(c)) === 0 && (await inked(a)) === 0));
await drag(a, [[0.3, 0.3], [0.7, 0.7]]);

// Someone who opens the panel in the middle of a turn gets the whole picture.
await c.press(P, 'Close');
await c.openGame('draw');
check('reopening the panel mid-turn shows the picture so far', await until(async () => (await inked(c)) > 0));

await guess(b, 'definitely wrong');
check('a wrong guess is shown to everyone', await until(async () => (await a.text(`${P} .mg-draw-feed`)).includes('Bao: definitely wrong') && (await c.text(`${P} .mg-draw-feed`)).includes('Bao: definitely wrong')));
await guess(b, `  ${word.toUpperCase()} `);
check('a right guess is announced without the word', await until(async () => (await a.text(`${P} .mg-draw-feed`)).includes('Bao guessed it')) && !(await c.text(`${P} .mg-draw-feed`)).toLowerCase().includes(word));
check('everyone having guessed ends the turn and shows the word', await until(async () => (await status(c)).includes(`The word was "${word}"`)));
const scores = async (page) => (await page.text(`${P} .mg-players`)).match(/\d+/g)?.map(Number) ?? [];
const [annScore, baoScore] = await scores(a);
check('the guesser scored for speed and the drawer for the guess', baoScore >= 40 && baoScore <= 100 && annScore === 25);

check('then the other player draws, on a clean sheet', await until(async () => (await status(b)).includes('Your turn to draw') && (await inked(a)) === 0));
const word2 = (await b.text(`${P} .mg-draw-word`)).replace('Draw: ', '');
check('with a different word', /^[a-z]{3,}$/.test(word2) && word2 !== word);
check('the last drawer can no longer draw', (await drag(a, [[0.1, 0.1], [0.9, 0.9]]), (await inked(a)) === 0));
await drag(b, [[0.5, 0.2], [0.5, 0.8]]);
check('the new drawer\'s stroke reaches the others', await until(async () => (await inked(a)) > 0));
await guess(a, word2);
check('after the last turn the ranking is shown', await until(async () => (await a.text(`${P} .mg-draw-rank`)).includes('Ann') && (await status(a)).includes('points')));
check('and the winner is announced in the room', await until(async () => (await c.evaluate(() => document.body.textContent)).includes('at Draw and guess with')));
check('then it returns to the lobby', await until(async () => (await status(a)).includes('Press Start'), 20000));

// The drawer leaving skips the turn rather than leaving everyone waiting.
await c.press(P, 'Join');
await until(async () => (await a.text(`${P} .mg-players`)).includes('Chi'));
await a.press(P, 'Start');
check('a second game starts with three', await until(async () => (await status(a)).includes('Your turn to draw')));
await a.press(P, 'Leave');
check('the drawer leaving ends their turn', await until(async () => (await status(b)).includes('The word was')));
check('and the next player draws', await until(async () => (await status(b)).includes('Your turn to draw')));
await b.press(P, 'Leave');
check('with one player left it drops back to waiting', await until(async () => (await status(c)).includes('Needs 2')));
await done();
