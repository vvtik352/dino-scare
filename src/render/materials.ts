import * as THREE from 'three';
import { applyPsxPatch, PsxUniforms } from './psx';
import { getTexture, usesLocalUv } from './textures';

/**
 * Единая фабрика материалов. ВЕСЬ код игры получает материалы только отсюда
 * (никаких `new MeshStandardMaterial` в world/entities).
 *
 * Каждый материал: процедурная текстура 64×64 (см. textures.ts) + PSX-патч шейдера
 * (vertex snapping, аффинные UV). Параметры PSX — общие uniform-ы в `psx`.
 */
export type MaterialKind =
  | 'ground'
  | 'road'
  | 'sidewalk'
  | 'wall'
  | 'plaster'
  | 'boundary'
  | 'floor'
  | 'roof'
  | 'stairs'
  | 'crate'
  | 'container'
  | 'dumpster'
  | 'ac'
  | 'door'
  | 'manhole'
  | 'lampPost'
  | 'lampGlow'
  | 'windowLit'
  | 'windowDark'
  | 'dino'
  | 'debug';

/** Цвет без текстуры (fallback и отладочный режим). */
const FLAT_COLORS: Record<MaterialKind, number> = {
  ground: 0x3a3f36,
  road: 0x2a2a2d,
  sidewalk: 0x55575a,
  wall: 0x7a6f66,
  plaster: 0x8a8478,
  boundary: 0x3a3a40,
  floor: 0x5e5248,
  roof: 0x4a4a52,
  stairs: 0xb08a3e,
  crate: 0x8a6a3a,
  container: 0x2f6a8f,
  dumpster: 0x2f5a3a,
  ac: 0x9aa4ad,
  door: 0x7a3e2a,
  manhole: 0x1c221c,
  lampPost: 0x333333,
  lampGlow: 0xffd28a,
  windowLit: 0xffc870,
  windowDark: 0x1a2230,
  dino: 0x6b8f3a,
  debug: 0xff00ff,
};

/** Самосветящиеся материалы (не зависят от освещения). */
const EMISSIVE: ReadonlySet<MaterialKind> = new Set<MaterialKind>(['lampGlow', 'windowLit']);

/** Размер ячейки подразбиения граней для материала (м) — см. BoxGeometryOptions.cell. */
export function cellSizeFor(kind: MaterialKind): number {
  if (usesLocalUv(kind)) return Infinity;
  switch (kind) {
    case 'floor': case 'sidewalk': case 'roof': return 1.5;
    case 'road': case 'ground': return 3;
    default: return 3;
  }
}
export { usesLocalUv };

export class Materials {
  readonly psx = new PsxUniforms();
  private cache = new Map<MaterialKind, THREE.Material>();

  get(kind: MaterialKind): THREE.Material {
    let m = this.cache.get(kind);
    if (!m) {
      m = this.create(kind);
      this.cache.set(kind, m);
    }
    return m;
  }

  dispose(): void {
    for (const m of this.cache.values()) m.dispose();
    this.cache.clear();
  }

  private create(kind: MaterialKind): THREE.Material {
    const map = getTexture(kind);
    const color = map ? 0xffffff : FLAT_COLORS[kind];
    const m = EMISSIVE.has(kind)
      ? new THREE.MeshBasicMaterial({ color, map, name: kind })
      : new THREE.MeshLambertMaterial({ color, map, name: kind });
    applyPsxPatch(m, this.psx);
    return m;
  }
}
