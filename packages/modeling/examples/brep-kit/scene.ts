import type { RGB } from './image.ts';

export type P3 = readonly [number, number, number];

export interface SceneTri {
  readonly a: P3;
  readonly b: P3;
  readonly c: P3;
  readonly color: RGB;
  /** Flat colour with no lighting (heat maps, id colours). */
  readonly unlit?: boolean;
}

export interface SceneLine {
  readonly points: readonly P3[];
  readonly color: RGB;
  /** Width in output pixels. */
  readonly width: number;
  /** Dash pattern `[on, off]` in output pixels. */
  readonly dash?: readonly [number, number];
  /** Added to the depth test, in units of the depth bias (default 1); negative pushes behind. */
  readonly bias?: number;
  /** Drawn even where hidden behind a surface, at 35 % strength. */
  readonly xray?: boolean;
}

export interface SceneMarker {
  readonly p: P3;
  readonly color: RGB;
  /** Radius in output pixels. */
  readonly radius: number;
  /** Outline only. */
  readonly ring?: boolean;
}

/** Everything a view draws: surfaces first, then depth-tested lines, then markers. */
export interface Scene {
  readonly tris: readonly SceneTri[];
  readonly lines: readonly SceneLine[];
  readonly markers: readonly SceneMarker[];
}

export const EMPTY_SCENE: Scene = { tris: [], lines: [], markers: [] };

export function mergeScenes(...scenes: readonly Scene[]): Scene {
  return {
    tris: scenes.flatMap((s) => s.tris),
    lines: scenes.flatMap((s) => s.lines),
    markers: scenes.flatMap((s) => s.markers),
  };
}

export function sceneBounds(scene: Scene): { min: P3; max: P3 } | undefined {
  let min: [number, number, number] = [Infinity, Infinity, Infinity];
  let max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const add = (p: P3) => {
    min = [Math.min(min[0], p[0]), Math.min(min[1], p[1]), Math.min(min[2], p[2])];
    max = [Math.max(max[0], p[0]), Math.max(max[1], p[1]), Math.max(max[2], p[2])];
  };
  for (const t of scene.tris) {
    add(t.a);
    add(t.b);
    add(t.c);
  }
  for (const l of scene.lines) for (const p of l.points) add(p);
  for (const m of scene.markers) add(m.p);
  return min[0] > max[0] ? undefined : { min, max };
}
