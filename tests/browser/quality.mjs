// The screenshare quality switch, between two real (headless) Chrome windows on the local dev
// server with Chrome's fake capture devices: Sharp reaches the viewer at about 1080 pixels high,
// Standard at about 720, and changing it mid-share says so instead of restarting the share.
// Needs `npm run dev` running and Google Chrome installed. Run: node tests/browser/quality.mjs
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
    // The captured screen has to be at least 1080 high, or there is nothing sharp to send.
    args: ['--use-angle=metal', '--enable-webgl', '--ignore-gpu-blocklist', '--window-size=1920,1080', '--screen-info={1920x1080}', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--auto-select-desktop-capture-source=Entire screen', '--autoplay-policy=no-user-gesture-required'],
    defaultViewport: { width: 1920, height: 1080 },
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

const pick = (q) => a.click(`.ft-quality [data-quality="${q}"]`);
const picked = () => a.evaluate(() => document.querySelector('.ft-quality .ft-quality-picked')?.dataset.quality ?? '');
const toast = () => a.evaluate(() => { const t = document.getElementById('toast'); return t && !t.hidden ? t.textContent : ''; });
const height = () => b.evaluate(() => document.querySelector('#theater video')?.videoHeight ?? 0);
/** The viewer's picture height once it has stopped climbing (the sender ramps up over a few seconds). */
async function settledHeight() {
  let best = 0;
  for (const end = Date.now() + 25000; Date.now() < end; await sleep(1000)) {
    const h = await height();
    if (h > best) best = h;
    if (best >= 1000) break;
  }
  return best;
}
async function startShare() {
  await a.click('#btn-share');
  check('the share starts', await until(async () => (await a.media()).sharing));
  check('the viewer receives it', await until(async () => (await b.media()).screenOwner !== null));
  await b.click('#btn-theater');
}
async function stopShare() {
  await a.click('#btn-share');
  check('stopping clears it for the viewer', await until(async () => (await b.media()).screenOwner === null));
}

check('the switch shows once voice is connected', await until(() => a.evaluate(() => { const e = document.querySelector('.ft-quality'); return !!e && !e.hidden && e.offsetParent !== null; }), 5000));
check('it starts on Standard', (await picked()) === 'standard');
check('it says what Sharp costs', await a.evaluate(() => document.querySelector('.ft-quality [data-quality="sharp"]')?.title === 'Sharper picture, uses about 2.5× the data'));

await pick('sharp');
check('Sharp is picked and remembered', (await picked()) === 'sharp' && (await a.evaluate(() => localStorage.getItem('shareQuality'))) === 'sharp');
await startShare();
const sharp = await settledHeight();
check(`Sharp arrives at about 1080 pixels high (measured ${sharp})`, sharp >= 1000 && sharp <= 1100);

await pick('standard');
check('changing it mid-share says to share again', await until(async () => (await toast()) === 'Stop and share again to use the new quality', 3000));
await sleep(3000);
check('and the running share is left alone', (await a.media()).sharing && (await height()) >= 1000);
await stopShare();

await startShare();
await sleep(8000); // long enough that a 1080p picture would have shown up
const standard = await settledHeight();
check(`Standard arrives at about 720 pixels high (measured ${standard})`, standard >= 540 && standard <= 800);
await stopShare();

console.log(errors.length ? errors : 'no page errors');
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
await a.evaluate(() => window.__debug?.leaveRoom?.()).catch(() => {});
await b.evaluate(() => window.__debug?.leaveRoom?.()).catch(() => {});
await new Promise((r) => setTimeout(r, 300));
await a.owner.close();
await b.owner.close();
process.exit(failed ? 1 : 0);
