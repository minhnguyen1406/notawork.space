// A listener for checking tools/speak.mjs: joins the live room, stands still, and measures how loud
// the voices it receives are. Run: node tools/listen.mjs [seconds]
import puppeteer from 'puppeteer-core';
const seconds = +(process.argv[2] ?? 70);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-angle=metal', '--enable-webgl', '--ignore-gpu-blocklist', '--window-size=1280,800', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: 1280, height: 800 },
});
const page = await browser.newPage();
await page.goto('https://minhnguyen1406.github.io/notawork.space/', { waitUntil: 'networkidle0' });
await page.type('#name', '(listener)');
await page.click('#join-button');
await page.waitForSelector('#hud:not([hidden])', { timeout: 15000 });
// Measure the level of every voice element the room creates.
await page.evaluate(() => {
  window.__levels = { peak: 0, elements: 0, volume: 0 };
  const ctx = new AudioContext();
  const seen = new WeakSet();
  setInterval(() => {
    const els = [...document.querySelectorAll('audio')];
    window.__levels.elements = els.length;
    for (const el of els) {
      window.__levels.volume = Math.max(window.__levels.volume, el.volume);
      if (seen.has(el) || !el.srcObject) continue;
      seen.add(el);
      const an = ctx.createAnalyser();
      ctx.createMediaStreamSource(el.srcObject).connect(an);
      const buf = new Float32Array(an.fftSize);
      setInterval(() => {
        an.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += v * v;
        window.__levels.peak = Math.max(window.__levels.peak, Math.sqrt(sum / buf.length));
      }, 100);
    }
  }, 300);
});
const shots = process.argv[3]; // optional folder for a picture every five seconds
for (let t = 0; t < seconds; t += 5) {
  await sleep(5000);
  if (shots) await page.screenshot({ path: `${shots}/listener-${String(t + 5).padStart(2, '0')}.jpg`, type: 'jpeg', quality: 80 });
  const l = await page.evaluate(() => window.__levels);
  console.log(`+${t + 5}s voices received: ${l.elements}, loudest so far: ${l.peak.toFixed(3)}, playback volume set to: ${l.volume.toFixed(2)}`);
}
await browser.close();
