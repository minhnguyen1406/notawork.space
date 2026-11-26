// Phone and tablet controls, in one desktop browser that is then touched. Needs `npm run dev`. Run: node tests/browser/touch.mjs
import { check, done, open, sleep, until } from './lib.mjs';

const a = await open('Ann');
// Not offsetParent: that is always null for a position: fixed element, shown or not.
const shown = (sel) => a.evaluate((s) => { const e = document.querySelector(s); return !!e && e.getClientRects().length > 0; }, sel);
/** Send a made-up finger event to the middle of `sel`, moved by (dx, dy) as a share of its half-width. */
const finger = (type, sel, dx = 0, dy = 0, id = 7) =>
  a.evaluate((t, s, x, y, pointerId) => {
    const e = document.querySelector(s);
    const r = e.getBoundingClientRect();
    e.dispatchEvent(new PointerEvent(t, { pointerId, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true, button: 0, clientX: r.left + r.width / 2 + (x * r.width) / 2, clientY: r.top + r.height / 2 + (y * r.width) / 2 }));
  }, type, sel, dx, dy, id);
const moved = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
/** Where the player is once they have stopped. */
const settle = async () => {
  let p = await a.pos();
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    const q = await a.pos();
    if (moved(p, q) < 0.01) return q;
    p = q;
  }
  return p;
};
/** What the Use button should say for the prompt on screen now. */
const expected = () =>
  a.evaluate(() => {
    const p = document.querySelector('#prompt');
    const m = p.hidden ? null : p.textContent.split(' · ').map((x) => /^[EG] — (.+)$/.exec(x)).find(Boolean);
    return m ? m[1][0].toUpperCase() + m[1].slice(1) : 'Use';
  });
const useLabel = () => a.text('.ft-touch-use');

// A mouse-and-keyboard player sees nothing new.
await a.tp(0, 10);
check('no touch controls on a desktop', !(await a.evaluate(() => document.querySelector('[class^="ft-touch"]'))) && !(await a.evaluate(() => document.body.classList.contains('ft-touch-on'))));
check('the key hints still show on a desktop', await shown('#help'));
const start = await settle();
await a.keyboard.down('KeyW');
await sleep(500);
await a.keyboard.up('KeyW');
check('the keyboard still walks', moved(start, await settle()) > 0.5);

// The first touch brings the controls out.
await a.evaluate(() => window.dispatchEvent(new Event('touchstart')));
check('a touch shows the joystick and the buttons', (await shown('.ft-touch-stick')) && (await shown('.ft-touch-use')) && (await shown('.ft-touch-kick')));
check('and hides the key hints', !(await shown('#help')));

// Joystick.
await a.tp(0, 10);
const p0 = await settle();
await finger('pointerdown', '.ft-touch-stick');
await sleep(300);
check('a finger resting on the middle does not walk', moved(p0, await a.pos()) < 0.05);
/** Metres a second over the next 400ms. */
const speed = async () => {
  await sleep(200);
  const [from, t] = [await a.pos(), Date.now()];
  await sleep(400);
  return moved(from, await a.pos()) / ((Date.now() - t) / 1000);
};
await finger('pointermove', '.ft-touch-stick', 0, -0.6);
const walking = await speed();
check('pushing the joystick walks', walking > 2 && moved(p0, await a.pos()) > 0.8);
await a.tp(0, 10); // back to open ground, thumb still down
await finger('pointermove', '.ft-touch-stick', 0, -1);
check('pushed to the edge it shows running', await a.evaluate(() => document.querySelector('.ft-touch-stick').classList.contains('ft-touch-run')));
check('and runs faster than it walked', (await speed()) > walking * 1.2);
await finger('pointerup', '.ft-touch-stick', 0, -1);
const p2 = await settle();
await sleep(600);
check('letting go stops', moved(p2, await a.pos()) < 0.02);
await finger('pointerdown', '.ft-touch-stick');
await finger('pointermove', '.ft-touch-stick', 0.7, 0.7);
await sleep(600);
await finger('pointercancel', '.ft-touch-stick');
const p3 = await settle();
check('a diagonal push walks too, and a cancelled touch stops', moved(p2, p3) > 0.5);

// The Use button says what the prompt says.
const spot = await a.evaluate(async () => (await import('/shared/minigames.ts')).GAME_SPOTS.dare);
await a.tp(spot.x + 0.6, spot.z + 0.9);
check('Use takes its label from the prompt', await until(async () => (await useLabel()) === spot.title && (await useLabel()) === (await expected())));
check('and is lit when there is something to use', !(await a.evaluate(() => document.querySelector('.ft-touch-use').classList.contains('ft-touch-dim'))));
await finger('pointerdown', '.ft-touch-use');
await finger('pointerup', '.ft-touch-use');
check('tapping Use does what E does', await until(async () => (await a.text('.mg-dare h2')) === 'Truth or dare'));
await a.keyboard.press('Escape');
await a.tp(0, 10);
check('the label changes when the prompt does', await until(async () => (await useLabel()) !== spot.title && (await useLabel()) === (await expected())));
check('with no prompt it is dimmed', (await a.text('#prompt')) !== '' || (await a.evaluate(() => document.querySelector('.ft-touch-use').classList.contains('ft-touch-dim'))));

// The small row.
check('the reactions are tucked away', !(await shown('.ft-touch-emotes')));
await a.evaluate(() => document.querySelector('.ft-touch-small[aria-label="Reactions"]').click());
check('Reactions opens six emoji and dance', (await shown('.ft-touch-emotes')) && (await a.evaluate(() => document.querySelectorAll('.ft-touch-emote').length)) === 7);
await a.evaluate(() => document.querySelector('.ft-touch-emote').click());
check('picking one closes it', !(await shown('.ft-touch-emotes')));
await a.evaluate(() => document.querySelector('.ft-touch-small[aria-label="Guide"]').click());
check('the guide button opens the guide', await shown('#guide'));
await a.evaluate(() => document.querySelector('#guide-close').click());
await a.evaluate(() => document.querySelector('.ft-touch-small[aria-label="Chat"]').click());
check('the chat button puts the cursor in the chat box', await a.evaluate(() => document.activeElement?.id === 'chat-input'));
await a.evaluate(() => document.activeElement.blur());

// Looking around: a one-finger drag on the picture turns the camera, so "forward" changes direction.
await a.tp(0, 10);
const walk = async () => {
  const from = await settle();
  await finger('pointerdown', '.ft-touch-stick');
  await finger('pointermove', '.ft-touch-stick', 0, -0.6);
  await sleep(600);
  await finger('pointerup', '.ft-touch-stick');
  const to = await settle();
  return Math.atan2(to[0] - from[0], to[1] - from[1]);
};
const before = await walk();
await a.tp(0, 10);
await finger('pointerdown', '.ft-touch-look', 0, 0, 9);
for (let i = 1; i <= 10; i++) await finger('pointermove', '.ft-touch-look', i * 0.05, 0, 9); // about 320px to the right: a quarter turn
await finger('pointerup', '.ft-touch-look', 0.5, 0, 9);
await sleep(1200);
const turn = Math.abs(((await walk()) - before + Math.PI * 3) % (Math.PI * 2) - Math.PI);
check('dragging a finger across the picture turns the view', turn > 0.8);
await done();
