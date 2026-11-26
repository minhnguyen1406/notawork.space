// The talking indicator: when someone's mic picks up sound, others see a speaker icon and a pulsing
// ring on that character, and it clears when they stop. Needs `npm run dev`.
// Run: node tests/browser/talking.mjs [out dir]
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
async function open(name) {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    args: ['--use-angle=metal', '--enable-webgl', '--ignore-gpu-blocklist', '--window-size=1280,800', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
    defaultViewport: { width: 1280, height: 800 },
  });
  const page = await browser.newPage();
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0' });
  await page.type('#name', name);
  if (password) await page.type('#password', password);
  await page.click('#join-button');
  await page.waitForSelector('#hud:not([hidden])', { timeout: 10000 });
  page.owner = browser;
  return page;
}
const until = async (fn, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(300)) if (await fn()) return true;
  return false;
};
const a = await open('Ann');
const b = await open('Bao');
await until(async () => (await a.evaluate(() => window.__debug.media())) && (await b.evaluate(() => window.__debug.media())));
await a.evaluate(() => window.__debug.tp(0, 14));
await b.evaluate(() => (window.__debug.tp(2, 14.5), window.__debug.cam(0.5, 0.25, 6)));
const aid = await a.evaluate(() => window.__debug.id());
const talking = (page) => page.evaluate(() => window.__debug.talking());
check('nobody is marked as talking at first', (await talking(b)).length === 0);
await a.keyboard.press('KeyM'); // Chrome's fake microphone beeps, which counts as speech
check('the other person sees you marked as talking', await until(async () => (await talking(b)).includes(aid)));
check('and you see it on yourself', await until(async () => (await talking(a)).includes(aid)));
// The fake microphone beeps on and off, so take the picture at a moment when it counts as talking.
await until(async () => (await talking(b)).includes(aid), 5000);
if (out) await b.screenshot({ path: `${out}/talking.jpg`, type: 'jpeg', quality: 85 });
await a.keyboard.press('KeyM');
check('it clears when you stop', await until(async () => !(await talking(b)).includes(aid)));
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
await a.evaluate(() => window.__debug?.leaveRoom?.()).catch(() => {});
await b.evaluate(() => window.__debug?.leaveRoom?.()).catch(() => {});
await new Promise((r) => setTimeout(r, 300));
await a.owner.close();
await b.owner.close();
process.exit(failed ? 1 : 0);
