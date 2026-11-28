// Shared plumbing of the gallery rows: output directory, PNG registry with sha256, quad-mode mapping and per-row
// metrics. Every row script writes its PNGs through `savePng`/`saveSheet` and its data through `record`, then calls
// `finish(part)`; stamp.ts merges the parts into summary.json and provenance.txt.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseImage } from '@forgeax/engine-image/parse-image';
import type { Result } from '@forgeax/engine-types';
import { type QuadOptions, type QuadResult, quadrangulate } from '../../src/brep/quad.ts';
import type { Shape } from '../../src/brep/types.ts';
import type { ModelingError } from '../../src/errors.ts';
import { createImage, drawText, type Image, toPng } from '../brep-kit/image.ts';
import { contactSheet, type SheetCell, type SheetOptions } from '../brep-kit/sheet.ts';
import { holeBoundaryMetrics, quadShapeReport } from '../qf-curved-baseline/metrics.ts';

export const OUT: string =
  process.env.GALLERY_OUT ??
  new URL('../../../../_scratch/viz-out/gallery-1/', import.meta.url).pathname;

export const EDGE_KINDS_SHOWN = ['convex', 'concave', 'boundary'] as const;

export function must<T>(result: Result<T, ModelingError>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error).slice(0, 400));
  return result.value;
}

const pngs: Record<string, string> = {};
const rows: Record<string, unknown>[] = [];

/** Writes an image under OUT and registers its sha256; returns the path relative to OUT. */
export function savePng(rel: string, image: Image): string {
  const bytes = toPng(image);
  const path = join(OUT, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  pngs[rel] = createHash('sha256').update(bytes).digest('hex');
  return rel;
}

/** Registers a PNG that another script already wrote under OUT (re-run of an existing example). */
export function registerPng(rel: string): void {
  pngs[rel] = createHash('sha256')
    .update(readFileSync(join(OUT, rel)))
    .digest('hex');
}

export function saveSheet(rel: string, cells: readonly SheetCell[], options: SheetOptions): string {
  return savePng(rel, contactSheet(cells, options));
}

export function record(row: Record<string, unknown>): void {
  rows.push(row);
}

/** Writes this process's rows and PNG digests as a part for stamp.ts. */
export function finish(part: string): void {
  const dir = join(OUT, '.parts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${part}.json`),
    `${JSON.stringify({ rows, pngSha256: pngs }, null, 2)}\n`,
  );
  // biome-ignore lint/suspicious/noConsole: example script output
  console.log(`${part}: ${rows.length} rows, ${Object.keys(pngs).length} png`);
}

/** Top-left caption lines on an image; the scale follows the image width. */
export function caption(image: Image, lines: readonly string[]): void {
  const scale = image.width >= 900 ? 2 : 1;
  lines.forEach((line, i) => {
    drawText(image, 8, 8 + i * (7 * scale + 4), line, [222, 226, 234], scale);
  });
}

export type QuadMode = 'iso' | 'quad-dominant' | 'blossom-row' | 'split-3';
export const QUAD_MODES: readonly QuadMode[] = ['iso', 'quad-dominant', 'blossom-row', 'split-3'];

export function quadOptions(mode: QuadMode, size: number): QuadOptions {
  switch (mode) {
    case 'iso':
      return { size, trimmed: 'quad-dominant', isoQuadric: true };
    case 'quad-dominant':
      return { size, trimmed: 'quad-dominant' };
    case 'blossom-row':
      return { size, trimmed: 'blossom-row' };
    case 'split-3':
      return { size, trimmed: 'quad-dominant', fallback: 'split-3' };
  }
}

export interface QuadRun {
  readonly row: Record<string, unknown>;
  readonly result?: QuadResult;
}

const round = (v: number): number => Math.round(v * 10000) / 10000;

/** One quadrangulate call reduced to the numbers the board reports; a refusal keeps its code and reason. */
export function runQuad(shape: Shape, mode: QuadMode, size: number): QuadRun {
  const t = performance.now();
  const r = quadrangulate(shape, quadOptions(mode, size));
  const ms = Math.round(performance.now() - t);
  if (!r.ok) {
    const d = r.error.detail as {
      face?: number;
      surface?: string;
      reason?: string;
      constraint?: string;
    };
    return {
      row: {
        mode,
        size,
        status: 'refused',
        code: r.error.code,
        reason: d.reason,
        face: d.face,
        surface: d.surface,
        constraint: d.constraint,
        ms,
      },
    };
  }
  const rep = r.value.report;
  const boundary = holeBoundaryMetrics(shape, r.value);
  return {
    result: r.value,
    row: {
      mode,
      size,
      status: 'ok',
      quads: rep.quads,
      tris: rep.triangles,
      open: rep.openEdges,
      nm: rep.nonManifoldEdges,
      folded: r.value.faceQuality.reduce((n, q) => n + q.foldedPairs, 0),
      minSj: round(rep.scaledJacobian.min),
      meanSj: round(rep.scaledJacobian.mean),
      boundary:
        boundary.boundaryEdges === 0
          ? 'n/a (no holed face)'
          : {
              rowOnly: round(boundary.rowOnly),
              allBoundary: round(boundary.allBoundary),
              coverage: round(boundary.coverage),
              boundaryEdges: boundary.boundaryEdges,
            },
      shape: quadShapeReport(r.value),
      ms,
    },
  };
}

export const fmt = (v: unknown, digits = 2): string =>
  typeof v === 'number' ? v.toFixed(digits) : String(v);

/** One-line metric text for a ran row, used in image captions. */
export function metricLine(row: Record<string, unknown>): string {
  if (row.status !== 'ok') return `REFUSED ${String(row.reason ?? row.code)}`;
  const b = row.boundary as { rowOnly: number; allBoundary: number } | string;
  const hole = typeof b === 'string' ? '' : ` row ${fmt(b.rowOnly)} all ${fmt(b.allBoundary)}`;
  return `minSJ ${fmt(row.minSj)} q ${String(row.quads)} t ${String(row.tris)} fold ${String(row.folded)} nm ${String(row.nm)} open ${String(row.open)}${hole}`;
}

/** Raw RGBA hand-over between processes (the fragmented-merge process feeds the side-by-side sheets). */
export function saveRaw(name: string, image: Image): void {
  const dir = join(OUT, '.raw');
  mkdirSync(dir, { recursive: true });
  const head = new Uint32Array([image.width, image.height]);
  writeFileSync(
    join(dir, `${name}.rgba`),
    Buffer.concat([Buffer.from(head.buffer), Buffer.from(image.rgba)]),
  );
}

export function loadRaw(name: string): Image {
  const buf = readFileSync(join(OUT, '.raw', `${name}.rgba`));
  const head = new Uint32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + 8));
  const rgba = new Uint8Array(buf.buffer.slice(buf.byteOffset + 8, buf.byteOffset + buf.length));
  return { width: head[0] as number, height: head[1] as number, rgba } as Image;
}

/** Placeholder cell for a mesher refusal: nothing is rendered, the reason is the content. */
export function refusalImage(lines: readonly string[], size = 640): Image {
  const image = createImage(size, size, [24, 18, 22]);
  lines.forEach((line, i) => {
    drawText(image, 16, size / 2 - 24 + i * 22, line, [255, 120, 120], 2);
  });
  return image;
}

/** Decodes a PNG already written under OUT (by an older example script) back into an Image for a sheet. */
export function loadPng(rel: string): Image {
  const r = parseImage(new Uint8Array(readFileSync(join(OUT, rel))), 'image/png');
  if (!r.ok) throw new Error(`cannot decode ${rel}`);
  return { width: r.value.width, height: r.value.height, rgba: r.value.bytes };
}
