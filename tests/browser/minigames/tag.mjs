// Tag with three browsers. Needs `npm run dev`. Run: node tests/browser/minigames/tag.mjs
import { check, done, open, sleep, until } from '../lib.mjs';

const a = await open('Ann');
const b = await open('Bao');
const c = await open('Chi');
const all = [a, b, c];
const P = '.mg-tag';
const who = `${P} .mg-tag-who`;
/** How far a player gets by holding W for a moment (pos() is [x, z]). */
const walked = async (p, ms) => {
  const [x0, z0] = await p.pos();
  await p.keyboard.down("KeyW");
  await sleep(ms);
  await p.keyboard.up("KeyW");
  const [x1, z1] = await p.pos();
  return Math.hypot(x1 - x0, z1 - z0);
};

await a.openGame('tag');
check('E at the signpost opens the game', (await a.text(`${P} h2`)) === 'Tag');
check('it says how many are needed', (await a.text(`${P} .mg-status`)).includes('Needs 2'));
check('nobody can start alone', (await a.press(P, 'Join')) && !(await a.press(P, 'Start')));
for (const p of [b, c]) {
  await p.openGame('tag');
  await p.press(P, 'Join');
}
check('all three are listed for everyone', await until(async () => (await Promise.all(all.map((p) => p.text(`${P} .mg-players`)))).every((t) => t === 'AnnBaoChi')));

// Spread out well away from each other (and the signposts) before anyone becomes "it".
const home = { x: -6, z: 12 };
await a.tp(home.x - 8, home.z);
await b.tp(home.x, home.z);
await c.tp(home.x + 8, home.z);
check('anyone in the game can start it', await b.press(P, 'Start'));
check('a countdown shows first', await until(async () => (await a.text(who)).includes('Get ready')));
check('then exactly one player is told they are it', await until(async () => (await Promise.all(all.map((p) => p.text(who)))).filter((t) => t.includes('You are it')).length === 1, 8000));
const texts = await Promise.all(all.map((p) => p.text(who)));
const it = all[texts.findIndex((t) => t.includes('You are it'))];
const [prey, far] = all.filter((p) => p !== it);
check('the others see who is it', (await prey.text(who)).includes('is it') && (await far.text(who)).includes('is it'));
check('the panel is a slim line with a running clock', /^[01]:\d\d$/.test(await a.text(`${P} .mg-tag-clock`)) && (await a.evaluate((s) => document.querySelector(s).offsetHeight, P)) < 70);
check('walking keys are not swallowed by the panel', (await walked(far, 500)) > 0.3);

// "It" jumps next to someone: the server notices and passes it on.
const [px, pz] = await prey.pos();
await it.tp(px + 0.8, pz);
check('standing next to someone tags them', await until(async () => (await prey.text(who)).includes('You are it') && (await it.text(who)).includes('is it')));
check('the tagged player is rooted for a moment', (await walked(prey, 600)) < 0.2);
await sleep(1200);
check('and cannot tag straight back while the tagger is safe', (await prey.text(who)).includes('You are it'));
check('after three seconds the tagger can be caught again', await until(async () => (await it.text(who)).includes('You are it'), 6000));
// Now `it` is it again, rooted beside `prey`; get `prey` away before the safe spell ends.
await prey.tp(home.x, home.z + 6);
check('time as it is counted for the player', await until(async () => /You: [1-9]\d*s/.test(await it.text(`${P} .mg-tag-mine`)), 6000));

// "It" leaves the game: someone else is picked.
await it.press(P, 'Leave');
check('if it leaves, one of the others becomes it', await until(async () => [await prey.text(who), await far.text(who)].filter((t) => t.includes('You are it')).length === 1));
check('the leaver no longer has the panel', (await it.text(P)) === '');
// With two left, one more leaving ends the game.
await far.press(P, 'Leave');
check('fewer than two left returns to the lobby', await until(async () => (await prey.text(`${P} .mg-status`)).includes('Needs 2')));
check('and walking is back to normal for the last player', (await walked(prey, 500)) > 0.3);
await done();
