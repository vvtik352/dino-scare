import type { Input } from '../core/input';

/**
 * Реестр отладочных функций. Подсистемы регистрируют свои переключатели
 * и действия, панель показывает их состояние.
 *
 * Клавиши (по ТЗ п.4 — показать NavMesh, радиусы слуха/зрения, teleport, spawn noise)
 * назначаются при регистрации. Работают только когда отладка включена (` / Ё).
 */
export interface DebugToggle {
  key: string; // KeyboardEvent.code
  label: string;
  value: boolean;
  onChange?(value: boolean): void;
}

export interface DebugAction {
  key: string;
  label: string;
  run(): void;
}

const MASTER_KEY = 'Backquote';

export class DebugTools {
  enabled = false;
  private toggles: DebugToggle[] = [];
  private actions: DebugAction[] = [];
  private infoProviders: Array<() => string> = [];
  private panel: HTMLDivElement;
  private hint: HTMLDivElement;

  constructor(input: Input) {
    this.panel = document.createElement('div');
    this.panel.className = 'debug-panel hidden';
    document.body.appendChild(this.panel);

    this.hint = document.createElement('div');
    this.hint.className = 'debug-hint';
    this.hint.textContent = '` — отладка';
    document.body.appendChild(this.hint);

    input.onKey((code) => this.handleKey(code));
    this.enabled = import.meta.env.DEV && new URLSearchParams(location.search).has('debug');
    this.syncVisibility();
  }

  addToggle(t: Omit<DebugToggle, 'value'> & { value?: boolean }): DebugToggle {
    const toggle: DebugToggle = { ...t, value: t.value ?? false };
    this.assertFreeKey(toggle.key);
    this.toggles.push(toggle);
    toggle.onChange?.(toggle.value);
    return toggle;
  }

  addAction(a: DebugAction): void {
    this.assertFreeKey(a.key);
    this.actions.push(a);
  }

  /** Строки для панели (позиция, FPS, состояние AI и т.п.). Вызываются каждый кадр. */
  addInfo(provider: () => string): void {
    this.infoProviders.push(provider);
  }

  isOn(key: string): boolean {
    return this.toggles.find((t) => t.key === key)?.value ?? false;
  }

  /** Обновить текст панели. Дёшево, но вызывать не чаще раза в кадр. */
  update(): void {
    if (!this.enabled) return;
    const lines: string[] = [];
    for (const p of this.infoProviders) lines.push(p());
    lines.push('');
    for (const t of this.toggles) {
      lines.push(`[${keyLabel(t.key)}] <span class="${t.value ? 'on' : 'off'}">${t.value ? '■' : '□'} ${t.label}</span>`);
    }
    for (const a of this.actions) lines.push(`[${keyLabel(a.key)}] ▶ ${a.label}`);
    this.panel.innerHTML = lines.join('\n');
  }

  dispose(): void {
    this.panel.remove();
    this.hint.remove();
  }

  private handleKey(code: string): void {
    if (code === MASTER_KEY) {
      this.enabled = !this.enabled;
      this.syncVisibility();
      return;
    }
    if (!this.enabled) return;
    const toggle = this.toggles.find((t) => t.key === code);
    if (toggle) {
      toggle.value = !toggle.value;
      toggle.onChange?.(toggle.value);
      return;
    }
    this.actions.find((a) => a.key === code)?.run();
  }

  private syncVisibility(): void {
    this.panel.classList.toggle('hidden', !this.enabled);
    this.hint.style.display = this.enabled ? 'none' : '';
    this.update();
  }

  private assertFreeKey(key: string): void {
    if (key === MASTER_KEY || this.toggles.some((t) => t.key === key) || this.actions.some((a) => a.key === key)) {
      throw new Error(`DebugTools: клавиша ${key} уже занята`);
    }
  }
}

function keyLabel(code: string): string {
  return code.replace(/^Key|^Digit/, '');
}
