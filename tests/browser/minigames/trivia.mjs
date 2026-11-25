// Trivia night with three browsers. Needs `npm run dev`. Run: node tests/browser/minigames/trivia.mjs
// A whole game is played, so this takes a minute or two.
import { check, done, open, sleep, until } from '../lib.mjs';

const a = await open('Ann');
const b = await open('Bao');
const c = await open('Chi');
const P = '.mg-trivia';
const phase = (page) => page.evaluate((s) => {
  const p = document.querySelector(s);
  if (!p || p.hidden) return 'hidden';
  if (p.querySelector('.mg-trivia-final')) return 'final';
  if (p.querySelector('.mg-trivia-opt.right')) return 'reveal';
  return p.querySelector('.mg-trivia-opt') ? 'question' : 'lobby';
}, P);
/** What the four option buttons look like: their classes and whether they can be pressed. */
const opts = (page) => page.evaluate((s) => [...document.querySelectorAll(`${s} .mg-trivia-opt`)].map((x) => ({ cls: x.className, off: x.disabled, text: x.querySelector('span').textContent })), P);
const scoreOf = (page, name) => page.evaluate((s, n) => {
  const li = [...document.querySelectorAll(`${s} .mg-trivia-board li`)].find((x) => x.querySelector('.name').textContent === n);
  return li ? +li.querySelector('.score').textContent : -1;
}, P, name);
const round = (page) => page.text(`${P} .mg-trivia-round`);

await a.openGame('trivia');
check('E at the signpost opens the game', (await a.text(`${P} h2`)) === 'Trivia night');
check('it says one player is enough', (await a.text(`${P} .mg-status`)).includes('One player is enough'));
check('nobody can start before joining', !(await a.press(P, 'Start')));
await a.press(P, 'Join');
await b.openGame('trivia');
await b.press(P, 'Join');
check('both players are listed for both', await until(async () => (await a.text(`${P} .mg-players`)) === 'AnnBao' && (await b.text(`${P} .mg-players`)) === 'AnnBao'));

await a.press(P, 'Start');
check('a question with four options appears for both', await until(async () => (await opts(a)).length === 4 && (await opts(b)).length === 4));
check('it is question 1 of 10', (await round(a)).startsWith('Question 1 of 10'));
check('there is a countdown bar', await a.evaluate((s) => !!document.querySelector(`${s} .mg-trivia-clock .mg-trivia-bar i`), P));
check('nothing is marked right while the question is open', (await opts(a)).every((o) => !o.cls.includes('right') && !o.off));

// Chi arrives in the middle of the question.
await c.openGame('trivia');
check('a watcher sees the question but cannot answer', await until(async () => (await opts(c)).length === 4 && (await opts(c)).every((o) => o.off)));
await c.press(P, 'Join');
check('someone joining mid-question is told they play from the next one', await until(async () => (await c.text(`${P} .mg-status`)).includes('next question')));
await c.keyboard.press('Digit1');
await sleep(400);
check('and their keys do not answer this one', (await opts(c)).every((o) => !o.cls.includes('picked')));

await a.keyboard.press('Digit1');
check('pressing 1 locks in the first option', await until(async () => (await opts(a))[0].cls.includes('picked') && (await opts(a)).every((o) => o.off)));
await a.keyboard.press('Digit2');
await sleep(400);
check('the answer cannot be changed', (await opts(a))[0].cls.includes('picked') && !(await opts(a))[1].cls.includes('picked'));
check('others see that one of two has answered, not what', (await b.text(`${P} .mg-status`)).includes('1 of 2 answered') && (await opts(b)).every((o) => !o.cls.includes('picked')));
await b.evaluate((s) => document.querySelectorAll(`${s} .mg-trivia-opt`)[1].click(), P);
check('once everyone has answered the reveal comes early', await until(async () => (await phase(a)) === 'reveal' && (await phase(b)) === 'reveal', 4000));
const shown = await opts(a);
const right = shown.findIndex((o) => o.cls.includes('right'));
check('exactly one option is shown as right', shown.filter((o) => o.cls.includes('right')).length === 1);
const annScore = await scoreOf(a, 'Ann');
const baoScore = await scoreOf(a, 'Bao');
check('the scoreboard matches who was right, with 500 to 1000 for speed', (right === 0 ? annScore >= 500 && annScore <= 1000 : annScore === 0) && (right === 1 ? baoScore >= 500 && baoScore <= 1000 : baoScore === 0));
check('the status names the right answer or the points won', (await a.text(`${P} .mg-status`)).includes(right === 0 ? 'Correct' : shown[right].text));

check('the next question follows the reveal', await until(async () => (await round(a)).startsWith('Question 2 of 10') && (await phase(a)) === 'question'));
check('the newcomer can answer from this question on', (await opts(c)).every((o) => !o.off));

// Bao leaves; the game carries on with Ann and Chi and does not wait for him.
await b.press(P, 'Leave');
check('after someone leaves, the question only waits for those still in', await until(async () => (await a.text(`${P} .mg-status`)).includes('of 2 answered')));
for (let q = 2; q <= 10; q++) {
  await until(async () => (await round(a)).startsWith(`Question ${q} of 10`) && (await phase(a)) === 'question' && (await phase(c)) === 'question');
  await a.keyboard.press('Digit3');
  await c.keyboard.press('Digit4');
  if (!(await until(async () => (await phase(a)) === 'reveal', 4000))) check(`question ${q} reached its reveal`, false);
}
check('after ten questions the final ranking shows for everyone still in', await until(async () => (await phase(a)) === 'final' && (await phase(c)) === 'final'));
check('the final ranking lists both remaining players', (await scoreOf(a, 'Ann')) >= 0 && (await scoreOf(a, 'Chi')) >= 0 && (await scoreOf(a, 'Bao')) === -1);
check('it can be played again', await a.press(P, 'Play again'));
check('a new game starts at question 1', await until(async () => (await round(a)).startsWith('Question 1 of 10')));
await a.press(P, 'Leave');
await c.press(P, 'Leave');
check('when everyone leaves it drops back to the lobby', await until(async () => (await b.text(`${P} .mg-players`)).includes('Nobody has joined')));
await done();
