// The character picker: thirteen choices on the join screen, your pick is what others see, and it
// is remembered next time. Needs `npm run dev`. Run: node tests/browser/picker.mjs [out dir]
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
async function open() {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    args: ['--use-angle=metal', '--enable-webgl', '--ignore-gpu-blocklist', '--window-size=1280,860'],
    defaultViewport: { width: 1280, height: 860 },
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('requestfailed', (r) => errors.push('failed: ' + r.url().slice(-50)));
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0' });
  page.owner = browser;
  return page;
}
const join = async (page, name, look) => {
  if (look) await page.click(`#looks .look[data-look="${look}"]`);
  await page.type('#name', name);
  if (password) await page.type('#password', password);
  await page.click('#join-button');
  await page.waitForSelector('#hud:not([hidden])', { timeout: 10000 });
  await sleep(1500);
};
const a = await open();
check('thirteen characters to choose from, in a Women row and a Men row', (await a.$$('#looks .look')).length === 13 && (await a.$$eval('.look-row span', (e) => e.map((x) => x.textContent).join())) === 'Women,Men');
check('every thumbnail loads', await a.$$eval('#looks img', (imgs) => imgs.every((i) => i.complete && i.naturalWidth > 0)));
check('one is already picked for a first-time visitor', (await a.$$('#looks .look.picked')).length === 1);
await a.click('#looks .look[data-look="female-c"]');
check('clicking another moves the pick', (await a.$eval('#looks .look[data-look="female-c"]', (e) => e.classList.contains('picked'))) && (await a.$$('#looks .look.picked')).length === 1);
const fits = await a.$eval('#join-form', (e) => {
  const r = e.getBoundingClientRect();
  return r.top >= 0 && r.bottom <= innerHeight;
});
check('the join card still fits on screen', fits);
if (out) await a.screenshot({ path: `${out}/picker.png` });
await join(a, 'Lan');
const b = await open();
await join(b, 'Nam', 'male-c');
const looks = (page) => page.evaluate(() => window.__debug.looks());
const la = await looks(a);
const lb = await looks(b);
const idA = await a.evaluate(() => window.__debug.id());
const idB = await b.evaluate(() => window.__debug.id());
check(`you are the character you picked (${la[idA]}, ${lb[idB]})`, la[idA] === 'female-c' && lb[idB] === 'male-c');
check('and the other person sees you as that character', lb[idA] === 'female-c' && la[idB] === 'male-c');
check('Claude is still the robot', la.claude === 'robot');
// Reload: the choice is remembered
await a.reload({ waitUntil: 'networkidle0' });
check('your choice is remembered next time', await a.$eval('#looks .look[data-look="female-c"]', (e) => e.classList.contains('picked')));
if (out) {
  await b.evaluate(() => (window.__debug.tp(0, 14), window.__debug.cam(3.14, 0.25, 6)));
  await sleep(1500);
  await b.screenshot({ path: `${out}/picker-in-room.jpg`, type: 'jpeg', quality: 85 });
}
console.log(errors.length ? errors : 'no errors');
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
await a.evaluate(() => window.__debug?.leaveRoom?.()).catch(() => {});
await b.evaluate(() => window.__debug?.leaveRoom?.()).catch(() => {});
await new Promise((r) => setTimeout(r, 300));
await a.owner.close();
await b.owner.close();
process.exit(failed ? 1 : 0);
