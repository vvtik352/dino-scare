/**
 * Headless-проверка FSM динозавра: патруль → шум → investigate → видит → chase → attack;
 * и сценарий «спрятался в переулке» → search → patrol.
 * Запуск: npx tsx scripts/simDino.ts
 */
import * as THREE from 'three';
import { Physics } from '../src/core/physics';
import { EventBus } from '../src/core/events';
import { Rng } from '../src/utils/rng';
import { generateCity } from '../src/world/cityGenerator';
import { NavGrid } from '../src/ai/navGrid';
import { Dinosaur, DINO_NAV_RADIUS, type DinoPerceptionTarget } from '../src/entities/dinosaur';
import { Materials } from '../src/render/materials';

const physics = await Physics.create();
const layout = generateCity(new Rng(0x1234).fork('city'));
for (const b of layout.boxes) if (b.collide) physics.addStaticBox((b.x0+b.x1)/2,(b.y0+b.y1)/2,(b.z0+b.z1)/2,(b.x1-b.x0)/2,(b.y1-b.y0)/2,(b.z1-b.z0)/2);
for (const r of layout.ramps) physics.addStaticConvex(new Float32Array(r.points));
physics.step(1 / 60);
const nav = NavGrid.fromLayout(layout, DINO_NAV_RADIUS);
const events = new EventBus();
let died = false;
let roars = 0, steps = 0;
events.on('playerDied', () => (died = true));
events.on('roar', () => roars++);
events.on('dinoStep', () => steps++);
const scene = new THREE.Scene();
const dino = new Dinosaur(physics, nav, events, new Rng(5), layout.streetNodes, layout.buildings.map((b) => b.rect), new Materials(), scene, layout.dinoSpawn);

const exposedAt = (p: THREE.Vector3) => physics.raycast({ x: p.x, y: p.y + 1.6, z: p.z }, { x: 0, y: 1, z: 0 }, 100) === null;
const player = (p: THREE.Vector3, crouch = false, speed = 0, alive = true): DinoPerceptionTarget => ({
  position: p, eye: p.clone().setY(p.y + (crouch ? 1.0 : 1.68)), chest: p.clone().setY(p.y + (crouch ? 0.66 : 1.08)),
  crouching: crouch, speed, light: 0.6, alive, exposed: exposedAt(p),
});
let t = 0;
const sim = (sec: number, target: DinoPerceptionTarget, log = false) => {
  const states: string[] = [];
  for (let i = 0; i < sec * 60; i++) {
    dino.fixedUpdate(1 / 60, t, target);
    physics.step(1 / 60);
    t += 1 / 60;
    if (states[states.length - 1] !== dino.state) states.push(dino.state);
    if (died) break;
  }
  if (log) console.log('   states:', states.join(' → '));
};

// --- 1. Патруль: двигается ли, рычит, шагает ---
const far = new THREE.Vector3(layout.playerSpawn.x, 0, layout.playerSpawn.z);
const p0 = dino.position.clone();
sim(30, player(far, true, 0));
console.log(`1 patrol 30s: moved ${p0.distanceTo(dino.position).toFixed(1)} m, state=${dino.state}, steps=${steps}, roars=${roars}`);

// --- 2. Шум рядом → investigate ---
const near = dino.position.clone().add(new THREE.Vector3(25, 0, 0));
const nf = nav.nearestFree(near.x, near.z)!;
const noisePos = new THREE.Vector3(nf.x, 0.15, nf.z);
dino.heading = Math.PI; // смотрит в сторону, не на шум
events.emit('noise', { position: noisePos, loudness: 0.8, source: 'test', time: t });
sim(0.1, player(far, true, 0));
console.log(`2 noise 0.8 @ ${dino.position.distanceTo(noisePos).toFixed(1)} m → state=${dino.state}`);

// --- 3. Игрок стоит на открытой улице на пути → chase → attack ---
sim(20, player(noisePos, false, 3.6), true);
console.log(`3 player in open street: died=${died}, state=${dino.state}, dist=${dino.position.distanceTo(noisePos).toFixed(1)}`);

// --- 4. Сценарий укрытия: игрок в здании на 2 этаже, вне LOS ---
died = false;
dino.reset(layout.dinoSpawn);
const bld = layout.buildings.find((b) => b.floors >= 2 && b.roofAccess)!;
const hide = new THREE.Vector3((bld.rect.x0 + bld.rect.x1) / 2, bld.base + bld.floorHeight + 0.05, (bld.rect.z0 + bld.rect.z1) / 2);
dino.teleport(hide.x + 30, hide.z);
dino.lastKnown = hide.clone();
dino.lastKnownTime = t;
dino.forceState('chase', t);
dino.awareness = 1;
sim(60, player(hide, true, 0), true);
console.log(`4 hidden in building: died=${died}, state=${dino.state}, awareness=${dino.awareness.toFixed(2)}`);

// --- 5. Тихий присед в 15 м за спиной ---
died = false;
dino.reset(layout.dinoSpawn);
sim(2, player(far, true, 0));
const behind = dino.position.clone().sub(dino.forward.multiplyScalar(15));
const bf = nav.nearestFree(behind.x, behind.z)!;
const sneaky = new THREE.Vector3(bf.x, 0, bf.z);
let heard = false;
const unsub = events.on('noise', () => undefined);
for (let i = 0; i < 20; i++) {
  events.emit('noise', { position: sneaky, loudness: 0.1, source: 'step', time: t });
  sim(0.6, player(sneaky, true, 1.7));
  if (dino.state !== 'patrol') heard = true;
}
unsub();
console.log(`5 crouch-steps 15 m behind: reacted=${heard}, state=${dino.state}`);

// --- 6. Убийство через стену: игрок внутри у стены (1-й и 2-й этаж), T-Rex в погоне трётся о дом ---
let wallKills = 0, trials = 0;
for (const b of layout.buildings.filter((b) => b.roofAccess || b.floors <= 3).slice(0, 25)) {
  for (const floor of [0, 1]) {
    if (floor >= b.floors) continue;
    for (const side of ['x0', 'x1', 'z0', 'z1'] as const) {
      const cx = (b.rect.x0 + b.rect.x1) / 2, cz = (b.rect.z0 + b.rect.z1) / 2;
      const inset = 0.8;
      const px = side === 'x0' ? b.rect.x0 + inset : side === 'x1' ? b.rect.x1 - inset : cx;
      const pz = side === 'z0' ? b.rect.z0 + inset : side === 'z1' ? b.rect.z1 - inset : cz;
      const pp = new THREE.Vector3(px, b.base + floor * b.floorHeight + 0.05, pz);
      // Динозавр снаружи напротив этой стены, смотрит на игрока.
      const ox = side === 'x0' ? -1 : side === 'x1' ? 1 : 0, oz = side === 'z0' ? -1 : side === 'z1' ? 1 : 0;
      died = false;
      dino.reset(layout.dinoSpawn);
      dino.teleport(px + ox * 4, pz + oz * 4);
      if (Math.hypot(dino.position.x - px, dino.position.z - pz) > 6) continue; // снаружи нет места
      dino.heading = Math.atan2(px - dino.position.x, pz - dino.position.z);
      dino.lastKnown = pp.clone(); dino.lastKnownTime = t;
      dino.forceState('chase', t); dino.awareness = 1;
      trials++;
      sim(6, player(pp, false, 0));
      if (died) wallKills++;
    }
  }
}
console.log(`6 player inside next to wall: kills through wall ${wallKills}/${trials}`);

// --- 7. «Чутьё»: игрок стоит под открытым небом далеко → T-Rex идёт к нему ---
died = false;
dino.reset(layout.dinoSpawn);
const open = new THREE.Vector3(layout.playerSpawn.x, 0.02, layout.playerSpawn.z);
const d0 = dino.position.distanceTo(open);
sim(60, { ...player(open, true, 0), light: 0 }, true);
console.log(`7 exposed far away: dist ${d0.toFixed(0)} → ${dino.position.distanceTo(open).toFixed(0)} m in 60 s, died=${died}`);
console.log(`totals: roars=${roars} steps=${steps}`);
