import { EMOTES, NPC_ID, workWord } from '../../shared/fun';
import { Npc } from './npc';
import { DurableObject } from 'cloudflare:workers';
import {
  COLORS,
  MAX_CHAT,
  MAX_NAME,
  MAX_PLAYERS,
  TICK_HZ,
  type Board,
  type ClientMsg,
  type GamesState,
  type PlayerInfo,
  type ServerMsg,
  LOOKS,
} from '../../shared/protocol';
import { BOUNDS, SEATS, SPAWN, SPOTS, STATIONS } from '../../shared/layout';
import { ballMoving, centreBall, MAX_KICK, stepBall, MAX_LIFT } from '../../shared/ball';
import { Tables } from './tables';
import { actStation, newKitchen, useStation, type KitchenState } from '../../shared/kitchen';

export interface Env {
  ROOM: DurableObjectNamespace<Room>;
  ROOM_PASSWORD?: string;
  LIVEKIT_URL?: string;
  LIVEKIT_API_KEY?: string;
  LIVEKIT_API_SECRET?: string;
  /** Which voice room to use. Local development sets its own, so tests never land in the live call. */
  LIVEKIT_ROOM?: string;
  /** Optional. With a Finnhub key, stock prices come from Finnhub instead of Yahoo's unofficial endpoint. */
  FINNHUB_API_KEY?: string;
}

const LIVEKIT_ROOM = 'main';
const REACH = 3.5; // how close you must be to a station to use it
const STALE_MS = 180_000; // browsers slow a hidden tab's timers to as little as once a minute
const WHEEL_SPIN_MS = 4500;
const WHEEL_MAX_NAMES = 12;
const LAPS_KEPT = 5;
const MIN_LAP_MS = 6000; // nobody can run the loop faster than this

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
      return env.ROOM.get(env.ROOM.idFromName('main')).fetch(req);
    }
    return new Response('notawork.space game server is running');
  },
} satisfies ExportedHandler<Env>;

interface Player extends PlayerInfo {
  ws: WebSocket;
  lastSeen: number;
  lastChat: number;
  lastEmote: number;
}

const clamp = (v: unknown, limit: number) => range(v, -limit, limit);
const range = (v: unknown, lo: number, hi: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : Math.max(lo, Math.min(hi, 0));
const clean = (v: unknown, max: number) =>
  typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '';

/** The whole room lives in one object: who is here, where they are, and the kitchen. */
export class Room extends DurableObject<Env> {
  private players = new Map<WebSocket, Player>();
  private kitchen: KitchenState = newKitchen();
  private timer: ReturnType<typeof setInterval> | null = null;
  private moved = false;
  private ticks = 0;
  private games: GamesState = { ball: centreBall(), score: [0, 0], laps: [] };
  private lastKicker = '';
  /** The built-in Claude character: always in the room, does what people ask in chat. */
  private npc = new Npc({
    people: () => [...this.players.values()].map(publicInfo),
    seatTaken: (seat) => this.everyone().some((p) => p.seat === seat),
    say: (text) => this.npcSay(text),
    emote: (k) => this.broadcast({ t: 'emote', id: NPC_ID, k }),
    sit: (seat) => this.npcSit(seat),
    present: (here) => this.broadcast(here ? { t: 'join', player: this.npc.info } : { t: 'leave', id: NPC_ID }),
  });
  /** Claude's chat lines go out a moment apart, so they read as speech rather than a burst. */
  private npcLines: string[] = [];
  private npcSay(text: string) {
    this.npcLines.push(text.slice(0, MAX_CHAT));
  }
  private npcSit(seat: string | null) {
    const me = this.npc.info;
    const before = me.seat;
    if (seat) {
      const s = SEATS.find((x) => x.id === seat);
      if (!s || this.everyone().some((p) => p.seat === seat)) return;
      Object.assign(me, { seat, x: s.x, z: s.z, ry: s.ry });
      this.moved = true;
    } else me.seat = null;
    this.broadcast({ t: 'sit', id: NPC_ID, seat: me.seat });
    this.tables.seatChanged(me, before);
  }
  /** Real players plus the Claude character, for anything that asks "who is where". */
  private everyone(): PlayerInfo[] {
    return this.npc.here ? [...this.players.values(), this.npc.info] : [...this.players.values()];
  }

  private tables = new Tables({
    sitters: () => this.everyone(),
    send: (id, table, view) => {
      for (const p of this.players.values()) if (p.id === id) this.send(p.ws, { t: 'table', table, view });
    },
    notice: (text) => this.broadcast({ t: 'notice', text }),
    botSay: (text) => this.npcSay(text),
    botEmote: (k) => this.broadcast({ t: 'emote', id: NPC_ID, k }),
  });
  private wheelBusyUntil = 0;
  private board: Board = { news: [], stocks: [], at: 0 };
  private boardBusy = false;
  /** The last time someone mentioned work in chat. */
  private work: { at: number; by: string } | null = null;

  /** Refresh headlines and prices if they are older than ten minutes. */
  private refreshBoard() {
    if (this.boardBusy || Date.now() - this.board.at < BOARD_TTL_MS) return;
    this.boardBusy = true;
    loadBoard(this.env.FINNHUB_API_KEY, this.board)
      .then((board) => {
        this.board = board;
        this.broadcast({ t: 'board', board });
      })
      .catch((err) => console.error('board refresh failed', err))
      .finally(() => (this.boardBusy = false));
  }

  async fetch(): Promise<Response> {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    // A socket that never joins is closed, so idle connections can't pile up.
    setTimeout(() => {
      if (!this.players.has(server)) this.drop(server);
    }, JOIN_TIMEOUT_MS);
    server.addEventListener('message', (e) => {
      this.onMessage(server, e.data).catch((err) => console.error('message failed', err));
    });
    const bye = () => this.drop(server);
    server.addEventListener('close', bye);
    server.addEventListener('error', bye);
    return new Response(null, { status: 101, webSocket: client });
  }

  private send(ws: WebSocket, msg: ServerMsg) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      this.drop(ws);
    }
  }

  private broadcast(msg: ServerMsg, except?: WebSocket) {
    const data = JSON.stringify(msg);
    for (const ws of [...this.players.keys()]) {
      if (ws === except) continue;
      try {
        ws.send(data);
      } catch {
        this.drop(ws);
      }
    }
  }

  private sendKitchen() {
    this.kitchen.now = Date.now();
    this.broadcast({ t: 'kitchen', state: this.kitchen });
  }

  private drop(ws: WebSocket) {
    const p = this.players.get(ws);
    try {
      ws.close();
    } catch {
      /* already closed */
    }
    if (!p) return;
    this.players.delete(ws);
    const wasHolding = this.kitchen.held[p.id];
    delete this.kitchen.held[p.id];
    this.broadcast({ t: 'leave', id: p.id });
    if (wasHolding) this.sendKitchen();
    const seat = p.seat;
    p.seat = null;
    this.tables.seatChanged(p, seat);
    if (this.players.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      // Nobody left: Claude gets up and goes back to the fire for next time.
      if (this.npc.info.seat) this.npcSit(null);
      this.npc.reset();
      this.npcLines.length = 0;
    }
  }

  /** Move the ball in two half-steps per tick and handle goals. */
  private tickBall() {
    const ball = this.games.ball;
    if (!ballMoving(ball)) return;
    const dt = 1 / TICK_HZ / 2;
    const goal = stepBall(ball, dt) ?? stepBall(ball, dt);
    if (goal) {
      // The west goal is Red's, so a ball in it is a goal for Blue.
      this.games.score[goal === 'west' ? 1 : 0]++;
      this.games.ball = centreBall();
      const [red, blue] = this.games.score;
      this.broadcast({ t: 'score', score: this.games.score });
      this.broadcast({ t: 'notice', text: `${this.lastKicker || 'Someone'} scored! Red ${red} – ${blue} Blue` });
    }
    this.broadcast({ t: 'ball', ball: this.games.ball });
  }

  private tick() {
    this.ticks++;
    this.tickBall();
    if (this.npc.tick(1 / TICK_HZ)) this.moved = true;
    if (this.npcLines.length && this.ticks % 8 === 0) {
      this.broadcast({ t: 'chat', id: NPC_ID, name: this.npc.info.name, text: this.npcLines.shift()! });
    }
    if (this.moved) {
      this.moved = false;
      this.broadcast({ t: 'state', players: this.everyone().map((p) => [p.id, p.x, p.z, p.ry]) });
    }
    // Every few seconds, clear out anyone whose connection died without saying so.
    if (this.ticks % (TICK_HZ * 5) === 0) {
      const cutoff = Date.now() - STALE_MS;
      for (const [ws, p] of [...this.players]) if (p.lastSeen < cutoff) this.drop(ws);
      this.refreshBoard();
    }
  }

  private async onMessage(ws: WebSocket, raw: unknown) {
    if (typeof raw !== 'string' || raw.length > 2000) return;
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    const me = this.players.get(ws);
    if (!me) {
      if (msg.t === 'join') await this.join(ws, msg);
      return;
    }
    me.lastSeen = Date.now();

    switch (msg.t) {
      case 'move':
        if (me.seat) return;
        me.x = range(msg.x, BOUNDS.x1, BOUNDS.x2);
        me.z = range(msg.z, BOUNDS.z1, BOUNDS.z2);
        me.ry = clamp(msg.ry, Math.PI * 2);
        this.moved = true;
        break;

      case 'chat': {
        const text = clean(msg.text, MAX_CHAT);
        if (!text || me.lastSeen - me.lastChat < 300) return; // light spam guard
        me.lastChat = me.lastSeen;
        this.broadcast({ t: 'chat', id: me.id, name: me.name, text });
        this.npc.hears(publicInfo(me), text);
        const word = workWord(text);
        if (word) {
          this.work = { at: Date.now(), by: me.name };
          this.broadcast({ t: 'work', by: me.name, word });
        }
        break;
      }

      case 'emote':
        if (!EMOTES.includes(msg.k) || me.lastSeen - me.lastEmote < 250) return;
        me.lastEmote = me.lastSeen;
        this.broadcast({ t: 'emote', id: me.id, k: msg.k });
        break;

      case 'game':
        if (typeof msg.table === 'string') this.tables.action(me, msg.table, msg.a);
        break;

      case 'sit': {
        const before = me.seat;
        if (msg.seat === null) {
          if (!me.seat) return;
          me.seat = null;
        } else {
          const seat = SEATS.find((s) => s.id === msg.seat);
          if (!seat) return;
          if (this.everyone().some((p) => p.seat === seat.id)) return; // taken
          me.seat = seat.id;
          me.x = seat.x;
          me.z = seat.z;
          me.ry = seat.ry;
          this.moved = true;
        }
        this.broadcast({ t: 'sit', id: me.id, seat: me.seat });
        this.tables.seatChanged(me, before);
        break;
      }

      case 'use':
      case 'act': {
        const st = STATIONS.find((s) => s.id === msg.station);
        if (!st || me.seat || Math.hypot(st.x - me.x, st.z - me.z) > REACH) return;
        if (msg.t === 'act') {
          if (actStation(this.kitchen, st)) this.sendKitchen();
          return;
        }
        const result = useStation(this.kitchen, me.id, st, Date.now());
        if (!result.changed) return;
        this.sendKitchen();
        if (result.served) this.broadcast({ t: 'notice', text: `${me.name} served a ${result.served}` });
        break;
      }

      case 'kick': {
        const ball = this.games.ball;
        if (me.seat || Math.hypot(ball.x - me.x, ball.z - me.z) > 3.5) return;
        let vx = clamp(msg.vx, MAX_KICK);
        let vz = clamp(msg.vz, MAX_KICK);
        const speed = Math.hypot(vx, vz);
        if (speed > MAX_KICK) {
          vx *= MAX_KICK / speed;
          vz *= MAX_KICK / speed;
        }
        ball.vx = vx;
        ball.vz = vz;
        // Lift only counts from the ground: no juggling the ball higher and higher.
        if (ball.y < 0.3) ball.vy = range(msg.vy, 0, MAX_LIFT);
        this.lastKicker = me.name;
        this.broadcast({ t: 'ball', ball }, ws);
        break;
      }

      case 'spot': {
        const spot = SPOTS.find((s) => s.id === msg.id);
        if (!spot || me.seat || Math.hypot(spot.x - me.x, spot.z - me.z) > REACH) return;
        if (spot.id === 'score') {
          this.games.score = [0, 0];
          this.games.ball = centreBall();
          this.broadcast({ t: 'score', score: this.games.score });
          this.broadcast({ t: 'ball', ball: this.games.ball });
          this.broadcast({ t: 'notice', text: `${me.name} reset the score` });
        } else if (spot.id === 'wheel') {
          const now = Date.now();
          if (now < this.wheelBusyUntil) return;
          this.wheelBusyUntil = now + WHEEL_SPIN_MS + 1500;
          // Everyone present goes on the wheel (a random dozen if the room is very full).
          const names = [...this.players.values()].map((p) => p.name);
          for (let i = names.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [names[i], names[j]] = [names[j], names[i]];
          }
          names.length = Math.min(names.length, WHEEL_MAX_NAMES);
          const winner = Math.floor(Math.random() * names.length);
          this.broadcast({ t: 'wheel', names, winner });
          setTimeout(
            () => this.broadcast({ t: 'notice', text: `The wheel picked ${names[winner]}!` }),
            WHEEL_SPIN_MS,
          );
        }
        break;
      }

      case 'lap': {
        const ms = typeof msg.ms === 'number' && Number.isFinite(msg.ms) ? Math.round(msg.ms) : 0;
        if (ms < MIN_LAP_MS || ms > 10 * 60_000) return;
        const laps = this.games.laps;
        const record = laps.length === 0 || ms < laps[0].ms;
        const mine = laps.find((l) => l.name === me.name);
        if (!mine) laps.push({ name: me.name, ms });
        else if (ms < mine.ms) mine.ms = ms;
        laps.sort((a, b) => a.ms - b.ms);
        laps.length = Math.min(laps.length, LAPS_KEPT);
        this.broadcast({ t: 'laps', laps });
        this.broadcast({
          t: 'notice',
          text: `${me.name} ran a lap in ${(ms / 1000).toFixed(2)}s${record ? ' — a new record!' : ''}`,
        });
        break;
      }

      case 'ping':
        break;
    }
  }

  /** Sockets part-way through joining, so a second join message can't create a second player. */
  private joining = new Set<WebSocket>();

  private async join(ws: WebSocket, msg: Extract<ClientMsg, { t: 'join' }>) {
    if (this.joining.has(ws)) return;
    const password = this.env.ROOM_PASSWORD;
    if (password && msg.password !== password) {
      this.send(ws, { t: 'denied', reason: 'password' });
      ws.close();
      return;
    }
    if (this.players.size >= MAX_PLAYERS) {
      this.send(ws, { t: 'denied', reason: 'full' });
      ws.close();
      return;
    }

    const me: Player = {
      id: crypto.randomUUID().slice(0, 8),
      name: clean(msg.name, MAX_NAME) || 'Guest',
      color: COLORS.includes(msg.color) ? msg.color : COLORS[0],
      // No choice sent (an older page): pick one at random.
      look: LOOKS.includes(msg.look ?? '') ? msg.look! : LOOKS[Math.floor(Math.random() * LOOKS.length)],
      x: SPAWN.x + (Math.random() - 0.5) * 6,
      z: SPAWN.z + Math.random() * 3,
      ry: Math.PI,
      seat: null,
      ws,
      lastSeen: Date.now(),
      lastChat: 0,
      lastEmote: 0,
    };

    let media: { url: string; token: string } | null = null;
    const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = this.env;
    if (LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET) {
      this.joining.add(ws);
      try {
        media = { url: LIVEKIT_URL, token: await livekitToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, this.env.LIVEKIT_ROOM || LIVEKIT_ROOM, me.id, me.name) };
      } finally {
        this.joining.delete(ws);
      }
      // The socket may have closed, or the room filled, while the token was being signed.
      if (ws.readyState !== WebSocket.OPEN || this.players.size >= MAX_PLAYERS) {
        this.drop(ws);
        return;
      }
    }

    this.players.set(ws, me);
    this.kitchen.now = Date.now();
    this.send(ws, {
      t: 'welcome',
      id: me.id,
      players: this.everyone().map(publicInfo),
      kitchen: this.kitchen,
      board: this.board,
      games: this.games,
      media,
      work: this.work && { ago: Date.now() - this.work.at, by: this.work.by },
    });
    this.refreshBoard();
    this.broadcast({ t: 'join', player: publicInfo(me) }, ws);
    this.npc.greet(me.name, Date.now());
    this.timer ??= setInterval(() => this.tick(), 1000 / TICK_HZ);
  }
}

const publicInfo = ({ id, name, color, look, x, z, ry, seat }: PlayerInfo): PlayerInfo => ({ id, name, color, look, x, z, ry, seat });

// --- LiveKit access token: a short-lived HS256 JWT, signed here so the secret never reaches browsers.

const b64url = (bytes: Uint8Array) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

async function livekitToken(apiKey: string, apiSecret: string, room: string, identity: string, name: string): Promise<string> {
  const text = new TextEncoder();
  const now = Math.floor(Date.now() / 1000);
  const part = (o: unknown) => b64url(text.encode(JSON.stringify(o)));
  const body =
    part({ alg: 'HS256', typ: 'JWT' }) +
    '.' +
    part({
      iss: apiKey,
      sub: identity,
      name,
      nbf: now - 10,
      exp: now + 6 * 3600,
      video: { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true },
    });
  const k = await crypto.subtle.importKey('raw', text.encode(apiSecret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, text.encode(body)));
  return body + '.' + b64url(sig);
}

// --- Billboard data: headlines from RSS feeds, prices from a quote API. No keys needed by default.

const BOARD_TTL_MS = 10 * 60_000;
const JOIN_TIMEOUT_MS = 15_000;
const FETCH_TIMEOUT_MS = 8000;
const FEEDS = [
  { src: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { src: 'VnExpress', url: 'https://e.vnexpress.net/rss/news.rss' },
];
const HEADLINES_PER_FEED = 6;
const SYMBOLS: { sym: string; label: string }[] = [
  { sym: '^GSPC', label: 'S&P 500' },
  { sym: '^IXIC', label: 'NASDAQ' },
  { sym: 'AAPL', label: 'AAPL' },
  { sym: 'NVDA', label: 'NVDA' },
  { sym: 'MSFT', label: 'MSFT' },
  { sym: 'GOOGL', label: 'GOOGL' },
  { sym: 'AMZN', label: 'AMZN' },
  { sym: 'TSLA', label: 'TSLA' },
  { sym: 'META', label: 'META' },
];
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; billboard)' };

const codePoint = (n: number) => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '');
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s: string) =>
  s
    .replace(/&#(x?)([0-9a-f]+);/gi, (_, hex, n) => codePoint(parseInt(n, hex ? 16 : 10)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);

function parseTitles(xml: string, max: number): string[] {
  const out: string[] = [];
  const re = /<item[\s>][\s\S]*?<title>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/title>/g;
  for (let m = re.exec(xml); m && out.length < max; m = re.exec(xml)) {
    const title = decode(m[1]).replace(/\s+/g, ' ').trim().slice(0, 160);
    if (title) out.push(title);
  }
  return out;
}

async function quote(sym: string, finnhubKey?: string): Promise<{ price: number; pct: number } | null> {
  if (finnhubKey && !sym.startsWith('^')) {
    const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${finnhubKey}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!r.ok) return null;
    const q = (await r.json()) as { c?: number; dp?: number };
    return q.c ? { price: q.c, pct: q.dp ?? 0 } : null;
  }
  const r = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`,
    { headers: UA, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
  );
  if (!r.ok) return null;
  const j = (await r.json()) as {
    chart?: { result?: { meta?: { regularMarketPrice?: number; chartPreviousClose?: number; previousClose?: number } }[] };
  };
  const meta = j.chart?.result?.[0]?.meta;
  const prev = meta?.chartPreviousClose ?? meta?.previousClose;
  if (!meta?.regularMarketPrice || !prev) return null;
  return { price: meta.regularMarketPrice, pct: ((meta.regularMarketPrice - prev) / prev) * 100 };
}

/** Fetch everything; anything that fails keeps its previous value. */
async function loadBoard(finnhubKey: string | undefined, old: Board): Promise<Board> {
  const feeds = await Promise.all(
    FEEDS.map(async (f) => {
      try {
        const r = await fetch(f.url, { headers: UA, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!r.ok) return [];
        return parseTitles(await r.text(), HEADLINES_PER_FEED).map((title) => ({ src: f.src, title }));
      } catch {
        return [];
      }
    }),
  );
  // Alternate between sources so the board doesn't show one feed in a block.
  const news: Board['news'] = [];
  for (let i = 0; i < HEADLINES_PER_FEED; i++) for (const f of feeds) if (f[i]) news.push(f[i]);

  const quotes = await Promise.all(
    SYMBOLS.map(async ({ sym, label }) => {
      try {
        const q = await quote(sym, finnhubKey);
        return q ? { sym: label, price: +q.price.toFixed(2), pct: +q.pct.toFixed(2) } : null;
      } catch {
        return null;
      }
    }),
  );
  const stocks = quotes.filter((q) => q !== null);

  return {
    news: news.length ? news : old.news,
    stocks: stocks.length ? stocks : old.stocks,
    at: Date.now(),
  };
}
