import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { quadrangulate } from '../../src/brep/quad.ts';
import type { Shape } from '../../src/brep/types.ts';
import { NEUTRAL } from '../brep-kit/colors.ts';
import { toPng } from '../brep-kit/image.ts';
import { renderShape } from '../brep-kit/index.ts';
import { asPolyMesh, meshSurface, quadNetwork } from '../brep-kit/mesh-scene.ts';
import { renderScene } from '../brep-kit/raster.ts';
import { mergeScenes } from '../brep-kit/scene.ts';
import { bellShape, potShape, vaseShape } from './shapes.ts';

export interface RevolveRender {
  readonly files: readonly string[];
  readonly quads: number;
}

const SIZE = 720;

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

/** Flat-shaded, one colour per face, no outlines: the facet contrast is the shading itself. */
function flat(shape: Shape, outDir: string, name: string): string {
  const r = must(
    renderShape(shape, {
      size: SIZE,
      modes: ['shaded'],
      views: ['iso'],
      colorBy: 'face',
      silhouette: false,
      label: false,
      legend: 'none',
      outDir,
      name: `${name}-`,
    }),
  );
  const path = r.views[0]?.path;
  if (path === undefined) throw new Error(`no image written for ${name}`);
  return path;
}

/** Quad wireframe drawn over the plain shaded surface of the same mesh. */
function wireOverShade(
  shape: Shape,
  size: number,
  outDir: string,
  name: string,
): { path: string; quads: number } {
  const q = must(quadrangulate(shape, { size }));
  const poly = asPolyMesh(q.mesh);
  const tris = meshSurface(poly, { color: NEUTRAL, dim: 0.85 });
  const net = quadNetwork(poly, { shading: 'plain', singularities: true });
  const scene = mergeScenes({ tris, lines: [], markers: [] }, net);
  const image = renderScene(scene, 'iso', { size: SIZE });
  const path = join(outDir, `${name}.png`);
  writeFileSync(path, toPng(image));
  return { path, quads: q.report.quads };
}

export function renderRevolveFreeform(outDir: string): RevolveRender {
  mkdirSync(outDir, { recursive: true });
  const vase = vaseShape();
  const wire = wireOverShade(vase, 0.25, outDir, 'vase-quad-wire');
  const files = [
    flat(vase, outDir, 'vase-flat'),
    flat(bellShape(), outDir, 'bell-flat'),
    flat(potShape(), outDir, 'pot-flat'),
    wire.path,
  ];
  return { files, quads: wire.quads };
}
