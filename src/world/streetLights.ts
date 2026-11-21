import * as THREE from 'three';
import type { LampSpec } from './layout';

/**
 * Пул динамических источников света для уличных фонарей.
 *
 * Фонарей в городе сотни, а каждый PointLight в forward-рендере стоит
 * дорого на каждом пикселе. Поэтому настоящих источников мало (POOL_SIZE),
 * и они каждые ~0.2 с переназначаются на ближайшие к игроку фонари.
 * Остальные фонари видны только как светящийся плафон.
 */
const POOL_SIZE = 8;
const REASSIGN_INTERVAL = 0.2;
const LAMP_COLOR = 0xffc27a;
const LAMP_INTENSITY = 18;
const LAMP_RANGE = 16;

export class StreetLights {
  private pool: THREE.PointLight[] = [];
  private assigned: Array<LampSpec | null> = [];
  private timer = 0;
  /** Фаза мерцания для каждого фонаря (детерминированно по индексу). */
  private phases: Map<LampSpec, number> = new Map();

  /** Фонари, к которым сейчас привязаны реальные источники света (ближайшие к игроку). */
  get activeLamps(): LampSpec[] {
    return this.assigned.filter((l): l is LampSpec => l !== null);
  }

  constructor(private readonly lamps: readonly LampSpec[], parent: THREE.Object3D) {
    for (let i = 0; i < POOL_SIZE; i++) {
      const light = new THREE.PointLight(LAMP_COLOR, 0, LAMP_RANGE, 1.6);
      light.visible = false;
      parent.add(light);
      this.pool.push(light);
      this.assigned.push(null);
    }
    lamps.forEach((l, i) => this.phases.set(l, i * 1.7));
  }

  update(dt: number, viewer: THREE.Vector3, time: number): void {
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = REASSIGN_INTERVAL;
      this.reassign(viewer);
    }
    for (let i = 0; i < this.pool.length; i++) {
      const lamp = this.assigned[i];
      const light = this.pool[i] as THREE.PointLight;
      if (!lamp) continue;
      light.intensity = LAMP_INTENSITY * (lamp.flicker ? flicker(time + (this.phases.get(lamp) ?? 0)) : 1);
    }
  }

  private reassign(viewer: THREE.Vector3): void {
    const nearest = this.lamps
      .map((l) => ({ l, d: (l.light.x - viewer.x) ** 2 + (l.light.z - viewer.z) ** 2 }))
      .sort((a, b) => a.d - b.d)
      .slice(0, POOL_SIZE);
    for (let i = 0; i < this.pool.length; i++) {
      const light = this.pool[i] as THREE.PointLight;
      const entry = nearest[i];
      if (!entry) {
        light.visible = false;
        this.assigned[i] = null;
        continue;
      }
      light.visible = true;
      light.position.set(entry.l.light.x, entry.l.light.y, entry.l.light.z);
      this.assigned[i] = entry.l;
    }
  }
}

/** Мерцание: в основном горит, изредка проседает и гаснет на доли секунды. */
function flicker(t: number): number {
  const n = Math.sin(t * 13.1) * Math.sin(t * 7.3 + 1.1) * Math.sin(t * 2.9 + 2.3);
  if (n > 0.55) return 0.05;
  return 0.85 + 0.15 * Math.sin(t * 31.7);
}
