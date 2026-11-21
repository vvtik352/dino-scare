import type { MaterialKind } from '../render/materials';

/**
 * Описание города как чистые данные (без Three.js/Rapier).
 * Генератор производит CityLayout, City превращает его в меши и коллайдеры,
 * навигация динозавра строит по нему свою сетку.
 */

export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export interface Vec2 {
  x: number;
  z: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Осевой бокс в мировых координатах. */
export interface BoxPrim {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
  mat: MaterialKind;
  collide: boolean;
}

/** Невидимый выпуклый коллайдер (наклон лестницы). Плоский массив xyz. */
export interface RampPrim {
  points: number[];
}

export interface DoorSpec {
  /** Точка петли у пола, в центре толщины стены. */
  hinge: Vec3;
  /** Единичный вектор от петли к свободному краю закрытой двери. */
  span: Vec2;
  /** Единичный вектор внутрь здания (в эту сторону дверь открывается). */
  inward: Vec2;
  width: number;
  height: number;
}

export interface LampSpec {
  /** Позиция источника света (под плафоном). */
  light: Vec3;
  flicker: boolean;
}

export interface ManholeSpec {
  x: number;
  z: number;
}

export interface BuildingInfo {
  rect: Rect;
  floors: number;
  floorHeight: number;
  base: number;
  roofAccess: boolean;
}

export interface CityLayout {
  /** Игровая область (внутри граничных стен). */
  bounds: Rect;
  boxes: BoxPrim[];
  ramps: RampPrim[];
  doors: DoorSpec[];
  lamps: LampSpec[];
  manholes: ManholeSpec[];
  buildings: BuildingInfo[];
  /** Прямоугольники, через которые не может пройти динозавр (здания, контейнеры, ящики). */
  navBlockers: Rect[];
  /** Центры перекрёстков — опорные точки для патрулирования. */
  streetNodes: Vec2[];
  playerSpawn: Vec3;
  dinoSpawn: Vec3;
}
