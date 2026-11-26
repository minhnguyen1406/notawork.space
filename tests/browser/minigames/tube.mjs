// Play a video with two browsers. Needs `npm run dev`. Run: node tests/browser/minigames/tube.mjs
// It checks what the room does (who is shown what); it does not need YouTube itself to be reachable.
import { check, done, open, sleep, until } from '../lib.mjs';

const a = await open('Ann');
const b = await open('Bao');
const P = '.mg-tube';
const W = '.mg-tube-player';
const ID = 'dQw4w9WgXcQ';
/** The floating window's video id and playing flag, or null when the window is not showing. */
const win = (page) => page.evaluate((s) => { const e = document.querySelector(s); return e && !e.hidden && e.offsetParent !== null ? { id: e.dataset.id ?? '', playing: e.dataset.playing } : null; }, W);
const paste = (page, text) => page.evaluate((s, t) => { const i = document.querySelector(`${s} .mg-tube-link`); i.value = t; }, P, text);

await a.openGame('tube');
check('E at the signpost opens the panel', (await a.text(`${P} h2`)) === 'Play a video');
check('nothing is on to begin with', (await a.text(`${P} .mg-status`)).includes('Nothing is on') && !(await win(a)) && !(await win(b)));
check('there is no Pause or Stop while nothing is on', !(await a.press(P, 'Pause')) && !(await a.press(P, 'Stop')));

for (const junk of ['hello there', 'javascript:alert(1)', `https://evil.example/watch?v=${ID}`, `https://youtu.be/${ID}xx`]) {
  await paste(a, junk);
  await a.press(P, 'Play');
  await sleep(400);
  check(`a junk link is refused: ${junk}`, (await a.text(`${P} .mg-status`)).includes('not a YouTube link') && !(await win(a)) && !(await win(b)));
}

await paste(a, `https://www.youtube.com/watch?v=${ID}&t=1`);
check('Play is there to press', await a.press(P, 'Play'));
check('the player window appears for the one who played it', await until(async () => (await win(a))?.id === ID));
check('and for someone who never opened the panel, with the same id', await until(async () => (await win(b))?.id === ID));
check('both are told it is playing', (await win(a)).playing === 'true' && (await win(b)).playing === 'true');
check('the panel lists what is on and who started it', await until(async () => (await a.text(`${P} .mg-tube-now`)).includes('started by Ann')));
check('the window is about 480 wide at the top centre', await b.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return Math.abs(r.width - 480) < 4 && r.top < 40 && Math.abs(r.left + r.width / 2 - innerWidth / 2) < 4; }, W));

check('Large makes it about four fifths of the window', (await b.press(W, 'Large')) && (await until(async () => b.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return r.width > innerWidth * 0.6 && r.height <= innerHeight; }, W), 3000)));
await b.press(W, 'Small');
check('Hide for me hides it for me alone and leaves a chip', (await b.press(W, 'Hide for me')) && !(await win(b)) && (await b.text('.mg-tube-chip')) === 'Show video' && (await win(a))?.id === ID);
await b.evaluate(() => document.querySelector('.mg-tube-chip').click());
check('Show video brings it back', (await win(b))?.id === ID);

await b.openGame('tube');
check('the other person may pause', await b.press(P, 'Pause'));
check('pause reaches everyone', await until(async () => (await win(a))?.playing === 'false' && (await win(b))?.playing === 'false' && (await a.text(`${P} .mg-status`)).includes('Paused')));
check('and resume', (await a.press(P, 'Resume')) && (await until(async () => (await win(b))?.playing === 'true')));

const c = await open('Chi');
check('someone arriving later gets the window too', await until(async () => (await win(c))?.id === ID));

check('Stop for everyone is there', await b.press(P, 'Stop for everyone'));
check('stop takes the window away from everyone', await until(async () => !(await win(a)) && !(await win(b)) && !(await win(c))));
check('and the panel says nothing is on', await until(async () => (await a.text(`${P} .mg-status`)).includes('Nothing is on')));

await paste(a, ID);
await a.press(P, 'Play');
check('a bare id plays too', await until(async () => (await win(b))?.id === ID));
await a.press(P, 'Stop for everyone');
await until(async () => !(await win(b)));
await done();
