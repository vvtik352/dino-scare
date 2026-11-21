import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { EventBus, GameEvents } from '../core/events';
import { CollisionLayer, interactionGroups, type Physics } from '../core/physics';
import type { Materials } from '../render/materials';
import type { Rng } from '../utils/rng';
import type { NavGrid } from '../ai/navGrid';
import type { Rect, Vec2 } from '../world/layout';
import { DEFAULT_VISION, hearNoise, visibility, type VisionTarget } from '../ai/senses';
import { DinosaurModel } from './dinosaurModel';

/**
 * T-Rex (ТЗ 3.3). FSM:
 *   Patrol → (шум) Investigate → (подозрение) Stalk → (обнаружен) Chase → (контакт) Attack
 *   Chase → (потерял) Search → (ничего) Patrol
 *
 * Перемещение — по NavGrid (A*), без физического тела: T-Rex слишком большой,
 * чтобы зайти в переулки и здания, а сетка это уже учитывает.
 */

export type DinoState = 'patrol' | 'investigate' | 'stalk' | 'chase' | 'search' | 'attack';

const SPEED: Record<DinoState, number> = {
  patrol: 3.0,
  investigate: 4.6,
  stalk: 2.4,
  chase: 9.5, // быстрее бегущего игрока (6.5) — на открытой улице не уйти
  search: 3.4,
  attack: 0,
};
const TURN_RATE: Record<DinoState, number> = {
  patrol: 1.5, investigate: 2.2, stalk: 1.8, chase: 3.6, search: 2.0, attack: 4,
};

export const DINO_NAV_RADIUS = 2.2; // радиус для навигации (переулки 2–3 м — непроходимы)
const EYE_HEIGHT = 5.4;
const EAR_HEIGHT = 4.5;
/** Насколько голова выдаётся вперёд от центра тела (м). */
const HEAD_REACH = 3.5;
/** Дистанция «укуса» от головы / от тела по горизонтали и макс. разница высот. */
const BITE_FROM_HEAD = 2.4;
const BITE_FROM_BODY = 2.8;
const ATTACK_HEIGHT = 5.0;
/**
 * «Чит» директора: если игрок стоит под открытым небом, T-Rex через какое-то
 * время примерно узнаёт, где он (с погрешностью, которая уменьшается со временем).
 */
const SKY_HINT_FIRST = 6;
const SKY_HINT_INTERVAL = 7;
const SKY_HINT_FUZZ_MAX = 18;
const SKY_HINT_FUZZ_MIN = 5;
/** Доля патрульных маршрутов, выбираемых рядом с игроком. */
const PATROL_TOWARD_PLAYER = 0.6;
/** Память: через сколько секунд без контакта Chase переходит в Search. */
const LOSE_TARGET_TIME = 4.0;
const SEARCH_DURATION = 18;
const INVESTIGATE_LINGER = 5;
const ROAR_INTERVAL: [number, number] = [8, 15];
/** Громкость шагов: подкрадываясь, T-Rex ступает почти бесшумно. */
const STEP_LOUDNESS: Record<DinoState, number> = {
  patrol: 1, investigate: 0.7, stalk: 0.2, chase: 1, search: 0.6, attack: 1,
};
/** Длина шага T-Rex (м) — частота «бум… бум…». */
const STRIDE = 2.6;

export interface DinoPerceptionTarget {
  position: THREE.Vector3; // ступни
  eye: THREE.Vector3;
  chest: THREE.Vector3;
  crouching: boolean;
  speed: number;
  light: number;
  alive: boolean;
  /** Над игроком открытое небо (не в здании, не под навесом). */
  exposed: boolean;
}

export class Dinosaur {
  readonly position = new THREE.Vector3();
  /** Направление взгляда/движения (угол вокруг Y, 0 = +Z). */
  heading = 0;
  state: DinoState = 'patrol';
  /** 0..1 — накопленная уверенность «вижу игрока». */
  awareness = 0;
  /** 0..1 — подозрение от шумов (для Stalk). */
  suspicion = 0;
  readonly model: DinosaurModel;
  /** Последняя известная позиция игрока. */
  lastKnown: THREE.Vector3 | null = null;
  lastKnownTime = -Infinity;
  /** Скорость за последний шаг (м/с). */
  speed = 0;
  path: Vec2[] = [];
  /** Сенсор-коллайдер (только для отладки/рейкастов игрока в будущем). */
  readonly collider: RAPIER.Collider;

  private target: Vec2 | null = null;
  private stateTime = 0;
  private repathTimer = 0;
  private roarTimer: number;
  private roarAnim = 0;
  private stuckTimer = 0;
  private lastPos = new THREE.Vector3();
  private searchPoints: Vec2[] = [];
  private pendingNoise: GameEvents['noise'] | null = null;
  private unsub: () => void;
  private speedSmoothed = 0;
  private stepDistance = 0;
  private skyTime = 0;
  private hintTimer = SKY_HINT_FIRST;
  /** Истинная позиция игрока — только для выбора района патруля (мягкий «чит»). */
  private playerArea: Vec2 | null = null;

  constructor(
    private readonly physics: Physics,
    private readonly nav: NavGrid,
    private readonly events: EventBus,
    private readonly rng: Rng,
    private readonly patrolNodes: readonly Vec2[],
    /** Контуры зданий: голова T-Rex не может в них проникнуть, а игрока внутри не достать. */
    private readonly buildings: readonly Rect[],
    materials: Materials,
    scene: THREE.Scene,
    spawn: { x: number; y: number; z: number },
  ) {
    this.model = new DinosaurModel(materials);
    scene.add(this.model.root);
    const start = nav.nearestFree(spawn.x, spawn.z) ?? { x: spawn.x, z: spawn.z };
    this.position.set(start.x, 0, start.z);
    this.lastPos.copy(this.position);
    this.roarTimer = rng.range(...ROAR_INTERVAL);

    const body = physics.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
    this.collider = physics.world.createCollider(
      RAPIER.ColliderDesc.capsule(1.5, 1.4)
        .setTranslation(0, 3, 0)
        .setSensor(true)
        .setCollisionGroups(interactionGroups(CollisionLayer.Dino, 0)),
      body,
    );

    this.unsub = events.on('noise', (n) => this.onNoise(n));
    this.syncModel();
  }

  dispose(scene: THREE.Scene): void {
    this.unsub();
    scene.remove(this.model.root);
  }

  /**
   * Голова (глаза/пасть). Выдаётся вперёд на HEAD_REACH, но не дальше ближайшей
   * стены: иначе, стоя вплотную к дому, T-Rex «смотрел» и кусал бы изнутри здания.
   */
  get eye(): THREE.Vector3 {
    const f = this.forward;
    const origin = { x: this.position.x, y: this.position.y + EYE_HEIGHT, z: this.position.z };
    const hit = this.physics.raycast(origin, f, HEAD_REACH + 0.5);
    let d = hit ? Math.max(0, hit.distance - 0.5) : HEAD_REACH;
    // Луч может пройти в оконный проём — дополнительно не пускаем голову за контур здания.
    for (let t = 0.25; t <= d; t += 0.25) {
      if (this.insideBuilding(origin.x + f.x * t, origin.z + f.z * t, 0.4)) {
        d = Math.max(0, t - 0.25);
        break;
      }
    }
    return new THREE.Vector3(origin.x + f.x * d, origin.y, origin.z + f.z * d);
  }

  insideBuilding(x: number, z: number, margin = 0): boolean {
    for (const r of this.buildings) {
      if (x > r.x0 - margin && x < r.x1 + margin && z > r.z0 - margin && z < r.z1 + margin) return true;
    }
    return false;
  }

  get forward(): THREE.Vector3 {
    return new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
  }

  /** Насколько динозавр «возбуждён» (для музыки/HUD): 0 — спокоен, 1 — погоня. */
  get alertness(): number {
    switch (this.state) {
      case 'chase': case 'attack': return 1;
      case 'stalk': return 0.7;
      case 'investigate': case 'search': return 0.45;
      default: return 0;
    }
  }

  forceState(s: DinoState, time: number): void {
    this.setState(s, time);
  }

  teleport(x: number, z: number): void {
    const p = this.nav.nearestFree(x, z) ?? { x, z };
    this.position.set(p.x, 0, p.z);
    this.lastPos.copy(this.position);
    this.path = [];
    this.target = null;
  }

  /** Полный сброс (рестарт): позиция, память, состояние. */
  reset(spawn: { x: number; z: number }): void {
    this.teleport(spawn.x, spawn.z);
    this.state = 'patrol';
    this.stateTime = 0;
    this.awareness = 0;
    this.suspicion = 0;
    this.lastKnown = null;
    this.lastKnownTime = -Infinity;
    this.speed = 0;
    this.pendingNoise = null;
    this.searchPoints = [];
    this.skyTime = 0;
    this.hintTimer = SKY_HINT_FIRST;
    this.roarTimer = this.rng.range(...ROAR_INTERVAL);
    this.syncModel();
  }

  debugRoar(time: number): void {
    this.roar(time, 1);
  }

  fixedUpdate(dt: number, time: number, player: DinoPerceptionTarget): void {
    this.stateTime += dt;
    this.perceive(dt, time, player);
    this.think(dt, time, player);
    const before = this.position.clone();
    this.move(dt);
    this.stepDistance += before.distanceTo(this.position);
    if (this.stepDistance > STRIDE) {
      this.stepDistance -= STRIDE;
      this.events.emit('dinoStep', { position: this.position.clone(), time, loudness: STEP_LOUDNESS[this.state] });
    }
    this.updateRoar(dt, time);
    this.updateStuck(dt, time);
    this.syncModel();
  }

  /** Анимация модели — в кадре рендера. */
  animate(dt: number): void {
    this.speedSmoothed = THREE.MathUtils.damp(this.speedSmoothed, this.speed, 6, dt);
    this.roarAnim = Math.max(0, this.roarAnim - dt);
    this.model.update(dt, this.speedSmoothed, this.roarAnim > 0 ? 1 : 0, this.alertness);
  }

  // ---------------------------------------------------------------------------
  // Восприятие

  private onNoise(n: GameEvents['noise']): void {
    // Обрабатываем самый громкий из шумов за шаг.
    if (!this.pendingNoise || n.loudness > this.pendingNoise.loudness) this.pendingNoise = n;
  }

  private perceive(dt: number, time: number, player: DinoPerceptionTarget): void {
    // --- Зрение ---
    if (player.alive) {
      const target: VisionTarget = {
        points: [player.eye, player.chest],
        crouching: player.crouching,
        speed: player.speed,
        light: player.light,
      };
      const range = this.state === 'chase' ? DEFAULT_VISION.range * 1.3 : DEFAULT_VISION.range;
      const fov = this.state === 'chase' ? 140 : DEFAULT_VISION.fovDeg;
      const rate = visibility(this.physics, this.eye, this.forward, target, { range, fovDeg: fov });
      if (rate > 0) {
        this.awareness = Math.min(1, this.awareness + rate * dt);
        if (this.awareness > 0.3) {
          this.lastKnown = player.position.clone();
          this.lastKnownTime = time;
        }
      } else {
        this.awareness = Math.max(0, this.awareness - dt * (this.state === 'chase' ? 0.15 : 0.25));
      }
    }

    // --- Слух ---
    const n = this.pendingNoise;
    this.pendingNoise = null;
    if (n) {
      const ear = new THREE.Vector3(this.position.x, EAR_HEIGHT, this.position.z);
      const strength = hearNoise(this.physics, ear, n.position, n.loudness);
      if (strength > 0) {
        this.suspicion = Math.min(1, this.suspicion + 0.25 + strength * 0.6);
        // В погоне шумы просто уточняют позицию цели.
        this.lastKnown = n.position.clone();
        this.lastKnownTime = time;
        this.onHeard(time, strength);
      }
    }
    this.suspicion = Math.max(0, this.suspicion - dt * 0.05);

    // --- «Чутьё»: игрок под открытым небом ---
    if (player.alive) {
      this.playerArea = { x: player.position.x, z: player.position.z };
      if (player.exposed) {
        this.skyTime += dt;
        this.hintTimer -= dt;
        if (this.hintTimer <= 0) {
          this.hintTimer = SKY_HINT_INTERVAL;
          this.skyHint(time, player);
        }
      } else {
        // Спрятался под крышу — отсчёт начинается заново.
        this.skyTime = Math.max(0, this.skyTime - dt * 2);
        this.hintTimer = SKY_HINT_FIRST;
      }
    }
  }

  /** Примерная позиция игрока: чем дольше он на открытом месте, тем точнее. */
  private skyHint(time: number, player: DinoPerceptionTarget): void {
    if (this.state === 'chase' || this.state === 'stalk' || this.state === 'attack') return;
    const fuzz = THREE.MathUtils.clamp(SKY_HINT_FUZZ_MAX - this.skyTime * 0.8, SKY_HINT_FUZZ_MIN, SKY_HINT_FUZZ_MAX);
    const a = this.rng.range(0, Math.PI * 2);
    const r = this.rng.range(0, fuzz);
    this.lastKnown = new THREE.Vector3(player.position.x + Math.cos(a) * r, player.position.y, player.position.z + Math.sin(a) * r);
    this.lastKnownTime = time;
    this.suspicion = Math.min(1, this.suspicion + 0.2);
    if (this.state === 'investigate') this.repathTimer = 0;
    else this.setState('investigate', time);
  }

  private onHeard(time: number, strength: number): void {
    switch (this.state) {
      case 'patrol':
      case 'search':
        this.setState(this.suspicion > 0.75 && strength > 0.4 ? 'stalk' : 'investigate', time);
        break;
      case 'investigate':
        if (this.suspicion > 0.75 && strength > 0.4) this.setState('stalk', time);
        else this.repathTimer = 0; // повернуть к новому шуму
        break;
      case 'stalk':
      case 'chase':
        this.repathTimer = Math.min(this.repathTimer, 0.2);
        break;
      default:
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Решения (FSM)

  private think(dt: number, time: number, player: DinoPerceptionTarget): void {
    if (this.state === 'attack') return;

    // Обнаружение → погоня из любого «спокойного» состояния.
    if (this.awareness >= 1 && this.state !== 'chase') this.setState('chase', time);
    else if (this.awareness > 0.55 && (this.state === 'patrol' || this.state === 'investigate' || this.state === 'search')) {
      this.setState('stalk', time);
    }

    // Атака при контакте: игрок в досягаемости пасти И пасть до него дотягивается
    // по прямой (без стен/перекрытий между головой и телом игрока).
    if (player.alive) {
      const head = this.eye;
      const lunge = this.state === 'chase' || this.state === 'stalk' ? 0.6 : 0;
      const fromHead = Math.hypot(player.chest.x - head.x, player.chest.z - head.z);
      const fromBody = Math.hypot(player.position.x - this.position.x, player.position.z - this.position.z);
      const dy = player.position.y - this.position.y;
      // Внутри здания (под крышей) не достать; на крыше — можно, если дотянется.
      const indoors = !player.exposed && this.insideBuilding(player.position.x, player.position.z);
      const inReach = !indoors && (fromHead < BITE_FROM_HEAD + lunge || fromBody < BITE_FROM_BODY + lunge) &&
        dy < ATTACK_HEIGHT && dy > -1;
      if (inReach && (this.physics.lineOfSight(head, player.chest) || this.physics.lineOfSight(head, player.eye))) {
        this.setState('attack', time);
        this.speed = 0;
        this.roarAnim = 1.2;
        this.events.emit('roar', { position: this.position.clone(), intensity: 1.5, time });
        this.events.emit('playerDied', { time });
        return;
      }
    }

    this.repathTimer -= dt;
    switch (this.state) {
      case 'patrol': {
        if (!this.target || this.reached(this.target, 3)) this.pickPatrolTarget();
        break;
      }
      case 'investigate': {
        if (this.lastKnown && this.repathTimer <= 0) {
          this.goTo({ x: this.lastKnown.x, z: this.lastKnown.z });
          this.repathTimer = 2;
        }
        if (this.target && this.reached(this.target, 3.5)) {
          // Постоять, осмотреться, потом искать вокруг.
          if (this.stateTime > INVESTIGATE_LINGER) this.setState('search', time);
        }
        if (this.stateTime > 30) this.setState('search', time);
        break;
      }
      case 'stalk': {
        if (this.lastKnown && this.repathTimer <= 0) {
          this.goTo({ x: this.lastKnown.x, z: this.lastKnown.z });
          this.repathTimer = 1;
        }
        if (time - this.lastKnownTime > 10 && this.awareness < 0.2) this.setState('search', time);
        break;
      }
      case 'chase': {
        if (player.alive && this.awareness > 0.3) {
          this.lastKnown = player.position.clone();
          this.lastKnownTime = time;
        }
        if (this.lastKnown && this.repathTimer <= 0) {
          this.goTo({ x: this.lastKnown.x, z: this.lastKnown.z });
          this.repathTimer = 0.4;
        }
        if (time - this.lastKnownTime > LOSE_TARGET_TIME) this.setState('search', time);
        break;
      }
      case 'search': {
        if (!this.target || this.reached(this.target, 3)) {
          const next = this.searchPoints.shift();
          if (next) this.goTo(next);
          else this.target = null;
        }
        if (this.stateTime > SEARCH_DURATION || (!this.target && this.searchPoints.length === 0)) {
          this.awareness = 0;
          this.suspicion *= 0.5;
          this.setState('patrol', time);
        }
        break;
      }
    }
  }

  private setState(s: DinoState, time: number): void {
    if (this.state === s) return;
    const prev = this.state;
    this.state = s;
    this.stateTime = 0;
    this.repathTimer = 0;
    if (s === 'patrol') {
      this.target = null;
      this.path = [];
    }
    if (s === 'search') this.buildSearchPoints();
    if (s === 'chase' && prev !== 'chase') {
      // Рёв при обнаружении.
      this.roar(time, 1.2);
    }
  }

  private buildSearchPoints(): void {
    this.searchPoints = [];
    const c = this.lastKnown ?? this.position;
    for (let i = 0; i < 5; i++) {
      const a = this.rng.range(0, Math.PI * 2);
      const r = this.rng.range(6, 20);
      const p = this.nav.nearestFree(c.x + Math.cos(a) * r, c.z + Math.sin(a) * r, 10);
      if (p) this.searchPoints.push(p);
    }
    this.target = null;
  }

  private pickPatrolTarget(): void {
    // Чаще всего патрулирует район, где сейчас игрок (ближайшие перекрёстки),
    // иногда — случайный перекрёсток, чтобы маршрут не был предсказуемым.
    const area = this.playerArea;
    const nearPlayer = area && this.rng.chance(PATROL_TOWARD_PLAYER)
      ? [...this.patrolNodes]
        .sort((a, b) => (a.x - area.x) ** 2 + (a.z - area.z) ** 2 - ((b.x - area.x) ** 2 + (b.z - area.z) ** 2))
        .slice(0, 4)
      : null;
    for (let attempt = 0; attempt < 8; attempt++) {
      const node = this.rng.pick(nearPlayer && attempt < 5 ? nearPlayer : this.patrolNodes);
      const jitter = { x: node.x + this.rng.range(-4, 4), z: node.z + this.rng.range(-4, 4) };
      if (Math.hypot(jitter.x - this.position.x, jitter.z - this.position.z) < 25) continue;
      if (this.goTo(jitter)) return;
    }
  }

  private goTo(p: Vec2): boolean {
    const path = this.nav.findPath({ x: this.position.x, z: this.position.z }, p);
    if (!path || path.length === 0) {
      this.target = null;
      this.path = [];
      return false;
    }
    this.path = path;
    this.target = path[path.length - 1] as Vec2;
    return true;
  }

  private reached(p: Vec2, radius: number): boolean {
    return Math.hypot(p.x - this.position.x, p.z - this.position.z) < radius;
  }

  // ---------------------------------------------------------------------------
  // Движение

  private move(dt: number): void {
    const speedMax = SPEED[this.state];
    let waypoint = this.path[0];
    while (waypoint && this.reached(waypoint, 1.2) && this.path.length > 1) {
      this.path.shift();
      waypoint = this.path[0];
    }
    if (!waypoint || speedMax === 0) {
      this.speed = THREE.MathUtils.damp(this.speed, 0, 4, dt);
      // Осматривается на месте.
      if (this.state === 'investigate' || this.state === 'search') {
        this.heading += Math.sin(this.stateTime * 0.8) * dt * 0.8;
      }
      return;
    }

    const dx = waypoint.x - this.position.x;
    const dz = waypoint.z - this.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.3 && this.path.length === 1) {
      this.path = [];
      return;
    }

    // Поворот к точке с ограниченной скоростью.
    const desired = Math.atan2(dx, dz);
    let delta = desired - this.heading;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    const maxTurn = TURN_RATE[this.state] * dt;
    this.heading += THREE.MathUtils.clamp(delta, -maxTurn, maxTurn);

    // На крутых поворотах замедляется (тяжёлое животное).
    const align = Math.max(0, Math.cos(delta));
    const targetSpeed = speedMax * (0.25 + 0.75 * align);
    const accel = this.state === 'chase' ? 7 : 3;
    this.speed += THREE.MathUtils.clamp(targetSpeed - this.speed, -accel * 2 * dt, accel * dt);

    const step = Math.min(this.speed * dt, dist);
    const f = this.forward;
    const nx = this.position.x + f.x * step;
    const nz = this.position.z + f.z * step;
    if (this.nav.isFreeAt(nx, nz)) {
      this.position.x = nx;
      this.position.z = nz;
    } else if (this.nav.isFreeAt(nx, this.position.z)) {
      this.position.x = nx;
    } else if (this.nav.isFreeAt(this.position.x, nz)) {
      this.position.z = nz;
    } else {
      this.speed *= 0.5;
    }
  }

  private updateStuck(dt: number, time: number): void {
    const moved = this.position.distanceTo(this.lastPos);
    this.lastPos.copy(this.position);
    if (this.path.length > 0 && moved < 0.2 * dt) {
      this.stuckTimer += dt;
      if (this.stuckTimer > 2) {
        this.stuckTimer = 0;
        this.path = [];
        this.target = null;
        this.repathTimer = 0;
        if (this.state === 'patrol') this.pickPatrolTarget();
        void time;
      }
    } else {
      this.stuckTimer = 0;
    }
  }

  // ---------------------------------------------------------------------------
  // Рычание (ТЗ 3.5: раз в 8–15 с в Investigate/Stalk)

  private updateRoar(dt: number, time: number): void {
    this.roarTimer -= dt;
    if (this.roarTimer > 0) return;
    // Подкрадываясь (stalk), молчит — рык выдал бы его.
    const active = this.state === 'investigate' || this.state === 'search';
    const patrol = this.state === 'patrol';
    if (active || (patrol && this.rng.chance(0.35))) {
      this.roar(time, active ? 1 : 0.7);
    }
    this.roarTimer = this.rng.range(...ROAR_INTERVAL);
  }

  private roar(time: number, intensity: number): void {
    this.roarAnim = 1.6;
    this.events.emit('roar', { position: this.position.clone(), intensity, time });
  }

  private syncModel(): void {
    this.model.root.position.copy(this.position);
    this.model.root.rotation.y = this.heading;
    const body = this.collider.parent();
    body?.setNextKinematicTranslation({ x: this.position.x, y: this.position.y, z: this.position.z });
  }
}
