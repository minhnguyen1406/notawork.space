// Pictures for judging the games by eye: the row of signposts, then each game's panel after joining.
// Needs `npm run dev`. Run: node tests/browser/minigames/look.mjs <out dir> [ids...]
import { open, sleep, done } from '../lib.mjs';

const [out, ...only] = process.argv.slice(2);
const ids = only.length ? only : ['dare', 'draw', 'trivia', 'tag', 'hide', 'sumo', 'cup', 'obstacle', 'dice', 'tienlen', 'baucua', 'words', 'cookoff'];
const a = await open('Minh');
const b = await open('Lan');
await sleep(1500);
// The signposts as you see them walking south from the spawn point.
await a.evaluate(() => (window.__debug.tp(-2, 13), window.__debug.cam(3.14, 0.3, 9)));
await sleep(1500);
await a.screenshot({ path: `${out}/mg-0-signposts.jpg`, type: 'jpeg', quality: 80 });
for (const id of ids) {
  for (const p of [a, b]) {
    await p.openGame(id);
    await p.press(`.mg-${id}`, 'Join');
    await sleep(400);
  }
  // Start whatever can be started with two people, so the picture shows the game itself.
  for (const label of ['Start', 'Deal', 'Kick off', 'Spin', 'Run']) if (await a.press(`.mg-${id}`, label)) break;
  await sleep(4500);
  await a.screenshot({ path: `${out}/mg-${id}.jpg`, type: 'jpeg', quality: 75 });
  for (const p of [a, b]) {
    await p.press(`.mg-${id}`, 'Leave');
    await p.press(`.mg-${id}`, 'Close');
    await p.press(`.mg-${id}`, 'Stop');
    await sleep(300);
  }
  await sleep(600);
}
await done();
