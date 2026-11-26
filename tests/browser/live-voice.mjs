// Voice on the LIVE site: two real (headless) Chrome windows join the public room with Chrome's fake
// microphone, and the room's own info panel (press I) reports the voice state. The room must have
// no password. Run: node tests/browser/live-voice.mjs
import puppeteer from 'puppeteer-core';
const SITE = 'https://minhnguyen1406.github.io/notawork.space/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function open(name) {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    args: ['--use-angle=metal', '--enable-webgl', '--ignore-gpu-blocklist', '--window-size=1280,800', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
    defaultViewport: { width: 1280, height: 800 },
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 160)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 160)));
  await page.goto(SITE, { waitUntil: 'networkidle0' });
  await page.type('#name', name);
  await page.click('#join-button');
  await page.waitForSelector('#hud:not([hidden])', { timeout: 15000 });
  page.owner = browser;
  page.errors = errors;
  return page;
}
const a = await open('(voice test 1)');
const b = await open('(voice test 2)');
await sleep(6000);
for (const p of [a, b]) await p.keyboard.press('KeyI');
await a.keyboard.press('KeyM'); // mic on
await sleep(7000);
for (const [name, p] of [['first', a], ['second', b]]) {
  console.log(`--- ${name} browser`);
  console.log(await p.$eval('#info', (e) => e.textContent));
  console.log('mic button:', await p.$eval('#btn-mic', (e) => (e.hidden ? '(hidden: voice not connected)' : e.textContent)));
  console.log('chat log tail:', (await p.$eval('#chat-log', (e) => e.textContent)).slice(-160));
  if (p.errors.length) console.log('errors:', p.errors.slice(0, 4));
}
await a.evaluate(() => window.__debug?.leaveRoom?.()).catch(() => {});
await b.evaluate(() => window.__debug?.leaveRoom?.()).catch(() => {});
await new Promise((r) => setTimeout(r, 300));
await a.owner.close();
await b.owner.close();
