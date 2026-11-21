import './ui/styles.css';
import { Game } from './core/game';
import { loadSettings, saveSettings } from './core/settings';
import { Menu } from './ui/menu';
import { makeSeed, persistSeed, resolveSeed } from './utils/seed';

/**
 * Точка входа: меню ↔ игра. Pointer lock — единственный источник правды
 * о том, идёт ли игра: захватили мышь → играем, отпустили (Esc) → пауза.
 */
async function bootstrap(): Promise<void> {
  const container = document.getElementById('app');
  if (!container) throw new Error('index.html: не найден #app');

  const settings = loadSettings();
  const seed = resolveSeed();
  persistSeed(seed);

  const menu = new Menu(settings, seed.text, {
    onPlay: () => game?.ctx.input.requestPointerLock(),
    onRestart: () => {
      game?.restart();
      game?.ctx.input.requestPointerLock();
    },
    onNewSeed: (text) => {
      // Новый город — проще и надёжнее всего перезагрузить страницу с новым seed.
      persistSeed(makeSeed(text));
      location.reload();
    },
    onSettingsChanged: (s) => {
      saveSettings(s);
      game?.applySettings();
    },
  });
  menu.setLoading('Генерация города…');

  // Даём меню отрисоваться до тяжёлой синхронной генерации.
  await new Promise((r) => setTimeout(r, 50));
  let game: Game | null = null;
  game = await Game.create(container, seed, settings);
  const g = game;
  g.start();
  menu.setReady();

  g.onDeath = (sec) => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    menu.setMode('dead', `Ты продержался ${m > 0 ? `${m} мин ` : ''}${s} с`);
  };

  document.addEventListener('pointerlockchange', () => {
    if (g.ctx.input.pointerLocked) {
      if (g.status === 'dead') return;
      menu.setMode('hidden');
      g.play();
    } else if (g.status === 'playing') {
      g.pause();
      menu.setMode('pause', `seed: ${seed.text}`);
    }
  });
  // Клик по canvas во время паузы тоже возвращает в игру.
  g.ctx.renderer.canvas.addEventListener('click', () => {
    if (g.status !== 'dead' && !g.ctx.input.pointerLocked) g.ctx.input.requestPointerLock();
  });

  // ?shot — без меню (для автоматических скриншотов в DEV).
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('shot')) menu.setMode('hidden');
  // Для отладки из консоли браузера.
  if (import.meta.env.DEV) (window as unknown as { game: Game }).game = g;
}

bootstrap().catch((err: unknown) => {
  console.error(err);
  const box = document.createElement('pre');
  box.style.cssText = 'position:fixed;inset:20px;color:#f66;white-space:pre-wrap;z-index:100';
  box.textContent = `Ошибка запуска:\n${err instanceof Error ? err.stack ?? err.message : String(err)}`;
  document.body.appendChild(box);
});
