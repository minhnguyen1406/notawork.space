// Helpers shared by the browser tests. They drive real (headless) Chrome against `npm run dev`.
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';

const password = readFileSync(new URL('../../worker/.dev.vars', import.meta.url), 'utf8').match(/^ROOM_PASSWORD=(.*)$/m)?.[1] ?? '';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const errors = [];
export function check(label, ok) {
  console.log((ok ? 'PASS ' : 'FAIL ') + label);
  if (!ok) failed++;
}
/** Keep trying `fn` until it returns something truthy or time runs out. */
export async function until(fn, ms = 12000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) if (await fn()) return true;
  return false;
}

const pages = [];
/** Open a browser, join the room under this name, and return the page with a few extras. */
export async function open(name, { media = false } = {}) {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    args: ['--use-angle=metal', '--enable-webgl', '--ignore-gpu-blocklist', '--window-size=1280,800', '--autoplay-policy=no-user-gesture-required', ...(media ? ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] : [])],
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
  /** Jump to a spot in the room. */
  page.tp = async (x, z) => {
    await page.evaluate((px, pz) => window.__debug.tp(px, pz), x, z);
    await sleep(400);
  };
  page.pos = () => page.evaluate(() => window.__debug.pos());
  page.id = () => page.evaluate(() => window.__debug.id());
  /** The text of an element, or '' if it is missing or hidden. (Judged by whether it has a box:
   *  offsetParent is always null for position: fixed elements, shown or not.) */
  page.text = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return e && !e.hidden && e.getClientRects().length > 0 ? e.textContent : ''; }, sel);
  /** Click the first visible button inside `sel` whose text starts with `label`. Returns false if there is none. */
  page.press = (sel, label) => page.evaluate((s, l) => { const b = [...document.querySelectorAll(`${s} button`)].find((x) => x.textContent.trim().startsWith(l) && !x.disabled && x.getClientRects().length > 0); if (b) b.click(); return !!b; }, sel, label);
  /** Stand at a game's signpost and press E to open it. */
  page.openGame = async (id) => {
    const spot = await page.evaluate(async (g) => (await import('/shared/minigames.ts')).GAME_SPOTS[g], id);
    await page.tp(spot.x + 0.6, spot.z + 0.9);
    await page.keyboard.press('KeyE');
    await sleep(300);
  };
  pages.push(page);
  return page;
}
/** Print the result, close every browser and exit with the right status. */
export async function done() {
  console.log(errors.length ? errors : 'no page errors');
  console.log(failed || errors.length ? `${failed} FAILED` : 'ALL PASSED');
  for (const p of pages) await p.owner.close();
  process.exit(failed || errors.length ? 1 : 0);
}
