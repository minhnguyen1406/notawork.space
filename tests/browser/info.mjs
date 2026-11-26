// The info panel (press I) shows the version, the browser and live share numbers for sharer and viewer.
// Needs `npm run dev`. Run: node tests/browser/info.mjs [out dir]
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
    args: ['--use-angle=metal', '--enable-webgl', '--ignore-gpu-blocklist', '--window-size=1280,800', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--auto-select-desktop-capture-source=Entire screen', '--autoplay-policy=no-user-gesture-required'],
    defaultViewport: { width: 1280, height: 800 },
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0' });
  await page.type('#name', name);
  if (password) await page.type('#password', password);
  await page.click('#join-button');
  await page.waitForSelector('#hud:not([hidden])', { timeout: 10000 });
  page.owner = browser;
  page.errors = errors;
  return page;
}
const a = await open('Sharer');
const b = await open('Viewer');
await sleep(4000);
await a.click('#btn-share');
await sleep(4000);
for (const p of [a, b]) await p.keyboard.press('KeyI');
await sleep(6500); // three refreshes, so the frame rate has two samples to compare
const ta = await a.$eval('#info', (e) => e.textContent);
const tb = await b.$eval('#info', (e) => e.textContent);
console.log('--- sharer\n' + ta + '\n--- viewer\n' + tb);
check('shows the version and browser', /Version: \S+/.test(tb) && /Browser: Chrome\//.test(tb));
check('sharer sees what they are sending', /You are sharing/.test(ta) && /sending \d+×\d+ at \d+ fps/.test(ta));
check('viewer sees what they are receiving', /Watching a share from Sharer/.test(tb) && /receiving \d+×\d+ at [1-9]\d* fps/.test(tb));
if (out) await b.screenshot({ path: `${out}/info.png` });
await b.keyboard.press('KeyI');
check('I hides it again', await b.$eval('#info', (e) => e.hidden));
check('no page errors', a.errors.length + b.errors.length === 0);
if (a.errors.length + b.errors.length) console.log(a.errors, b.errors);
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
await a.evaluate(() => window.__debug?.leaveRoom?.()).catch(() => {});
await b.evaluate(() => window.__debug?.leaveRoom?.()).catch(() => {});
await new Promise((r) => setTimeout(r, 300));
await a.owner.close();
await b.owner.close();
process.exit(failed ? 1 : 0);
