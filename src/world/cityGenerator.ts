import { hashString, type Rng } from '../utils/rng';
import type { CityLayout, Rect, Vec2 } from './layout';
import { LayoutBuilder, rectD, rectW } from './layoutBuilder';
import {
  LocalFrame, MIN_ENTERABLE_D, MIN_ENTERABLE_W, addClimbRoute, addWallUnits, buildEnterable, buildSolid,
  type FacadeSlots, type Side,
} from './buildings';
import { FLOOR_HEIGHT, PARAPET_HEIGHT, SIDEWALK_HEIGHT } from './constants';

/**
 * Процедурный город (ТЗ 3.1): сетка кварталов с улицами разной ширины,
 * внутри кварталов — ряды участков, разделённые узкими переулками (2–3 м).
 * Широкие улицы — территория T-Rex, переулки и здания — укрытия игрока.
 */
export interface CityParams {
  blocksX: number;
  blocksZ: number;
}

const DEFAULT_PARAMS: CityParams = { blocksX: 4, blocksZ: 4 };

const SIDEWALK_W = 2.5;
const BOUNDARY_WALL_H = 14;

export function generateCity(rng: Rng, params: CityParams = DEFAULT_PARAMS): CityLayout {
  const b = new LayoutBuilder();

  // --- Сетка: ширины улиц и кварталов ---
  const xs = axisLayout(rng.fork('gridX'), params.blocksX);
  const zs = axisLayout(rng.fork('gridZ'), params.blocksZ);
  const size = { x: xs.total, z: zs.total };
  const bounds: Rect = { x0: 0, z0: 0, x1: size.x, z1: size.z };

  // Дорожное полотно на всю площадь.
  b.box('road', -20, -1, -20, size.x + 20, 0, size.z + 20);
  // Граничные стены.
  const wt = 1;
  b.box('boundary', -wt, 0, -wt, size.x + wt, BOUNDARY_WALL_H, 0);
  b.box('boundary', -wt, 0, size.z, size.x + wt, BOUNDARY_WALL_H, size.z + wt);
  b.box('boundary', -wt, 0, 0, 0, BOUNDARY_WALL_H, size.z);
  b.box('boundary', size.x, 0, 0, size.x + wt, BOUNDARY_WALL_H, size.z);

  // --- Узлы улиц (перекрёстки) для патрулирования ---
  const streetNodes: Vec2[] = [];
  for (const sx of xs.streets) for (const sz of zs.streets) streetNodes.push({ x: sx.center, z: sz.center });

  // --- Кварталы ---
  const blockRng = rng.fork('blocks');
  for (const bx of xs.blocks) {
    for (const bz of zs.blocks) {
      const rect: Rect = { x0: bx.start, z0: bz.start, x1: bx.end, z1: bz.end };
      buildBlock(b, blockRng, rect);
    }
  }

  // --- Фонари вдоль улиц ---
  placeLamps(b, rng.fork('lamps'), xs.blocks, zs.blocks);

  // --- Люки (заглушки канализации) ---
  const mhRng = rng.fork('manholes');
  for (let i = 0; i < 6; i++) {
    const node = mhRng.pick(streetNodes);
    const along = mhRng.chance(0.5);
    const off = mhRng.range(6, 12) * (mhRng.chance(0.5) ? 1 : -1);
    const x = node.x + (along ? off : 0);
    const z = node.z + (along ? 0 : off);
    if (x < 3 || z < 3 || x > size.x - 3 || z > size.z - 3) continue;
    b.manholes.push({ x, z });
    b.box('manhole', x - 0.45, 0, z - 0.45, x + 0.45, 0.02, z + 0.45, false);
  }

  // --- Точки появления: игрок и динозавр в противоположных углах ---
  const firstX = xs.streets[0];
  const firstZ = zs.streets[0];
  const lastX = xs.streets[xs.streets.length - 1];
  const lastZ = zs.streets[zs.streets.length - 1];
  if (!firstX || !firstZ || !lastX || !lastZ) throw new Error('city: пустая сетка');

  return {
    bounds,
    boxes: b.boxes,
    ramps: b.ramps,
    doors: b.doors,
    lamps: b.lamps,
    manholes: b.manholes,
    buildings: b.buildings,
    navBlockers: b.navBlockers,
    streetNodes,
    playerSpawn: { x: firstX.center, y: 0.1, z: firstZ.center },
    dinoSpawn: { x: lastX.center, y: 0, z: lastZ.center },
  };
}

interface Span {
  start: number;
  end: number;
  center: number;
}

/** Чередование улица/квартал/улица/... вдоль одной оси. */
function axisLayout(rng: Rng, blocks: number): { streets: Span[]; blocks: Span[]; total: number } {
  const streets: Span[] = [];
  const blockSpans: Span[] = [];
  let cursor = 0;
  for (let i = 0; i <= blocks; i++) {
    // Внешнее кольцо — пошире: удобный маршрут патруля.
    const w = rng.range(10, 14);
    streets.push({ start: cursor, end: cursor + w, center: cursor + w / 2 });
    cursor += w;
    if (i === blocks) break;
    const bw = rng.range(30, 44);
    blockSpans.push({ start: cursor, end: cursor + bw, center: cursor + bw / 2 });
    cursor += bw;
  }
  return { streets, blocks: blockSpans, total: cursor };
}

/**
 * Квартал: приподнятый тротуар + один или два ряда участков.
 * Ряды идут вдоль оси «a», фасады смотрят на улицу по оси «b».
 */
function buildBlock(b: LayoutBuilder, rng: Rng, block: Rect): void {
  b.box('sidewalk', block.x0, 0, block.z0, block.x1, SIDEWALK_HEIGHT, block.z1);

  const inner: Rect = {
    x0: block.x0 + SIDEWALK_W, z0: block.z0 + SIDEWALK_W,
    x1: block.x1 - SIDEWALK_W, z1: block.z1 - SIDEWALK_W,
  };
  // Ряды вдоль длинной стороны — так переулки получаются длинными.
  const rowsAlongX = rng.chance(rectW(inner) >= rectD(inner) ? 0.75 : 0.25);
  const aLen = rowsAlongX ? rectW(inner) : rectD(inner);
  const bLen = rowsAlongX ? rectD(inner) : rectW(inner);

  // Прямоугольник в координатах (a, b) → мировой.
  const toWorld = (a0: number, b0: number, a1: number, b1: number): Rect =>
    rowsAlongX
      ? { x0: inner.x0 + a0, z0: inner.z0 + b0, x1: inner.x0 + a1, z1: inner.z0 + b1 }
      : { x0: inner.x0 + b0, z0: inner.z0 + a0, x1: inner.x0 + b1, z1: inner.z0 + a1 };
  // Фасад к улице «снизу» (b=0) или «сверху» (b=bLen).
  const frontSide = (low: boolean): Side => (rowsAlongX ? (low ? 'minZ' : 'maxZ') : (low ? 'minX' : 'maxX'));

  const twoRows = bLen >= 2 * MIN_ENTERABLE_D + 2.5 && rng.chance(0.85);
  if (twoRows) {
    const alley = rng.range(2.0, 3.0);
    const split = bLen / 2 + rng.range(-2, 2);
    const r0b1 = split - alley / 2;
    const r1b0 = split + alley / 2;
    buildRow(b, rng, aLen, 0, r0b1, toWorld, frontSide(true), true);
    buildRow(b, rng, aLen, r1b0, bLen, toWorld, frontSide(false), true);
    // Хлам в продольном переулке.
    scatterAlleyProps(b, rng, aLen, r0b1, r1b0, toWorld);
  } else {
    buildRow(b, rng, aLen, 0, bLen, toWorld, frontSide(rng.chance(0.5)), false);
  }
}

type ToWorld = (a0: number, b0: number, a1: number, b1: number) => Rect;

/** Ряд участков вдоль оси a; ширина ряда по b = [b0, b1]. */
function buildRow(
  b: LayoutBuilder, rng: Rng, aLen: number, b0: number, b1: number,
  toWorld: ToWorld, front: Side, backOnAlley: boolean,
): void {
  const frontIsLow = front === 'minZ' || front === 'minX';
  let a = 0;
  while (aLen - a > 4) {
    const remaining = aLen - a;
    let w = rng.range(9, 16);
    if (remaining - w < 9) w = remaining; // остаток слишком мал для отдельного участка
    const lotA0 = a;
    const lotA1 = a + w;
    a = lotA1;

    // Поперечный переулок между участками.
    let gap = 0;
    if (aLen - a > 9 && rng.chance(0.4)) gap = rng.range(2.0, 3.0);

    // Глубина здания: не больше 16 м, остаток — двор со стороны тыла.
    const rowDepth = b1 - b0;
    const depth = Math.min(rowDepth, rng.range(10, 16));
    const lb0 = frontIsLow ? b0 : b1 - depth;
    const lb1 = frontIsLow ? b0 + depth : b1;
    const lot = toWorld(lotA0, lb0, lotA1, lb1);
    buildLot(b, rng, lot, front, backOnAlley || depth < rowDepth);

    // Задний двор (если здание мельче ряда) — место для хлама и укрытий.
    if (depth < rowDepth - 2) {
      const yb0 = frontIsLow ? b0 + depth : b0;
      const yb1 = frontIsLow ? b1 : b1 - depth;
      scatterYardProps(b, rng, toWorld(lotA0, yb0, lotA1, yb1));
    }

    if (gap > 0) {
      const alleyRect = toWorld(a, b0, a + gap, b1);
      scatterCrossAlleyProps(b, rng, alleyRect);
      a += gap;
    }
  }
}

function buildLot(b: LayoutBuilder, rng: Rng, lot: Rect, front: Side, backAccessible: boolean): void {
  const f = new LocalFrame(lot, front);
  const roll = rng.next();

  // Пустой участок: стоянка/склад с контейнерами — открытое, но с укрытиями.
  if (roll < 0.12) {
    scatterYardProps(b, rng, lot);
    return;
  }

  b.blockNav(lot);
  const canEnter = f.W >= MIN_ENTERABLE_W && f.D >= MIN_ENTERABLE_D;
  if (canEnter && roll < 0.7) {
    const floors = rng.int(1, 3);
    const roofAccess = rng.chance(0.75);
    buildEnterable(b, f, rng, { wallMat: wallMaterialFor(lot), floors, backDoor: backAccessible && rng.chance(0.6), roofAccess });
    // Сначала маршрут на крышу (он важнее), потом случайные кондиционеры вокруг него.
    const slots: FacadeSlots = [];
    if (floors <= 2 && f.W >= 8 && rng.chance(0.35)) {
      addClimbRoute(b, f, rng, SIDEWALK_HEIGHT + floors * FLOOR_HEIGHT + PARAPET_HEIGHT, slots);
    }
    addWallUnits(b, f, rng, floors, slots);
    b.buildings.push({ rect: lot, floors, floorHeight: FLOOR_HEIGHT, base: SIDEWALK_HEIGHT, roofAccess });
  } else {
    const floors = rng.int(2, 5);
    const slots: FacadeSlots = [];
    if (floors <= 2 && f.W >= 8 && rng.chance(0.4)) {
      addClimbRoute(b, f, rng, SIDEWALK_HEIGHT + floors * FLOOR_HEIGHT + 0.3, slots);
    }
    buildSolid(b, f, rng, { wallMat: wallMaterialFor(lot), floors, litChance: 0.12, slots });
    b.buildings.push({ rect: lot, floors, floorHeight: FLOOR_HEIGHT, base: SIDEWALK_HEIGHT, roofAccess: false });
  }
}

/** Кирпич или штукатурка — детерминированно по позиции участка (не сдвигает rng генерации). */
function wallMaterialFor(lot: Rect): 'wall' | 'plaster' {
  return hashString(`${lot.x0.toFixed(2)}:${lot.z0.toFixed(2)}`) % 100 < 55 ? 'wall' : 'plaster';
}

function prop(b: LayoutBuilder, mat: 'crate' | 'container' | 'dumpster', x0: number, z0: number, x1: number, z1: number, h: number): void {
  b.box(mat, x0, SIDEWALK_HEIGHT, z0, x1, SIDEWALK_HEIGHT + h, z1);
  b.blockNav({ x0, z0, x1, z1 });
}

/** Двор/стоянка: контейнеры (2.6 м — запрыгнуть с ящика), мусорные баки, ящики. */
function scatterYardProps(b: LayoutBuilder, rng: Rng, r: Rect): void {
  const w = rectW(r);
  const d = rectD(r);
  if (w < 3 || d < 3) return;
  const placed: Rect[] = [];
  const tryPlace = (sx: number, sz: number): Rect | null => {
    if (sx > w - 1 || sz > d - 1) return null;
    for (let attempt = 0; attempt < 6; attempt++) {
      const x0 = r.x0 + rng.range(0.5, w - sx - 0.5);
      const z0 = r.z0 + rng.range(0.5, d - sz - 0.5);
      const c: Rect = { x0, z0, x1: x0 + sx, z1: z0 + sz };
      // Между объектами оставляем проход ≥ 1.2 м.
      if (placed.some((p) => c.x0 < p.x1 + 1.2 && c.x1 + 1.2 > p.x0 && c.z0 < p.z1 + 1.2 && c.z1 + 1.2 > p.z0)) continue;
      placed.push(c);
      return c;
    }
    return null;
  };

  const containers = Math.min(3, Math.floor((w * d) / 120));
  for (let i = 0; i < containers; i++) {
    const along = rng.chance(0.5);
    const c = tryPlace(along ? 6 : 2.4, along ? 2.4 : 6);
    if (!c) continue;
    prop(b, 'container', c.x0, c.z0, c.x1, c.z1, 2.6);
    // Ящик рядом — ступенька на крышу контейнера.
    const s = tryPlace(1, 1);
    if (s) prop(b, 'crate', s.x0, s.z0, s.x1, s.z1, 1.2);
  }
  const small = rng.int(1, 4);
  for (let i = 0; i < small; i++) {
    if (rng.chance(0.5)) {
      const c = tryPlace(1.8, 1.2);
      if (c) prop(b, 'dumpster', c.x0, c.z0, c.x1, c.z1, 1.15);
    } else {
      const c = tryPlace(1, 1);
      if (c) prop(b, 'crate', c.x0, c.z0, c.x1, c.z1, 1);
    }
  }
}

/** Продольный переулок: баки и ящики у стен, проход сохраняется. */
function scatterAlleyProps(b: LayoutBuilder, rng: Rng, aLen: number, b0: number, b1: number, toWorld: ToWorld): void {
  const count = Math.floor(aLen / 12);
  for (let i = 0; i < count; i++) {
    const a = rng.range(1, aLen - 3);
    const atLow = rng.chance(0.5);
    const isCrate = rng.chance(0.5);
    const len = isCrate ? 1 : 1.8;
    const depth = isCrate ? 0.9 : 1.0;
    const pb0 = atLow ? b0 : b1 - depth;
    const r = toWorld(a, pb0, a + len, pb0 + depth);
    prop(b, isCrate ? 'crate' : 'dumpster', r.x0, r.z0, r.x1, r.z1, isCrate ? 1 : 1.15);
  }
}

function scatterCrossAlleyProps(b: LayoutBuilder, rng: Rng, r: Rect): void {
  if (!rng.chance(0.5)) return;
  const w = rectW(r);
  const d = rectD(r);
  const alongX = w > d;
  const len = alongX ? w : d;
  const t = rng.range(2, Math.max(2.1, len - 3));
  const box = alongX
    ? { x0: r.x0 + t, z0: r.z0, x1: r.x0 + t + 1, z1: r.z0 + 0.9 }
    : { x0: r.x0, z0: r.z0 + t, x1: r.x0 + 0.9, z1: r.z0 + t + 1 };
  prop(b, 'crate', box.x0, box.z0, box.x1, box.z1, 1);
}

/** Фонари по краю тротуара каждого квартала. */
function placeLamps(b: LayoutBuilder, rng: Rng, xBlocks: Span[], zBlocks: Span[]): void {
  const spacing = 17;
  const inset = 0.5;
  for (const bx of xBlocks) {
    for (const bz of zBlocks) {
      const edges: Array<{ ax: number; az: number; dx: number; dz: number; len: number }> = [
        { ax: bx.start, az: bz.start + inset, dx: 1, dz: 0, len: bx.end - bx.start },
        { ax: bx.start, az: bz.end - inset, dx: 1, dz: 0, len: bx.end - bx.start },
        { ax: bx.start + inset, az: bz.start, dx: 0, dz: 1, len: bz.end - bz.start },
        { ax: bx.end - inset, az: bz.start, dx: 0, dz: 1, len: bz.end - bz.start },
      ];
      for (const e of edges) {
        const n = Math.max(1, Math.round(e.len / spacing));
        for (let i = 0; i < n; i++) {
          if (rng.chance(0.2)) continue; // часть фонарей не работает — тёмные участки
          const t = ((i + 0.5) / n) * e.len;
          const x = e.ax + e.dx * t;
          const z = e.az + e.dz * t;
          const y0 = SIDEWALK_HEIGHT;
          b.box('lampPost', x - 0.08, y0, z - 0.08, x + 0.08, y0 + 4.6, z + 0.08);
          b.box('lampGlow', x - 0.25, y0 + 4.45, z - 0.25, x + 0.25, y0 + 4.6, z + 0.25, false);
          b.lamps.push({ light: { x, y: y0 + 4.3, z }, flicker: rng.chance(0.15) });
        }
      }
    }
  }
}
