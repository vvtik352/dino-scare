import * as THREE from 'three';

/**
 * Тактильная обратная связь от рычания и шагов T-Rex (ТЗ 3.5):
 *  - тряска камеры: амплитуда ∝ 1/distance² с ограничением;
 *  - вибрация геймпада (GamepadHapticActuator);
 *  - вибрация телефона (navigator.vibrate).
 *
 * Тряска — сумма затухающих «импульсов», каждый со своей частотой,
 * плюс шум; результат пишется в Vector3 смещения камеры.
 */
export interface FeedbackSettings {
  shake: boolean;
  haptics: boolean;
}

interface Impulse {
  amp: number;
  /** Длительность, с. */
  dur: number;
  age: number;
  freq: number;
}

const MAX_SHAKE = 0.22; // м
const REF_DIST = 8; // на этой дистанции амплитуда = базовой

export class Feedback {
  private impulses: Impulse[] = [];
  private time = 0;
  /** Текущая сила тряски 0..1 (для HUD/постпроцессинга). */
  intensity = 0;

  constructor(private readonly settings: FeedbackSettings) {}

  /** Рычание на расстоянии distance. */
  roar(distance: number, strength: number): void {
    const amp = falloff(distance) * strength;
    if (amp < 0.01) return;
    this.impulses.push({ amp, dur: 2.8, age: 0, freq: 17 });
    this.haptic(amp, 1400);
  }

  /** Шаг динозавра: короткий толчок. */
  footstep(distance: number, loudness = 1): void {
    const amp = falloff(distance) * 0.35 * loudness;
    if (amp < 0.01) return;
    this.impulses.push({ amp, dur: 0.35, age: 0, freq: 11 });
    this.haptic(amp * 0.6, 120);
  }

  /** Собственное жёсткое приземление игрока. */
  landing(strength: number): void {
    this.impulses.push({ amp: strength * 0.25, dur: 0.2, age: 0, freq: 14 });
  }

  update(dt: number, out: THREE.Vector3): void {
    this.time += dt;
    let total = 0;
    for (const i of this.impulses) {
      i.age += dt;
      const env = Math.max(0, 1 - i.age / i.dur);
      // Нарастание в начале рыка, затем спад.
      const attack = Math.min(1, i.age / 0.15);
      total += i.amp * env * env * attack;
    }
    this.impulses = this.impulses.filter((i) => i.age < i.dur);
    this.intensity = Math.min(1, total);
    if (!this.settings.shake || total < 1e-4) {
      out.set(0, 0, 0);
      return;
    }
    const a = Math.min(total, 1) * MAX_SHAKE;
    const t = this.time;
    out.set(
      a * (Math.sin(t * 37.1) * 0.6 + Math.sin(t * 13.7 + 1.3) * 0.4),
      a * (Math.sin(t * 41.3 + 0.7) * 0.5 + Math.sin(t * 17.9) * 0.5),
      a * 0.5 * Math.sin(t * 29.3 + 2.1),
    );
  }

  private haptic(amp: number, durationMs: number): void {
    if (!this.settings.haptics) return;
    const strength = THREE.MathUtils.clamp(amp, 0, 1);
    for (const pad of navigator.getGamepads?.() ?? []) {
      const act = pad?.vibrationActuator;
      if (act && 'playEffect' in act) {
        void act.playEffect('dual-rumble', {
          duration: durationMs,
          strongMagnitude: strength,
          weakMagnitude: strength * 0.5,
        }).catch(() => undefined);
      }
    }
    if ('vibrate' in navigator && strength > 0.15) {
      try {
        navigator.vibrate(Math.round(durationMs * strength));
      } catch {
        /* не поддерживается */
      }
    }
  }
}

/** 1/d² с clamp: на REF_DIST = 1, ближе — до 1.6, дальше быстро падает. */
function falloff(distance: number): number {
  const d = Math.max(distance, 4);
  return Math.min(1.6, (REF_DIST * REF_DIST) / (d * d)) * smoothFar(distance);
}

/** Мягко обнуляем на дальних дистанциях (> 80 м), чтобы не было вечного микродрожания. */
function smoothFar(d: number): number {
  return THREE.MathUtils.clamp(1 - (d - 50) / 40, 0, 1);
}
