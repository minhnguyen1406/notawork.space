// The camera bubble over someone's head and the cinema screen must show moving video, not a frozen
// first frame: counts the frames actually copied into the 3D scene. Needs `npm run dev`. Run: node tests/browser/live-video.mjs [out dir]
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
// Stand on open deck, well away from fire and fairy lights, and look almost straight down so the
// only thing that can change behind the bubble is the bubble itself.
await a.evaluate(() => window.__debug.tp(-20, 14));
await b.evaluate(() => (window.__debug.tp(-20, 14.01), window.__debug.cam(0, 1.3, 7)));
await a.click('#btn-cam');
const aid = await a.evaluate(() => window.__debug.id());
check('the viewer receives the camera', await until(async () => (await b.evaluate(() => window.__debug.cams()))[aid] > 0));
await sleep(2000);
const state = (await b.evaluate(() => window.__debug.camState())).find((c) => c.id === aid);
check('the camera video is on the page and playing', state.onPage && !state.paused);
// Like FaceTime and Zoom: you see yourself mirrored, everyone else sees you the true way round.
await sleep(500);
check('your own bubble is mirrored for you', (await a.evaluate(() => window.__debug.mirrored()))[aid] === true);
check('and not mirrored for the other person', (await b.evaluate(() => window.__debug.mirrored()))[aid] === false);
const drawn = () => b.evaluate(() => window.__debug.drawn());
const c1 = (await drawn()).cams[aid];
await sleep(2000);
const c2 = (await drawn()).cams[aid];
check(`new camera frames keep being drawn into the 3D bubble (${((c2 - c1) / 2).toFixed(0)} updates a second)`, c2 - c1 > 20);
if (out) await b.screenshot({ path: `${out}/bubble.png` });

// The cinema screen
await a.click('#btn-share');
check('a share reaches the viewer', await until(async () => (await b.evaluate(() => window.__debug.media())).screenOwner !== null));
await sleep(2500);
const s1 = (await drawn()).screen;
await sleep(2000);
const s2 = (await drawn()).screen;
check(`new shared frames keep being drawn onto the cinema screen (${((s2 - s1) / 2).toFixed(0)} updates a second)`, s2 - s1 > 20);
const own1 = (await a.evaluate(() => window.__debug.drawn())).screen;
await sleep(2000);
const own2 = (await a.evaluate(() => window.__debug.drawn())).screen;
check(`and onto the sharer's own cinema screen (${((own2 - own1) / 2).toFixed(0)} updates a second)`, own2 - own1 > 20);
const t1 = (await b.evaluate(() => window.__debug.camState())).find((c) => c.id === aid).t;
await sleep(1000);
const t2 = (await b.evaluate(() => window.__debug.camState())).find((c) => c.id === aid).t;
check(`the video clock keeps running (${t1.toFixed(1)} → ${t2.toFixed(1)})`, t2 > t1 + 0.5);
// Face grid: sit both down by the fire and look at the tiles.
await a.click('#btn-share'); // stop sharing
const seats = await a.evaluate(async () => (await import('/shared/layout.ts')).SEATS.filter((x) => x.group === 'lounge').slice(0, 2).map((x) => [x.x, x.z]));
for (const [page, [x, z]] of [[a, seats[0]], [b, seats[1]]]) {
  await page.evaluate((px, pz) => window.__debug.tp(px + 0.9, pz + 0.9), x, z);
  await sleep(700);
  await page.keyboard.press('KeyE');
}
await sleep(2500);
const tiles = (page) => page.evaluate(() => [...document.querySelectorAll('#grid-tiles .tile')].map((t) => ({ name: t.querySelector('.tile-name')?.textContent, video: !!t.querySelector('video'), mirror: !!t.querySelector('video.mirror') })));
const ta = await tiles(a);
const tb = await tiles(b);
check('in the face grid your own picture is mirrored', ta.some((t) => t.name?.includes('(you)') && t.video && t.mirror));
check("and the other person sees you un-mirrored", tb.some((t) => t.name === 'Ann' && t.video && !t.mirror));
if (out) await a.screenshot({ path: `${out}/grid-own.png` });
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
await a.owner.close();
await b.owner.close();
process.exit(failed ? 1 : 0);
