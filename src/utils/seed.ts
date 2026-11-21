import { hashString } from './rng';

const STORAGE_KEY = 'dinoscare.seed';

/** Seed хранится строкой (удобно вводить в меню), в число превращается хешем. */
export interface SeedInfo {
  text: string;
  value: number;
}

/**
 * Приоритет: ?seed= в URL → последний seed из localStorage → случайный.
 */
export function resolveSeed(): SeedInfo {
  const fromUrl = new URLSearchParams(window.location.search).get('seed');
  const fromStorage = safeStorageGet(STORAGE_KEY);
  const text = (fromUrl ?? fromStorage ?? randomSeedText()).trim() || randomSeedText();
  return makeSeed(text);
}

export function makeSeed(text: string): SeedInfo {
  return { text, value: hashString(text) };
}

export function persistSeed(seed: SeedInfo): void {
  try {
    localStorage.setItem(STORAGE_KEY, seed.text);
  } catch {
    /* приватный режим и т.п. — не критично */
  }
  const url = new URL(window.location.href);
  url.searchParams.set('seed', seed.text);
  window.history.replaceState(null, '', url);
}

export function randomSeedText(): string {
  return Math.floor(Math.random() * 0xffffffff).toString(36);
}

function safeStorageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
