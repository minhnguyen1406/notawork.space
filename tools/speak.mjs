// Send a test character into the live room to say something out loud.
//   node tools/speak.mjs "what to say" [name of the person to walk up to]
// The words are turned into speech by this Mac (`say`), and a headless Chrome plays that recording
// as the character's microphone. It is one-way: the character cannot hear anyone.
import puppeteer from 'puppeteer-core';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const [text = 'Hello from the test character.', who = ''] = process.argv.slice(2);
const SITE = 'https://minhnguyen1406.github.io/notawork.space/';
const NAME = 'Claude (voice)';
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '.claude-bot');
mkdirSync(dir, { recursive: true });
const wav = join(dir, 'speech.wav');
const raw = join(dir, 'speech-raw.wav');
execFileSync('say', ['-o', raw, '--data-format=LEI16@48000', text]);
// macOS adds extra chunks to the file; rewrite it with just the standard header and the sound.
{
  const b = readFileSync(raw);
  let data = null;
  for (let o = 12; o + 8 <= b.length; ) {
    const size = b.readUInt32LE(o + 4);
    if (b.toString('ascii', o, o + 4) === 'data') data = b.subarray(o + 8, o + 8 + size);
    o += 8 + size + (size % 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // plain PCM
  head.writeUInt16LE(1, 22); // one channel
  head.writeUInt32LE(48000, 24);
  head.writeUInt32LE(96000, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  writeFileSync(wav, Buffer.concat([head, data]));
}
const seconds = (statSync(wav).size - 44) / (48000 * 2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
log(`speech is ${seconds.toFixed(1)} s long`);

// Chrome's audio process is sandboxed and cannot read the recording unless that one sandbox is
// switched off (for this throwaway browser only).
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-angle=metal', '--enable-webgl', '--ignore-gpu-blocklist', '--window-size=1280,800', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${wav}%noloop`, '--autoplay-policy=no-user-gesture-required', '--disable-features=AudioServiceSandbox'],
  defaultViewport: { width: 1280, height: 800 },
});
const page = await browser.newPage();
// Keep a copy of what the room server says, so we know where everyone is standing.
await page.evaluateOnNewDocument(() => {
  window.__room = { me: null, people: {} };
  const Real = window.WebSocket;
  window.WebSocket = class extends Real {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', (e) => {
        try {
          const m = JSON.parse(e.data);
          const R = window.__room;
          if (m.t === 'welcome') {
            R.me = m.id;
            for (const p of m.players) R.people[p.id] = { name: p.name, x: p.x, z: p.z };
          } else if (m.t === 'join') R.people[m.player.id] = { name: m.player.name, x: m.player.x, z: m.player.z };
          else if (m.t === 'leave') delete R.people[m.id];
          else if (m.t === 'state') for (const [id, x, z] of m.players) if (R.people[id]) Object.assign(R.people[id], { x, z });
        } catch {}
      });
    }
  };
});
await page.goto(SITE, { waitUntil: 'networkidle0' });
await page.type('#name', NAME);
await page.click('#join-button');
await page.waitForSelector('#hud:not([hidden])', { timeout: 15000 });
await sleep(5000);
const say = async (line) => {
  await page.keyboard.press('Enter');
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
  await sleep(400);
};
const room = () => page.evaluate(() => window.__room);
const pick = (R) => {
  const others = Object.entries(R.people).filter(([id, p]) => id !== R.me && id !== 'claude');
  return (who && others.find(([, p]) => p.name.toLowerCase().includes(who.toLowerCase()))) || others[0] || null;
};

let R = await room();
let target = pick(R);
if (!target) {
  log('nobody else is in the room; leaving');
  await browser.close();
  process.exit(0);
}
log(`walking over to ${target[1].name}`);
await say(`Hi ${target[1].name}! Stay where you are, I'm walking over to say something out loud.`);
// Walk towards them one axis at a time (with the camera as it starts, W is north, S south, A west, D east).
const gapTo = (R, t) => ({ dx: t.x - R.people[R.me].x, dz: t.z - R.people[R.me].z });
let stuck = 0;
for (let i = 0; i < 140; i++) {
  R = await room();
  target = pick(R);
  if (!target) break;
  const { dx, dz } = gapTo(R, target[1]);
  const d = Math.hypot(dx, dz);
  if (d < 2.4) break;
  // Prefer the longer axis; if we made no progress last time, try the other one.
  const alongX = (Math.abs(dx) > Math.abs(dz)) !== (stuck % 2 === 1);
  const key = alongX ? (dx > 0 ? 'KeyD' : 'KeyA') : dz > 0 ? 'KeyS' : 'KeyW';
  await page.keyboard.down(key);
  await sleep(Math.min(700, Math.max(180, (alongX ? Math.abs(dx) : Math.abs(dz)) * 150)));
  await page.keyboard.up(key);
  await sleep(250);
  const after = gapTo(await room(), target[1]);
  stuck = Math.hypot(after.dx, after.dz) > d - 0.2 ? stuck + 1 : 0;
}
R = await room();
target = pick(R);
const { dx, dz } = target ? gapTo(R, target[1]) : { dx: 99, dz: 99 };
const dist = Math.hypot(dx, dz);
log(`now ${dist.toFixed(1)} m from ${target?.[1].name ?? 'nobody'}`);
if (dist > 11) await say("I couldn't get close enough. Come and stand next to me and I'll talk.");
else await say('Speaking now. Listen for a voice.');
await sleep(1500);
await page.keyboard.press('KeyM'); // mic on: Chrome starts playing the recording as the microphone
await sleep(seconds * 1000 + 2500);
await page.keyboard.press('KeyM');
log('mic button after speaking:', await page.$eval('#btn-mic', (e) => (e.hidden ? '(hidden: voice not connected)' : e.textContent)));
await say("That was me talking. I can't hear you, so tell me in the terminal whether you heard it.");
await sleep(6000);
await browser.close();
log('left the room');
