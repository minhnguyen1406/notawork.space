// Hovering over the "N here" count lists everyone in the room and what they are doing.
// Needs `npm run dev`. Run: node tests/browser/people.mjs [out dir]
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
    args: ['--use-angle=metal', '--enable-webgl', '--ignore-gpu-blocklist', '--window-size=1280,800'],
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
const a = await open('Minh');
const b = await open('Lan');
await sleep(1200);
const rows = () => a.$$eval('#people .person', (els) => els.map((e) => e.textContent));
check('the list is hidden until you point at the count', await a.$eval('#people', (e) => e.hidden));
await a.hover('#online');
await sleep(300);
let list = await rows();
check(`pointing at "${await a.$eval('#online', (e) => e.textContent)}" lists everyone (${list.length})`, !(await a.$eval('#people', (e) => e.hidden)) && list.length === 3);
check('you come first, marked as you', list[0].startsWith('Minh (you)'));
check('Claude and your friend are listed', list.some((r) => r.startsWith('Claude')) && list.some((r) => r.startsWith('Lan')));
// Lan sits by the fire: the list should say so within a second or two.
const seat = await b.evaluate(async () => (await import('/shared/layout.ts')).SEATS.find((s) => s.group === 'lounge'));
await b.evaluate((s) => window.__debug.tp(s.x + 0.9, s.z + 0.9), seat);
await sleep(500);
await b.keyboard.press('KeyE');
await sleep(2200);
list = await rows();
check(`it says what people are doing (${list.find((r) => r.startsWith('Lan'))})`, list.some((r) => r.startsWith('Lan') && r.includes('by the fire')));
if (out) await a.screenshot({ path: `${out}/people.jpg`, type: 'jpeg', quality: 85, clip: { x: 0, y: 0, width: 520, height: 260 } });
await a.mouse.move(700, 500);
await sleep(300);
check('it goes away when you move off', await a.$eval('#people', (e) => e.hidden));
await a.click('#online');
await a.mouse.move(700, 500);
await sleep(300);
check('clicking the count pins it open', !(await a.$eval('#people', (e) => e.hidden)));
await a.click('#online');
await a.mouse.move(700, 500);
await sleep(300);
check('and clicking again closes it', await a.$eval('#people', (e) => e.hidden));
console.log(errors.length ? errors : 'no page errors');
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
await a.owner.close();
await b.owner.close();
process.exit(failed ? 1 : 0);
