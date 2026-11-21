import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { Input } from '../core/input';
import type { EventBus } from '../core/events';
import { CollisionLayer, interactionGroups, type Physics } from '../core/physics';

/**
 * Кинематический контроллер игрока от первого лица (ТЗ 3.2).
 *
 * Движение: KinematicCharacterController из Rapier (скольжение по стенам,
 * автоступеньки, привязка к земле). Вертикальная скорость считаем сами.
 * Паркур: coyote time, jump buffer, vault/mantle на уступы до 1.2 м.
 * Шум: события `noise` (ТЗ 3.4) — шаги по пройденному расстоянию, прыжки, приземления.
 */

export interface PlayerSettings {
  mouseSensitivity: number;
}

const STAND_HEIGHT = 1.8;
const CROUCH_HEIGHT = 1.1;
const RADIUS = 0.3;
const EYE_OFFSET = 0.12; // глаза ниже макушки

const WALK_SPEED = 3.6;
const RUN_SPEED = 6.5;
const CROUCH_SPEED = 1.7;
const GROUND_ACCEL = 40;
const AIR_ACCEL = 8;
const GRAVITY = 22;
const JUMP_VELOCITY = 7.0; // ≈ 1.1 м высоты прыжка
const MAX_FALL_SPEED = 40;

const COYOTE_TIME = 0.1;
const JUMP_BUFFER = 0.1;

const MANTLE_MAX_HEIGHT = 1.2; // над ступнями (ТЗ: vault/mantle до 1.2 м)
const MANTLE_MIN_HEIGHT = 0.45; // ниже — это ступенька, её берёт autostep
const MANTLE_REACH = 0.75;
const MANTLE_DURATION = 0.38;

/** Громкость шагов по ТЗ 3.4. */
export const NOISE = {
  crouchStep: 0.1,
  walkStep: 0.3,
  runStep: 0.8,
  jump: 0.6,
  land: 0.6,
  door: 0.5,
} as const;

export type MoveMode = 'idle' | 'crouch' | 'walk' | 'run' | 'air' | 'mantle';

interface Mantle {
  from: THREE.Vector3;
  to: THREE.Vector3;
  t: number;
}

export class Player {
  /** Позиция ступней (низ капсулы). */
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  yaw = 0;
  pitch = 0;

  grounded = false;
  crouching = false;
  mode: MoveMode = 'idle';
  /** Сглаженная «шумность» 0..1 для HUD. */
  noiseLevel = 0;
  /** Текущая высота капсулы (плавно меняется при приседании). */
  height = STAND_HEIGHT;
  alive = true;

  readonly collider: RAPIER.Collider;
  private readonly controller: RAPIER.KinematicCharacterController;
  private readonly body: RAPIER.RigidBody;

  private timeSinceGrounded = 0;
  private timeSinceJumpPressed = Infinity;
  private stepDistance = 0;
  private airPeakY = 0;
  private mantle: Mantle | null = null;
  private prevPosition = new THREE.Vector3();
  private headBob = 0;
  /** Смещение камеры (для тряски от рычания и т.п.), добавляется в applyCamera. */
  readonly cameraShake = new THREE.Vector3();

  constructor(
    private readonly physics: Physics,
    private readonly input: Input,
    private readonly events: EventBus,
    private readonly settings: PlayerSettings,
    spawn: { x: number; y: number; z: number },
  ) {
    this.body = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(spawn.x, spawn.y, spawn.z),
    );
    this.collider = physics.world.createCollider(
      RAPIER.ColliderDesc.capsule(this.halfSegment(STAND_HEIGHT), RADIUS)
        .setCollisionGroups(interactionGroups(CollisionLayer.Player, CollisionLayer.World))
        .setTranslation(0, STAND_HEIGHT / 2, 0),
      this.body,
    );

    this.controller = physics.world.createCharacterController(0.02);
    this.controller.setUp({ x: 0, y: 1, z: 0 });
    this.controller.setSlideEnabled(true);
    this.controller.enableAutostep(0.45, 0.2, false);
    this.controller.enableSnapToGround(0.3);
    this.controller.setMaxSlopeClimbAngle(THREE.MathUtils.degToRad(50));
    this.controller.setMinSlopeSlideAngle(THREE.MathUtils.degToRad(60));
    this.controller.setApplyImpulsesToDynamicBodies(false);

    this.teleport(spawn);
  }

  get eyeHeight(): number {
    return this.height - EYE_OFFSET;
  }

  get eyePosition(): THREE.Vector3 {
    return new THREE.Vector3(this.position.x, this.position.y + this.eyeHeight, this.position.z);
  }

  /** Центр масс — для проверки видимости динозавром. */
  get chestPosition(): THREE.Vector3 {
    return new THREE.Vector3(this.position.x, this.position.y + this.height * 0.6, this.position.z);
  }

  teleport(p: { x: number; y: number; z: number }): void {
    this.position.set(p.x, p.y, p.z);
    this.prevPosition.copy(this.position);
    this.velocity.set(0, 0, 0);
    this.mantle = null;
    this.body.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
    this.airPeakY = p.y;
  }

  /** Поворот камеры — каждый кадр рендера (мышь не должна зависеть от шага физики). */
  look(): void {
    const { dx, dy } = this.input.takeMouseDelta();
    const s = this.settings.mouseSensitivity;
    this.yaw -= dx * s;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * s, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
  }

  fixedUpdate(dt: number, time: number): void {
    if (!this.alive) return;
    this.prevPosition.copy(this.position);

    if (this.input.wasPressed('Space')) this.timeSinceJumpPressed = 0;
    else this.timeSinceJumpPressed += dt;

    if (this.mantle) {
      this.updateMantle(dt, time);
    } else {
      this.updateCrouch(dt);
      this.updateMovement(dt, time);
    }

    this.updateNoise(dt);
  }

  /** Камера: интерполяция между шагами физики + покачивание при ходьбе. */
  applyCamera(camera: THREE.Camera, alpha: number, frameDt: number): void {
    const p = new THREE.Vector3().lerpVectors(this.prevPosition, this.position, alpha);
    const horizSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    if (this.grounded && horizSpeed > 0.5) {
      this.headBob += frameDt * horizSpeed * 1.9;
    } else {
      this.headBob += frameDt * 2; // затухание фазы, чтобы не замирало в пике
    }
    const bobAmp = this.grounded ? Math.min(horizSpeed / RUN_SPEED, 1) * 0.045 : 0;
    camera.position.set(
      p.x + this.cameraShake.x,
      p.y + this.eyeHeight + Math.sin(this.headBob * 2) * bobAmp + this.cameraShake.y,
      p.z + this.cameraShake.z,
    );
    camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, Math.sin(this.headBob) * bobAmp * 0.15, 'YXZ'));
  }

  // ---------------------------------------------------------------------------

  private halfSegment(height: number): number {
    return Math.max(0.01, height / 2 - RADIUS);
  }

  private wishDirection(): THREE.Vector3 {
    const i = this.input;
    const f = (i.isDown('KeyW') ? 1 : 0) - (i.isDown('KeyS') ? 1 : 0);
    const r = (i.isDown('KeyD') ? 1 : 0) - (i.isDown('KeyA') ? 1 : 0);
    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const dir = forward.multiplyScalar(f).add(right.multiplyScalar(r));
    if (dir.lengthSq() > 1) dir.normalize();
    return dir;
  }

  private updateCrouch(dt: number): void {
    const wantCrouch = this.input.isDown('ControlLeft') || this.input.isDown('KeyC');
    if (wantCrouch) {
      this.crouching = true;
    } else if (this.crouching && this.canStandUp()) {
      this.crouching = false;
    }
    const target = this.crouching ? CROUCH_HEIGHT : STAND_HEIGHT;
    const prev = this.height;
    this.height = THREE.MathUtils.damp(this.height, target, 14, dt);
    if (Math.abs(this.height - prev) > 1e-4) this.resizeCapsule();
  }

  private resizeCapsule(): void {
    const shape = this.collider.shape as RAPIER.Capsule;
    shape.halfHeight = this.halfSegment(this.height);
    this.collider.setShape(shape);
    this.collider.setTranslationWrtParent({ x: 0, y: this.height / 2, z: 0 });
  }

  /** Есть ли место над головой, чтобы встать. */
  private canStandUp(): boolean {
    const origin = { x: this.position.x, y: this.position.y + this.height - 0.05, z: this.position.z };
    const need = STAND_HEIGHT - this.height + 0.05;
    for (const [ox, oz] of [[0, 0], [RADIUS * 0.7, 0], [-RADIUS * 0.7, 0], [0, RADIUS * 0.7], [0, -RADIUS * 0.7]] as const) {
      if (this.physics.raycast({ x: origin.x + ox, y: origin.y, z: origin.z + oz }, { x: 0, y: 1, z: 0 }, need)) return false;
    }
    return true;
  }

  private updateMovement(dt: number, time: number): void {
    const wish = this.wishDirection();
    const running = this.input.isDown('ShiftLeft') && !this.crouching && wish.lengthSq() > 0;
    const speed = this.crouching ? CROUCH_SPEED : running ? RUN_SPEED : WALK_SPEED;

    // Горизонтальное ускорение к целевой скорости.
    const accel = this.grounded ? GROUND_ACCEL : AIR_ACCEL;
    const target = wish.multiplyScalar(speed);
    const dvx = target.x - this.velocity.x;
    const dvz = target.z - this.velocity.z;
    const dvLen = Math.hypot(dvx, dvz);
    const maxDv = accel * dt;
    if (dvLen > maxDv) {
      this.velocity.x += (dvx / dvLen) * maxDv;
      this.velocity.z += (dvz / dvLen) * maxDv;
    } else {
      this.velocity.x = target.x;
      this.velocity.z = target.z;
    }

    // Прыжок / mantle (coyote time + jump buffer).
    const canJump = this.timeSinceGrounded <= COYOTE_TIME;
    // В воздухе с зажатым прыжком — цепляемся за уступ (прыжок + mantle = до ~2.2 м).
    if (!this.grounded && this.input.isDown('Space') && this.velocity.y < 3 && this.tryStartMantle()) {
      this.timeSinceJumpPressed = Infinity;
      return;
    }
    if (this.timeSinceJumpPressed <= JUMP_BUFFER) {
      if (this.tryStartMantle()) {
        this.timeSinceJumpPressed = Infinity;
        return;
      }
      if (canJump && !this.crouching) {
        this.velocity.y = JUMP_VELOCITY;
        this.timeSinceGrounded = Infinity;
        this.timeSinceJumpPressed = Infinity;
        this.grounded = false;
        this.emitNoise(NOISE.jump, 'jump', time);
      }
    }

    // Гравитация.
    if (!this.grounded || this.velocity.y > 0) {
      this.velocity.y = Math.max(this.velocity.y - GRAVITY * dt, -MAX_FALL_SPEED);
    } else {
      // На земле вертикальной скорости нет: подъём по склону делает сам контроллер,
      // спуск — snap-to-ground. Давление вниз «съедало» бы горизонтальную скорость на рампах.
      this.velocity.y = 0;
    }

    // Без snap в прыжке, иначе контроллер тянет обратно на землю.
    if (this.velocity.y > 0) this.controller.disableSnapToGround();
    else this.controller.enableSnapToGround(0.3);

    const desired = { x: this.velocity.x * dt, y: this.velocity.y * dt, z: this.velocity.z * dt };
    this.controller.computeColliderMovement(this.collider, desired, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS);
    const moved = this.controller.computedMovement();
    const wasGrounded = this.grounded;
    this.grounded = this.controller.computedGrounded();

    this.position.x += moved.x;
    this.position.y += moved.y;
    this.position.z += moved.z;
    this.body.setNextKinematicTranslation({ x: this.position.x, y: this.position.y, z: this.position.z });

    // Удар головой о потолок.
    if (this.velocity.y > 0 && moved.y < desired.y * 0.5) this.velocity.y = 0;
    // Гасим компоненту скорости, направленную в стены (не в пол/рампы),
    // чтобы после прыжка в стену не «прилипать» с накопленной скоростью.
    for (let i = 0; i < this.controller.numComputedCollisions(); i++) {
      const c = this.controller.computedCollision(i);
      if (!c) continue;
      const n = c.normal1;
      if (Math.abs(n.y) > 0.3) continue;
      const len = Math.hypot(n.x, n.z);
      if (len < 1e-4) continue;
      const nx = n.x / len, nz = n.z / len;
      const into = this.velocity.x * nx + this.velocity.z * nz;
      if (into < 0) {
        this.velocity.x -= into * nx;
        this.velocity.z -= into * nz;
      }
    }

    if (this.grounded) {
      if (!wasGrounded) this.onLanded(time);
      this.timeSinceGrounded = 0;
      this.airPeakY = this.position.y;
    } else {
      this.timeSinceGrounded += dt;
      this.airPeakY = Math.max(this.airPeakY, this.position.y);
    }

    // Шаги.
    const horiz = Math.hypot(moved.x, moved.z);
    if (this.grounded && horiz > 1e-4) {
      this.stepDistance += horiz;
      const stride = this.crouching ? 0.6 : running ? 1.0 : 0.75;
      if (this.stepDistance >= stride) {
        this.stepDistance -= stride;
        const loud = this.crouching ? NOISE.crouchStep : running ? NOISE.runStep : NOISE.walkStep;
        this.emitNoise(loud, 'step', time);
      }
    }

    this.mode = !this.grounded ? 'air'
      : horiz < 1e-4 ? (this.crouching ? 'crouch' : 'idle')
      : this.crouching ? 'crouch' : running ? 'run' : 'walk';
  }

  private onLanded(time: number): void {
    const fall = this.airPeakY - this.position.y;
    if (fall > 0.5) {
      // Тихое приземление в приседе, громкое — с высоты.
      const loud = Math.min(1, NOISE.land * (this.crouching ? 0.5 : 1) * (0.6 + fall * 0.25));
      this.emitNoise(loud, 'land', time);
    }
  }

  /**
   * Mantle: если перед игроком уступ высотой MANTLE_MIN..MANTLE_MAX над ступнями
   * и над ним достаточно места для капсулы — плавно перемещаем игрока на уступ.
   */
  private tryStartMantle(): boolean {
    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const feet = this.position;

    const side = new THREE.Vector3(-forward.z, 0, forward.x);

    // 1) Вертикальные грани перед игроком: веер лучей на нескольких высотах
    //    (висящий кондиционер ловится, даже если его низ выше пояса) и со
    //    смещением вбок (узкие предметы, если смотришь не точно в центр).
    const hits: Array<{ x: number; z: number; distance: number }> = [];
    for (const h of [MANTLE_MIN_HEIGHT + 0.05, 0.85, MANTLE_MAX_HEIGHT - 0.05]) {
      for (const lat of [0, -0.22, 0.22]) {
        const hit = this.physics.raycast(
          { x: feet.x + side.x * lat, y: feet.y + h, z: feet.z + side.z * lat }, forward, RADIUS + MANTLE_REACH,
        );
        if (hit && Math.abs(hit.normal.y) < 0.3) hits.push({ x: hit.point.x, z: hit.point.z, distance: hit.distance });
      }
    }
    if (hits.length === 0) return false;
    hits.sort((a, b) => a.distance - b.distance);

    // 2) Ищем верх уступа лучом сверху вниз за краем. Сначала глубже (устойчивее),
    //    потом у самого края (узкий подоконник). Если место занято предметом
    //    сверху/сбоку — пробуем сдвинуться вдоль уступа.
    let target: THREE.Vector3 | null = null;
    search: for (const edge of hits) {
      for (const lat of [0, -0.3, 0.3, -0.6, 0.6]) {
        const e = { x: edge.x + side.x * lat, z: edge.z + side.z * lat };
        for (const inset of [0.35, 0.15]) {
          target = this.findLedge(e, forward, inset, feet.y);
          if (target) break search;
        }
      }
    }
    if (!target) return false;

    // Если стоя не помещаемся — забираемся в приседе.
    const standClear = !this.physics.world.intersectionWithShape(
      { x: target.x, y: target.y + STAND_HEIGHT / 2 + 0.03, z: target.z },
      { x: 0, y: 0, z: 0, w: 1 },
      new RAPIER.Capsule(this.halfSegment(STAND_HEIGHT), RADIUS - 0.02),
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      interactionGroups(0xffff, CollisionLayer.World),
    );
    if (!standClear) {
      this.crouching = true;
      this.height = CROUCH_HEIGHT;
      this.resizeCapsule();
    }

    this.mantle = { from: this.position.clone(), to: target, t: 0 };
    this.velocity.set(0, 0, 0);
    this.grounded = false;
    this.mode = 'mantle';
    return true;
  }

  /** Точка на уступе за краем стены, куда может встать хотя бы присевший игрок, или null. */
  private findLedge(
    edge: { x: number; z: number }, forward: THREE.Vector3, inset: number, feetY: number,
  ): THREE.Vector3 | null {
    const probe = { x: edge.x + forward.x * inset, y: feetY + MANTLE_MAX_HEIGHT + 0.3, z: edge.z + forward.z * inset };
    const down = this.physics.raycast(probe, { x: 0, y: -1, z: 0 }, MANTLE_MAX_HEIGHT + 0.3);
    if (!down) return null;
    const rise = down.point.y - feetY;
    if (rise < MANTLE_MIN_HEIGHT || rise > MANTLE_MAX_HEIGHT) return null;
    if (down.normal.y < 0.7) return null; // верх должен быть горизонтальным

    const target = new THREE.Vector3(probe.x, down.point.y + 0.02, probe.z);
    const blocked = this.physics.world.intersectionWithShape(
      { x: target.x, y: target.y + CROUCH_HEIGHT / 2 + 0.03, z: target.z },
      { x: 0, y: 0, z: 0, w: 1 },
      new RAPIER.Capsule(this.halfSegment(CROUCH_HEIGHT), RADIUS - 0.02),
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      interactionGroups(0xffff, CollisionLayer.World),
    );
    return blocked ? null : target;
  }

  private updateMantle(dt: number, time: number): void {
    const m = this.mantle as Mantle;
    m.t = Math.min(1, m.t + dt / MANTLE_DURATION);
    // Сначала поднимаемся, потом переносимся вперёд.
    const up = Math.min(1, m.t / 0.6);
    const fwd = Math.max(0, (m.t - 0.35) / 0.65);
    const ease = (x: number): number => x * x * (3 - 2 * x);
    this.position.set(
      THREE.MathUtils.lerp(m.from.x, m.to.x, ease(fwd)),
      THREE.MathUtils.lerp(m.from.y, m.to.y, ease(up)),
      THREE.MathUtils.lerp(m.from.z, m.to.z, ease(fwd)),
    );
    this.body.setNextKinematicTranslation({ x: this.position.x, y: this.position.y, z: this.position.z });
    if (m.t >= 1) {
      this.mantle = null;
      this.grounded = true;
      this.timeSinceGrounded = 0;
      this.airPeakY = this.position.y;
      this.emitNoise(NOISE.walkStep, 'mantle', time);
    }
  }

  private updateNoise(dt: number): void {
    const target = !this.alive ? 0
      : this.mode === 'run' ? NOISE.runStep
      : this.mode === 'walk' ? NOISE.walkStep
      : this.mode === 'crouch' && Math.hypot(this.velocity.x, this.velocity.z) > 0.1 ? NOISE.crouchStep
      : 0;
    // Пики от событий держатся дольше (выставляются в emitNoise).
    this.noiseLevel = Math.max(target, this.noiseLevel - dt * 0.8);
  }

  private emitNoise(loudness: number, source: string, time: number): void {
    this.noiseLevel = Math.max(this.noiseLevel, loudness);
    this.events.emit('noise', {
      position: this.position.clone(),
      loudness,
      source,
      time,
    });
  }
}
