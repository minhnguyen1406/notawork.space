// Football feel: walking into the ball dribbles it a short way; Space shoots it far and off the ground.
// Needs `npm run dev`. Run: node tests/browser/ball.mjs
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';
const password = readFileSync(new URL('../../worker/.dev.vars', import.meta.url), 'utf8').match(/^ROOM_PASSWORD=(.*)$/m)?.[1] ?? '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (label, ok) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label);
  if (!ok) failed++;
};
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
await page.type('#name', 'Minh');
if (password) await page.type('#password', password);
await page.click('#join-button');
await page.waitForSelector('#hud:not([hidden])', { timeout: 10000 });
await sleep(1500);
const ball = () => page.evaluate(() => window.__debug.ball());
const me = () => page.evaluate(() => window.__debug.pos());
const settle = async () => {
  for (let i = 0; i < 60; i++) {
    const b = await ball();
    if (!b.vx && !b.vz && !b.y) return b;
    await sleep(200);
  }
  return ball();
};
// Reset the ball to the centre spot by resetting the score.
const P = await page.evaluate(async () => (await import('/shared/layout.ts')).PITCH);
const S = await page.evaluate(async () => (await import('/shared/layout.ts')).SCOREBOARD);
await page.evaluate((s) => window.__debug.tp(s.x, s.z + 0.4), S);
await sleep(500);
await page.keyboard.press('KeyE');
await sleep(800);
await page.evaluate(() => window.__debug.cam(0, 0.6, 12)); // D walks east (+x)

// Dribble: walk into the ball from the west and keep walking.
const start = await settle();
await page.evaluate((b) => window.__debug.tp(b.x - 3, b.z), start);
await sleep(300);
await page.keyboard.down('KeyD');
await sleep(1800);
const mid = await ball();
const meMid = await me();
await page.keyboard.up('KeyD');
check(`walking into the ball moves it along with you (ball ${(mid.x - start.x).toFixed(1)} m on)`, mid.x - start.x > 2);
check(`and it stays close, a dribble not a blast (ball ${(mid.x - meMid[0]).toFixed(1)} m ahead)`, mid.x - meMid[0] > 0.3 && mid.x - meMid[0] < 4.5);
check('a dribbled ball stays on the grass', mid.y < 0.05);
const rest = await settle();
check(`it rolls to a stop soon after you do (${(rest.x - mid.x).toFixed(1)} m further)`, rest.x - mid.x < 6);

// Shoot: stand behind the ball facing east, press Space.
await page.evaluate((b) => window.__debug.tp(b.x - 2.6, b.z), rest);
await sleep(300);
await page.keyboard.down('KeyD');
await sleep(260);
await page.keyboard.up('KeyD');
await sleep(250);
const before = await ball();
await page.keyboard.press('Space');
let peak = 0;
for (let i = 0; i < 12; i++) {
  await sleep(70);
  peak = Math.max(peak, (await ball()).y);
}
const shot = await settle();
const travelled = Math.hypot(shot.x - before.x, shot.z - before.z);
check(`Space lifts the ball off the grass (peak ${peak.toFixed(2)} m)`, peak > 0.25);
check(`and sends it much further than a dribble (${travelled.toFixed(1)} m, or into the goal)`, travelled > 9 || Math.abs(shot.x - P.cx) < 0.01);
console.log(errors.length ? errors : 'no page errors');
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
await page.evaluate(() => window.__debug?.leaveRoom?.()).catch(() => {});
await new Promise((r) => setTimeout(r, 300));
await browser.close();
process.exit(failed ? 1 : 0);
