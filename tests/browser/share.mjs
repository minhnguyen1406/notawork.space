// Screenshare between two real (headless) Chrome windows on the local dev server, using Chrome's
// fake capture devices: it starts, reaches a far-away viewer smoothly, and stops.
// Needs `npm run dev` running and Google Chrome installed. Run: node tests/browser/share.mjs
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';
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
    args: ['--use-angle=metal', '--enable-webgl', '--ignore-gpu-blocklist', '--window-size=1280,800', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--auto-select-desktop-capture-source=Entire screen', '--autoplay-policy=no-user-gesture-required'],
    defaultViewport: { width: 1280, height: 800 },
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`${name}: ${m.text().slice(0, 200)}`));
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0' });
  await page.type('#name', name);
  if (password) await page.type('#password', password);
  await page.click('#join-button');
  await page.waitForSelector('#hud:not([hidden])', { timeout: 10000 });
  page.owner = browser;
  page.media = () => page.evaluate(() => window.__debug.media());
  return page;
}
const until = async (fn, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(300)) if (await fn()) return true;
  return false;
};
const a = await open('Sharer');
const b = await open('Viewer');
check('both connect to voice', await until(async () => (await a.media()) && (await b.media())));
await b.evaluate(() => window.__debug.tp(-30, 30)); // far from the sharer
await a.click('#btn-share');
check('the share starts', await until(async () => (await a.media()).sharing));
check('a far-away viewer receives it', await until(async () => (await b.media()).screenOwner !== null));
await b.click('#btn-theater');
const frames = () => b.evaluate(() => document.querySelector('#theater video')?.getVideoPlaybackQuality().totalVideoFrames ?? 0);
await sleep(3000);
const first = await frames();
await sleep(10000);
const fps = ((await frames()) - first) / 10;
const height = await b.evaluate(() => document.querySelector('#theater video')?.videoHeight ?? 0);
// The setting asks for 30; two headless browsers on one machine capture about 20. The old setting gave 15.
check(`video arrives faster than the old 15 frames a second (measured ${fps.toFixed(1)})`, fps > 17);
check(`at 720p or close to it (measured ${height}px high)`, height >= 540 && height <= 800);
await a.click('#btn-share');
check('stopping clears it for the viewer', await until(async () => (await b.media()).screenOwner === null));
console.log(errors.length ? errors : 'no page errors');
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
await a.owner.close();
await b.owner.close();
process.exit(failed ? 1 : 0);
