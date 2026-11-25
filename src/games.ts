import * as THREE from 'three';
import { FLOODLIGHTS, GOAL_HALF, LAP_BOARD, PITCH, RACE, RACE_R, SCOREBOARD, WHEEL } from '../shared/layout';
import { BALL_R, centreBall, stepBall, type BallState } from '../shared/ball';
import type { GamesState, Lap } from '../shared/protocol';
import { box, glow, mat } from './world';
import { textSprite } from './avatar';

const FONT = 'ui-rounded, system-ui, sans-serif';
const WHEEL_R = 2.6;
const WHEEL_SPIN_S = 4.5;
const SEGMENT_COLORS = ['#e4572e', '#f3a712', '#76b041', '#29a19c', '#3a86ff', '#8338ec', '#ff5d8f', '#c98a3c'];

function canvasTexture(w: number, h: number) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return { ctx: canvas.getContext('2d')!, tex, w, h };
}

/** A two-sided sign board on posts. `ry` is the direction the front faces. */
function signBoard(tex: THREE.Texture, w: number, h: number, x: number, y: number, z: number, ry: number) {
  const g = new THREE.Group();
  g.add(box(w + 0.3, h + 0.3, 0.2, '#1d1726'));
  for (const side of [1, -1]) {
    const face = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex }));
    face.position.z = side * 0.11;
    if (side < 0) face.rotation.y = Math.PI;
    g.add(face);
  }
  for (const dx of [-w / 2 + 0.2, w / 2 - 0.2]) g.add(box(0.2, y, 0.2, '#3a2f3c', dx, -y / 2 - h / 2, 0));
  g.position.set(x, y, z);
  g.rotation.y = ry;
  return g;
}

/** The football pitch, the lap race and the wheel. Draws what the server says and animates in between. */
export class Games {
  /** The ball as this browser currently believes it to be. */
  readonly ball: BallState = centreBall();
  private ballMesh: THREE.Mesh;
  private score = canvasTexture(1024, 256);
  private laps = canvasTexture(768, 512);
  private wheelFace = canvasTexture(1024, 1024);
  private wheel: THREE.Mesh;
  private spin: { from: number; to: number; start: number } | null = null;
  private gates: { ring: THREE.Mesh; base: THREE.Color }[] = [];
  private nextGate: number | null = null;

  constructor(private scene: THREE.Scene) {
    this.buildPitch();
    this.buildRace();
    this.wheel = this.buildWheel();

    this.ballMesh = new THREE.Mesh(new THREE.IcosahedronGeometry(BALL_R, 1), mat('#f4f1ea'));
    this.ballMesh.castShadow = true;
    // A few dark panels so you can see it roll.
    const dark = new THREE.MeshStandardMaterial({ color: '#22202a', flatShading: true });
    for (const [x, y, z] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) {
      const patch = new THREE.Mesh(new THREE.CircleGeometry(BALL_R * 0.42, 5), dark);
      patch.position.set(x, y, z).multiplyScalar(BALL_R * 0.94);
      patch.lookAt(x * 2, y * 2, z * 2);
      this.ballMesh.add(patch);
    }
    scene.add(this.ballMesh);

    this.drawScore([0, 0]);
    this.drawLaps([]);
    this.drawWheel([]);
  }

  // ------------------------------------------------------------ football

  private buildPitch() {
    const { scene } = this;
    const P = PITCH;
    const w = P.x2 - P.x1;
    const d = P.z2 - P.z1;
    const flat = (geo: THREE.BufferGeometry, color: string, x: number, z: number, y: number) => {
      const m = new THREE.Mesh(geo, mat(color));
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, y, z);
      m.receiveShadow = true;
      scene.add(m);
    };
    const stripes = 9;
    for (let i = 0; i < stripes; i++) {
      flat(new THREE.PlaneGeometry(w / stripes, d), i % 2 ? '#3f8f4a' : '#48a055', P.x1 + (i + 0.5) * (w / stripes), P.cz, 0.02);
    }
    const line = '#eef5ea';
    flat(new THREE.PlaneGeometry(0.14, d), line, P.cx, P.cz, 0.03);
    flat(new THREE.RingGeometry(2.6, 2.74, 40), line, P.cx, P.cz, 0.03);
    for (const z of [P.z1 + 0.07, P.z2 - 0.07]) flat(new THREE.PlaneGeometry(w, 0.14), line, P.cx, z, 0.03);
    for (const x of [P.x1 + 0.07, P.x2 - 0.07]) flat(new THREE.PlaneGeometry(0.14, d), line, x, P.cz, 0.03);

    // Low boards all round, open at the two goal mouths.
    const board = '#e9e2d2';
    for (const z of [P.z1 - 0.15, P.z2 + 0.15]) scene.add(box(w + 0.6, 0.5, 0.3, board, P.cx, 0.25, z));
    const endLen = d / 2 - GOAL_HALF;
    for (const x of [P.x1 - 0.15, P.x2 + 0.15]) {
      scene.add(box(0.3, 0.5, endLen, board, x, 0.25, P.z1 + endLen / 2));
      scene.add(box(0.3, 0.5, endLen, board, x, 0.25, P.z2 - endLen / 2));
    }

    // Goals: Red defends the west end, Blue the east.
    const goal = (x: number, dir: number, color: string) => {
      for (const dz of [-GOAL_HALF, GOAL_HALF]) scene.add(box(0.18, 2.4, 0.18, color, x, 1.2, P.cz + dz));
      scene.add(box(0.18, 0.18, GOAL_HALF * 2 + 0.18, color, x, 2.4, P.cz));
      const net = new THREE.Mesh(
        new THREE.BoxGeometry(1.6, 2.3, GOAL_HALF * 2),
        new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.35 }),
      );
      net.position.set(x + dir * 0.85, 1.15, P.cz);
      scene.add(net);
    };
    goal(P.x1, -1, '#e4572e');
    goal(P.x2, 1, '#3a86ff');

    for (const f of FLOODLIGHTS) {
      scene.add(box(0.3, 9, 0.3, '#3a2f3c', f.x, 4.5, f.z));
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.5, 0.5), glow('#eef4ff', 1.5));
      lamp.position.set(f.x, 9.2, f.z);
      lamp.lookAt(P.cx, 0, P.cz);
      scene.add(lamp);
    }
    for (const x of [P.cx - 9, P.cx + 9]) {
      const light = new THREE.PointLight('#eaf2ff', 170, 34, 1.7);
      light.position.set(x, 8.5, P.cz);
      scene.add(light);
    }

    scene.add(signBoard(this.score.tex, 6, 1.5, SCOREBOARD.x, 3.2, SCOREBOARD.z - 0.9, 0));
  }

  private drawScore([red, blue]: [number, number]) {
    const { ctx, w, h, tex } = this.score;
    ctx.fillStyle = '#0d0b14';
    ctx.fillRect(0, 0, w, h);
    ctx.textBaseline = 'middle';
    ctx.font = `800 110px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ff7a55';
    ctx.fillText(`RED ${red}`, w / 2 - 50, h / 2 + 6);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#6aa5ff';
    ctx.fillText(`${blue} BLUE`, w / 2 + 50, h / 2 + 6);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#f6ecdd';
    ctx.fillText('–', w / 2, h / 2);
    tex.needsUpdate = true;
  }

  /** The server's word on where the ball is. Small differences are blended so it doesn't jump. */
  syncBall(b: BallState) {
    const off = Math.hypot(b.x - this.ball.x, b.z - this.ball.z);
    const k = off > 2 ? 1 : 0.5;
    this.ball.x += (b.x - this.ball.x) * k;
    this.ball.z += (b.z - this.ball.z) * k;
    this.ball.vx = b.vx;
    this.ball.vz = b.vz;
  }

  kick(vx: number, vz: number) {
    this.ball.vx = vx;
    this.ball.vz = vz;
  }

  // ------------------------------------------------------------ lap race

  private buildRace() {
    const { scene } = this;
    RACE.forEach((g, i) => {
      const base = new THREE.Color(i === 0 ? '#ffd76a' : '#6fe3d2');
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(RACE_R - 0.35, RACE_R, 40),
        new THREE.MeshBasicMaterial({ color: base.clone(), transparent: true, opacity: 0.85 }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(g.x, 0.03, g.z);
      scene.add(ring);
      this.gates.push({ ring, base });
      const label = textSprite(i === 0 ? 'START · FINISH' : `Gate ${i}`, 0.5);
      label.position.set(g.x, 3.3, g.z);
      scene.add(label);
    });
    // An arch over the start line.
    const s = RACE[0];
    for (const dx of [-RACE_R, RACE_R]) scene.add(box(0.25, 4.2, 0.25, '#3a2f3c', s.x + dx, 2.1, s.z));
    const banner = new THREE.Mesh(new THREE.BoxGeometry(RACE_R * 2 + 0.25, 0.6, 0.2), glow('#ffd76a', 1.6));
    banner.position.set(s.x, 4.3, s.z);
    scene.add(banner);

    scene.add(signBoard(this.laps.tex, 3.2, 2.1, LAP_BOARD.x, 2.6, LAP_BOARD.z, Math.PI));
  }

  private drawLaps(laps: Lap[]) {
    const { ctx, w, h, tex } = this.laps;
    ctx.fillStyle = '#0d0b14';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#ffd76a';
    ctx.fillRect(0, 0, w, 90);
    ctx.fillStyle = '#0d0b14';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.font = `800 50px ${FONT}`;
    ctx.fillText('FASTEST LAPS', 28, 48);
    ctx.font = `700 46px ${FONT}`;
    if (!laps.length) {
      ctx.fillStyle = '#b9a998';
      ctx.fillText('No laps yet.', 28, 190);
      ctx.fillText('Press E at START.', 28, 260);
    }
    laps.slice(0, 5).forEach((lap, i) => {
      const y = 140 + i * 76;
      ctx.fillStyle = i === 0 ? '#ffd76a' : '#f6ecdd';
      ctx.textAlign = 'left';
      const name = lap.name.length > 14 ? lap.name.slice(0, 13) + '…' : lap.name;
      ctx.fillText(`${i + 1}. ${name}`, 28, y);
      ctx.textAlign = 'right';
      ctx.fillText(`${(lap.ms / 1000).toFixed(2)}s`, w - 28, y);
    });
    tex.needsUpdate = true;
  }

  /** Highlight the gate a runner should head for next (null when not racing). */
  setNextGate(i: number | null) {
    this.nextGate = i;
  }

  // ------------------------------------------------------------ the wheel

  private buildWheel() {
    const { scene } = this;
    const holder = new THREE.Group();
    holder.position.set(WHEEL.x, 3.9, WHEEL.z);
    holder.rotation.y = Math.PI / 2; // face east, toward the rest of the roof
    const disc = new THREE.Mesh(new THREE.CircleGeometry(WHEEL_R, 64), new THREE.MeshBasicMaterial({ map: this.wheelFace.tex }));
    disc.position.z = 0.16;
    const back = new THREE.Mesh(new THREE.CylinderGeometry(WHEEL_R + 0.15, WHEEL_R + 0.15, 0.3, 48), mat('#2a2230'));
    back.rotation.x = Math.PI / 2;
    const pointer = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.7, 4), glow('#ffd76a', 2.4));
    pointer.rotation.z = Math.PI;
    pointer.position.set(0, WHEEL_R + 0.2, 0.3);
    holder.add(back, disc, pointer);
    scene.add(holder);
    scene.add(box(0.5, 3.9, 0.5, '#3a2f3c', WHEEL.x - 0.3, 1.95, WHEEL.z));
    scene.add(box(1.4, 0.3, 2.4, '#3a2f3c', WHEEL.x - 0.3, 0.15, WHEEL.z));
    const label = textSprite('The wheel picks one of us', 0.46);
    label.position.set(WHEEL.x + 0.4, 7.3, WHEEL.z);
    scene.add(label);
    return disc;
  }

  private drawWheel(names: string[]) {
    const { ctx, w, tex } = this.wheelFace;
    const c = w / 2;
    const r = c - 8;
    ctx.clearRect(0, 0, w, w);
    const list = names.length ? names : ['Press E', 'to spin', 'Press E', 'to spin'];
    const seg = (Math.PI * 2) / list.length;
    list.forEach((name, i) => {
      const a0 = -Math.PI / 2 + i * seg; // segment 0 starts at the top and they run clockwise
      ctx.beginPath();
      ctx.moveTo(c, c);
      ctx.arc(c, c, r, a0, a0 + seg);
      ctx.closePath();
      ctx.fillStyle = SEGMENT_COLORS[i % SEGMENT_COLORS.length];
      ctx.fill();
      ctx.strokeStyle = '#1d1726';
      ctx.lineWidth = 6;
      ctx.stroke();
      ctx.save();
      ctx.translate(c, c);
      ctx.rotate(a0 + seg / 2);
      ctx.fillStyle = '#16121c';
      ctx.font = `800 ${list.length > 8 ? 44 : 58}px ${FONT}`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(name.length > 12 ? name.slice(0, 11) + '…' : name, r - 28, 0);
      ctx.restore();
    });
    ctx.beginPath();
    ctx.arc(c, c, 60, 0, Math.PI * 2);
    ctx.fillStyle = '#1d1726';
    ctx.fill();
    tex.needsUpdate = true;
  }

  /** Spin and come to rest with the winner's segment under the pointer. */
  spinWheel(names: string[], winner: number, time: number) {
    this.drawWheel(names);
    const seg = (Math.PI * 2) / Math.max(1, names.length);
    this.spin = { from: 0, to: Math.PI * 2 * 6 + (winner + 0.5) * seg, start: time };
  }

  // ------------------------------------------------------------ shared

  setAll(state: GamesState) {
    Object.assign(this.ball, state.ball);
    this.drawScore(state.score);
    this.drawLaps(state.laps);
  }
  setScore(score: [number, number]) {
    this.drawScore(score);
  }
  setLaps(laps: Lap[]) {
    this.drawLaps(laps);
  }

  update(time: number, dt: number) {
    // Ball: run the same physics as the server between its updates. A goal is the server's call,
    // so if this browser thinks it went in, just hold the ball still until the server says so.
    const { ball } = this;
    const speed = Math.hypot(ball.vx, ball.vz);
    if (stepBall(ball, dt)) ball.vx = ball.vz = 0;
    this.ballMesh.position.set(ball.x, BALL_R, ball.z);
    if (speed > 0.01) {
      const axis = new THREE.Vector3(ball.vz, 0, -ball.vx).normalize();
      this.ballMesh.rotateOnWorldAxis(axis, (speed * dt) / BALL_R);
    }

    if (this.spin) {
      const t = Math.min(1, (time - this.spin.start) / WHEEL_SPIN_S);
      const eased = 1 - Math.pow(1 - t, 3);
      this.wheel.rotation.z = this.spin.from + (this.spin.to - this.spin.from) * eased;
      if (t >= 1) this.spin = null;
    }

    this.gates.forEach((g, i) => {
      const mat = g.ring.material as THREE.MeshBasicMaterial;
      if (i === this.nextGate) mat.color.copy(g.base).multiplyScalar(2.2 + Math.sin(time * 8) * 0.6);
      else mat.color.copy(g.base).multiplyScalar(this.nextGate === null ? 1 : 0.45);
    });
  }
}
