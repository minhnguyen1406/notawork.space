// Photo mode with one browser. Needs `npm run dev`. Run: node tests/browser/photo.mjs
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, done, open, sleep, until } from './lib.mjs';

const page = await open('Ann');
const BAR = '.ft-photo-bar';
// lib's page.text() goes by offsetParent, which is always null for a position: fixed element, so read these directly.
const text = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return e && e.getClientRects().length > 0 ? e.textContent : ''; }, sel);
// SHOTS=dir saves pictures of photo mode and of the countdown there.
const shot = async (name) => { if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, name) }); };
const shown = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0; }, sel);

// Real downloads go to a folder of our own, and the page also notes every download link it clicks.
const dir = mkdtempSync(join(tmpdir(), 'notawork-photo-'));
const cdp = await page.createCDPSession();
const browserCdp = await page.owner.target().createCDPSession();
await browserCdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, eventsEnabled: true });
await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dir }).catch(() => {});
const begun = [];
let completed = 0;
browserCdp.on('Browser.downloadWillBegin', (e) => begun.push(e.suggestedFilename));
browserCdp.on('Browser.downloadProgress', (e) => { if (e.state === 'completed') completed++; });
await page.evaluate(() => {
  window.__clicked = [];
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.hasAttribute('download')) window.__clicked.push({ name: this.download, href: this.href });
    return click.call(this);
  };
});
const clicked = () => page.evaluate(() => window.__clicked);
const NAME = /^notawork-\d{4}-\d{2}-\d{2}-\d{6}\.png$/;

check('the top bar has a camera button', await shown('.ft-photo-open'));
check('the photo bar is hidden to begin with', !(await shown(BAR)));

await page.keyboard.press('KeyP');
check('P hides the interface', await until(async () => !(await shown('#hud'))));
check('and shows the photo bar', await shown(BAR));
check('with Take photo, the timer and Done', (await text(BAR)) === 'Take photo3s timerDone');
await shot('photo-mode.png');

// Walking still works with the interface hidden.
const before = await page.pos();
await page.keyboard.down('KeyD');
await sleep(1200);
await page.keyboard.up('KeyD');
const after = await page.pos();
check(`you can still walk in photo mode (${Math.hypot(after[0] - before[0], after[1] - before[1]).toFixed(1)} m)`, Math.hypot(after[0] - before[0], after[1] - before[1]) > 1);
check('and walking does not leave photo mode', await shown(BAR));

// Space takes a photo and saves it.
await page.keyboard.press('Space');
check('Space clicks a download link', await until(async () => (await clicked()).length === 1));
const first = (await clicked())[0];
check(`the file is named notawork-YYYY-MM-DD-HHMMSS.png (${first?.name})`, NAME.test(first?.name ?? ''));
check('the browser starts a download of that name', await until(() => begun.length === 1 && begun[0] === first.name));
check('the download finishes', await until(() => completed === 1));
const file = readdirSync(dir).find((f) => f.endsWith('.png'));
const bytes = file ? readFileSync(join(dir, file)) : Buffer.alloc(0);
check(`the saved file is a PNG with a picture in it (${bytes.length} bytes)`, bytes.length > 2000 && bytes.subarray(1, 4).toString() === 'PNG');
check('a thumbnail of the photo appears', await until(() => shown('.ft-photo-preview .ft-photo-thumb')));
check('the bar is back after the capture', await shown(BAR));
check('still in photo mode', !(await shown('#hud')));

// The button and Enter do the same.
await page.press(BAR, 'Take photo');
check('the Take photo button saves a second photo', await until(async () => (await clicked()).length === 2));
await page.keyboard.press('Enter');
check('Enter saves a third', await until(async () => (await clicked()).length === 3));
check('Enter did not open the chat box', await page.evaluate(() => document.activeElement?.id !== 'chat-input'));

// The timer counts down from 3 before the photo is taken.
await page.press(BAR, '3s timer');
check('the timer button switches on', await page.evaluate(() => document.querySelector('.ft-photo-timer').classList.contains('on')));
await page.keyboard.press('Space');
check('a big 3 appears', await until(async () => (await text('.ft-photo-count')) === '3', 1000));
await shot('photo-count.png');
check('no photo yet', (await clicked()).length === 3);
check('it counts down', await until(async () => (await text('.ft-photo-count')) === '1', 3000));
check('then takes the photo', await until(async () => (await clicked()).length === 4, 3000));
check('and the number goes away', (await text('.ft-photo-count')) === '');

// Leaving in the middle of a countdown calls it off.
await page.keyboard.press('Space');
await sleep(500);
await page.keyboard.press('Escape');
check('Escape restores the interface', await until(() => shown('#hud')));
check('and hides the photo bar', !(await shown(BAR)));
await sleep(3500);
check('a countdown under way when you leave takes no photo', (await clicked()).length === 4);
await page.keyboard.press('Space');
await sleep(400);
check('Space takes no photo outside photo mode', (await clicked()).length === 4);

// The camera button and Done, and P to leave.
await page.click('.ft-photo-open');
check('the camera button enters photo mode', await until(async () => (await shown(BAR)) && !(await shown('#hud'))));
check('the timer choice is remembered', await page.evaluate(() => document.querySelector('.ft-photo-timer').classList.contains('on')));
await page.press(BAR, '3s timer');
await page.press(BAR, 'Done');
check('Done restores the interface', await until(async () => (await shown('#hud')) && !(await shown(BAR))));
await page.keyboard.press('KeyP');
await until(() => shown(BAR));
await page.keyboard.press('KeyP');
check('P leaves photo mode too', await until(async () => (await shown('#hud')) && !(await shown(BAR))));

// P typed into the chat box is just a letter.
await page.focus('#chat-input');
await page.keyboard.type('p');
check('P in the chat box does not enter photo mode', !(await shown(BAR)) && (await shown('#hud')));
await page.evaluate(() => { const i = document.querySelector('#chat-input'); i.value = ''; i.blur(); });

// A dropped connection must not leave the interface hidden.
await page.keyboard.press('KeyP');
await until(() => shown(BAR));
await page.evaluate(() => window.__debug.dropRoom());
check('losing the connection leaves photo mode', await until(async () => !(await shown(BAR)) && !(await page.evaluate(() => document.body.classList.contains('ui-hidden')))));

rmSync(dir, { recursive: true, force: true });
await done();
