import type { MaterialKind } from '../render/materials';
import type { Rng } from '../utils/rng';
import type { Rect, Vec2 } from './layout';
import type { LayoutBuilder } from './layoutBuilder';
import {
  DOOR_HEIGHT, DOOR_WIDTH, FLOOR_HEIGHT, PARAPET_HEIGHT, SIDEWALK_HEIGHT, SLAB_THICKNESS,
  STAIR_LANDING, STAIR_LANE, STAIR_RISER, STAIR_RUN, STAIR_TREAD, WALL_THICKNESS,
  WINDOW_SILL, WINDOW_TOP, WINDOW_WIDTH,
} from './constants';

/** С какой стороны прямоугольника участка находится фасад (дверь). */
export type Side = 'minX' | 'maxX' | 'minZ' | 'maxZ';

/**
 * Локальная система координат здания: u — вдоль фасада (0..W), v — от фасада вглубь (0..D).
 * Все повороты кратны 90°, поэтому осевой бокс в локальных координатах
 * остаётся осевым в мировых — достаточно преобразовать два угла.
 */
export class LocalFrame {
  readonly W: number;
  readonly D: number;

  constructor(readonly rect: Rect, readonly front: Side) {
    const w = rect.x1 - rect.x0;
    const d = rect.z1 - rect.z0;
    const alongX = front === 'minZ' || front === 'maxZ';
    this.W = alongX ? w : d;
    this.D = alongX ? d : w;
  }

  point(u: number, v: number): Vec2 {
    const r = this.rect;
    switch (this.front) {
      case 'minZ': return { x: r.x0 + u, z: r.z0 + v };
      case 'maxZ': return { x: r.x1 - u, z: r.z1 - v };
      case 'minX': return { x: r.x0 + v, z: r.z1 - u };
      case 'maxX': return { x: r.x1 - v, z: r.z0 + u };
    }
  }

  dir(du: number, dv: number): Vec2 {
    switch (this.front) {
      case 'minZ': return { x: du, z: dv };
      case 'maxZ': return { x: -du, z: -dv };
      case 'minX': return { x: dv, z: -du };
      case 'maxX': return { x: -dv, z: du };
    }
  }

  box(b: LayoutBuilder, mat: MaterialKind, u0: number, y0: number, v0: number, u1: number, y1: number, v1: number, collide = true): void {
    const a = this.point(u0, v0);
    const c = this.point(u1, v1);
    b.box(mat, a.x, y0, a.z, c.x, y1, c.z, collide);
  }

  worldRect(u0: number, v0: number, u1: number, v1: number): Rect {
    const a = this.point(u0, v0);
    const c = this.point(u1, v1);
    return { x0: Math.min(a.x, c.x), z0: Math.min(a.z, c.z), x1: Math.max(a.x, c.x), z1: Math.max(a.z, c.z) };
  }
}

/** Проём в стене: [a, b] вдоль стены, [bottom, top] по высоте от пола этажа. */
interface Opening {
  a: number;
  b: number;
  bottom: number;
  top: number;
}

/**
 * Стена с проёмами вдоль оси u (фасад/задняя) или v (боковые).
 * Режется на горизонтальные полосы по границам проёмов; в каждой полосе
 * сплошные участки = [from, to] минус проёмы, перекрывающие полосу.
 */
function wallWithOpenings(
  b: LayoutBuilder, f: LocalFrame, mat: MaterialKind,
  axis: 'u' | 'v', fixed0: number, fixed1: number,
  from: number, to: number, y0: number, height: number, openings: Opening[],
): void {
  const ys = new Set<number>([0, height]);
  for (const o of openings) {
    ys.add(Math.max(0, o.bottom));
    ys.add(Math.min(height, o.top));
  }
  const levels = [...ys].sort((p, q) => p - q);
  for (let i = 0; i < levels.length - 1; i++) {
    const lo = levels[i] as number;
    const hi = levels[i + 1] as number;
    if (hi - lo < 1e-3) continue;
    const cuts = openings
      .filter((o) => o.bottom <= lo + 1e-4 && o.top >= hi - 1e-4)
      .sort((p, q) => p.a - q.a);
    let cursor = from;
    const emit = (s: number, e: number): void => {
      if (e - s < 1e-3) return;
      if (axis === 'u') f.box(b, mat, s, y0 + lo, fixed0, e, y0 + hi, fixed1);
      else f.box(b, mat, fixed0, y0 + lo, s, fixed1, y0 + hi, e);
    };
    for (const c of cuts) {
      emit(cursor, c.a);
      cursor = Math.max(cursor, c.b);
    }
    emit(cursor, to);
  }
}

/** Равномерно расставленные окна на отрезке [from, to], не задевающие запрещённые интервалы. */
function windowOpenings(from: number, to: number, spacing: number, avoid: Array<[number, number]>): Opening[] {
  const margin = 0.7;
  const usable = to - from - 2 * margin;
  const n = Math.floor((usable + spacing - WINDOW_WIDTH) / spacing);
  if (n <= 0) return [];
  const total = (n - 1) * spacing + WINDOW_WIDTH;
  const start = from + margin + (usable - total) / 2;
  const res: Opening[] = [];
  for (let i = 0; i < n; i++) {
    const a = start + i * spacing;
    const bb = a + WINDOW_WIDTH;
    if (avoid.some(([s, e]) => a < e + 0.3 && bb > s - 0.3)) continue;
    res.push({ a, b: bb, bottom: WINDOW_SILL, top: WINDOW_TOP });
  }
  return res;
}

export interface EnterableOptions {
  wallMat: MaterialKind;
  floors: number;
  backDoor: boolean;
  roofAccess: boolean;
}

/** Минимальный размер участка для здания с лестницей. */
export const MIN_ENTERABLE_W = 2 * WALL_THICKNESS + STAIR_RUN + 2 * STAIR_LANDING + 0.2;
export const MIN_ENTERABLE_D = 7.5;

/**
 * Здание, в которое можно зайти: этажи, лестница-«змейка» у задней стены,
 * окна-проёмы, двери, выход на крышу.
 *
 * Лестница k (с этажа k на k+1) лежит в полосе k % 2 у задней стены.
 * Полоса 0 поднимается в +u, полоса 1 — в −u. Перекрытие уровня k+1
 * имеет проём над полосой k % 2 на длину марша.
 */
export function buildEnterable(b: LayoutBuilder, f: LocalFrame, rng: Rng, opt: EnterableOptions): void {
  const { W, D } = f;
  const t = WALL_THICKNESS;
  const H = FLOOR_HEIGHT;
  const base = SIDEWALK_HEIGHT;
  const top = base + opt.floors * H;

  const s0 = t + STAIR_LANDING;
  const s1 = s0 + STAIR_RUN;
  const laneV = (lane: number): [number, number] =>
    lane === 0 ? [D - t - STAIR_LANE, D - t] : [D - t - 2 * STAIR_LANE, D - t - STAIR_LANE];
  const stairwellFront = D - t - 2 * STAIR_LANE;

  // --- Двери ---
  const frontDoorA = rng.range(t + 0.8, W - t - 0.8 - DOOR_WIDTH);
  const frontDoor: Opening = { a: frontDoorA, b: frontDoorA + DOOR_WIDTH, bottom: 0, top: DOOR_HEIGHT };
  addDoor(b, f, frontDoorA, t / 2, 1, base);

  let backDoor: Opening | null = null;
  if (opt.backDoor && W - t - s1 >= DOOR_WIDTH + 0.3) {
    const a = rng.range(s1 + 0.15, W - t - 0.15 - DOOR_WIDTH);
    backDoor = { a, b: a + DOOR_WIDTH, bottom: 0, top: DOOR_HEIGHT };
    addDoor(b, f, a, D - t / 2, -1, base);
  }

  // --- Стены по этажам ---
  for (let fl = 0; fl < opt.floors; fl++) {
    const y0 = base + fl * H;
    const spacing = rng.pick([2.6, 3.0, 3.4]);

    const frontOps = windowOpenings(0, W, spacing, fl === 0 ? [[frontDoor.a, frontDoor.b]] : []);
    if (fl === 0) frontOps.push(frontDoor);
    wallWithOpenings(b, f, opt.wallMat, 'u', 0, t, 0, W, y0, H, frontOps);

    const backAvoid: Array<[number, number]> = [[s0 - 0.2, s1 + 0.2]];
    if (fl === 0 && backDoor) backAvoid.push([backDoor.a, backDoor.b]);
    const backOps = windowOpenings(0, W, spacing, backAvoid);
    if (fl === 0 && backDoor) backOps.push(backDoor);
    wallWithOpenings(b, f, opt.wallMat, 'u', D - t, D, 0, W, y0, H, backOps);

    // Боковые стены: окна только перед лестничной клеткой.
    const sideOps = windowOpenings(t, stairwellFront, spacing, []);
    wallWithOpenings(b, f, opt.wallMat, 'v', 0, t, t, D - t, y0, H, sideOps);
    wallWithOpenings(b, f, opt.wallMat, 'v', W - t, W, t, D - t, y0, H, sideOps);

    // Внутренняя перегородка с проходом (комнаты = укрытия).
    if (stairwellFront - t > 7 && rng.chance(0.6)) {
      const vp = rng.range(t + 3, stairwellFront - 2);
      const pa = rng.range(t + 0.5, W - t - 0.5 - 1.2);
      wallWithOpenings(b, f, opt.wallMat, 'u', vp, vp + 0.15, t, W - t, y0, H, [
        { a: pa, b: pa + 1.2, bottom: 0, top: DOOR_HEIGHT },
      ]);
    }
  }

  // --- Перекрытия (уровни 1..floors; уровень floors — крыша) ---
  for (let lvl = 1; lvl <= opt.floors; lvl++) {
    const y = base + lvl * H;
    const isRoof = lvl === opt.floors;
    const hasStairBelow = !isRoof || opt.roofAccess;
    const mat: MaterialKind = isRoof ? 'roof' : 'floor';
    if (hasStairBelow) {
      const [hv0, hv1] = laneV((lvl - 1) % 2);
      slabWithHole(b, f, mat, t, t, W - t, D - t, y - SLAB_THICKNESS, y, { u0: s0, v0: hv0, u1: s1, v1: hv1 });
      // Перила вдоль проёма со стороны комнаты / соседней полосы.
      f.box(b, 'stairs', s0, y, hv0 - 0.06, s1, y + 1.0, hv0);
      // Перила у торца проёма, откуда марш начинается снизу.
      const endU = (lvl - 1) % 2 === 0 ? s0 : s1;
      f.box(b, 'stairs', endU - 0.03, y, hv0, endU + 0.03, y + 1.0, hv1);
    } else {
      f.box(b, mat, t, y - SLAB_THICKNESS, t, W - t, y, D - t);
    }
  }

  // Парапет крыши.
  f.box(b, opt.wallMat, 0, top, 0, W, top + PARAPET_HEIGHT, t);
  f.box(b, opt.wallMat, 0, top, D - t, W, top + PARAPET_HEIGHT, D);
  f.box(b, opt.wallMat, 0, top, t, t, top + PARAPET_HEIGHT, D - t);
  f.box(b, opt.wallMat, W - t, top, t, W, top + PARAPET_HEIGHT, D - t);

  // --- Лестницы ---
  const stairs = opt.roofAccess ? opt.floors : opt.floors - 1;
  for (let k = 0; k < stairs; k++) {
    const lane = k % 2;
    const [v0, v1] = laneV(lane);
    buildStair(b, f, base + k * H, v0, v1, s0, s1, lane === 0 ? 1 : -1);
  }

  // Укрытия внутри: ящики на первом этаже.
  const crates = rng.int(0, 2);
  for (let i = 0; i < crates; i++) {
    const u = rng.range(t + 0.6, W - t - 1.6);
    const v = rng.range(t + 1.5, Math.max(t + 1.6, stairwellFront - 1.6));
    f.box(b, 'crate', u, base, v, u + 1, base + 1, v + 1);
  }
}

function addDoor(b: LayoutBuilder, f: LocalFrame, uHinge: number, vCenter: number, inwardSign: number, base: number): void {
  const p = f.point(uHinge, vCenter);
  b.doors.push({
    hinge: { x: p.x, y: base, z: p.z },
    span: f.dir(1, 0),
    inward: f.dir(0, inwardSign),
    width: DOOR_WIDTH,
    height: DOOR_HEIGHT - 0.05,
  });
}

/** Перекрытие с прямоугольным проёмом: до 4 боксов вокруг дыры. */
function slabWithHole(
  b: LayoutBuilder, f: LocalFrame, mat: MaterialKind,
  u0: number, v0: number, u1: number, v1: number, y0: number, y1: number,
  hole: { u0: number; v0: number; u1: number; v1: number },
): void {
  f.box(b, mat, u0, y0, v0, u1, y1, hole.v0);
  f.box(b, mat, u0, y0, hole.v1, u1, y1, v1);
  f.box(b, mat, u0, y0, hole.v0, hole.u0, y1, hole.v1);
  f.box(b, mat, hole.u1, y0, hole.v0, u1, y1, hole.v1);
}

/**
 * Марш: визуальные ступени (без коллизии) + невидимый наклонный клин-коллайдер,
 * по которому плавно идёт контроллер игрока.
 * dir = +1: подъём от uA к uB; dir = −1: от uB к uA.
 */
function buildStair(
  b: LayoutBuilder, f: LocalFrame, y0: number,
  v0: number, v1: number, uA: number, uB: number, dir: 1 | -1,
): void {
  const steps = Math.round(FLOOR_HEIGHT / STAIR_RISER);
  for (let i = 0; i < steps; i++) {
    const yTop = y0 + (i + 1) * STAIR_RISER;
    const ua = dir === 1 ? uA + i * STAIR_TREAD : uB - (i + 1) * STAIR_TREAD;
    const ub = ua + STAIR_TREAD;
    // Каждая ступень — отдельный короткий бокс (лестница «висит»: виден проход под маршем).
    f.box(b, 'stairs', ua, Math.max(y0, yTop - 0.35), v0 + 0.02, ub, yTop, v1 - 0.02, false);
  }
  const lowU = dir === 1 ? uA : uB;
  const highU = dir === 1 ? uB : uA;
  const pts: number[] = [];
  const corner = (u: number, y: number, v: number): void => {
    const p = f.point(u, v);
    pts.push(p.x, y, p.z);
  };
  // Тонкий наклонный клин (толщина 0.3), чтобы под маршем оставался проход.
  const thick = 0.3;
  for (const v of [v0 + 0.02, v1 - 0.02]) {
    corner(lowU, y0, v);
    corner(highU, y0 + FLOOR_HEIGHT, v);
    corner(highU, y0 + FLOOR_HEIGHT - thick, v);
    corner(lowU + (highU - lowU) * (thick / FLOOR_HEIGHT), y0, v);
  }
  b.ramp(pts);
}

export interface SolidOptions {
  wallMat: MaterialKind;
  floors: number;
  litChance: number;
  slots?: FacadeSlots;
}

/** «Глухое» здание (фон и силуэт): сплошной объём + стёкла окон + детали. */
export function buildSolid(b: LayoutBuilder, f: LocalFrame, rng: Rng, opt: SolidOptions): void {
  const { W, D } = f;
  const base = SIDEWALK_HEIGHT;
  const top = base + opt.floors * FLOOR_HEIGHT;
  f.box(b, opt.wallMat, 0, 0, 0, W, top, D);
  // Парапет-«карниз» (небольшой выступ — опора для паркура по крышам).
  f.box(b, 'roof', -0.15, top, -0.15, W + 0.15, top + 0.3, D + 0.15);

  const spacing = rng.pick([2.6, 3.0, 3.4]);
  const protrude = 0.05;
  const panes = (len: number, place: (a: number, bb: number, y0: number, y1: number, mat: MaterialKind) => void): void => {
    const ops = windowOpenings(0, len, spacing, []);
    for (let fl = 0; fl < opt.floors; fl++) {
      const y = base + fl * FLOOR_HEIGHT;
      for (const o of ops) {
        place(o.a, o.b, y + WINDOW_SILL, y + WINDOW_TOP, rng.chance(opt.litChance) ? 'windowLit' : 'windowDark');
      }
    }
  };
  panes(W, (a, bb, y0, y1, m) => f.box(b, m, a, y0, -protrude, bb, y1, 0, false));
  panes(W, (a, bb, y0, y1, m) => f.box(b, m, a, y0, D, bb, y1, D + protrude, false));
  panes(D, (a, bb, y0, y1, m) => f.box(b, m, -protrude, y0, a, 0, y1, bb, false));
  panes(D, (a, bb, y0, y1, m) => f.box(b, m, W, y0, a, W + protrude, y1, bb, false));

  // Кондиционеры на фасаде — паркур-уступы.
  addWallUnits(b, f, rng, opt.floors, opt.slots);
}

/** Занятые места на фасадах: [сторона, u0, u1, y0, y1] — чтобы предметы не висели друг над другом. */
export type FacadeSlots = Array<{ side: number; a0: number; a1: number; y0: number; y1: number }>;

/** Свободно ли место: по горизонтали рядом (с зазором) не должно быть предмета ближе 2.4 м по высоте. */
function facadeFree(slots: FacadeSlots, side: number, a0: number, a1: number, y0: number, y1: number): boolean {
  return !slots.some((s) => s.side === side && a0 < s.a1 + 0.5 && a1 > s.a0 - 0.5 && y0 < s.y1 + 2.4 && y1 > s.y0 - 2.4);
}

/** Кондиционеры на фасадах: выступ 0.6 м, на них можно запрыгнуть. */
export function addWallUnits(b: LayoutBuilder, f: LocalFrame, rng: Rng, floors: number, slots: FacadeSlots = []): void {
  const count = rng.int(0, 2 + floors);
  const w = 0.9;
  const depth = 0.6;
  const h = 0.55;
  for (let i = 0; i < count; i++) {
    const fl = rng.int(0, Math.max(0, floors - 1));
    const y = SIDEWALK_HEIGHT + fl * FLOOR_HEIGHT + rng.pick([2.3, 2.6]);
    const side = rng.int(0, 3);
    const len = side < 2 ? f.W : f.D;
    const a = rng.range(0.5, Math.max(0.6, len - 1.5));
    if (!facadeFree(slots, side, a, a + w, y, y + h)) continue;
    slots.push({ side, a0: a, a1: a + w, y0: y, y1: y + h });
    switch (side) {
      case 0: f.box(b, 'ac', a, y, -depth, a + w, y + h, 0); break;
      case 1: f.box(b, 'ac', a, y, f.D, a + w, y + h, f.D + depth); break;
      case 2: f.box(b, 'ac', -depth, y, a, 0, y + h, a + w); break;
      default: f.box(b, 'ac', f.W, y, a, f.W + depth, y + h, a + w); break;
    }
  }
}

/**
 * Паркур-маршрут на крышу невысокого здания: ящик 1 м → штабель 2 м у стены →
 * лесенка кондиционеров → парапет. Каждый шаг ≤ 1.2 м (высота mantle).
 * Кондиционеры идут вдоль фасада с зазором STEP_GAP, чтобы над точкой приземления
 * оставалось место. Маршрут целиком помещается на фасаде; возвращает false, если не влез.
 */
const ROUTE_AC_W = 0.9;
const ROUTE_STEP_GAP = 0.5;
export function addClimbRoute(b: LayoutBuilder, f: LocalFrame, rng: Rng, roofTop: number, slots: FacadeSlots = []): boolean {
  // Высоты кондиционеров (низ): первый на 0.45 выше штабеля, далее +1 м,
  // пока до верха парапета больше 1.1 м.
  const ys: number[] = [];
  let y = SIDEWALK_HEIGHT + 2 + 0.45;
  ys.push(y);
  while (roofTop - (y + 0.55) > 1.1) {
    y += 1.0;
    ys.push(y);
  }
  const pitch = ROUTE_AC_W + ROUTE_STEP_GAP;
  const length = 1 + 0.2 + ys.length * pitch; // штабель + зазор + кондиционеры
  if (length > f.W - 1) return false;

  const dir = rng.chance(0.5) ? 1 : -1;
  const start = dir === 1 ? rng.range(0.5, f.W - 0.5 - length) : rng.range(0.5 + length, f.W - 0.5);
  // Интервал [a, a+w] вдоль фасада с учётом направления.
  const span = (off: number, w: number): [number, number] =>
    dir === 1 ? [start + off, start + off + w] : [start - off - w, start - off];

  const [c0, c1] = span(0, 1);
  // Слоты, которые займёт маршрут — проверяем, что случайные кондиционеры их не перекрыли.
  const planned = ys.map((yy, i) => {
    const [a0, a1] = span(1.2 + i * pitch, ROUTE_AC_W);
    return { side: 0, a0, a1, y0: yy, y1: yy + 0.55 };
  });
  const others = slots.filter((s) => s.side === 0);
  if (planned.some((p) => others.some((o) => p.a0 < o.a1 + 0.5 && p.a1 > o.a0 - 0.5 && p.y0 < o.y1 + 2.4 && p.y1 > o.y0 - 2.4))) {
    return false;
  }
  if (others.some((o) => c0 < o.a1 + 0.5 && c1 > o.a0 - 0.5 && o.y0 < SIDEWALK_HEIGHT + 2 + 2.4)) return false;

  f.box(b, 'crate', c0, SIDEWALK_HEIGHT, -2.1, c1, SIDEWALK_HEIGHT + 1, -1.1);
  f.box(b, 'crate', c0, SIDEWALK_HEIGHT, -1.0, c1, SIDEWALK_HEIGHT + 2, 0);
  for (const p of planned) {
    f.box(b, 'ac', p.a0, p.y0, -0.6, p.a1, p.y1, 0);
    slots.push(p);
  }
  return true;
}
