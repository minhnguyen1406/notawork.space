import { DurableObject } from 'cloudflare:workers';
import {
  COLORS,
  MAX_CHAT,
  MAX_NAME,
  MAX_PLAYERS,
  ROOM_HALF,
  TICK_HZ,
  type Board,
  type ClientMsg,
  type PlayerInfo,
  type ServerMsg,
} from '../../shared/protocol';
import { SEATS, SPAWN, STATIONS } from '../../shared/layout';
import { actStation, newKitchen, useStation, type KitchenState } from '../../shared/kitchen';

export interface Env {
  ROOM: DurableObjectNamespace<Room>;
  ROOM_PASSWORD?: string;
  LIVEKIT_URL?: string;
  LIVEKIT_API_KEY?: string;
  LIVEKIT_API_SECRET?: string;
  /** Optional. With a Finnhub key, stock prices come from Finnhub instead of Yahoo's unofficial endpoint. */
  FINNHUB_API_KEY?: string;
}

const LIVEKIT_ROOM = 'main';
const REACH = 3.5; // how close you must be to a station to use it
const STALE_MS = 60_000;

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
}

const clamp = (v: unknown, limit: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(-limit, Math.min(limit, v)) : 0;
const clean = (v: unknown, max: number) =>
  typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '';

/** The whole room lives in one object: who is here, where they are, and the kitchen. */
export class Room extends DurableObject<Env> {
  private players = new Map<WebSocket, Player>();
  private kitchen: KitchenState = newKitchen();
  private timer: ReturnType<typeof setInterval> | null = null;
  private moved = false;
  private ticks = 0;
  private board: Board = { news: [], stocks: [], at: 0 };
  private boardBusy = false;

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
    if (this.players.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick() {
    this.ticks++;
    if (this.moved) {
      this.moved = false;
      this.broadcast({ t: 'state', players: [...this.players.values()].map((p) => [p.id, p.x, p.z, p.ry]) });
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
        me.x = clamp(msg.x, ROOM_HALF);
        me.z = clamp(msg.z, ROOM_HALF);
        me.ry = clamp(msg.ry, Math.PI * 2);
        this.moved = true;
        break;

      case 'chat': {
        const text = clean(msg.text, MAX_CHAT);
        if (!text || me.lastSeen - me.lastChat < 300) return; // light spam guard
        me.lastChat = me.lastSeen;
        this.broadcast({ t: 'chat', id: me.id, name: me.name, text });
        break;
      }

      case 'sit': {
        if (msg.seat === null) {
          if (!me.seat) return;
          me.seat = null;
        } else {
          const seat = SEATS.find((s) => s.id === msg.seat);
          if (!seat) return;
          for (const p of this.players.values()) if (p.seat === seat.id) return; // taken
          me.seat = seat.id;
          me.x = seat.x;
          me.z = seat.z;
          me.ry = seat.ry;
          this.moved = true;
        }
        this.broadcast({ t: 'sit', id: me.id, seat: me.seat });
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

      case 'ping':
        break;
    }
  }

  private async join(ws: WebSocket, msg: Extract<ClientMsg, { t: 'join' }>) {
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
      x: SPAWN.x + (Math.random() - 0.5) * 6,
      z: SPAWN.z + Math.random() * 3,
      ry: Math.PI,
      seat: null,
      ws,
      lastSeen: Date.now(),
      lastChat: 0,
    };

    let media: { url: string; token: string } | null = null;
    const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = this.env;
    if (LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET) {
      media = { url: LIVEKIT_URL, token: await livekitToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, me.id, me.name) };
    }

    this.players.set(ws, me);
    this.kitchen.now = Date.now();
    this.send(ws, {
      t: 'welcome',
      id: me.id,
      players: [...this.players.values()].map(publicInfo),
      kitchen: this.kitchen,
      board: this.board,
      media,
    });
    this.refreshBoard();
    this.broadcast({ t: 'join', player: publicInfo(me) }, ws);
    this.timer ??= setInterval(() => this.tick(), 1000 / TICK_HZ);
  }
}

const publicInfo = ({ id, name, color, x, z, ry, seat }: Player): PlayerInfo => ({ id, name, color, x, z, ry, seat });

// --- LiveKit access token: a short-lived HS256 JWT, signed here so the secret never reaches browsers.

const b64url = (bytes: Uint8Array) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

async function livekitToken(apiKey: string, apiSecret: string, identity: string, name: string): Promise<string> {
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
      video: { room: LIVEKIT_ROOM, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true },
    });
  const k = await crypto.subtle.importKey('raw', text.encode(apiSecret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, text.encode(body)));
  return body + '.' + b64url(sig);
}

// --- Billboard data: headlines from RSS feeds, prices from a quote API. No keys needed by default.

const BOARD_TTL_MS = 10 * 60_000;
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

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s: string) =>
  s
    .replace(/&#(x?)([0-9a-f]+);/gi, (_, hex, n) => String.fromCodePoint(parseInt(n, hex ? 16 : 10)))
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
    const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${finnhubKey}`);
    if (!r.ok) return null;
    const q = (await r.json()) as { c?: number; dp?: number };
    return q.c ? { price: q.c, pct: q.dp ?? 0 } : null;
  }
  const r = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`,
    { headers: UA },
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
        const r = await fetch(f.url, { headers: UA });
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
