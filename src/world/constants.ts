/** Размеры, общие для генератора города и игровых систем (в метрах). */
export const SIDEWALK_HEIGHT = 0.15;
export const FLOOR_HEIGHT = 3.2;
export const WALL_THICKNESS = 0.3;
export const SLAB_THICKNESS = 0.25;
export const PARAPET_HEIGHT = 0.6;

export const DOOR_WIDTH = 1.0;
export const DOOR_HEIGHT = 2.2;
export const WINDOW_WIDTH = 1.2;
export const WINDOW_SILL = 0.9;
export const WINDOW_TOP = 2.2;

/** Лестница: подступенок 0.2, проступь 0.3 → уклон ~34°. */
export const STAIR_RISER = 0.2;
export const STAIR_TREAD = 0.3;
export const STAIR_LANE = 1.2;
export const STAIR_LANDING = 1.2;
export const STAIR_RUN = (FLOOR_HEIGHT / STAIR_RISER) * STAIR_TREAD;

export const CHUNK_SIZE = 32;
