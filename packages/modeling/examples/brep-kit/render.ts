import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { err, ok, type Result } from '@forgeax/engine-types';
import { type TessellateOptions, tessellate } from '../../src/brep/tessellate.ts';
import type { Shape } from '../../src/brep/types.ts';
import type { ModelingError } from '../../src/errors.ts';
import type { EditMesh } from '../../src/mesh.ts';
import { STANDARD_VIEWS, type ViewSpec, viewBasis, viewName } from './camera.ts';
import { type EdgeKind, NEUTRAL, PART_PALETTE, paletteAt, scaleColor } from './colors.ts';
import { drawText, type Image, toPng } from './image.ts';
import { drawHeatBar, drawLegend, edgeLegend, valenceLegend } from './legend.ts';
import {
  asPolyMesh,
  meshSurface,
  type PolyMesh,
  quadNetwork,
  quadStats,
  silhouetteLines,
} from './mesh-scene.ts';
import { type RenderOptions, renderScene } from './raster.ts';
import { mergeScenes, type Scene, type SceneLine, type SceneTri } from './scene.ts';
import {
  classifyEdges,
  countByKind,
  featureLines,
  type IsoOptions,
  isoLines,
} from './shape-lines.ts';

/** What a mode draws. Shapes support shaded/features/iso; meshes support shaded/network/jacobian; every part supports all. */
export type Mode = 'shaded' | 'features' | 'iso' | 'network' | 'jacobian';

export type Part = Shape | EditMesh | PolyMesh;

export interface RenderShapeOptions extends RenderOptions {
  readonly views?: readonly ViewSpec[];
  /** Default: shaded, features, iso for a Shape; shaded, network, jacobian for a mesh. */
  readonly modes?: readonly Mode[];
  /** Directory for `<name><mode>-<view>.png`; omit to only return images. */
  readonly outDir?: string;
  /** File-name prefix, for example `housing-`. */
  readonly name?: string;
  /** Surface tessellation for Shapes (default angle pi / 32). */
  readonly tessellation?: TessellateOptions;
  readonly crease?: number;
  readonly iso?: IsoOptions;
  readonly silhouette?: boolean;
  readonly colorBy?: 'part' | 'face';
  /** Legend on the first view only (default), on every view, or never. */
  readonly legend?: 'first' | 'all' | 'none';
  /** Draw "<mode> <view>" in the top-left corner (default true). */
  readonly label?: boolean;
  /** Context parts drawn as a dim, line-free underlay in every mode (for example parts a mesh mode cannot show). */
  readonly ghost?: readonly Part[];
  /** Feature edge classes to draw (default all). */
  readonly kinds?: readonly EdgeKind[];
}

export interface RenderedView {
  readonly mode: Mode;
  readonly view: string;
  readonly image: Image;
  readonly path?: string;
}

export interface RenderSummary {
  readonly edges: Record<EdgeKind, number>;
  readonly quad?: ReturnType<typeof quadStats>;
}

export interface RenderResult {
  readonly views: readonly RenderedView[];
  readonly summary: RenderSummary;
}

const DEFAULT_TESSELLATION: TessellateOptions = { angle: Math.PI / 32 };
const UNDERLAY = 0.42;
const GHOST_DIM = 0.3;
const TEXT: [number, number, number] = [222, 226, 234];

function isShape(p: Part): p is Shape {
  return 'shells' in p;
}

interface Prepared {
  readonly part: Part;
  readonly index: number;
  readonly poly: PolyMesh;
}

function prepare(
  parts: readonly Part[],
  tessellation: TessellateOptions,
): Result<Prepared[], ModelingError> {
  const out: Prepared[] = [];
  for (const [index, part] of parts.entries()) {
    if (isShape(part)) {
      const mesh = tessellate(part, tessellation);
      if (!mesh.ok) return err(mesh.error);
      const byLabel = new Map(part.faces.map((f, i) => [f.label, i] as const));
      const poly = asPolyMesh(mesh.value);
      const labels = mesh.value
        .faces()
        .map((f) => mesh.value.labelNames[mesh.value.fLabel[f] as number] ?? '');
      out.push({ part, index, poly: { ...poly, group: labels.map((l) => byLabel.get(l) ?? 0) } });
    } else out.push({ part, index, poly: asPolyMesh(part) });
  }
  return ok(out);
}

function surfaceTris(
  prepared: readonly Prepared[],
  options: RenderShapeOptions,
  dim: number,
  forceParts = false,
): SceneTri[] {
  const single = prepared.length === 1 && !forceParts;
  return prepared.flatMap(({ part, index, poly }) => {
    const colorBy = options.colorBy ?? (single && isShape(part) ? 'face' : 'part');
    const color = single ? NEUTRAL : paletteAt(PART_PALETTE, index);
    return meshSurface(poly, { colorBy, color, dim });
  });
}

function defaultModes(parts: readonly Part[]): Mode[] {
  return parts.every((p) => !isShape(p))
    ? ['shaded', 'network', 'jacobian']
    : ['shaded', 'features', 'iso'];
}

function meshFeatureLines(poly: PolyMesh): SceneLine[] {
  const lines: SceneLine[] = [];
  const net = quadNetwork(poly, { shading: 'plain', singularities: false });
  for (const l of net.lines) if (l.width > 1.2) lines.push(l);
  return lines;
}

/** Renders one or more parts (a Shape, EditMesh, PolyMesh, or an assembly of them) in each requested mode and view. */
export function renderShape(
  input: Part | readonly Part[],
  options: RenderShapeOptions = {},
): Result<RenderResult, ModelingError> {
  const parts: readonly Part[] = Array.isArray(input)
    ? (input as readonly Part[])
    : [input as Part];
  const prepared = prepare(parts, options.tessellation ?? DEFAULT_TESSELLATION);
  if (!prepared.ok) return prepared;
  const ghost = prepare(options.ghost ?? [], options.tessellation ?? DEFAULT_TESSELLATION);
  if (!ghost.ok) return ghost;
  const ghostTris = surfaceTris(ghost.value, { ...options, colorBy: 'part' }, GHOST_DIM, true);
  const withGhost = (scene: Scene): Scene =>
    ghostTris.length === 0 ? scene : { ...scene, tris: [...scene.tris, ...ghostTris] };
  const modes = options.modes ?? defaultModes(parts);
  const views = options.views ?? STANDARD_VIEWS;
  const shapes = parts.filter(isShape);
  const kindSet = options.kinds === undefined ? undefined : new Set(options.kinds);
  const classified = shapes.flatMap((s) =>
    classifyEdges(s, options.crease === undefined ? {} : { crease: options.crease }),
  );
  const edgeCounts = countByKind(classified);
  const meshes = prepared.value.filter((p) => !isShape(p.part));
  const quad = meshes.length > 0 ? quadStats(meshes[0]?.poly as PolyMesh) : undefined;
  const staticScene = (mode: Mode): Scene => {
    switch (mode) {
      case 'shaded':
        return { tris: surfaceTris(prepared.value, options, 1), lines: [], markers: [] };
      case 'features': {
        const lines = [
          ...shapes.flatMap((s) =>
            featureLines(s, {
              ...(options.crease === undefined ? {} : { crease: options.crease }),
              ...(kindSet === undefined ? {} : { kinds: kindSet }),
            }),
          ),
          ...meshes.flatMap((m) => meshFeatureLines(m.poly)),
        ];
        return { tris: surfaceTris(prepared.value, options, UNDERLAY), lines, markers: [] };
      }
      case 'iso': {
        const lines = [
          ...shapes.flatMap((s) => isoLines(s, options.iso)),
          ...shapes.flatMap((s) =>
            featureLines(s, {
              ...(options.crease === undefined ? {} : { crease: options.crease }),
              kinds: new Set<EdgeKind>(['convex', 'concave', 'boundary']),
            }).map((l) => ({ ...l, color: scaleColor(l.color, 0.55), width: 1.2 })),
          ),
        ];
        return { tris: surfaceTris(prepared.value, options, UNDERLAY), lines, markers: [] };
      }
      case 'network':
      case 'jacobian':
        return mergeScenes(
          ...prepared.value.map((p) =>
            quadNetwork(p.poly, { shading: mode === 'jacobian' ? 'jacobian' : 'plain' }),
          ),
        );
    }
  };
  const out: RenderedView[] = [];
  for (const mode of modes) {
    const base = withGhost(staticScene(mode));
    for (const [i, view] of views.entries()) {
      const scene: Scene =
        options.silhouette === true && mode !== 'jacobian'
          ? {
              ...base,
              lines: [
                ...base.lines,
                ...prepared.value.flatMap((p) => silhouetteLines(p.poly, viewBasis(view))),
              ],
            }
          : base;
      const image = renderScene(scene, view, options);
      const scale = image.width >= 900 ? 2 : 1;
      if (options.label !== false) drawText(image, 8, 8, `${mode} ${viewName(view)}`, TEXT, scale);
      const showLegend = options.legend === 'all' || (options.legend !== 'none' && i === 0);
      if (showLegend) decorate(image, mode, classified.length > 0, edgeCounts, quad, scale);
      const name = `${options.name ?? ''}${mode}-${viewName(view)}`;
      const rendered: RenderedView = { mode, view: viewName(view), image };
      if (options.outDir !== undefined) {
        mkdirSync(options.outDir, { recursive: true });
        const path = join(options.outDir, `${name}.png`);
        writeFileSync(path, toPng(image));
        out.push({ ...rendered, path });
      } else out.push(rendered);
    }
  }
  return ok({
    views: out,
    summary: { edges: edgeCounts, ...(quad === undefined ? {} : { quad }) },
  });
}

function decorate(
  image: Image,
  mode: Mode,
  hasShapes: boolean,
  counts: Record<EdgeKind, number>,
  quad: ReturnType<typeof quadStats> | undefined,
  scale: number,
): void {
  const y = image.height - 8;
  if ((mode === 'features' || mode === 'iso') && hasShapes) {
    const kinds = (Object.keys(counts) as EdgeKind[]).filter(
      (k) => counts[k] > 0 && (mode === 'features' || (k !== 'smooth' && k !== 'seam')),
    );
    const entries = edgeLegend(kinds).map((e, i) => ({
      ...e,
      label: `${e.label} ${counts[kinds[i] as EdgeKind]}`,
    }));
    const h = 8 + (7 * scale + 5) * (entries.length + 1);
    drawLegend(image, 8, y - h, mode === 'features' ? 'edges' : 'edges (dim)', entries, scale);
  } else if ((mode === 'network' || mode === 'jacobian') && quad !== undefined) {
    const valences = Object.keys(quad.singular)
      .map(Number)
      .sort((a, b) => a - b);
    const entries = valenceLegend(valences, quad.featureCorners > 0);
    const h = 8 + (7 * scale + 5) * (entries.length + 1);
    drawLegend(
      image,
      8,
      y - h,
      `singular ${quad.singularTotal}, corners ${quad.featureCorners}`,
      entries,
      scale,
    );
    if (mode === 'jacobian') drawHeatBar(image, image.width - 140 * scale, y - 36 * scale, scale);
  }
}

export type { Scene };
