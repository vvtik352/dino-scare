import type { Vector3 } from 'three';

/**
 * Карта всех событий игры. Новые события добавляются сюда —
 * так шина остаётся строго типизированной.
 */
export interface GameEvents {
  /** Шум, издаваемый игроком/миром (см. ТЗ 3.4). loudness в [0..1]. */
  noise: { position: Vector3; loudness: number; source: string; time: number };
  /** Рычание динозавра — для вибрации/камеры/аудио (ТЗ 3.5). */
  roar: { position: Vector3; intensity: number; time: number };
  /** Тяжёлый шаг динозавра — аудио-удар и толчок камеры. */
  dinoStep: { position: Vector3; time: number; loudness: number };
  playerDied: { time: number };
}

type Handler<T> = (payload: T) => void;

export class EventBus {
  private handlers = new Map<keyof GameEvents, Set<Handler<never>>>();

  on<K extends keyof GameEvents>(type: K, handler: Handler<GameEvents[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler as Handler<never>);
    return () => set.delete(handler as Handler<never>);
  }

  emit<K extends keyof GameEvents>(type: K, payload: GameEvents[K]): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const h of set) (h as Handler<GameEvents[K]>)(payload);
  }
}
