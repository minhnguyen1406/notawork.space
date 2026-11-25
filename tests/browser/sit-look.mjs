// One browser: pictures of a character sitting by the fire and at the dining table, and running.
// Needs `npm run dev`. Run: node tests/browser/sit-look.mjs <out dir>
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';
const [out] = process.argv.slice(2);
const password = readFileSync(new URL('../../worker/.dev.vars', import.meta.url), 'utf8').match(/^ROOM_PASSWORD=(.*)$/m)?.[1] ?? '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-angle=metal', '--enable-webgl', '--ignore-gpu-blocklist', '--window-size=1280,800'],
  defaultViewport: { width: 1280, height: 800 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0' });
await page.type('#name', 'Lan');
if (password) await page.type('#password', password);
await page.click('#join-button');
await page.waitForSelector('#hud:not([hidden])', { timeout: 10000 });
await sleep(3000);
const seats = await page.evaluate(async () => (await import('/shared/layout.ts')).SEATS.filter((s) => s.group === 'lounge' || s.group === 'dining').map((s) => [s.id, s.x, s.z]));
for (const [label, seat, yaw] of [['fire', seats.find((s) => s[0].startsWith('lounge')), 0.9], ['table', seats.find((s) => s[0].startsWith('dining')), -1.3]]) {
  await page.evaluate((x, z) => window.__debug.tp(x + 0.9, z + 0.9), seat[1], seat[2]);
  await sleep(500);
  await page.keyboard.press('KeyE');
  await sleep(1200);
  // Hide the face-grid panel so the 3D pose is visible.
  await page.evaluate((y) => ((document.getElementById('grid').style.visibility = 'hidden'), window.__debug.cam(y, 0.3, 5)), yaw);
  await sleep(1200);
  await page.screenshot({ path: `${out}/sit-${label}.jpg`, type: 'jpeg', quality: 85 });
  await page.keyboard.press('KeyE');
  await sleep(500);
}
await page.evaluate(() => (window.__debug.tp(-12, 14), window.__debug.cam(1.2, 0.3, 6)));
await page.keyboard.down('ShiftLeft');
await page.keyboard.down('KeyD');
await sleep(700);
await page.screenshot({ path: `${out}/run.jpg`, type: 'jpeg', quality: 85 });
await page.keyboard.up('KeyD');
await page.keyboard.up('ShiftLeft');
console.log(errors.length ? errors : 'no page errors');
await browser.close();
