import * as THREE from 'three';
import type { Board } from '../shared/protocol';
import { BILLBOARD } from '../shared/layout';

const FONT = 'ui-rounded, system-ui, sans-serif';
const UP = '#5fe08a';
const DOWN = '#ff6b6b';
const HEADLINE_SECONDS = 8;

function canvasTexture(w: number, h: number) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return { ctx: canvas.getContext('2d')!, tex, w, h };
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = lines[maxLines - 1].replace(/.{0,3}$/, '…');
  }
  return lines;
}

const fmtPrice = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (n: number) => `${n >= 0 ? '▲' : '▼'} ${Math.abs(n).toFixed(2)}%`;

/** The scoreboard hanging over the middle of the roof: headlines on two faces, prices on the other two. */
export class Billboard {
  readonly group = new THREE.Group();
  private news = canvasTexture(1024, 576);
  private stocks = canvasTexture(1024, 576);
  private ring = canvasTexture(4096, 128);
  private board: Board = { news: [], stocks: [], at: 0 };
  private shown = -1;

  constructor() {
    const { w, h } = BILLBOARD;
    this.group.position.set(BILLBOARD.x, BILLBOARD.y, BILLBOARD.z);

    const body = new THREE.Mesh(
      new THREE.BoxGeometry(w + 0.3, h + 0.3, w + 0.3),
      new THREE.MeshStandardMaterial({ color: '#17131f', roughness: 0.6 }),
    );
    this.group.add(body);

    const face = (tex: THREE.Texture, ry: number) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex }));
      m.rotation.y = ry;
      m.position.set(Math.sin(ry) * (w / 2 + 0.16), 0, Math.cos(ry) * (w / 2 + 0.16));
      this.group.add(m);
    };
    face(this.news.tex, 0);
    face(this.news.tex, Math.PI);
    face(this.stocks.tex, Math.PI / 2);
    face(this.stocks.tex, -Math.PI / 2);

    // A ticker band running around underneath.
    this.ring.tex.wrapS = THREE.RepeatWrapping;
    const band = new THREE.Mesh(
      new THREE.CylinderGeometry(w * 0.78, w * 0.78, 0.62, 48, 1, true),
      new THREE.MeshBasicMaterial({ map: this.ring.tex, side: THREE.DoubleSide }),
    );
    band.position.y = -h / 2 - 0.75;
    this.group.add(band);

    this.drawNews(0);
    this.drawStocks();
    this.drawRing();
  }

  setBoard(board: Board) {
    this.board = board;
    this.shown = -1;
    this.drawStocks();
    this.drawRing();
  }

  update(time: number) {
    const n = this.board.news.length;
    const index = n ? Math.floor(time / HEADLINE_SECONDS) % n : 0;
    if (index !== this.shown) {
      this.shown = index;
      this.drawNews(index);
    }
    this.ring.tex.offset.x = (time * 0.012) % 1;
  }

  private header(c: { ctx: CanvasRenderingContext2D; w: number; h: number }, title: string, color: string, right: string) {
    const { ctx, w, h } = c;
    ctx.fillStyle = '#0d0b14';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, w, 84);
    ctx.fillStyle = '#0d0b14';
    ctx.font = `800 46px ${FONT}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(title, 32, 44);
    ctx.font = `600 28px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.fillText(right, w - 32, 44);
    ctx.textAlign = 'left';
  }

  private drawNews(index: number) {
    const c = this.news;
    const { ctx, w } = c;
    const item = this.board.news[index];
    this.header(c, 'HEADLINES', '#f3a712', item ? `${index + 1} / ${this.board.news.length}` : '');
    if (!item) {
      ctx.fillStyle = '#b9a998';
      ctx.font = `600 44px ${FONT}`;
      ctx.fillText('Fetching the news…', 40, 300);
    } else {
      ctx.fillStyle = '#f3a712';
      ctx.font = `700 34px ${FONT}`;
      ctx.fillText(item.src.toUpperCase(), 40, 150);
      ctx.fillStyle = '#f6ecdd';
      ctx.font = `700 62px ${FONT}`;
      wrap(ctx, item.title, w - 80, 5).forEach((line, i) => ctx.fillText(line, 40, 230 + i * 74));
    }
    c.tex.needsUpdate = true;
  }

  private drawStocks() {
    const c = this.stocks;
    const { ctx, w } = c;
    this.header(c, 'MARKETS', '#29a19c', 'US · delayed');
    const list = this.board.stocks.slice(0, 9);
    if (!list.length) {
      ctx.fillStyle = '#b9a998';
      ctx.font = `600 44px ${FONT}`;
      ctx.fillText('Fetching prices…', 40, 300);
    }
    const cols = 3;
    const cw = (w - 40) / cols;
    const ch = 156;
    list.forEach((s, i) => {
      const x = 20 + (i % cols) * cw;
      const y = 100 + Math.floor(i / cols) * ch;
      ctx.fillStyle = '#1b1726';
      ctx.beginPath();
      ctx.roundRect(x + 8, y + 6, cw - 16, ch - 12, 16);
      ctx.fill();
      ctx.fillStyle = '#b9a998';
      ctx.font = `700 30px ${FONT}`;
      ctx.fillText(s.sym, x + 28, y + 38);
      ctx.fillStyle = '#f6ecdd';
      ctx.font = `800 44px ${FONT}`;
      ctx.fillText(fmtPrice(s.price), x + 28, y + 84);
      ctx.fillStyle = s.pct >= 0 ? UP : DOWN;
      ctx.font = `700 30px ${FONT}`;
      ctx.fillText(fmtPct(s.pct), x + 28, y + 126);
    });
    c.tex.needsUpdate = true;
  }

  private drawRing() {
    const { ctx, w, h, tex } = this.ring;
    ctx.fillStyle = '#0d0b14';
    ctx.fillRect(0, 0, w, h);
    ctx.textBaseline = 'middle';
    ctx.font = `800 64px ${FONT}`;
    const parts: { text: string; color: string }[] = [];
    for (const s of this.board.stocks) {
      parts.push({ text: `${s.sym} ${fmtPrice(s.price)} `, color: '#f6ecdd' });
      parts.push({ text: `${fmtPct(s.pct)}     `, color: s.pct >= 0 ? UP : DOWN });
    }
    if (!parts.length) parts.push({ text: 'notawork.space   ·   no meetings   ·   ', color: '#f3a712' });
    // Repeat a whole number of times so the loop has no visible seam.
    const total = parts.reduce((sum, p) => sum + ctx.measureText(p.text).width, 0);
    const repeats = Math.max(1, Math.round(w / total));
    ctx.save();
    ctx.scale(w / (total * repeats), 1);
    let x = 0;
    for (let r = 0; r < repeats; r++) {
      for (const p of parts) {
        ctx.fillStyle = p.color;
        ctx.fillText(p.text, x, h / 2 + 4);
        x += ctx.measureText(p.text).width;
      }
    }
    ctx.restore();
    tex.needsUpdate = true;
  }
}
