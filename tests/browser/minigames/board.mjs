// Leaderboards with one browser. Needs `npm run dev`. Run: node tests/browser/minigames/board.mjs
import { check, done, open, until } from '../lib.mjs';

const a = await open('Ann');
const P = '.mg-board';
check('the panel is hidden to begin with', (await a.text(P)) === '');
await a.openGame('board');
check('E at the signpost opens the leaderboards', await until(async () => (await a.text(`${P} h2`)) === 'Leaderboards'));
const headings = await a.evaluate((s) => [...document.querySelectorAll(`${s} h3`)].map((h) => h.textContent), P);
check('it shows the five tables', ['Duels', 'Goals scored', 'Fastest lap', 'Chess wins', 'Dishes served'].every((h) => headings.includes(h)) && headings.length === 5);
check('it says how long the tallies go back', (await a.text(P)).includes('Since the room last restarted'));
check('it has a Close button', (await a.text(`${P} .mg-close`)) === 'Close');
await a.keyboard.press('Escape');
check('Escape closes it', await until(async () => (await a.text(P)) === '', 3000));
await a.openGame('board');
check('it opens again', await until(async () => (await a.text(`${P} h2`)) === 'Leaderboards'));
check('and the Close button closes it', (await a.press(P, 'Close')) && (await until(async () => (await a.text(P)) === '', 3000)));
await done();
