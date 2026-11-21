import RAPIER from '@dimforge/rapier3d-compat';
import type { Vector3 } from 'three';

export type { RAPIER };

/** Группы коллизий (биты 16 старших = membership, 16 младших = filter). */
export const CollisionLayer = {
  World: 1 << 0,
  Player: 1 << 1,
  Dino: 1 << 2,
  Trigger: 1 << 3,
} as const;

export function interactionGroups(membership: number, filter: number): number {
  return ((membership & 0xffff) << 16) | (filter & 0xffff);
}

export interface RayHit {
  distance: number;
  point: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
  collider: RAPIER.Collider;
}

/**
 * Обёртка над миром Rapier. Остальной код не работает с RAPIER.World напрямую,
 * а только через эти методы — так проще заменить/замокать физику.
 */
export class Physics {
  readonly world: RAPIER.World;
  readonly rapier = RAPIER;

  private constructor(world: RAPIER.World) {
    this.world = world;
  }

  /** WASM нужно инициализировать асинхронно до создания мира. */
  static async create(gravityY = -20): Promise<Physics> {
    await RAPIER.init();
    const world = new RAPIER.World({ x: 0, y: gravityY, z: 0 });
    return new Physics(world);
  }

  step(dt: number): void {
    this.world.timestep = dt;
    this.world.step();
  }

  /** Статический бокс (стены, полы, ящики). Центр и полуразмеры в метрах. */
  addStaticBox(
    cx: number, cy: number, cz: number,
    hx: number, hy: number, hz: number,
    rotationY = 0,
  ): RAPIER.Collider {
    const desc = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
      .setTranslation(cx, cy, cz)
      .setCollisionGroups(interactionGroups(CollisionLayer.World, 0xffff));
    if (rotationY !== 0) {
      const s = Math.sin(rotationY / 2);
      desc.setRotation({ x: 0, y: s, z: 0, w: Math.cos(rotationY / 2) });
    }
    return this.world.createCollider(desc);
  }

  /** Статическое тело из выпуклой оболочки (например, наклон лестницы). */
  addStaticConvex(points: Float32Array): RAPIER.Collider | null {
    const desc = RAPIER.ColliderDesc.convexHull(points);
    if (!desc) return null;
    desc.setCollisionGroups(interactionGroups(CollisionLayer.World, 0xffff));
    return this.world.createCollider(desc);
  }

  removeCollider(c: RAPIER.Collider): void {
    this.world.removeCollider(c, false);
  }

  /**
   * Луч от origin по направлению dir (не обязательно нормализованному) длиной maxDist.
   * По умолчанию бьёт только по геометрии мира (для line-of-sight и т.п.).
   */
  raycast(
    origin: Vector3 | { x: number; y: number; z: number },
    dir: Vector3 | { x: number; y: number; z: number },
    maxDist: number,
    groups = interactionGroups(0xffff, CollisionLayer.World),
    exclude?: RAPIER.Collider,
  ): RayHit | null {
    const len = Math.hypot(dir.x, dir.y, dir.z);
    if (len < 1e-8) return null;
    const d = { x: dir.x / len, y: dir.y / len, z: dir.z / len };
    const ray = new RAPIER.Ray({ x: origin.x, y: origin.y, z: origin.z }, d);
    const hit = this.world.castRayAndGetNormal(
      ray, maxDist, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, groups, exclude,
    );
    if (!hit) return null;
    const t = hit.timeOfImpact;
    return {
      distance: t,
      point: { x: origin.x + d.x * t, y: origin.y + d.y * t, z: origin.z + d.z * t },
      normal: { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z },
      collider: hit.collider,
    };
  }

  /** Есть ли прямая видимость между точками (не мешает геометрия мира). */
  lineOfSight(
    a: { x: number; y: number; z: number },
    b: { x: number; y: number; z: number },
  ): boolean {
    const dir = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
    const dist = Math.hypot(dir.x, dir.y, dir.z);
    if (dist < 1e-4) return true;
    return this.raycast(a, dir, dist) === null;
  }
}
