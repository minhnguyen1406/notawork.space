// The built-in Claude character: it is in the room, obeys chat commands, and plays chess.
// Needs `npm run dev`. Run: node tests/browser/claude.mjs [out dir]
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';
import { Chess } from 'chess.js';
const out = process.argv[2];
const password = readFileSync(new URL('../../worker/.dev.vars', import.meta.url), 'utf8').match(/^ROOM_PASSWORD=(.*)$/m)?.[1] ?? '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (label, ok) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label);
  if (!ok) failed++;
};
const errors = [];
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-angle=metal', '--enable-webgl', '--ignore-gpu-blocklist', '--window-size=1280,800', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: 1280, height: 800 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 200)));
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0' });
await page.type('#name', 'Minh');
if (password) await page.type('#password', password);
await page.click('#join-button');
await page.waitForSelector('#hud:not([hidden])', { timeout: 10000 });
const until = async (fn, ms = 20000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(300)) if (await fn()) return true;
  return false;
};
const chatLog = () => page.$eval('#chat-log', (e) => e.textContent);
const say = async (text) => {
  await page.keyboard.press('Enter');
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
};
const claude = () => page.evaluate(() => window.__debug.where('claude'));
const me = () => page.evaluate(() => window.__debug.pos());

check('Claude is in the room when you arrive', (await claude()) !== null && (await page.$eval('#online', (e) => e.textContent)) === '2 here');
check('and says hello', await until(async () => (await chatLog()).includes("I'm Claude"), 6000));

await say('/claude');
check('"/claude" lists the commands', await until(async () => (await chatLog()).includes('/claude chess'), 6000));

await page.evaluate(() => window.__debug.tp(2, 18));
await sleep(400);
await say('/claude come here');
check('"come" brings it to you', await until(async () => { const c = await claude(); const m = await me(); return Math.hypot(c[0] - m[0], c[1] - m[1]) < 2.8; }, 15000));
if (out) await page.screenshot({ path: `${out}/claude-come.png` });

await say('/claude dance');
await sleep(1200);
if (out) await page.screenshot({ path: `${out}/claude-dance.png` });

await say('/claude play chess with me');
check('"chess" sends it to the board', await until(async () => { const c = await claude(); return Math.hypot(c[0] - 13.5, c[1] - 26) < 0.3; }, 25000));
// Sit down as White
await page.evaluate(() => window.__debug.tp(9.6, 26));
await sleep(600);
await page.keyboard.press('KeyE');
check('you sit opposite and the board opens', await until(async () => (await page.$$('.chess-board .sq')).length === 64, 6000));
const view = () => page.evaluate(() => window.__debug.table('chess'));
check('the board knows Claude is Black', (await view())?.bot === 'b' && (await view())?.you === 'w');
check('Claude wishes you luck', await until(async () => (await chatLog()).includes("You're White"), 6000));

// Play: e4 first, then random legal moves, clicking the real squares.
let replies = 0;
let slowest = 0;
for (let i = 0; i < 10; i++) {
  const v = await view();
  if (v.status !== 'playing') break;
  const game = new Chess(v.fen);
  const options = game.moves({ verbose: true });
  const move = i === 0 ? options.find((m) => m.san === 'e4') : options[Math.floor(Math.random() * options.length)];
  await page.click(`.chess-board [aria-label^="${move.from}"]`);
  await page.click(`.chess-board [aria-label^="${move.to}"]`);
  const asked = Date.now();
  const answered = await until(async () => { const n = await view(); return n.status !== 'playing' || (n.fen !== v.fen && n.fen.split(' ')[1] === 'w'); }, 9000);
  if (!answered) break;
  replies++;
  slowest = Math.max(slowest, Date.now() - asked);
}
const end = await view();
check(`Claude answered every move (${replies} replies, slowest ${(slowest / 1000).toFixed(1)} s)`, replies === 10 || end.status !== 'playing');
check('each reply came in good time', slowest < 6000);
if (out) await page.screenshot({ path: `${out}/claude-chess.png` });

// Sending it elsewhere gets it up from the table
await say('/claude go to the fire');
check('"go fire" gets it up and walking', await until(async () => { const c = await claude(); return c[1] < 20; }, 15000));
check('its seat is free again', (await view())?.bot === null);

await say('/claude bye');
check('"bye" removes it', await until(async () => (await claude()) === null, 6000));
check('the room count drops to just you', (await page.$eval('#online', (e) => e.textContent)) === 'Just you here');
await say('/claude wave');
check('any command brings it back', await until(async () => (await claude()) !== null, 6000));

console.log(errors.length ? errors : 'no page errors');
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
await page.evaluate(() => window.__debug?.leaveRoom?.()).catch(() => {});
await new Promise((r) => setTimeout(r, 300));
await browser.close();
process.exit(failed ? 1 : 0);
