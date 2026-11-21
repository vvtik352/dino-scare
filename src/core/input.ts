/**
 * Ввод: клавиатура (по event.code — не зависит от раскладки, важно для RU),
 * мышь через Pointer Lock.
 *
 * «Нажато в этом кадре» считается относительно фиксированного шага:
 * consumeFrame() вызывается в конце каждого fixedUpdate, поэтому короткое
 * нажатие между кадрами не теряется.
 */
export class Input {
  private down = new Set<string>();
  private pressed = new Set<string>();
  private released = new Set<string>();
  private mouseDX = 0;
  private mouseDY = 0;

  /** Колбэки на одиночные нажатия (для отладочных хоткеев, меню). Срабатывают сразу. */
  private keyListeners = new Set<(code: string) => void>();

  constructor(private readonly element: HTMLElement) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('mousemove', this.onMouseMove);
  }

  get pointerLocked(): boolean {
    return document.pointerLockElement === this.element;
  }

  requestPointerLock(): void {
    // В некоторых браузерах возвращает Promise, который может отклониться
    // (например, при слишком частом запросе) — это не ошибка игры.
    const result = this.element.requestPointerLock() as unknown;
    if (result instanceof Promise) result.catch(() => undefined);
  }

  exitPointerLock(): void {
    if (this.pointerLocked) document.exitPointerLock();
  }

  isDown(code: string): boolean {
    return this.down.has(code);
  }

  wasPressed(code: string): boolean {
    return this.pressed.has(code);
  }

  wasReleased(code: string): boolean {
    return this.released.has(code);
  }

  /** Забрать накопленное смещение мыши (обнуляет его). */
  takeMouseDelta(): { dx: number; dy: number } {
    const d = { dx: this.mouseDX, dy: this.mouseDY };
    this.mouseDX = 0;
    this.mouseDY = 0;
    return d;
  }

  onKey(listener: (code: string) => void): () => void {
    this.keyListeners.add(listener);
    return () => this.keyListeners.delete(listener);
  }

  /** Вызывать в конце каждого фиксированного шага. */
  consumeFrame(): void {
    this.pressed.clear();
    this.released.clear();
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('mousemove', this.onMouseMove);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    // Ctrl+W / Ctrl+D и т.п. в браузере: приседание на Ctrl не должно закрывать вкладку
    // или ставить закладку, пока игра в pointer lock.
    if (this.pointerLocked && (e.ctrlKey || e.code === 'Space' || e.code.startsWith('F'))) {
      if (e.code !== 'F5' && e.code !== 'F12') e.preventDefault();
    }
    if (e.repeat) return;
    this.down.add(e.code);
    this.pressed.add(e.code);
    for (const l of this.keyListeners) l(e.code);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.down.delete(e.code);
    this.released.add(e.code);
  };

  private onBlur = (): void => {
    this.down.clear();
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.pointerLocked) return;
    this.mouseDX += e.movementX;
    this.mouseDY += e.movementY;
  };
}
