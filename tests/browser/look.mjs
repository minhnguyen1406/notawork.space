// Pictures of the room from a few standing spots, for judging the look by eye.
// Needs `npm run dev`. Run: node tests/browser/look.mjs <out dir> [prefix]
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';
const [out, prefix = 'look'] = process.argv.slice(2);
const password = readFileSync(new URL('../../worker/.dev.vars', import.meta.url), 'utf8').match(/^ROOM_PASSWORD=(.*)$/m)?.[1] ?? '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-angle=metal', '--enable-webgl', '--ignore-gpu-blocklist', '--window-size=1440,900'],
  defaultViewport: { width: 1440, height: 900 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 200)));
page.on('requestfailed', (r) => errors.push('failed: ' + r.url().slice(-60)));
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0' });
await page.type('#name', 'Minh');
if (password) await page.type('#password', password);
await page.click('#join-button');
await page.waitForSelector('#hud:not([hidden])', { timeout: 10000 });
await sleep(5000);
// [name, x, z, yaw, pitch, distance]
const views = [
  ['spawn', 0, 10, 0, 0.42, 12],
  ['low-north', 0, 14, 0, 0.14, 10],
  ['low-east', -10, 16, -1.57, 0.14, 12],
  ['low-south', 0, 6, 3.14, 0.14, 12],
  ['low-west', 4, 14, 1.57, 0.14, 12],
  ['deck-close', -18, 16, 0.6, 0.5, 5],
  ['pitch', -12, 22, 3.14, 0.35, 14],
];
for (const [name, x, z, yaw, pitch, dist] of views) {
  await page.evaluate((a, b, c, d, e) => (window.__debug.tp(a, b), window.__debug.cam(c, d, e)), x, z, yaw, pitch, dist);
  await sleep(1300);
  await page.screenshot({ path: `${out}/${prefix}-${name}.jpg`, type: 'jpeg', quality: 80 });
}
console.log(errors.length ? errors : 'no errors');
await browser.close();
