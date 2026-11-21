import * as THREE from 'three';
import type { Physics } from '../core/physics';

/**
 * Сенсоры динозавра (ТЗ 3.3): слух и зрение. Чистая логика без состояния FSM.
 */

export const HEARING_MAX_RANGE = 50;

export interface HeardNoise {
  position: THREE.Vector3;
  loudness: number;
  time: number;
  /** Насколько уверенно услышано: 1 — рядом, 0 — на границе слышимости. */
  strength: number;
}

/**
 * Слышит, если distance < loudness × maxRange (ТЗ 3.4).
 * Стены глушат звук: если между источником и динозавром нет прямой видимости,
 * эффективная дальность снижается.
 */
export function hearNoise(
  physics: Physics,
  ear: THREE.Vector3,
  source: THREE.Vector3,
  loudness: number,
  maxRange = HEARING_MAX_RANGE,
): number {
  const dist = ear.distanceTo(source);
  let range = loudness * maxRange;
  if (dist >= range) return 0;
  const lifted = source.clone();
  lifted.y += 0.5;
  if (!physics.lineOfSight(ear, lifted)) range *= 0.6;
  if (dist >= range) return 0;
  return 1 - dist / range;
}

export interface VisionParams {
  fovDeg: number;
  range: number;
}

export const DEFAULT_VISION: VisionParams = { fovDeg: 90, range: 40 };

export interface VisionTarget {
  /** Точки тела игрока для проверки видимости (голова, грудь). */
  points: THREE.Vector3[];
  crouching: boolean;
  /** Скорость игрока — движение заметнее. */
  speed: number;
  /** Освещённость в точке игрока 0..1 (в темноте видно хуже). */
  light: number;
}

/**
 * Возвращает «скорость заметности» в секунду (0 — не видно).
 * Динозавр накапливает её в awareness; при 1 — обнаружение.
 */
export function visibility(
  physics: Physics,
  eye: THREE.Vector3,
  forward: THREE.Vector3,
  target: VisionTarget,
  params: VisionParams = DEFAULT_VISION,
): number {
  const halfFov = THREE.MathUtils.degToRad(params.fovDeg / 2);
  let best = 0;
  for (const p of target.points) {
    const to = p.clone().sub(eye);
    const dist = to.length();
    if (dist > params.range || dist < 1e-3) continue;
    to.divideScalar(dist);
    // Угол в горизонтальной плоскости (T-Rex смотрит по сторонам, но не вверх/вниз).
    const flatTo = new THREE.Vector3(to.x, 0, to.z).normalize();
    const flatFwd = new THREE.Vector3(forward.x, 0, forward.z).normalize();
    const angle = Math.acos(THREE.MathUtils.clamp(flatTo.dot(flatFwd), -1, 1));
    // Вблизи (< 6 м) периферийное зрение шире.
    const fov = dist < 6 ? halfFov * 1.6 : halfFov;
    if (angle > fov) continue;
    if (!physics.lineOfSight(eye, p)) continue;

    const distFactor = 1 - dist / params.range; // 1 рядом, 0 на краю
    const centerFactor = 1 - (angle / fov) * 0.5;
    best = Math.max(best, distFactor * centerFactor);
  }
  if (best === 0) return 0;

  let rate = 0.6 + best * 4.5; // рядом — почти мгновенно
  if (target.crouching) rate *= 0.45;
  rate *= 0.5 + Math.min(target.speed / 4, 1) * 0.7; // неподвижный — менее заметен
  rate *= 0.35 + 0.65 * target.light;
  return rate;
}
