/**
 * Паркур-маршрут на крышу (ящик → штабель → кондиционеры → крыша):
 * ставим игрока на каждую ступень лицом к следующей и жмём прыжок.
 * Запуск: npx tsx scripts/simClimb.ts
 */
import { Physics } from '../src/core/physics';
import { EventBus } from '../src/core/events';
import { Player } from '../src/entities/player';
import { Rng } from '../src/utils/rng';
import { LayoutBuilder } from '../src/world/layoutBuilder';
import { LocalFrame, addClimbRoute } from '../src/world/buildings';
import { SIDEWALK_HEIGHT, FLOOR_HEIGHT, PARAPET_HEIGHT } from '../src/world/constants';
import type { Input } from '../src/core/input';

let total = 0, ok = 0;
const fails: string[] = [];
const START = [0.2, 0.5, 0.8]; // доля ширины текущей ступени
const AIM = [0.15, 0.5, 0.85]; // доля ширины следующей ступени
for (const floors of [1, 2]) {
  for (let seed = 1; seed <= 4; seed++) {
   for (const sFrac of START) for (const aFrac of AIM) {
    const physics = await Physics.create();
    const b = new LayoutBuilder();
    const f = new LocalFrame({ x0: 0, z0: 10, x1: 12, z1: 22 }, 'minZ');
    const roofTop = SIDEWALK_HEIGHT + floors * FLOOR_HEIGHT;
    b.box('road', -20, -1, -20, 40, 0, 40);
    f.box(b, 'wall', 0, 0, 0, 12, roofTop, 12); // глухое здание
    f.box(b, 'wall', 0, roofTop, 0, 12, roofTop + PARAPET_HEIGHT, 0.3); // парапет
    const before = b.boxes.length;
    addClimbRoute(b, f, new Rng(seed), roofTop + PARAPET_HEIGHT);
    const steps = b.boxes.slice(before);
    for (const bx of b.boxes) physics.addStaticBox((bx.x0+bx.x1)/2,(bx.y0+bx.y1)/2,(bx.z0+bx.z1)/2,(bx.x1-bx.x0)/2,(bx.y1-bx.y0)/2,(bx.z1-bx.z0)/2);
    physics.step(1 / 60);
    // Последняя «ступень» — парапет (лицом к стене, т.е. +Z).
    const targets = [...steps, { x0: 0, x1: 12, z0: 10, z1: 10.3, y0: roofTop, y1: roofTop + PARAPET_HEIGHT }];

    const down = new Set<string>(); const pressed = new Set<string>();
    const input = { isDown: (c: string) => down.has(c), wasPressed: (c: string) => pressed.has(c), wasReleased: () => false, takeMouseDelta: () => ({ dx: 0, dy: 0 }), consumeFrame() { pressed.clear(); } };
    const player = new Player(physics, input as unknown as Input, new EventBus(), { mouseSensitivity: 0 }, { x: 0, y: 0, z: 0 });
    const tick = (n: number) => { for (let i = 0; i < n; i++) { player.fixedUpdate(1 / 60, 0); physics.step(1 / 60); input.consumeFrame(); } };

    // Старт на земле перед первым ящиком.
    const c0 = targets[0]!;
    let from = { x: (c0.x0 + c0.x1) / 2, y: 0.05, z: c0.z0 - 0.6 };
    const log: string[] = [];
    for (let i = 0; i < targets.length; i++) {
      const tgt = targets[i]!;
      player.teleport(from);
      tick(10);
      const cz = (tgt.z0 + tgt.z1) / 2;
      const isParapet = i === targets.length - 1;
      const aimX = isParapet ? player.position.x : tgt.x0 + (tgt.x1 - tgt.x0) * aFrac;
      const aimZ = cz;
      player.yaw = Math.atan2(-(aimX - player.position.x), -(aimZ - player.position.z));
      down.add('KeyW'); down.add('Space'); pressed.add('Space');
      for (let k = 0; k < 50; k++) {
        // Игрок отпускает W, когда зацепился или уже приземлился выше, чем стоял.
        if (player.mode === 'mantle' || (player.grounded && player.position.y > from.y + 0.5)) down.delete('KeyW');
        tick(1);
      }
      down.clear(); tick(30);
      const onTop = Math.abs(player.position.y - tgt.y1) < 0.12;
      total++; if (onTop) ok++;
      log.push(`${onTop ? '✓' : '✗'} step${i} top=${tgt.y1.toFixed(2)} got=${player.position.y.toFixed(2)}`);
      if (!onTop) { fails.push(`floors=${floors} seed=${seed} start=${sFrac} aim=${aFrac}: ${log.join('  ')}`); break; }
      // Встаём на этой ступени в точку sFrac по ширине (по центру глубины).
      from = { x: tgt.x0 + (tgt.x1 - tgt.x0) * sFrac, y: tgt.y1 + 0.02, z: (tgt.z0 + tgt.z1) / 2 };
    }
   }
  }
}
console.log(fails.map((f) => f.split(":")[0] + " → " + (f.match(/✗ step\d+/) ?? [""])[0]).join('\n'));
console.log(`ok ${ok}/${total}  failed routes ${fails.length}/${2 * 4 * START.length * AIM.length}`);
