import * as THREE from 'three';
import { EventBus } from './events';
import { GameLoop } from './loop';
import { Input } from './input';
import { Physics } from './physics';
import { Feedback } from './feedback';
import { radiansPerPixel, type Settings } from './settings';
import { Renderer } from '../render/renderer';
import { Materials } from '../render/materials';
import { PsxPipeline } from '../render/psx';
import { DebugTools } from '../debug/debugTools';
import { PhysicsDebugView } from '../debug/physicsDebugView';
import { AiDebugView } from '../debug/aiDebugView';
import { FlyCamera } from '../debug/flyCamera';
import { Rng } from '../utils/rng';
import type { SeedInfo } from '../utils/seed';
import { City } from '../world/city';
import { Doors } from '../world/doors';
import { generateCity } from '../world/cityGenerator';
import { Player, NOISE } from '../entities/player';
import { Dinosaur, DINO_NAV_RADIUS, type DinoPerceptionTarget, type DinoState } from '../entities/dinosaur';
import { NavGrid } from '../ai/navGrid';
import { AudioManager } from '../audio/audioManager';
import { Hud } from '../ui/hud';

/**
 * Корневой объект игры: создаёт подсистемы и передаёт их друг другу явно (DI через конструктор).
 * Глобальных синглтонов нет — всё, что нужно подсистеме, она получает в конструкторе.
 */
export interface GameContext {
  seed: SeedInfo;
  rng: Rng;
  events: EventBus;
  input: Input;
  physics: Physics;
  renderer: Renderer;
  materials: Materials;
  debug: DebugTools;
  settings: Settings;
}

export type GameStatus = 'menu' | 'playing' | 'paused' | 'dead';

const NIGHT_COLOR = 0x0b0d14;
const FOG_DENSITY = 0.024; // 50% тумана на ~35 м (было ~28 м)

export class Game {
  readonly ctx: GameContext;
  status: GameStatus = 'menu';
  /** Вызывается при смерти игрока (UI показывает экран смерти). */
  onDeath: (survivedSec: number) => void = () => undefined;

  readonly city: City;
  readonly player: Player;
  readonly dino: Dinosaur;
  readonly doors: Doors;
  readonly nav: NavGrid;
  readonly audio: AudioManager;
  readonly hud = new Hud();

  private loop: GameLoop;
  private feedback: Feedback;
  private physicsView: PhysicsDebugView;
  private aiView: AiDebugView;
  private flyCam: FlyCamera;
  private moon!: THREE.DirectionalLight;
  private flashlight: THREE.SpotLight;
  private flashlightOn = false;
  private debugLight = new THREE.HemisphereLight(0xffffff, 0x666655, 2.5);
  /** ?cam= фиксирует камеру (для скриншотов), пока игра не запущена. */
  private debugCamLocked = false;
  private dinoFrozen = false;
  private invulnerable = false;
  private psxDisabled = false;
  private survivedTime = 0;
  private deathTime = 0;
  private deathCamFrom = new THREE.Vector3();
  private interactPrompt: string | null = null;

  private constructor(ctx: GameContext) {
    this.ctx = ctx;
    this.loop = new GameLoop({
      fixedUpdate: (dt) => this.fixedUpdate(dt),
      render: (frameDt, alpha) => this.render(frameDt, alpha),
    });

    const { renderer, physics, materials, events, input, settings } = ctx;
    this.physicsView = new PhysicsDebugView(physics, renderer.scene);
    this.flyCam = new FlyCamera(input);
    this.feedback = new Feedback(settings);
    this.audio = new AudioManager({ masterVolume: settings.volume });

    this.setupAtmosphere();

    const layout = generateCity(ctx.rng.fork('city'));
    this.city = new City(layout, renderer.scene, physics, materials);
    this.doors = new Doors(layout.doors, this.city.root, physics, materials);
    this.nav = NavGrid.fromLayout(layout, DINO_NAV_RADIUS);
    this.aiView = new AiDebugView(this.nav, renderer.scene);

    const playerSettings = { get mouseSensitivity() { return radiansPerPixel(settings); } };
    this.player = new Player(physics, input, events, playerSettings, layout.playerSpawn);
    // Стартовый взгляд — в сторону центра города.
    const b = layout.bounds;
    this.player.yaw = Math.atan2(-((b.x0 + b.x1) / 2 - layout.playerSpawn.x), -((b.z0 + b.z1) / 2 - layout.playerSpawn.z));
    this.dino = new Dinosaur(
      physics, this.nav, events, ctx.rng.fork('dino'), layout.streetNodes,
      layout.buildings.map((b) => b.rect), materials, renderer.scene, layout.dinoSpawn,
    );

    // Фонарик (ТЗ 3.7) — привязан к камере.
    this.flashlight = new THREE.SpotLight(0xfff2d8, 0, 28, THREE.MathUtils.degToRad(24), 0.45, 1.4);
    this.flashlight.position.set(0.15, -0.1, 0);
    this.flashlight.target.position.set(0, 0, -1);
    renderer.camera.add(this.flashlight, this.flashlight.target);

    this.subscribeEvents();
    this.setupDebug();
    this.applySettings();
    this.player.applyCamera(renderer.camera, 1, 0);
    this.applyDebugCamera();
  }

  static async create(container: HTMLElement, seed: SeedInfo, settings: Settings): Promise<Game> {
    const physics = await Physics.create();
    const renderer = new Renderer(container);
    const input = new Input(renderer.canvas);
    const ctx: GameContext = {
      seed,
      rng: new Rng(seed.value),
      events: new EventBus(),
      input,
      physics,
      renderer,
      materials: new Materials(),
      debug: new DebugTools(input),
      settings,
    };
    return new Game(ctx);
  }

  start(): void {
    this.loop.start();
  }

  /** Перейти в игру (после клика в меню). */
  play(): void {
    this.audio.resume();
    this.audio.setVolume(this.ctx.settings.volume);
    this.status = 'playing';
    this.debugCamLocked = false;
    this.hud.setVisible(true);
  }

  pause(): void {
    if (this.status === 'playing') this.status = 'paused';
    this.hud.setVisible(false);
  }

  /** Рестарт на той же карте: игрок и динозавр — на исходные позиции. */
  restart(): void {
    const layout = this.city.layout;
    this.player.alive = true;
    this.player.teleport(layout.playerSpawn);
    this.player.pitch = 0;
    this.dino.reset(layout.dinoSpawn);
    this.doors.reset();
    this.survivedTime = 0;
    this.flashlightOn = false;
    this.status = 'paused';
  }

  applySettings(): void {
    const s = this.ctx.settings;
    this.applyGraphics();
    this.audio.setVolume(s.volume);
    this.hud.setNoiseMeterVisible(s.noiseMeter);
    const shadows = s.shadows !== 'off';
    this.ctx.renderer.setShadows(shadows);
    this.moon.castShadow = shadows;
    const size = s.shadows === 'high' ? 2048 : 1024;
    if (this.moon.shadow.mapSize.x !== size) {
      this.moon.shadow.mapSize.set(size, size);
      this.moon.shadow.map?.dispose();
      this.moon.shadow.map = null;
    }
  }

  /** PSX: разрешение кадра, дрожание вершин, аффинные текстуры. */
  private applyGraphics(): void {
    const s = this.ctx.settings;
    const { renderer, materials } = this.ctx;
    const psxOn = s.renderHeight > 0 && !this.psxDisabled;
    materials.psx.jitter.value = psxOn ? s.jitter : 0;
    materials.psx.affine.value = psxOn ? s.affine : 0;
    if (!psxOn) {
      renderer.setPipeline(null);
      return;
    }
    if (renderer.pipeline instanceof PsxPipeline) {
      renderer.pipeline.height = s.renderHeight;
      window.dispatchEvent(new Event('resize')); // пересчитать размер буфера
    } else {
      renderer.setPipeline(new PsxPipeline(materials.psx, s.renderHeight));
    }
  }

  // ---------------------------------------------------------------------------

  private fixedUpdate(dt: number): void {
    const { physics, input, debug } = this.ctx;
    if (this.status === 'playing') {
      const time = this.loop.simTime;
      const noclip = debug.isOn('KeyV');
      if (!noclip) {
        this.player.fixedUpdate(dt, time);
        this.handleInteraction(time);
      }
      if (!this.dinoFrozen) {
        this.dino.fixedUpdate(dt, time, this.perceptionTarget(!this.invulnerable && !noclip));
      }
      this.doors.update(dt);
      physics.step(dt);
      this.survivedTime += dt;
    } else if (this.status === 'dead') {
      // Мир продолжает жить: динозавр стоит над жертвой.
      this.dino.fixedUpdate(dt, this.loop.simTime, this.perceptionTarget(false));
      physics.step(dt);
    }
    input.consumeFrame();
  }

  private render(frameDt: number, alpha: number): void {
    const { renderer, debug } = this.ctx;
    const camera = renderer.camera;
    const playing = this.status === 'playing';

    this.feedback.update(frameDt, this.player.cameraShake);
    if (debug.isOn('KeyV')) {
      if (playing) this.flyCam.update(frameDt, camera);
    } else if (this.status === 'dead') {
      this.updateDeathCamera(frameDt);
    } else if (!this.debugCamLocked) {
      if (playing) this.player.look();
      this.player.applyCamera(camera, alpha, frameDt);
    }

    this.dino.animate(frameDt);
    this.city.update(frameDt, camera.position, this.loop.simTime);
    this.updateMoonShadow();
    this.flashlight.intensity = this.flashlightOn ? 40 : 0;

    const danger = playing ? this.dangerLevel(this.dinoDistance()) : 0;
    this.audio.update(frameDt, camera, danger);
    this.hud.update(
      frameDt,
      this.player.noiseLevel,
      danger,
      this.feedback.intensity,
      this.player.crouching,
      playing ? this.interactPrompt : null,
    );

    this.physicsView.update();
    this.aiView.update(this.dino);
    renderer.render();
    debug.update();
  }

  // ---------------------------------------------------------------------------

  private perceptionTarget(alive: boolean): DinoPerceptionTarget {
    return {
      position: this.player.position,
      eye: this.player.eyePosition,
      chest: this.player.chestPosition,
      crouching: this.player.crouching,
      speed: Math.hypot(this.player.velocity.x, this.player.velocity.z),
      light: this.playerLightLevel(),
      alive: alive && this.player.alive,
      exposed: this.playerExposed(),
    };
  }

  /** Над головой игрока ничего нет (луч вверх не встретил геометрию). */
  private playerExposed(): boolean {
    return this.ctx.physics.raycast(this.player.eyePosition, { x: 0, y: 1, z: 0 }, 100) === null;
  }

  private subscribeEvents(): void {
    const { events } = this.ctx;
    events.on('roar', (r) => {
      const d = r.position.distanceTo(this.player.position);
      this.feedback.roar(d, r.intensity);
      this.audio.roar(r.position, d, r.intensity);
    });
    events.on('dinoStep', (s) => {
      const d = s.position.distanceTo(this.player.position);
      this.feedback.footstep(d, s.loudness);
      this.audio.dinoFootstep(s.position, d, s.loudness);
    });
    events.on('noise', (n) => {
      if (n.source === 'step' || n.source === 'land' || n.source === 'mantle') this.audio.playerStep(n.loudness);
      if (n.source === 'land' && n.loudness > 0.4) this.feedback.landing(n.loudness);
    });
    events.on('playerDied', () => this.die());
  }

  private die(): void {
    if (this.status !== 'playing') return;
    this.player.alive = false;
    this.status = 'dead';
    this.deathTime = 0;
    this.deathCamFrom.copy(this.ctx.renderer.camera.position);
    this.hud.setVisible(false);
    this.ctx.input.exitPointerLock();
    this.onDeath(this.survivedTime);
  }

  /** Камера при смерти: падает на землю и поворачивается к пасти динозавра. */
  private updateDeathCamera(dt: number): void {
    this.deathTime += dt;
    const cam = this.ctx.renderer.camera;
    const t = Math.min(1, this.deathTime / 0.6);
    const p = this.player.position;
    cam.position.set(p.x, THREE.MathUtils.lerp(this.deathCamFrom.y, p.y + 0.3, t * t), p.z);
    cam.position.add(this.player.cameraShake);
    const look = new THREE.Matrix4().lookAt(cam.position, this.dino.eye, new THREE.Vector3(0, 1, 0));
    const q = new THREE.Quaternion().setFromRotationMatrix(look);
    cam.quaternion.slerp(q, Math.min(1, dt * 6));
  }

  /** E — двери, F — фонарик. Шум двери 0.5 (ТЗ 3.4). */
  private handleInteraction(time: number): void {
    const { input, renderer, events } = this.ctx;
    const look = new THREE.Vector3(0, 0, -1).applyQuaternion(renderer.camera.quaternion);
    const door = this.doors.findInteractable(this.player.eyePosition, look);
    this.interactPrompt = door ? `[E] ${door.open ? 'закрыть' : 'открыть'} дверь` : null;
    if (door && input.wasPressed('KeyE')) {
      this.doors.toggle(door, this.player.position);
      this.audio.door(door.center);
      events.emit('noise', { position: door.center.clone(), loudness: NOISE.door, source: 'door', time });
    }
    if (input.wasPressed('KeyF')) this.flashlightOn = !this.flashlightOn;
  }

  /** Освещённость игрока 0..1: фонари рядом, фонарик (свет в темноте выдаёт!). */
  private playerLightLevel(): number {
    let light = 0.25;
    const p = this.player.position;
    for (const lamp of this.city.lights.activeLamps) {
      const d = Math.hypot(lamp.light.x - p.x, lamp.light.z - p.z);
      if (d < 12) light = Math.max(light, 1 - d / 14);
    }
    if (this.flashlightOn) light = Math.max(light, 0.9);
    return light;
  }

  private dinoDistance(): number {
    return this.dino.position.distanceTo(this.player.position);
  }

  /** Опасность 0..1 для сердцебиения/виньетки: близость + насколько он насторожен. */
  private dangerLevel(dist: number): number {
    const near = THREE.MathUtils.clamp(1 - (dist - 8) / 40, 0, 1);
    const chase = this.dino.state === 'chase' ? 0.3 : 0;
    return THREE.MathUtils.clamp(near * (0.55 + 0.45 * this.dino.alertness) + chase, 0, 1);
  }

  private setupAtmosphere(): void {
    const { scene } = this.ctx.renderer;
    const nightColor = new THREE.Color(NIGHT_COLOR);
    scene.background = nightColor;
    scene.fog = new THREE.FogExp2(nightColor, FOG_DENSITY);

    scene.add(new THREE.HemisphereLight(0x5a6a90, 0x1a1712, 1.5));
    this.moon = new THREE.DirectionalLight(0x8899cc, 1.0);
    this.moon.position.set(-30, 60, 20);
    const sc = this.moon.shadow.camera;
    sc.left = -40;
    sc.right = 40;
    sc.top = 40;
    sc.bottom = -40;
    sc.near = 1;
    sc.far = 160;
    this.moon.shadow.bias = -0.0008;
    this.moon.shadow.normalBias = 0.04;
    scene.add(this.moon, this.moon.target);

    this.debugLight.visible = false;
    scene.add(this.debugLight);
  }

  /** Теневая камера луны следует за игроком (тени только вокруг него). */
  private updateMoonShadow(): void {
    const p = this.ctx.renderer.camera.position;
    const snap = 2; // привязка к сетке, чтобы тени не «плавали»
    const x = Math.round(p.x / snap) * snap;
    const z = Math.round(p.z / snap) * snap;
    this.moon.target.position.set(x, 0, z);
    this.moon.position.set(x - 30, 60, z + 20);
  }

  /** ?cam=x,y,z,yawDeg,pitchDeg — стартовая позиция камеры (скриншоты/отладка, только DEV). */
  private applyDebugCamera(): void {
    if (!import.meta.env.DEV) return;
    const raw = new URLSearchParams(location.search).get('cam');
    if (!raw) return;
    const [x = 0, y = 0, z = 0, yaw = 0, pitch = 0] = raw.split(',').map(Number);
    const cam = this.ctx.renderer.camera;
    cam.position.set(x, y, z);
    cam.quaternion.setFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(pitch), THREE.MathUtils.degToRad(yaw), 0, 'YXZ'));
    this.flyCam.syncFrom(cam);
    this.city.update(1, cam.position, 0);
    this.debugCamLocked = true;
  }

  private setupDebug(): void {
    const { debug, renderer, seed } = this.ctx;
    const params = new URLSearchParams(location.search);
    debug.addInfo(() => {
      const p = renderer.camera.position;
      const s = renderer.stats();
      const d = this.dino;
      return [
        `FPS ${this.loop.fps.toFixed(0)}  calls ${s.calls}  tris ${s.triangles}`,
        `seed "${seed.text}"`,
        `pos ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}`,
        `player: ${this.player.mode}  noise ${this.player.noiseLevel.toFixed(2)}  light ${this.playerLightLevel().toFixed(2)}`,
        `T-Rex: ${d.state.toUpperCase()}  dist ${this.dinoDistance().toFixed(1)}  spd ${d.speed.toFixed(1)}`,
        `  awareness ${d.awareness.toFixed(2)}  suspicion ${d.suspicion.toFixed(2)}  sky ${this.playerExposed() ? 'ОТКРЫТО' : 'укрыт'}`,
        `city: ${this.city.layout.buildings.length} зданий, ${this.city.meshCount} мешей`,
      ].join('\n');
    });
    debug.addToggle({ key: 'Digit1', label: 'коллайдеры (Rapier)', onChange: (v) => this.physicsView.setVisible(v) });
    debug.addToggle({ key: 'Digit2', label: 'навигационная сетка T-Rex', onChange: (v) => this.aiView.setNavVisible(v) });
    debug.addToggle({
      key: 'Digit3',
      label: 'слух/зрение/путь T-Rex',
      value: import.meta.env.DEV && params.has('senses'),
      onChange: (v) => this.aiView.setSensesVisible(v),
    });
    const fog = renderer.scene.fog;
    debug.addToggle({
      key: 'Digit4',
      label: 'без тумана, светло',
      value: import.meta.env.DEV && params.has('bright'),
      onChange: (v) => {
        renderer.scene.fog = v ? null : fog;
        this.debugLight.visible = v;
      },
    });
    debug.addToggle({
      key: 'Digit7',
      label: 'PSX-графика выкл (сравнение)',
      onChange: (v) => {
        this.psxDisabled = v;
        this.applyGraphics();
      },
    });
    debug.addToggle({ key: 'Digit5', label: 'бессмертие (T-Rex не видит)', onChange: (v) => (this.invulnerable = v) });
    debug.addToggle({ key: 'Digit6', label: 'заморозить T-Rex', onChange: (v) => (this.dinoFrozen = v) });
    debug.addToggle({
      key: 'KeyV',
      label: 'noclip-камера (Space/C — вверх/вниз)',
      onChange: (v) => {
        if (v) this.flyCam.syncFrom(renderer.camera);
      },
    });
    debug.addAction({
      key: 'KeyT',
      label: 'телепорт: игрок → noclip-камера / к спавну',
      run: () => {
        if (debug.isOn('KeyV')) {
          const c = renderer.camera.position;
          this.player.teleport({ x: c.x, y: c.y - 1.6, z: c.z });
        } else {
          this.player.teleport(this.city.layout.playerSpawn);
        }
      },
    });
    debug.addAction({
      key: 'KeyN',
      label: 'шум 0.8 в позиции игрока',
      run: () => this.ctx.events.emit('noise', {
        position: this.player.position.clone(), loudness: 0.8, source: 'debug', time: this.loop.simTime,
      }),
    });
    debug.addAction({ key: 'KeyR', label: 'T-Rex: зарычать', run: () => this.dino.debugRoar(this.loop.simTime) });
    debug.addAction({
      key: 'KeyG',
      label: 'T-Rex → в 25 м перед игроком',
      run: () => {
        const f = new THREE.Vector3(-Math.sin(this.player.yaw), 0, -Math.cos(this.player.yaw));
        this.dino.teleport(this.player.position.x + f.x * 25, this.player.position.z + f.z * 25);
      },
    });
    const states: DinoState[] = ['patrol', 'investigate', 'stalk', 'chase', 'search'];
    debug.addAction({
      key: 'KeyB',
      label: 'T-Rex: следующее состояние',
      run: () => {
        const i = states.indexOf(this.dino.state);
        this.dino.lastKnown = this.player.position.clone();
        this.dino.lastKnownTime = this.loop.simTime;
        this.dino.forceState(states[(i + 1) % states.length] as DinoState, this.loop.simTime);
      },
    });
  }
}
