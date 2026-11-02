import { err, ok, type Result } from '@forgeax/engine-types';
import { alphaCoverage, type BakeResult, type BakeSettings } from './bake';
import type { BakeMapKind } from './compute/job';
import { type ModelingError, modelingError } from './errors';
import { type Model, model } from './model';
import type { Point2 } from './primitives';
import { circle } from './recipes/common';
import { sel } from './selectors';

/**
 * Thin grille and vent holes as opacity or height recesses (C-401 rule): a hole in a plate
 * a few millimeters thick is not worth real through-geometry in the runtime mesh. The
 * runtime keeps one flat quad; the detail exists only at build time and is baked either as
 * an alpha-tested cutout (`'opacity'`, the hole is see-through; a dark backing stays real
 * geometry in the runtime scene) or as a shallow recess in the height map (`'recess'`, a
 * blind pocket). Parallax must never dig a see-through hole, so the opacity bake keeps the
 * height of the solid plate only.
 */
export interface ThinHoleOptions {
  /** Tile extent along x and y in meters; the tile spans [0, width] x [0, height]. */
  readonly width: number;
  readonly height: number;
  /** Hole diameter and center spacing along x (hex rows are spaced pitch x sqrt(3) / 2). */
  readonly diameter: number;
  readonly pitch: number;
  /** 'square' (default) or 'hex' (every other row shifted half a pitch). */
  readonly pattern?: 'square' | 'hex';
  /** Plate thickness along z; the plate top lies on z = 0, the base plane. */
  readonly thickness: number;
  /** 'opacity' (default): through-holes cut by alpha; 'recess': blind pockets in the height map. */
  readonly mode?: 'opacity' | 'recess';
  /** Recess depth in meters, at most `thickness` (default half the thickness); recess mode only. */
  readonly depth?: number;
  /** Sides of each hole polygon (default 16). */
  readonly segments?: number;
  /** Texture size, as `BakeSettings.resolution`. */
  readonly resolution: number | readonly [number, number];
  /** Alpha-test cutoff the opacity mips keep coverage for (default 0.5). */
  readonly cutoff?: number;
  /** Maps besides the ones the mode needs (default normal, ao). */
  readonly maps?: readonly BakeMapKind[];
}

export interface ThinHolePlan {
  /** The perforated plate (closed, top at z = 0, facing +z): the bake detail. */
  readonly detail: Model;
  /** One quad over [0, width] x [0, height] with uv0 over [0, 1]^2: the bake base. */
  readonly base: Model;
  /** Bake settings for `bakeMaps({ base, detail, ...settings })` or `bakeSources`. */
  readonly settings: BakeSettings & { readonly maps: readonly BakeMapKind[] };
  readonly mode: 'opacity' | 'recess';
  readonly width: number;
  readonly height: number;
  /** Hole outlines in the tile plane. */
  readonly holes: readonly (readonly Point2[])[];
  /** Exact hole area over tile area. */
  readonly openFraction: number;
  /** Alpha-test cutoff of the opacity map (opacity mode). */
  readonly cutoff: number;
}

export interface ThinHoleReport {
  readonly pass: boolean;
  readonly mode: 'opacity' | 'recess';
  /** Opacity: the solid share of the tile (alpha coverage). Recess: the hole share (floor texels). */
  readonly expected: number;
  /** Opacity: alpha-test coverage on each mip down to a 16-texel side. Recess: the floor share of mip 0. */
  readonly measured: readonly number[];
  readonly maxError: number;
  readonly tolerance: number;
}

const invalid = (message: string, detail: Record<string, unknown>): ModelingError =>
  modelingError('model-invalid-argument', message, detail);

function finite(
  name: string,
  value: number | undefined,
  positive = true,
): ModelingError | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && (!positive || value > 0))
    return undefined;
  return invalid(`${name} is a finite number greater than 0`, { [name]: value });
}

function layout(o: ThinHoleOptions, segments: number): Point2[][] | ModelingError {
  const radius = o.diameter / 2;
  const hex = o.pattern === 'hex';
  const step = hex ? (o.pitch * Math.sqrt(3)) / 2 : o.pitch;
  const holes: Point2[][] = [];
  for (let j = 0; ; j++) {
    const y = (j + 0.5) * step;
    if (y + radius > o.height) break;
    const shift = hex && j % 2 === 1 ? o.pitch / 2 : 0;
    for (let i = 0; ; i++) {
      const x = (i + 0.5) * o.pitch + shift;
      if (x + radius > o.width) break;
      if (y - radius < 0 || x - radius < 0) continue;
      holes.push(circle(radius, segments, [x, y]));
    }
  }
  if (holes.length === 0)
    return invalid('the tile fits at least one hole', {
      width: o.width,
      height: o.height,
      diameter: o.diameter,
    });
  return holes;
}

const ringArea = (ring: readonly Point2[]): number => {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i] as Point2;
    const q = ring[(i + 1) % ring.length] as Point2;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
};

/**
 * Plan a thin-hole tile: the perforated detail plate, the flat base quad with tile uv0 and
 * the bake settings that follow the C-401 rule. Compose it with the ordinary bake:
 * `bakeMaps({ base, detail, ...settings })`, then judge the result with `thinHoleCheck`.
 */
export function thinHole(options: ThinHoleOptions): Result<ThinHolePlan, ModelingError> {
  const mode = options.mode ?? 'opacity';
  const segments = options.segments ?? 16;
  const cutoff = options.cutoff ?? 0.5;
  const bad =
    finite('width', options.width) ??
    finite('height', options.height) ??
    finite('diameter', options.diameter) ??
    finite('pitch', options.pitch) ??
    finite('thickness', options.thickness);
  if (bad !== undefined) return err(bad);
  if (options.diameter >= options.pitch)
    return err(
      invalid('holes are narrower than their pitch', {
        diameter: options.diameter,
        pitch: options.pitch,
      }),
    );
  if (!(Number.isInteger(segments) && segments >= 3))
    return err(invalid('segments is a whole count of at least 3', { segments }));
  if (mode !== 'opacity' && mode !== 'recess')
    return err(invalid("mode is 'opacity' or 'recess'", { mode }));
  if (options.pattern !== undefined && options.pattern !== 'square' && options.pattern !== 'hex')
    return err(invalid("pattern is 'square' or 'hex'", { pattern: options.pattern }));
  if (!(cutoff > 0 && cutoff < 1)) return err(invalid('cutoff is in (0, 1)', { cutoff }));
  const depth = options.depth ?? options.thickness / 2;
  if (mode === 'recess' && !(depth > 0 && depth <= options.thickness))
    return err(invalid('depth is in (0, thickness]', { depth, thickness: options.thickness }));
  const holes = layout(options, segments);
  if (!Array.isArray(holes)) return err(holes as ModelingError);
  const { width, height, thickness } = options;
  const outline: Point2[] = [
    [0, 0],
    [width, 0],
    [width, height],
    [0, height],
  ];
  const detail = model();
  if (mode === 'opacity') {
    detail.extrudePolygon({ points: outline, holes, depth: thickness, tag: 'plate' });
    detail.translate(sel.tag('plate'), [0, 0, -thickness]);
  } else {
    detail.extrudePolygon({ points: outline, holes, depth, tag: 'plate' });
    detail.translate(sel.tag('plate'), [0, 0, -depth]);
    if (depth < thickness) {
      detail.extrudePolygon({ points: outline, depth: thickness - depth, tag: 'floor' });
      detail.translate(sel.tag('floor'), [0, 0, -thickness]);
    }
  }
  const base = model();
  base.plane({ width, height, center: [width / 2, height / 2, 0] });
  const mesh = base.editMesh;
  for (const f of mesh.faces()) {
    for (const h of mesh.faceHalves(f)) {
      const [x, y] = mesh.position(mesh.hVert[h] as number);
      mesh.setCorner('uv0', h, [x / width, y / height]);
    }
  }
  for (const m of [detail, base]) if (m.poisoned !== undefined) return err(m.poisoned);
  const open = holes.reduce((sum, ring) => sum + ringArea(ring), 0) / (width * height);
  const relief = mode === 'opacity' ? thickness : depth;
  const maps = [
    ...new Set<BakeMapKind>([
      ...(options.maps ?? ['normal', 'ao']),
      'height',
      ...(mode === 'opacity' ? (['opacity'] as const) : []),
    ]),
  ];
  return ok({
    detail,
    base,
    settings: {
      maps,
      resolution: options.resolution,
      samples: 4,
      cage: { offset: thickness, maxRay: 3 * thickness },
      height: { range: [-relief, 0] },
      ...(mode === 'opacity' ? { opacity: { cutoff } } : {}),
    },
    mode,
    width,
    height,
    holes,
    openFraction: open,
    cutoff,
  });
}

/**
 * Judge a thin-hole bake against its plan. Opacity mode: the alpha-test coverage on every
 * mip down to a 16-texel side stays within `tolerance` (default 0.05, the V12 limit) of
 * the exact solid share, so the holes neither close nor widen with distance. Recess mode:
 * the share of mip-0 texels at the recess floor is within `tolerance` of the open share.
 * A missing map fails the check.
 */
export function thinHoleCheck(
  result: Pick<BakeResult, 'textures'>,
  plan: ThinHolePlan,
  tolerance = 0.05,
): ThinHoleReport {
  const opacity = plan.mode === 'opacity';
  const expected = opacity ? 1 - plan.openFraction : plan.openFraction;
  const texture = result.textures[opacity ? 'opacity' : 'height'];
  const measured: number[] = [];
  if (texture !== undefined) {
    if (opacity) measured.push(...alphaCoverage(texture, plan.cutoff));
    else {
      const { width, height } = texture.shape.extent as { width: number; height: number };
      let floor = 0;
      for (let i = 0; i < width * height; i++) if ((texture.data[i * 4] as number) < 128) floor++;
      measured.push(floor / (width * height));
    }
  }
  const maxError =
    measured.length === 0
      ? Number.POSITIVE_INFINITY
      : Math.max(...measured.map((c) => Math.abs(c - expected)));
  return { pass: maxError <= tolerance, mode: plan.mode, expected, measured, maxError, tolerance };
}
