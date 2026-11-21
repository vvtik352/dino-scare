/**
 * Headless-проверка контроллера игрока: генерируем город, ставим игрока
 * у входа в здание с лестницей и «нажимаем кнопки» скриптом.
 * Запуск: npx tsx scripts/simPlayer.ts
 */
import { Physics } from '../src/core/physics';
import { EventBus } from '../src/core/events';
import { Player } from '../src/entities/player';
import { Rng } from '../src/utils/rng';
import { generateCity } from '../src/world/cityGenerator';
import type { Input } from '../src/core/input';

class FakeInput {
  down = new Set<string>();
  pressed = new Set<string>();
  isDown(c: string) { return this.down.has(c); }
  wasPressed(c: string) { return this.pressed.has(c); }
  wasReleased() { return false; }
  takeMouseDelta() { return { dx: 0, dy: 0 }; }
  consumeFrame() { this.pressed.clear(); }
  press(c: string) { this.pressed.add(c); }
}

const physics = await Physics.create();
const layout = generateCity(new Rng(0x1234).fork('city'));
for (const b of layout.boxes) if (b.collide) physics.addStaticBox((b.x0+b.x1)/2,(b.y0+b.y1)/2,(b.z0+b.z1)/2,(b.x1-b.x0)/2,(b.y1-b.y0)/2,(b.z1-b.z0)/2);
for (const r of layout.ramps) physics.addStaticConvex(new Float32Array(r.points));
physics.step(1/60);

const input = new FakeInput();
const events = new EventBus();
const noises: string[] = [];
events.on('noise', (n) => noises.push(`${n.source}:${n.loudness.toFixed(2)}`));
const player = new Player(physics, input as unknown as Input, events, { mouseSensitivity: 0 }, layout.playerSpawn);
let t = 0;
const run = (sec: number, keys: string[] = [], pressOnce: string[] = []) => {
  for (const k of keys) input.down.add(k);
  for (const k of pressOnce) input.press(k);
  for (let i = 0; i < Math.round(sec * 60); i++) {
    player.fixedUpdate(1/60, t); physics.step(1/60); input.consumeFrame(); t += 1/60;
  }
  for (const k of keys) input.down.delete(k);
};
const pos = () => `(${player.position.x.toFixed(2)}, ${player.position.y.toFixed(2)}, ${player.position.z.toFixed(2)}) ${player.mode} grounded=${player.grounded}`;

// 1. Падение на землю, стоим.
run(1);
console.log('1 spawn settle  ', pos());
const groundY = player.position.y;

// 2. Ходьба 2 с по направлению yaw=0 (−Z).
const start = player.position.clone();
run(2, ['KeyW']);
console.log('2 walk 2s       ', pos(), 'dist', start.distanceTo(player.position).toFixed(2), 'noises', noises.length);
noises.length = 0;

// 3. Бег.
player.teleport(layout.playerSpawn); run(0.5);
const s2 = player.position.clone();
run(1, ['KeyW', 'ShiftLeft']);
console.log('3 run 1s        ', pos(), 'dist', s2.distanceTo(player.position).toFixed(2), noises.join(' '));
noises.length = 0;

// 4. Прыжок на месте.
player.teleport(layout.playerSpawn); run(0.5);
let peak = 0; const y0 = player.position.y;
input.press('Space');
for (let i = 0; i < 90; i++) { player.fixedUpdate(1/60, t); physics.step(1/60); input.consumeFrame(); t+=1/60; peak = Math.max(peak, player.position.y - y0); }
console.log('4 jump peak     ', peak.toFixed(2), pos(), noises.join(' '));
noises.length = 0;

// 5. Mantle на ящик 1 м / 1.2 м, если найдём такой.
const crate = layout.boxes.find((b) => b.mat === 'crate' && Math.abs((b.y1 - b.y0) - 1.2) < 0.01) ?? layout.boxes.find((b) => b.mat === 'crate');
if (crate) {
  const cx = (crate.x0 + crate.x1) / 2, cz = crate.z0 - 0.8;
  player.teleport({ x: cx, y: crate.y0 + 0.05, z: cz });
  player.yaw = Math.PI; // смотреть в +Z
  run(0.3);
  run(0.8, ['KeyW'], ['Space']);
  console.log(`5 mantle crate h=${(crate.y1-crate.y0).toFixed(2)} top=${crate.y1.toFixed(2)}`, pos());
}

// 6. Лестница: найдём первое здание с ≥2 этажами и пройдём по маршу.
const ramp = layout.ramps[0]!;
const pts = ramp.points;
// низ марша: точка 0 (lowU, y0, v0) и верх: точка 1.
const lo = { x: pts[0]!, y: pts[1]!, z: pts[2]! }, hi = { x: pts[3]!, y: pts[4]!, z: pts[5]! };
const lo2 = { x: pts[12]!, z: pts[14]! };
const mid = { x: (lo.x + lo2.x) / 2, z: (lo.z + lo2.z) / 2 };
const dx = hi.x - lo.x, dz = hi.z - lo.z;
const len = Math.hypot(dx, dz);
player.teleport({ x: mid.x - dx / len * 0.6, y: lo.y + 0.05, z: mid.z - dz / len * 0.6 });
player.yaw = Math.atan2(-dx, -dz);
run(0.3);
run(3.5, ['KeyW']);
console.log(`6 stairs low y=${lo.y.toFixed(2)} high y=${hi.y.toFixed(2)}`, pos());

// 7. Присед под низким потолком: присесть, отпустить — должен остаться в приседе, если над головой препятствие.
player.teleport(layout.playerSpawn); run(0.5);
run(0.5, ['ControlLeft']);
console.log('7 crouch        ', pos(), 'height', player.height.toFixed(2));
run(0.5);
console.log('7 stand up      ', pos(), 'height', player.height.toFixed(2));
console.log('groundY', groundY.toFixed(3));
