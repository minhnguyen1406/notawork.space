// Truth or dare with two browsers. Needs `npm run dev`. Run: node tests/browser/minigames/dare.mjs
import { check, done, open, sleep, until } from '../lib.mjs';

const a = await open('Ann');
const b = await open('Bao');
const P = '.mg-dare';
await a.openGame('dare');
check('E at the signpost opens the game', (await a.text(`${P} h2`)) === 'Truth or dare');
check('it says how many are needed', (await a.text(`${P} .mg-status`)).includes('Needs 2'));
await a.press(P, 'Join');
await b.openGame('dare');
await b.press(P, 'Join');
check('both players are listed for both', await until(async () => (await a.text(`${P} .mg-players`)) === 'AnnBao' && (await b.text(`${P} .mg-players`)) === 'AnnBao'));
await a.press(P, 'Spin');
check('a spin picks someone and asks them to choose', await until(async () => (await a.text(`${P} .mg-status`)).includes('wheel picked')));
const picked = (await a.text(`${P} .mg-status`)).includes('picked you') ? a : b;
const other = picked === a ? b : a;
check('only the person picked gets the Truth and Dare buttons', !(await other.press(P, 'Dare')) && (await picked.press(P, 'Dare')));
check('everyone sees the dare', await until(async () => (await other.text(`${P} .mg-dare-prompt`)).length > 10 && (await other.text(`${P} .mg-status`)).includes('Dare')));
check('and can spin again', await other.press(P, 'Spin again'));
await sleep(500);
await a.press(P, 'Leave');
check('leaving with two players drops back to waiting', await until(async () => (await b.text(`${P} .mg-status`)).includes('Needs 2')));
await done();
