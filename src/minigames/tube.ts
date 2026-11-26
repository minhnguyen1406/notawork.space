import { TUBE_ID, parseTube, type TubeAction, type TubeView } from '../../shared/minigames/tube';
import type { ClientGame, GameCtx } from './api';
import './tube.css';

// ---- the small part of the YouTube IFrame Player API that is used here
interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  loadVideoById(o: { videoId: string; startSeconds?: number }): void;
  cueVideoById(o: { videoId: string; startSeconds?: number }): void;
  setVolume(v: number): void;
  unMute(): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  getVideoData?(): { title?: string; isLive?: boolean } | undefined;
  destroy(): void;
}
interface YTApi {
  Player: new (
    el: HTMLElement,
    o: {
      host: string;
      width: string;
      height: string;
      videoId: string;
      playerVars: Record<string, string | number>;
      events: { onReady(): void; onStateChange(e: { data: number }): void; onError(e: { data: number }): void };
    },
  ) => YTPlayer;
}
type YTWindow = { YT?: Partial<YTApi>; onYouTubeIframeAPIReady?: () => void };
const ENDED = 0;
const PLAYING = 1;
const BUFFERING = 3;

/** How far my player may drift from the room before it is pulled back, in seconds. */
const DRIFT = 1.5;
/** How often the drift is checked. */
const CHECK_MS = 2500;
/** After a correction, give the player this long to buffer before correcting again, or a slow line would seek for ever. */
const SETTLE_MS = 6000;
/** If the video has not started this long after it should have, the browser is probably blocking autoplay. */
const BLOCKED_MS = 3500;
const VOL_KEY = 'mg-tube-vol';

let ctx: GameCtx;
let view: TubeView | null = null;
/** When the current view arrived on my clock: its `pos` was true at that moment. */
let viewAt = 0;
/** The panel only shows for people who opened it. The player window shows for everyone. */
let open = false;
/** Why my last try was refused. */
let err = '';

let player: YTPlayer | null = null;
let ready = false;
/** The video my player was last told to show, and the one it was built for. */
let loaded: string | null = null;
let builtFor: string | null = null;
/** Where a video that is cued but not started will begin. */
let cuedAt = 0;
/** A plain message when YouTube will not play this video here. */
let broken = '';
/** I chose "Hide for me": the window is gone and my copy is paused, for me alone. */
let hiddenByMe = false;
/** The browser would not start the video without a click. */
let blocked = false;
let wantSince = 0;
let lastCheck = 0;
let lastSeek = 0;
let lastPaint = 0;
let title = '';
/** My hand is on the seek bar: don't move it under me. */
let seeking = false;
let volume = 80;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};
const button = (text: string, on: () => void, cls = '') => {
  const b = el('button', cls, text);
  b.type = 'button';
  b.onclick = on;
  return b;
};
const send = (a: TubeAction) => ctx.send(a);
const clock = (s: number) => {
  const t = Math.max(0, Math.floor(s));
  const m = Math.floor(t / 60) % 60;
  const ss = String(t % 60).padStart(2, '0');
  return t >= 3600 ? `${Math.floor(t / 3600)}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};
/** Where the room's video is right now, on my clock. */
const expected = () => (view?.id ? view.pos + (view.playing ? (performance.now() - viewAt) / 1000 : 0) : 0);
/** The player's own calls can throw while its frame is loading or going away; none of that matters to the room. */
const quiet = <T>(fn: () => T, or: T): T => {
  try {
    return fn();
  } catch {
    return or;
  }
};
const duration = () => (player && ready ? quiet(() => player!.getDuration(), 0) || 0 : 0);

// ---- the panel at the signpost (built once, so a view arriving does not wipe a half-typed link)
const ui = {
  status: el('p', 'mg-status'),
  link: el('input', 'mg-tube-link'),
  controls: el('div'),
  toggle: el('button'),
  bar: el('input'),
  at: el('span', '', '0:00'),
  total: el('span', '', '–:––'),
  now: el('li'),
};
let built = false;

function submit() {
  const text = ui.link.value.trim();
  if (!text) return;
  // Checked here for a quick answer; the server checks again and is the one that counts.
  if (!parseTube(text)) {
    err = 'That is not a YouTube link.';
    return render();
  }
  err = '';
  send({ k: 'play', link: text.slice(0, 300) });
  ui.link.value = '';
  render();
}

function build() {
  built = true;
  const p = ctx.panel;
  ui.link.type = 'text';
  ui.link.placeholder = 'Paste a YouTube link';
  ui.link.maxLength = 300;
  ui.link.autocomplete = 'off';
  ui.link.spellcheck = false;
  ui.link.onkeydown = (e) => {
    if (e.key === 'Enter') submit();
  };
  const top = el('div', 'mg-row');
  top.append(ui.link, button('Play', submit, 'primary'));

  ui.toggle.type = 'button';
  ui.toggle.onclick = () => send({ k: view?.playing ? 'pause' : 'resume' });
  const row = el('div', 'mg-row');
  row.append(ui.toggle, button('Stop for everyone', () => send({ k: 'stop' })));

  ui.bar.type = 'range';
  ui.bar.min = '0';
  ui.bar.step = '1';
  ui.bar.oninput = () => {
    seeking = true;
    ui.at.textContent = clock(Number(ui.bar.value));
  };
  ui.bar.onchange = () => {
    seeking = false;
    send({ k: 'seek', t: Number(ui.bar.value) });
  };
  const seek = el('div', 'mg-tube-seek');
  seek.append(ui.at, ui.bar, ui.total);

  const list = el('ul', 'mg-tube-now');
  list.append(ui.now);
  ui.controls.append(row, seek, list);

  const close = button('Close', () => {
    open = false;
    render();
  }, 'mg-close');
  p.replaceChildren(close, el('h2', '', 'Play a video'), el('p', 'mg-muted', 'Everyone in the room watches it together.'), ui.status, top, ui.controls);
}

function render() {
  const p = ctx.panel;
  if (!open) {
    p.hidden = true;
    return;
  }
  if (!built) build();
  p.className = 'mg mg-card mg-tube';
  const on = !!view?.id;
  ui.status.textContent = err || (!on ? 'Nothing is on. Paste a link to start.' : view!.playing ? 'Playing for everyone.' : 'Paused for everyone.');
  ui.controls.hidden = !on;
  if (on) {
    ui.toggle.textContent = view!.playing ? 'Pause' : 'Resume';
    const what = el('b', '', title || `Video ${view!.id}`);
    ui.now.replaceChildren(what, ` · started by ${view!.by ?? 'someone'}`);
    paint();
  }
  p.hidden = false;
}

/** The moving parts of the panel: the seek bar and the two times. */
function paint() {
  const dur = duration();
  const at = expected();
  ui.bar.disabled = dur <= 0;
  ui.total.textContent = dur > 0 ? clock(dur) : '–:––';
  if (seeking) return;
  if (dur > 0) {
    ui.bar.max = String(Math.floor(dur));
    ui.bar.value = String(Math.min(dur, at));
  }
  ui.at.textContent = clock(dur > 0 ? Math.min(dur, at) : at);
}

// ---- the floating window
const win = el('div', 'mg-tube-player');
const chip = button('Show video', () => hide(false), 'mg-tube-chip');
const heading = el('span', 'mg-tube-title', 'Video');
const screen = el('div', 'mg-tube-screen');
const over = el('div', 'mg-tube-over');
const size = button('Large', () => {
  const large = win.classList.toggle('large');
  size.textContent = large ? 'Small' : 'Large';
  home();
});
const vol = el('input', 'mg-tube-vol');

/** Back to the top centre (a dragged window could end up off the screen when it grows). */
function home() {
  win.classList.remove('moved');
  win.style.left = win.style.top = '';
}

function buildWindow() {
  win.hidden = chip.hidden = over.hidden = true;
  try {
    const saved = Number(localStorage.getItem(VOL_KEY) ?? '80');
    if (Number.isFinite(saved)) volume = Math.min(100, Math.max(0, saved));
  } catch {
    /* private window: keep the default */
  }
  vol.type = 'range';
  vol.min = '0';
  vol.max = '100';
  vol.value = String(volume);
  vol.title = 'My volume';
  vol.setAttribute('aria-label', 'My volume');
  vol.oninput = () => {
    volume = Number(vol.value);
    applyVolume();
    try {
      localStorage.setItem(VOL_KEY, String(volume));
    } catch {
      /* not remembered, that is all */
    }
  };
  const bar = el('div', 'mg-tube-bar');
  bar.append(heading, vol, size, button('Hide for me', () => hide(true)));
  screen.append(over);
  win.append(bar, screen);

  // Drag by the title bar. The buttons and the slider on it keep working as themselves.
  let grab: { dx: number; dy: number } | null = null;
  bar.onpointerdown = (e) => {
    if ((e.target as HTMLElement).closest('button, input')) return;
    const r = win.getBoundingClientRect();
    grab = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    bar.setPointerCapture(e.pointerId);
    win.classList.add('dragging');
  };
  bar.onpointermove = (e) => {
    if (!grab) return;
    const box = (win.offsetParent ?? document.body).getBoundingClientRect();
    const r = win.getBoundingClientRect();
    const x = Math.min(Math.max(0, e.clientX - grab.dx - box.left), Math.max(0, box.width - r.width));
    const y = Math.min(Math.max(0, e.clientY - grab.dy - box.top), Math.max(0, box.height - 40));
    win.classList.add('moved');
    win.style.left = `${x}px`;
    win.style.top = `${y}px`;
  };
  bar.onpointerup = bar.onpointercancel = () => {
    grab = null;
    win.classList.remove('dragging');
  };
  (ctx.panel.parentElement ?? document.body).append(win, chip);
}

function applyVolume() {
  if (!player || !ready) return;
  quiet(() => {
    player!.setVolume(volume);
    if (volume > 0) player!.unMute();
  }, undefined);
}

/** What lies over the picture: nothing, a plain message, or the button that gets round blocked autoplay. */
function cover() {
  if (broken) over.replaceChildren(el('p', '', broken));
  else if (blocked)
    over.replaceChildren(
      button('Click to start the video', () => {
        blocked = false;
        wantSince = performance.now();
        quiet(() => player?.playVideo(), undefined);
        applyVolume();
        cover();
      }, 'primary'),
    );
  over.hidden = !broken && !blocked;
}

/** "Hide for me" and back. Nobody else is told. */
function hide(on: boolean) {
  hiddenByMe = on;
  if (on) quiet(() => player?.pauseVideo(), undefined);
  wantSince = performance.now();
  showWindow();
  if (!on) sync(true);
}

function showWindow() {
  const on = !!view?.id;
  win.hidden = !on || hiddenByMe;
  chip.hidden = !on || !hiddenByMe;
  // For anyone looking from outside (and the browser test): what this window is showing.
  if (on) {
    win.dataset.id = view!.id!;
    win.dataset.playing = String(view!.playing);
  } else {
    delete win.dataset.id;
    delete win.dataset.playing;
  }
  heading.textContent = title || 'Video';
}

let api: Promise<YTApi> | null = null;
/** Fetch YouTube's player script, once. */
function loadApi(): Promise<YTApi> {
  return (api ??= new Promise<YTApi>((done, fail) => {
    const w = window as unknown as YTWindow;
    if (w.YT?.Player) return done(w.YT as YTApi);
    const before = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => {
      before?.();
      done(w.YT as YTApi);
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.async = true;
    s.onerror = () => {
      api = null; // let the next video try again
      fail(new Error('YouTube did not load'));
    };
    document.head.append(s);
  }));
}

/** Point my player at the room's video, making the player if there is none yet. */
function load(id: string) {
  loaded = id;
  broken = '';
  blocked = false;
  title = '';
  wantSince = lastSeek = performance.now();
  cover();
  if (player) {
    // One still being made catches up in onReady.
    if (!ready) return;
    cuedAt = expected();
    const o = { videoId: id, startSeconds: cuedAt };
    quiet(() => (view?.playing && !hiddenByMe ? player!.loadVideoById(o) : player!.cueVideoById(o)), undefined);
    return;
  }
  if (screen.querySelector('.mg-tube-frame')) return; // the script is on its way
  const frame = el('div', 'mg-tube-frame');
  screen.prepend(frame);
  loadApi().then(
    (YT) => {
      // The video may have been stopped or swapped while the script was loading.
      if (!frame.isConnected || !loaded || player) return;
      builtFor = loaded;
      cuedAt = Math.floor(expected());
      wantSince = lastSeek = performance.now();
      player = new YT.Player(frame, {
        host: 'https://www.youtube-nocookie.com',
        width: '100%',
        height: '100%',
        videoId: loaded,
        // No controls of YouTube's own: the room's buttons are the controls.
        playerVars: { autoplay: view?.playing && !hiddenByMe ? 1 : 0, controls: 0, disablekb: 1, fs: 0, rel: 0, playsinline: 1, iv_load_policy: 3, start: cuedAt, origin: location.origin },
        events: {
          onReady() {
            ready = true;
            applyVolume();
            wantSince = performance.now();
            if (view?.id && view.id !== builtFor) load(view.id);
            else sync(true);
          },
          onStateChange(e) {
            if (e.data === PLAYING) {
              blocked = false;
              cover();
              title = quiet(() => player?.getVideoData?.()?.title, undefined) || title;
              showWindow();
              render();
              // Started when the room is paused (seeking a cued video does that), or while I have it hidden.
              if (!view?.playing || hiddenByMe) quiet(() => player?.pauseVideo(), undefined);
            }
            // A pause clicked inside the frame is deliberately not sent anywhere: the next check undoes it.
          },
          onError(e) {
            // The server is told nothing: the video may play perfectly well for everyone else.
            broken = e.data === 101 || e.data === 150 ? 'The owner of this video does not allow it to be played here.' : e.data === 100 ? 'This video is unavailable.' : 'This video cannot be played here.';
            cover();
          },
        },
      });
    },
    () => {
      frame.remove();
      broken = 'YouTube could not be reached from this browser.';
      cover();
    },
  );
}

/** Nothing is on: take the player away altogether. */
function unload() {
  if (player) quiet(() => player!.destroy(), undefined);
  player = null;
  ready = false;
  loaded = builtFor = null;
  broken = title = '';
  blocked = hiddenByMe = seeking = false;
  for (const f of screen.querySelectorAll('.mg-tube-frame, iframe')) f.remove();
  cover();
}

/** Bring my player into step with the room. `now` means a view just arrived, so don't wait for it to settle. */
function sync(now = false) {
  const t = performance.now();
  lastCheck = t;
  if (!view?.id || !player || !ready || broken || hiddenByMe || loaded !== view.id) return;
  const p = player;
  const want = expected();
  const st = quiet(() => p.getPlayerState(), -1);
  const dur = duration();
  const going = st === PLAYING || st === BUFFERING;
  // A live stream has no fixed timeline to seek on: only play and pause are mirrored.
  const live = !!quiet(() => p.getVideoData?.()?.isLive, false);
  // It ran to the end and the room's clock is past the end: leave it resting there.
  if (st === ENDED && dur > 0 && want >= dur - DRIFT) return;
  const off = Math.abs(quiet(() => p.getCurrentTime(), 0) - want);
  const settled = now || t - lastSeek > SETTLE_MS;

  if (view.playing) {
    if (!going) {
      quiet(() => p.playVideo(), undefined);
      if (t - wantSince > BLOCKED_MS && !blocked) {
        blocked = true;
        cover();
      }
    }
    if (!live && off > DRIFT && settled && (now || st !== BUFFERING)) {
      lastSeek = t;
      quiet(() => p.seekTo(want, true), undefined);
    }
  } else {
    if (blocked) {
      blocked = false;
      cover();
    }
    if (going) quiet(() => p.pauseVideo(), undefined);
    if (live || !settled) return;
    if (st === PLAYING || st === BUFFERING || st === 2 || st === ENDED) {
      if (off > DRIFT) {
        lastSeek = t;
        quiet(() => p.seekTo(want, true), undefined);
      }
    } else if (Math.abs(cuedAt - want) > DRIFT) {
      // Not started yet: seeking would start it, so cue it again at the new place instead.
      cuedAt = want;
      lastSeek = t;
      quiet(() => p.cueVideoById({ videoId: view!.id!, startSeconds: want }), undefined);
    }
  }
}

export const game: ClientGame = {
  init(c) {
    ctx = c;
    buildWindow();
  },
  onView(raw) {
    const v = raw as TubeView;
    const before = view;
    // Belt and braces: only ever hand YouTube something that looks like one of its ids.
    const id = typeof v?.id === 'string' && TUBE_ID.test(v.id) ? v.id : null;
    view = { id, playing: !!id && !!v.playing, pos: id && Number.isFinite(v.pos) ? Math.max(0, Number(v.pos)) : 0, by: typeof v?.by === 'string' ? v.by : null };
    viewAt = performance.now();
    err = v?.err === 'link' ? 'That is not a YouTube link.' : v?.err === 'slow' ? 'Slow down a moment, then try again.' : '';
    if (!id) unload();
    else {
      if (id !== loaded) {
        // Something new is on: it shows again even for someone who hid the last one.
        hiddenByMe = false;
        load(id);
      }
      if (view.playing && !before?.playing) wantSince = viewAt;
      sync(true);
    }
    showWindow();
    render();
  },
  open() {
    open = true;
    render();
    ui.link.focus();
  },
  frame() {
    const t = performance.now();
    if (view?.id && t - lastCheck > CHECK_MS) sync();
    if (open && view?.id && t - lastPaint > 250) {
      lastPaint = t;
      paint();
    }
  },
  key(code) {
    // Only Escape, and only to close my own panel. Everything else is the room's.
    if (code === 'Escape' && open && !ctx.panel.hidden) {
      open = false;
      render();
      return true;
    }
    return false;
  },
  reset() {
    view = null;
    open = false;
    err = '';
    unload();
    showWindow();
    render();
  },
};
