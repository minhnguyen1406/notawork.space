// Share a real YouTube tab from one Chrome to another on the local dev server and watch what the
// viewer gets, on the cinema screen and in full screen, for a couple of minutes.
// Needs `npm run dev`. Run: node tests/browser/youtube-share.mjs <out dir> [seconds]
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';
const [out, seconds = '120'] = process.argv.slice(2);
// By default a local moving test page (YouTube shows an error to automated browsers after a while).
// Set VIDEO to a real address and TITLE to part of its tab title to try a real site.
const VIDEO = process.env.VIDEO ?? new URL('./moving-source.html', import.meta.url).href;
const TITLE = process.env.TITLE ?? 'Moving Source';
const password = readFileSync(new URL('../../worker/.dev.vars', import.meta.url), 'utf8').match(/^ROOM_PASSWORD=(.*)$/m)?.[1] ?? '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s]`, ...a);
const launch = (extra = []) =>
  puppeteer.launch({
    executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: process.env.HEADFUL ? false : 'new',
    // No fake capture devices here: they would replace the shared tab with Chrome's test pattern.
    args: ['--use-angle=metal', '--enable-webgl', '--ignore-gpu-blocklist', '--window-size=1280,800', '--autoplay-policy=no-user-gesture-required', ...extra],
    defaultViewport: { width: 1280, height: 800 },
  });
async function join(browser, name) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => log(name, 'pageerror:', e.message.slice(0, 200)));
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' || /disconnect|reconnect|could not|failed|unpublish|ended|muted/i.test(t)) log(name, `${m.type()}:`, t.slice(0, 200));
  });
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0' });
  await page.type('#name', name);
  if (password) await page.type('#password', password);
  await page.click('#join-button');
  await page.waitForSelector('#hud:not([hidden])', { timeout: 10000 });
  return page;
}

// Sharer: a YouTube tab playing, and the room in another tab. Chrome picks the YouTube tab for the share.
const sharerBrowser = await launch([`--auto-select-tab-capture-source-by-title=${TITLE}`, '--allow-file-access-from-files']);
const yt = await sharerBrowser.newPage();
await yt.goto(VIDEO, { waitUntil: 'domcontentloaded' });
await sleep(6000);
for (const text of ['Reject all', 'Accept all']) {
  const b = await yt.evaluateHandle((t) => [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === t), text);
  if (b.asElement()) {
    await b.asElement().click();
    await sleep(3000);
    break;
  }
}
await yt.evaluate(() => document.querySelector('video')?.play().catch(() => {}));
await sleep(3000);
const ytState = () => yt.evaluate(() => {
  const v = document.querySelector('video');
  if (window.__t !== undefined) return { t: +window.__t.toFixed(1) };
  return v ? { t: +v.currentTime.toFixed(1), paused: v.paused, w: v.videoWidth } : null;
});
log('source tab:', await yt.title(), JSON.stringify(await ytState()));
await yt.screenshot({ path: `${out}/yt-0-source.png` });

const sharer = await join(sharerBrowser, 'Sharer');
const viewerBrowser = await launch();
const viewer = await join(viewerBrowser, 'Viewer');
await sleep(4000);
await sharer.bringToFront();
await sharer.click('#btn-share');
await sleep(6000);
log('sharer:', JSON.stringify(await sharer.evaluate(() => ({ ...window.__debug.media(), toast: document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent, button: document.getElementById('btn-share').textContent }))));
log('viewer:', JSON.stringify(await viewer.evaluate(() => window.__debug.media())));

// Viewer stands in front of the cinema screen.
await viewer.evaluate(() => (window.__debug.tp(0, -6), window.__debug.cam(0, 0.18, 9)));
const drawn = (page) => page.evaluate(() => window.__debug.drawn().screen);
const stats = async () => {
  const before = await drawn(viewer);
  await sleep(2000);
  return { viewerScreenUpdatesPerSec: ((await drawn(viewer)) - before) / 2, yt: await ytState() };
};
const total = +seconds;
for (const at of [5, 20, 45, 75, total].filter((s, i, a) => s <= total && a.indexOf(s) === i)) {
  while ((Date.now() - t0) / 1000 < at + 30) await sleep(500);
  const s = await stats();
  log(`cinema at +${at}s:`, JSON.stringify(s));
  await viewer.screenshot({ path: `${out}/yt-cinema-${at}.png` });
}
// Full screen
await viewer.click('#btn-theater');
await sleep(3000);
const theater = () => viewer.evaluate(() => {
  const v = document.querySelector('#theater video');
  return v ? { w: v.videoWidth, h: v.videoHeight, paused: v.paused, frames: v.getVideoPlaybackQuality().totalVideoFrames, box: `${Math.round(v.getBoundingClientRect().width)}x${Math.round(v.getBoundingClientRect().height)}` } : 'no video element';
});
const f1 = await theater();
await sleep(5000);
const f2 = await theater();
log('full screen:', JSON.stringify(f2), '| frames a second:', typeof f2 === 'object' ? (f2.frames - f1.frames) / 5 : '-');
await viewer.screenshot({ path: `${out}/yt-theater.png` });
// The sharer looking at their own room tab. Chrome jumps to the shared tab when a share starts,
// so first note what the room tab is doing in the background, then come back to it.
log('sharer room tab hidden while sharing:', await sharer.evaluate(() => document.hidden));
await sharer.bringToFront();
await sleep(1500);
log('sharer room tab hidden after switching back:', await sharer.evaluate(() => document.hidden), '| own video:', JSON.stringify(await sharer.evaluate(() => { const v = document.querySelector('#video-parking video'); return v ? { paused: v.paused, t: +v.currentTime.toFixed(1), ready: v.readyState, w: v.videoWidth, count: document.querySelectorAll('#video-parking video').length } : 'none parked'; })));
await sharer.evaluate(() => (window.__debug.tp(0, -6), window.__debug.cam(0, 0.18, 9)));
await sleep(2500);
const own = await drawn(sharer);
await sleep(2000);
log("sharer's own cinema updates a second:", ((await drawn(sharer)) - own) / 2);
await sharer.screenshot({ path: `${out}/yt-sharer-own.png` });
log('source tab at the end:', JSON.stringify(await ytState()), await yt.title());
await yt.screenshot({ path: `${out}/yt-9-source-end.png` });
await sharerBrowser.close();
await viewerBrowser.close();
