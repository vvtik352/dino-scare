import type { MaterialKind } from '../render/materials';
import type {
  BoxPrim, BuildingInfo, DoorSpec, LampSpec, ManholeSpec, RampPrim, Rect,
} from './layout';

/** Накопитель примитивов при генерации. */
export class LayoutBuilder {
  readonly boxes: BoxPrim[] = [];
  readonly ramps: RampPrim[] = [];
  readonly doors: DoorSpec[] = [];
  readonly lamps: LampSpec[] = [];
  readonly manholes: ManholeSpec[] = [];
  readonly buildings: BuildingInfo[] = [];
  readonly navBlockers: Rect[] = [];

  /** Бокс по двум углам (порядок координат не важен). Вырожденные боксы игнорируются. */
  box(
    mat: MaterialKind,
    xa: number, ya: number, za: number,
    xb: number, yb: number, zb: number,
    collide = true,
  ): void {
    const x0 = Math.min(xa, xb), x1 = Math.max(xa, xb);
    const y0 = Math.min(ya, yb), y1 = Math.max(ya, yb);
    const z0 = Math.min(za, zb), z1 = Math.max(za, zb);
    if (x1 - x0 < 1e-3 || y1 - y0 < 1e-3 || z1 - z0 < 1e-3) return;
    this.boxes.push({ x0, y0, z0, x1, y1, z1, mat, collide });
  }

  ramp(points: number[]): void {
    this.ramps.push({ points });
  }

  blockNav(r: Rect): void {
    this.navBlockers.push({
      x0: Math.min(r.x0, r.x1), z0: Math.min(r.z0, r.z1),
      x1: Math.max(r.x0, r.x1), z1: Math.max(r.z0, r.z1),
    });
  }
}

export function rectW(r: Rect): number {
  return r.x1 - r.x0;
}

export function rectD(r: Rect): number {
  return r.z1 - r.z0;
}

export function shrinkRect(r: Rect, m: number): Rect {
  return { x0: r.x0 + m, z0: r.z0 + m, x1: r.x1 - m, z1: r.z1 - m };
}

export function rectsOverlap(a: Rect, b: Rect, margin = 0): boolean {
  return a.x0 < b.x1 + margin && a.x1 + margin > b.x0 && a.z0 < b.z1 + margin && a.z1 + margin > b.z0;
}
