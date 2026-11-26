// Movement and reliability: the pitch boards are solid with gates, starting and stopping are eased,
// other people move smoothly, and a dropped room connection reconnects by itself.
// Needs `npm run dev`. Run: node tests/browser/smooth.mjs [out dir]
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
    args: ['--use-angle=metal', '--enable-webgl', '--ignore-gpu-blocklist', '--window-size=1280,800', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
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
  page.pos = () => page.evaluate(() => window.__debug.pos());
  page.tp = (x, z) => page.evaluate((px, pz) => window.__debug.tp(px, pz), x, z);
  return page;
}
const until = async (fn, ms = 20000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(300)) if (await fn()) return true;
  return false;
};
const a = await open('Ann');
const L = await a.evaluate(async () => {
  const m = await import('/shared/layout.ts');
  return { P: m.PITCH, SPAWN: m.SPAWN };
});
await a.evaluate(() => window.__debug.cam(0, 0.6, 12)); // with the camera this way, W is north (-z) and S is south (+z)
const hold = async (key, ms) => {
  await a.keyboard.down(key);
  await sleep(ms);
  await a.keyboard.up(key);
  await sleep(500);
};

// --- pitch boards
await a.tp(L.P.cx + 8, L.P.z1 - 3); // north of the pitch, away from the gate
await sleep(300);
await hold('KeyS', 2000);
let [, z] = await a.pos();
check(`the pitch board stops you (stopped at z=${z.toFixed(2)}, board at ${L.P.z1})`, z < L.P.z1 - 0.3);
await a.tp(L.P.cx, L.P.z1 - 3); // lined up with the gate
await sleep(300);
await hold('KeyS', 2000);
[, z] = await a.pos();
check(`the gate lets you onto the pitch (reached z=${z.toFixed(2)})`, z > L.P.z1 + 1);
await a.tp(L.P.cx + 8, L.P.z1 + 3); // inside, heading back out through the board
await sleep(300);
await hold('KeyW', 2000);
[, z] = await a.pos();
check(`and the board stops you from inside too (stopped at z=${z.toFixed(2)})`, z > L.P.z1 + 0.3);
if (out) {
  await a.evaluate((p) => (window.__debug.tp(p.cx, p.z1 - 5), window.__debug.cam(0, 0.5, 14)), L.P);
  await sleep(1200);
  await a.screenshot({ path: `${out}/pitch-gate.png` });
}

// --- eased start and stop: sample position every frame while tapping a key
await a.tp(L.P.cx - 10, L.P.cz - 6); // open grass, nothing to bump into
await a.evaluate(() => window.__debug.cam(0, 0.6, 12));
await sleep(400);
await a.evaluate(() => {
  window.__trace = [];
  const tick = () => {
    const p = window.__debug.pos();
    if (p) window.__trace.push([performance.now(), p[1]]);
    if (window.__trace.length < 240) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
await sleep(200);
await a.keyboard.down('KeyS');
await sleep(900);
await a.keyboard.up('KeyS');
await sleep(900);
const trace = await a.evaluate(() => window.__trace);
// Speed over a few frames at a time: single frames are too jittery to time accurately.
const paced = (samples, span = 5) => {
  const list = [];
  for (let i = span; i < samples.length; i++) list.push((samples[i][1] - samples[i - span][1]) / ((samples[i][0] - samples[i - span][0]) / 1000));
  return list;
};
const speeds = paced(trace);
const top = Math.max(...speeds);
const jumps = speeds.slice(1).map((s, i) => Math.abs(s - speeds[i]));
const biggest = Math.max(...jumps);
check(`reaches walking speed (${top.toFixed(1)} m/s)`, top > 4.5 && top < 6.5);
check(`speed changes gradually, never in one jump (biggest change between frames ${biggest.toFixed(2)} m/s of ${top.toFixed(1)})`, biggest < top * 0.45);
check('comes to a complete stop', Math.abs(speeds[speeds.length - 1]) < 0.01);

// --- someone else walking, as seen by me: no frame-to-frame lurches
const b = await open('Bao');
const bid = await b.evaluate(() => window.__debug.id());
await b.tp(L.P.cx - 12, L.P.cz + 5); // open grass again
await b.evaluate(() => window.__debug.cam(0, 0.6, 12));
await sleep(800);
await a.evaluate((id) => {
  window.__other = [];
  const tick = () => {
    const p = window.__debug.where(id);
    if (p) window.__other.push([performance.now(), p[0]]);
    if (window.__other.length < 260) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}, bid);
await b.keyboard.down('KeyD');
await sleep(2600);
await b.keyboard.up('KeyD');
await sleep(1500);
const other = await a.evaluate(() => window.__other);
const v = paced(other);
const cruising = v.filter((s) => s > 3);
const mean = cruising.reduce((x, y) => x + y, 0) / (cruising.length || 1);
const worst = Math.max(...cruising.map((s) => Math.abs(s - mean)));
check(`the other player is seen moving for most of the walk (${cruising.length} frames at speed)`, cruising.length > 90);
check(`at a steady pace: average ${mean.toFixed(1)} m/s, worst frame off by ${worst.toFixed(1)} m/s`, worst < mean * 0.6);
check('and no frame goes backwards', Math.min(...v) > -0.5);

// --- reconnecting
await a.tp(-25, 5);
await sleep(400);
const before = await a.pos();
const oldId = await a.evaluate(() => window.__debug.id());
await a.evaluate(() => window.__debug.dropRoom());
check('a dropped connection says it is reconnecting', await until(async () => (await a.$eval('#toast', (e) => (e.hidden ? '' : e.textContent))).includes('Reconnecting'), 4000));
check('and comes back by itself', await until(async () => { const id = await a.evaluate(() => window.__debug.id()); return id === oldId; }));
await sleep(1200);
const after = await a.pos();
check(`standing where you were (${after.map((n) => n.toFixed(1))})`, Math.hypot(after[0] - before[0], after[1] - before[1]) < 0.3);
check('the notice is cleared', await a.$eval('#toast', (e) => e.hidden));
check('voice reconnects too', await until(async () => (await a.evaluate(() => window.__debug.media())) !== null));
const newId = await a.evaluate(() => window.__debug.id());
check('the other player sees you back, once', await until(async () => { const w = await b.evaluate((id) => window.__debug.where(id), newId); return !!w && Math.hypot(w[0] - before[0], w[1] - before[1]) < 1; }));
check('as the same person, not a newcomer', newId === oldId);
check('the room count is right for both', (await a.$eval('#online', (e) => e.textContent)) === '3 here' && (await b.$eval('#online', (e) => e.textContent)) === '3 here'); // two people and Claude
await hold('KeyS', 600);
check('and you can walk again', (await a.pos())[1] > after[1] + 1);

console.log(errors.length ? errors : 'no page errors');
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
await a.owner.close();
await b.owner.close();
process.exit(failed ? 1 : 0);
