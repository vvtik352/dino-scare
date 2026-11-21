import * as THREE from 'three';

/**
 * Процедурное аудио на Web Audio API (ТЗ 3.5, 3.6). Без внешних файлов:
 * рычание, шаги, ветер и сердцебиение синтезируются из шума и осцилляторов.
 *
 * Позиционные звуки идут через PannerNode (HRTF), слушатель привязан к камере.
 * Рокот рычания — отдельная «нелокализуемая» низкочастотная шина: её громкость
 * зависит от расстояния, но не от направления — игрок «чувствует» близость,
 * а не точное место.
 */
export interface AudioSettings {
  masterVolume: number; // 0..1
}

export class AudioManager {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private rumbleBus!: GainNode;
  private noiseBuffer!: AudioBuffer;
  private windGain!: GainNode;
  private heartGain!: GainNode;
  private heartTimer = 0;

  constructor(private readonly settings: AudioSettings) {}

  /** Web Audio можно запускать только после жеста пользователя. */
  resume(): void {
    if (!this.ctx) this.init();
    void this.ctx?.resume();
  }

  get ready(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  setVolume(v: number): void {
    this.settings.masterVolume = v;
    if (this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  /** Каждый кадр: позиция слушателя, фоновые слои. */
  update(dt: number, camera: THREE.Camera, danger: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const l = ctx.listener;
    const p = camera.position;
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const u = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    const t = ctx.currentTime;
    if (l.positionX) {
      l.positionX.setTargetAtTime(p.x, t, 0.02);
      l.positionY.setTargetAtTime(p.y, t, 0.02);
      l.positionZ.setTargetAtTime(p.z, t, 0.02);
      l.forwardX.setTargetAtTime(f.x, t, 0.02);
      l.forwardY.setTargetAtTime(f.y, t, 0.02);
      l.forwardZ.setTargetAtTime(f.z, t, 0.02);
      l.upX.setTargetAtTime(u.x, t, 0.02);
      l.upY.setTargetAtTime(u.y, t, 0.02);
      l.upZ.setTargetAtTime(u.z, t, 0.02);
    }

    // Сердцебиение: чаще и громче при опасности.
    const heartVol = THREE.MathUtils.clamp((danger - 0.25) / 0.75, 0, 1);
    this.heartGain.gain.setTargetAtTime(heartVol * 0.9, t, 0.3);
    if (heartVol > 0.01) {
      this.heartTimer -= dt;
      if (this.heartTimer <= 0) {
        const bpm = 70 + danger * 90;
        this.heartTimer = 60 / bpm;
        this.heartbeat();
      }
    }

    // Ветер стихает, когда рядом динозавр (тишина перед бурей).
    this.windGain.gain.setTargetAtTime(0.12 * (1 - heartVol * 0.6), t, 0.5);
  }

  /** Рычание: позиционный голос + нелокализуемый инфразвуковой рокот. */
  roar(position: THREE.Vector3, distance: number, intensity: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const dur = 2.6 + intensity * 0.8;

    // --- Голос (позиционный) ---
    const panner = this.makePanner(position, 6, 400);
    // Вблизи голос приглушаем: иначе голос + рокот перегружают компрессор и звук «рвётся».
    const closeDuck = THREE.MathUtils.clamp(distance / 20, 0.45, 1);
    const voiceAmp = 0.6 * Math.min(intensity, 1.2) * closeDuck;
    const voice = ctx.createGain();
    voice.gain.setValueAtTime(0, t);
    voice.gain.linearRampToValueAtTime(voiceAmp, t + 0.35);
    voice.gain.setValueAtTime(voiceAmp, t + dur * 0.55);
    voice.gain.exponentialRampToValueAtTime(0.001, t + dur);
    // Срезаем верха пилы — меньше «жужжания».
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 1400;
    tone.Q.value = 0.5;
    voice.connect(tone).connect(panner).connect(this.sfx);

    // Рычащий тембр: пила с вибрато через полосовой фильтр + шум.
    const base = 55 + Math.random() * 10;
    for (const mult of [1, 1.5, 2.02]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(base * mult * 1.3, t);
      osc.frequency.linearRampToValueAtTime(base * mult, t + dur);
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 22 + Math.random() * 8;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = base * mult * 0.08;
      lfo.connect(lfoGain).connect(osc.frequency);
      const g = ctx.createGain();
      g.gain.value = 0.25 / mult;
      osc.connect(g).connect(voice);
      osc.start(t);
      lfo.start(t);
      osc.stop(t + dur + 0.1);
      lfo.stop(t + dur + 0.1);
    }
    const breath = this.noiseSource();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(700, t);
    bp.frequency.linearRampToValueAtTime(300, t + dur);
    bp.Q.value = 0.8;
    const bg = ctx.createGain();
    bg.gain.value = 0.5;
    breath.connect(bp).connect(bg).connect(voice);
    breath.start(t);
    breath.stop(t + dur + 0.1);

    // --- Рокот (вибрация, ТЗ 3.5): громкость ∝ близости, без направления ---
    const near = THREE.MathUtils.clamp(1 - distance / 90, 0, 1);
    const rumbleAmp = near * near * intensity;
    if (rumbleAmp > 0.01) {
      const rg = ctx.createGain();
      rg.gain.setValueAtTime(0, t);
      rg.gain.linearRampToValueAtTime(rumbleAmp * 0.9, t + 0.5);
      rg.gain.setValueAtTime(rumbleAmp * 0.9, t + dur * 0.6);
      rg.gain.exponentialRampToValueAtTime(0.001, t + dur + 0.8);
      rg.connect(this.rumbleBus);
      const sub = ctx.createOscillator();
      sub.type = 'sine';
      sub.frequency.setValueAtTime(38, t);
      sub.frequency.linearRampToValueAtTime(28, t + dur);
      const am = ctx.createOscillator();
      am.frequency.value = 9;
      const amGain = ctx.createGain();
      amGain.gain.value = 0.5;
      const subGain = ctx.createGain();
      subGain.gain.value = 0.6;
      am.connect(amGain).connect(subGain.gain);
      sub.connect(subGain).connect(rg);
      const rn = this.noiseSource();
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 90;
      rn.connect(lp).connect(rg);
      for (const n of [sub, am, rn]) {
        n.start(t);
        n.stop(t + dur + 1);
      }
    }
  }

  /** Шаг игрока (тихий, локальный). */
  playerStep(loudness: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const src = this.noiseSource();
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 500 + loudness * 1500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.05 + loudness * 0.25, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.09 + loudness * 0.06);
    src.connect(f).connect(g).connect(this.sfx);
    src.start(t);
    src.stop(t + 0.2);
  }

  /** Скрип двери (позиционный). */
  door(position: THREE.Vector3): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const panner = this.makePanner(position, 2, 40);
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(320, t);
    osc.frequency.linearRampToValueAtTime(180 + Math.random() * 120, t + 0.45);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 900;
    bp.Q.value = 4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.25, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    osc.connect(bp).connect(g).connect(panner).connect(this.sfx);
    osc.start(t);
    osc.stop(t + 0.55);
  }

  dispose(): void {
    void this.ctx?.close();
    this.ctx = null;
  }

  // ---------------------------------------------------------------------------

  private init(): void {
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.settings.masterVolume;
    // Мягкий лимитер, чтобы рокот + рык не клиппировали.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.01;
    comp.release.value = 0.3;
    this.master.connect(comp).connect(ctx.destination);

    this.sfx = ctx.createGain();
    this.sfx.connect(this.master);
    this.rumbleBus = ctx.createGain();
    this.rumbleBus.connect(this.master);

    // Белый шум для всего синтеза.
    const len = ctx.sampleRate * 2;
    this.noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    // Ветер: шум через медленно гуляющий полосовой фильтр.
    const wind = this.noiseSource(true);
    const wf = ctx.createBiquadFilter();
    wf.type = 'bandpass';
    wf.frequency.value = 400;
    wf.Q.value = 0.6;
    const wlfo = ctx.createOscillator();
    wlfo.frequency.value = 0.07;
    const wlfoG = ctx.createGain();
    wlfoG.gain.value = 250;
    wlfo.connect(wlfoG).connect(wf.frequency);
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0.12;
    wind.connect(wf).connect(this.windGain).connect(this.master);
    wind.start();
    wlfo.start();

    // Шина сердцебиения.
    this.heartGain = ctx.createGain();
    this.heartGain.gain.value = 0;
    this.heartGain.connect(this.master);
  }

  /** Тяжёлый шаг T-Rex: позиционный удар + нелокализуемый саб вблизи. */
  dinoFootstep(position: THREE.Vector3, distance: number, loudness = 1): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const panner = this.makePanner(position, 8, 300);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(70, t);
    osc.frequency.exponentialRampToValueAtTime(28, t + 0.35);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(1.4 * loudness, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    osc.connect(g).connect(panner).connect(this.sfx);
    osc.start(t);
    osc.stop(t + 0.55);

    // Землю трясёт: немного нелокализуемого саба вблизи.
    const near = THREE.MathUtils.clamp(1 - distance / 45, 0, 1) * loudness;
    if (near > 0.01) {
      const s = ctx.createOscillator();
      s.frequency.setValueAtTime(40, t);
      s.frequency.exponentialRampToValueAtTime(25, t + 0.3);
      const sg = ctx.createGain();
      sg.gain.setValueAtTime(near * near * 0.8, t);
      sg.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
      s.connect(sg).connect(this.rumbleBus);
      s.start(t);
      s.stop(t + 0.45);
    }
  }

  private heartbeat(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    for (const [offset, amp] of [[0, 1], [0.16, 0.7]] as const) {
      const osc = ctx.createOscillator();
      osc.frequency.setValueAtTime(60, t + offset);
      osc.frequency.exponentialRampToValueAtTime(35, t + offset + 0.12);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t + offset);
      g.gain.linearRampToValueAtTime(amp, t + offset + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t + offset + 0.15);
      osc.connect(g).connect(this.heartGain);
      osc.start(t + offset);
      osc.stop(t + offset + 0.2);
    }
  }

  private makePanner(position: THREE.Vector3, refDistance: number, maxDistance: number): PannerNode {
    const ctx = this.ctx as AudioContext;
    const p = ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = refDistance;
    p.maxDistance = maxDistance;
    p.rolloffFactor = 1.2;
    p.positionX.value = position.x;
    p.positionY.value = position.y + 3;
    p.positionZ.value = position.z;
    return p;
  }

  private noiseSource(loop = false): AudioBufferSourceNode {
    const ctx = this.ctx as AudioContext;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = loop;
    if (!loop) src.loopStart = Math.random();
    return src;
  }
}
