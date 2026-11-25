# Add-on features: how to build one

Small features that sit on top of the room (touch controls, sound, the minimap, photo mode, the
screenshare quality switch) each live in one file here, `src/features/<name>.ts`, plus an optional
`src/features/<name>.css` imported from it, and export `const feature: Feature`.

`src/features/api.ts` is the whole contract: read it. `FeatureCtx` gives you the scene, camera,
canvas, everyone's characters, the held-keys set, `press(code)` to act as a key press, `talk`,
`look` to move the camera, `prompt()`, `toast`, the HUD and top-bar elements to add your own
controls to, `on(listener)` for things that happen in the room, `setUiHidden`, `capture()` and a
small `store` for settings. Placeholders already exist and are already listed in
`src/features/registry.ts`: replace your placeholder; do not touch the registry.

Rules:
1. Every CSS selector you add starts with `.ft-<name>`; give your elements those classes.
2. `key()` returns true only for a key you actually used. It is called for every key press in the
   room, so swallowing others breaks walking and chat. Keys typed in an `<input>` never reach it.
3. Never break the room: wrap risky browser features (audio, fullscreen, clipboard, storage) in
   try/catch and carry on without them.
4. Do not change how anything works for a desktop keyboard-and-mouse player unless your brief says so.
5. Comments say why, briefly. Match the style of the rest of `src/`.
6. A feature is browser-only. If you find you need the server, stop and say so in your report.
