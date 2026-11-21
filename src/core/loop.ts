/**
 * Игровой цикл с фиксированным шагом симуляции и переменным рендером.
 * Физика/AI считаются строго по FIXED_DT (детерминированно и стабильно),
 * рендер — с каждым кадром браузера, с коэффициентом интерполяции alpha.
 */
export const FIXED_DT = 1 / 60;
const MAX_FRAME_TIME = 0.25; // защита от «спирали смерти» после сворачивания вкладки

export interface LoopCallbacks {
  fixedUpdate(dt: number): void;
  /** frameDt — реальное время кадра; alpha — доля до следующего фиксированного шага. */
  render(frameDt: number, alpha: number): void;
}

export class GameLoop {
  private accumulator = 0;
  private lastTime = 0;
  private rafId = 0;
  private running = false;

  /** Время симуляции в секундах (только фиксированные шаги). */
  simTime = 0;
  /** Сглаженный FPS для отладки. */
  fps = 0;

  constructor(private readonly callbacks: LoopCallbacks) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.rafId = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  private tick = (now: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.tick);

    const frameDt = Math.min((now - this.lastTime) / 1000, MAX_FRAME_TIME);
    this.lastTime = now;
    if (frameDt > 0) this.fps += (1 / frameDt - this.fps) * 0.05;

    this.accumulator += frameDt;
    while (this.accumulator >= FIXED_DT) {
      this.callbacks.fixedUpdate(FIXED_DT);
      this.simTime += FIXED_DT;
      this.accumulator -= FIXED_DT;
    }

    this.callbacks.render(frameDt, this.accumulator / FIXED_DT);
  };
}
