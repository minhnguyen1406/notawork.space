// A duel between two browsers: challenge, accept, rounds with keys 1 to 3, hearts, a winner.
// Needs `npm run dev`. Run: node tests/browser/duel.mjs [out dir]
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';
const out = process.argv[2];
const password = readFileSync(new URL('../../worker/.dev.vars', import.meta.url), 'utf8').match(/^ROOM_PASSWORD=(.*)$/m)?.[1] ?? '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (label, ok) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label);
  if (!ok) failed++;
};
const errors = [];
async function open(name) {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    args: ['--use-angle=metal', '--enable-webgl', '--ignore-gpu-blocklist', '--window-size=1280,800', '--autoplay-policy=no-user-gesture-required'],
    defaultViewport: { width: 1280, height: 800 },
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0' });
  await page.type('#name', name);
  if (password) await page.type('#password', password);
  await page.click('#join-button');
  await page.waitForSelector('#hud:not([hidden])', { timeout: 10000 });
  page.owner = browser;
  return page;
}
const until = async (fn, ms = 12000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) if (await fn()) return true;
  return false;
};
const a = await open('Ann');
const b = await open('Bao');
await a.evaluate(() => (window.__debug.tp(-18, 14), window.__debug.cam(0.6, 0.3, 7)));
await b.evaluate(() => (window.__debug.tp(-16, 14), window.__debug.cam(0.6, 0.3, 7)));
await sleep(1200);
const prompt = () => a.$eval('#prompt', (e) => (e.hidden ? '' : e.textContent));
check('standing next to someone offers a duel', await until(async () => (await prompt()).includes('challenge Bao')));
await a.keyboard.press('KeyG');
check('the other person is asked', await until(async () => !(await b.$eval('#duel-ask', (e) => e.hidden))));
check('and told who is asking', (await b.$eval('#duel-ask', (e) => e.textContent)).includes('Ann challenges you'));
await b.keyboard.press('KeyY');
const duel = (p) => p.evaluate(() => window.__debug.duel());
check('accepting starts the duel for both', await until(async () => (await duel(a)) && (await duel(b))));
check('each fighter gets the move panel', (await a.$$('.duel-move')).length === 3 && !(await b.$eval('#duel', (e) => e.hidden)));
const before = await a.evaluate(() => window.__debug.pos());
await a.keyboard.down('KeyD');
await sleep(500);
await a.keyboard.up('KeyD');
const after = await a.evaluate(() => window.__debug.pos());
check('you stay put while fighting', before[0] === after[0] && before[1] === after[1]);

// Ann plays Pillow (1) every round, Bao plays Rubber chicken (2): Ann should win 3–0.
for (let r = 1; r <= 3; r++) {
  await until(async () => (await duel(a))?.phase === 'pick' && (await duel(a)).round === r, 8000);
  await a.keyboard.press('Digit1');
  if (r === 1) {
    await sleep(300);
    check("your opponent can't see your move, only that you're ready", (await b.$eval('.duel-status', (e) => e.textContent)).includes('Ann is ready') && !(await b.$eval('#duel', (e) => e.textContent)).includes('You chose'));
    if (out) await b.screenshot({ path: `${out}/duel-pick.jpg`, type: 'jpeg', quality: 85 });
  }
  await b.keyboard.press('Digit2');
  if (r === 1) {
    check('both moves are revealed with the result', await until(async () => (await b.$eval('.duel-status', (e) => e.textContent)).includes('You lose a heart'), 5000));
    await sleep(500);
    if (out) await a.screenshot({ path: `${out}/duel-reveal.jpg`, type: 'jpeg', quality: 85 });
  }
}
check('three hearts gone ends the duel with the right winner', await until(async () => (await a.$eval('.duel-status', (e) => e.textContent)).includes('You win the duel'), 8000));
check('the loser is told too', (await b.$eval('.duel-status', (e) => e.textContent)).includes('Ann wins the duel'));
check('the room is told', await until(async () => (await b.$eval('#chat-log', (e) => e.textContent)).includes('Ann won the duel against Bao'), 4000));
await sleep(1500);
if (out) await b.screenshot({ path: `${out}/duel-over.jpg`, type: 'jpeg', quality: 85 });
check('afterwards the panel goes away and you can move again', await until(async () => (await a.$eval('#duel', (e) => e.hidden)) && !(await duel(a)), 9000));
await a.keyboard.down('KeyD');
await sleep(500);
await a.keyboard.up('KeyD');
check('walking works again', (await a.evaluate(() => window.__debug.pos()))[0] > after[0] + 0.5);

// Declining
await a.evaluate(() => window.__debug.tp(-18, 14));
await b.evaluate(() => window.__debug.tp(-16, 14));
await sleep(1200);
await a.keyboard.press('KeyG');
await until(async () => !(await b.$eval('#duel-ask', (e) => e.hidden)));
await b.keyboard.press('KeyN');
check('declining starts nothing and tells the challenger', (await until(async () => (await a.$eval('#chat-log', (e) => e.textContent)).includes('would rather not fight'), 4000)) && !(await duel(a)));
console.log(errors.length ? errors : 'no page errors');
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
await a.owner.close();
await b.owner.close();
process.exit(failed ? 1 : 0);
