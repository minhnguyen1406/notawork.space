# Party games: how to build one

The room has a small framework for party games. Each game is a handful of files that nothing else
depends on. **Truth or dare (`dare`) is the worked example: read all of its files before writing
anything**, and copy its shape.

## The files of a game with id `<id>`

| File | What goes in it |
|---|---|
| `shared/minigames/<id>.ts` | The rules, as plain functions on a plain state object, plus the view and action types. No browser, server, timer or random-global code: take `now` and a `rnd` function as arguments so tests are repeatable. |
| `worker/src/minigames/<id>.ts` | `export const create: GameFactory`. The server side. It owns the state, validates every action, and sends views. |
| `src/minigames/<id>.ts` | `export const game: ClientGame`. What the browser shows: the panel, and any 3D objects. |
| `src/minigames/<id>.css` | Styles, imported by the file above. **Every selector must start with `.mg-<id>`.** |
| `tests/minigames/<id>.test.ts` | Vitest tests of the rules. |
| `tests/browser/minigames/<id>.mjs` | A two-browser (or more) test using `tests/browser/lib.mjs`. |

Placeholder versions of the server and browser files already exist and are already listed in both
registries. **Replace the placeholders; do not touch the registries or any other file.**

## What the framework gives you

Read these two short files; they are the whole contract:

- `worker/src/minigames/api.ts`: `GameIO` (players with live positions, `send` to one person,
  `broadcast`, `notice`, `emote`, `put`, `nudge`, `resetBall`, `setScore`), `ServerGame`
  (`onAction`, `onLeave`, `onJoin`, `tick` ten times a second, `onEvent` for goals and dishes served).
- `src/minigames/api.ts`: `GameCtx` (`scene`, `avatars`, `myId`, `me`, `send`, `toast`, `panel`,
  `confetti`, `play`, `freeze`, `speed`, `put`) and `ClientGame` (`init`, `onView`, `open`, `frame`,
  `key`, `reset`).

Useful things on a character (`ctx.avatars.get(id)`, class `Avatar` in `src/avatar.ts`): `x`, `z`,
`seat`, `info.name`, `info.id`, `info.color`, `emote(k)`, `act(clip, ms)` (clips include
`attack-melee-right`, `attack-kick-right`, `emote-yes`, `emote-no`, `die`, `jump`), `setBadge(emoji | null)`
for a lasting marker over the head, `setNameHidden(bool)`, `setHearts(n | null)`.

`shared/minigames.ts` has every game's signpost position (`GAME_SPOTS`) and the patches of roof set
aside for games that need space (`GAME_ZONES`). The signpost and its "E — title" prompt are drawn
for you; pressing E there calls your `open()`.

Shared panel styles are in `src/minigames/base.css`: give your panel `mg mg-card mg-<id>` for a
compact card at the bottom of the screen, or `mg mg-sheet mg-<id>` for a large centred sheet, and
use `.mg-status`, `.mg-muted`, `.mg-row`, `.mg-players`, `.mg-chip` (`.me`, `.turn`), `.mg-close`.
Buttons with class `primary` are the orange call-to-action.

## Rules every game must follow

1. **The server decides everything.** Treat `a` in `onAction` as hostile: check types, ranges, whose
   turn it is, and that the player is in the game. Never trust a browser's claim about a score, a
   time or a position; you have real positions from `io.players()`.
2. **Secrets go by `io.send` to one person, never `io.broadcast`.** Write a test that the broadcast
   view does not contain them.
3. **No `setTimeout` or `setInterval` on the server.** Use `tick(now)` and deadlines stored in the
   state. The browser may count a clock down locally from the time left in the last view.
4. **People leave.** `onLeave` must keep the game sane: pass the turn, end the round, or go back to
   the lobby. A game must never be stuck waiting for someone who has gone. Also give every turn or
   phase a time limit so an idle player cannot freeze it.
5. **People arrive.** `onJoin` sends a newcomer the current public view if a game is going.
6. **`key()` must return false unless your panel is showing and the player is taking part.** It is
   called for every key press in the room; swallowing keys breaks walking and chat. Keys typed in
   an `<input>` never reach it.
7. **`reset()`** (called after a reconnect) clears everything the browser remembers, hides the
   panel, removes badges, and undoes `freeze` and `speed`.
8. Always undo `ctx.freeze(true)` and `ctx.speed(...)` when the game ends or the player leaves it.
9. 3D objects you add: set `userData.walkThrough = true` on anything people should be able to walk
   through (rings on the floor, markers).
10. Works for the numbers of players in your brief; says clearly in the panel how many are needed.
11. Original content only: your own words, questions and prompts in plain English (Vietnamese game
    names are fine). No names, artwork or text from commercial games.
12. Comments say why, briefly. Match the style of the `dare` files.

## Testing

- Rules: `npx vitest run tests/minigames/<id>.test.ts`. Cover turn order, scoring, time-outs,
  leaving mid-game, invalid actions, and secrecy.
- Types: `npx tsc --noEmit` and `npx tsc -p worker --noEmit`. Other games are being written in this
  repository at the same time, so you may see errors in files that are not yours: ignore those, fix
  every error in your own files.
- Browser test: write `tests/browser/minigames/<id>.mjs` in the style of `dare.mjs`, using
  `open`, `check`, `until`, `sleep`, `done` and the page helpers (`openGame`, `press`, `text`, `tp`,
  `pos`, `id`) from `tests/browser/lib.mjs`. **Write it but do not run it**: the shared development
  server restarts whenever anyone edits a server file, so browser runs are done later, one at a time.
