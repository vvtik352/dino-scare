import { Physics } from '../src/core/physics';
import { EventBus } from '../src/core/events';
import { Player } from '../src/entities/player';
import { Rng } from '../src/utils/rng';
import { generateCity } from '../src/world/cityGenerator';
import type { Input } from '../src/core/input';
const physics = await Physics.create();
const layout = generateCity(new Rng(0x1234).fork('city'));
for (const b of layout.boxes) if (b.collide) physics.addStaticBox((b.x0+b.x1)/2,(b.y0+b.y1)/2,(b.z0+b.z1)/2,(b.x1-b.x0)/2,(b.y1-b.y0)/2,(b.z1-b.z0)/2);
for (const r of layout.ramps) physics.addStaticConvex(new Float32Array(r.points));
physics.step(1/60);
const down = new Set<string>(); const pressed = new Set<string>();
const input = { isDown: (c: string) => down.has(c), wasPressed: (c: string) => pressed.has(c), wasReleased: () => false, takeMouseDelta: () => ({dx:0,dy:0}), consumeFrame(){ pressed.clear(); } };
const crates = layout.boxes.filter((b) => b.mat === 'crate' || b.mat === 'container' || b.mat === 'dumpster');
let ok = 0, fail = 0, skipped = 0;
const results: string[] = [];
for (const crate of crates.slice(0, 40)) {
  const h = crate.y1 - crate.y0;
  const cx = (crate.x0 + crate.x1) / 2;
  // Старт внутри соседнего предмета (штабель паркур-маршрута) — артефакт теста, пропускаем.
  const sx = cx, sz = crate.z0 - 0.7;
  if (layout.boxes.some((o) => o !== crate && o.collide && o.y1 > crate.y0 + 0.3 && o.y0 < crate.y0 + 1.8 &&
    sx > o.x0 - 0.35 && sx < o.x1 + 0.35 && sz > o.z0 - 0.35 && sz < o.z1 + 0.35)) { skipped++; continue; }
  const player = new Player(physics, input as unknown as Input, new EventBus(), { mouseSensitivity: 0 }, { x: sx, y: crate.y0 + 0.05, z: sz });
  player.yaw = Math.PI;
  for (let i = 0; i < 20; i++) { player.fixedUpdate(1/60, 0); physics.step(1/60); input.consumeFrame(); }
  const startY = player.position.y;
  down.add('KeyW'); down.add('Space'); pressed.add('Space');
  for (let i = 0; i < 40; i++) {
    if (player.mode === 'mantle') down.delete('KeyW');
    player.fixedUpdate(1/60, 0); physics.step(1/60); input.consumeFrame();
  }
  down.clear();
  for (let i = 0; i < 60; i++) { player.fixedUpdate(1/60, 0); physics.step(1/60); input.consumeFrame(); }
  const onTop = Math.abs(player.position.y - crate.y1) < 0.1;
  const expected = h <= 2.2;
  if (onTop === expected) ok++; else fail++;
  results.push(`[${crate.x0.toFixed(1)},${crate.z0.toFixed(1)}] ${crate.mat.padEnd(9)} h=${h.toFixed(2)} start=${startY.toFixed(2)} end=${player.position.y.toFixed(2)} top=${crate.y1.toFixed(2)} ${onTop ? 'ON TOP' : 'not'} ${onTop === expected ? '' : '<-- unexpected'}`);
  physics.world.removeCollider(player.collider, false);
}
console.log(results.join('\n'));
console.log('ok', ok, 'fail', fail, 'skipped', skipped);
