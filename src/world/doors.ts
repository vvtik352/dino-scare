import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { Physics } from '../core/physics';
import type { Materials } from '../render/materials';
import type { DoorSpec } from './layout';

/**
 * Двери (ТЗ 3.1): открываются/закрываются клавишей E, открытие шумит (ТЗ 3.4: 0.5).
 * Коллайдер двери — кинематическое тело, поворачивающееся вокруг петли.
 * Закрытая дверь блокирует обзор T-Rex (рейкасты видимости бьют по ней).
 */
const DOOR_THICKNESS = 0.08;
const OPEN_ANGLE = Math.PI * 0.55;
const SWING_SPEED = 3.2; // рад/с
const INTERACT_DIST = 2.2;

export interface DoorInstance {
  spec: DoorSpec;
  pivot: THREE.Group;
  body: RAPIER.RigidBody;
  baseYaw: number;
  open: boolean;
  angle: number;
  /** Знак поворота при открытии (+1/−1). */
  sign: number;
  center: THREE.Vector3;
}

/**
 * Поворот на угол θ вокруг Y переводит +X в (cos θ, 0, −sin θ).
 * Если базовый поворот совмещает +X со span, то доп. поворот на +90°
 * направляет свободный край в (span.z, −span.x).
 */
function signToward(spec: DoorSpec, dir: { x: number; z: number }): number {
  const endPlus = { x: spec.span.z, z: -spec.span.x };
  return endPlus.x * dir.x + endPlus.z * dir.z >= 0 ? 1 : -1;
}

export class Doors {
  readonly list: DoorInstance[] = [];

  constructor(specs: readonly DoorSpec[], parent: THREE.Object3D, physics: Physics, materials: Materials) {
    const geom = new THREE.BoxGeometry(1, 1, 1);
    const mat = materials.get('door');
    for (const spec of specs) {
      const baseYaw = Math.atan2(-spec.span.z, spec.span.x);
      const pivot = new THREE.Group();
      pivot.position.set(spec.hinge.x, spec.hinge.y, spec.hinge.z);
      const mesh = new THREE.Mesh(geom, mat);
      mesh.scale.set(spec.width - 0.04, spec.height, DOOR_THICKNESS);
      mesh.position.set(spec.width / 2, spec.height / 2, 0);
      pivot.add(mesh);
      parent.add(pivot);

      const body = physics.world.createRigidBody(
        RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(spec.hinge.x, spec.hinge.y, spec.hinge.z),
      );
      physics.world.createCollider(
        RAPIER.ColliderDesc.cuboid((spec.width - 0.04) / 2, spec.height / 2, DOOR_THICKNESS / 2)
          .setTranslation(spec.width / 2, spec.height / 2, 0),
        body,
      );
      const center = new THREE.Vector3(
        spec.hinge.x + spec.span.x * spec.width / 2,
        spec.hinge.y + 1.1,
        spec.hinge.z + spec.span.z * spec.width / 2,
      );
      const inst: DoorInstance = { spec, pivot, body, baseYaw, open: false, angle: 0, sign: signToward(spec, spec.inward), center };
      this.applyTransform(inst, true);
      this.list.push(inst);
    }
  }

  /** Ближайшая дверь, на которую смотрит игрок. */
  findInteractable(eye: THREE.Vector3, look: THREE.Vector3): DoorInstance | null {
    let best: DoorInstance | null = null;
    let bestScore = -Infinity;
    const to = new THREE.Vector3();
    for (const d of this.list) {
      to.subVectors(d.center, eye);
      const dist = to.length();
      if (dist > INTERACT_DIST) continue;
      const dot = to.normalize().dot(look);
      if (dot < 0.5) continue;
      const score = dot - dist * 0.3;
      if (score > bestScore) {
        bestScore = score;
        best = d;
      }
    }
    return best;
  }

  /** Открыть/закрыть. Открывается от игрока, чтобы не толкать его. */
  toggle(d: DoorInstance, playerPos: THREE.Vector3): void {
    d.open = !d.open;
    if (d.open) {
      const away = { x: d.center.x - playerPos.x, z: d.center.z - playerPos.z };
      d.sign = signToward(d.spec, away);
    }
  }

  reset(): void {
    for (const d of this.list) {
      d.open = false;
      d.angle = 0;
      this.applyTransform(d, true);
    }
  }

  update(dt: number): void {
    for (const d of this.list) {
      const target = d.open ? OPEN_ANGLE : 0;
      if (Math.abs(d.angle - target) < 1e-4) continue;
      const step = SWING_SPEED * dt;
      d.angle = d.angle < target ? Math.min(target, d.angle + step) : Math.max(target, d.angle - step);
      this.applyTransform(d, false);
    }
  }

  private applyTransform(d: DoorInstance, immediate: boolean): void {
    const yaw = d.baseYaw + d.angle * d.sign;
    d.pivot.rotation.y = yaw;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const rot = { x: q.x, y: q.y, z: q.z, w: q.w };
    if (immediate) d.body.setRotation(rot, true);
    else d.body.setNextKinematicRotation(rot);
  }
}
