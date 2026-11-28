// A small multi-feature bracket: each part carries a role, and the exported mesh gives each
// role its own material slot. The render colours one flat colour per slot, so the role split is
// visible in the picture rather than only in the export report.

import * as exact from '../../src/brep/index.ts';
import { type Model, model } from '../../src/model.ts';
import type { ViewSpec } from '../brep-kit/camera.ts';
import type { RGB } from '../brep-kit/image.ts';
import { type RenderOptions, renderScene } from '../brep-kit/raster.ts';
import type { Scene, SceneTri } from '../brep-kit/scene.ts';
import { contactSheet, type SheetCell } from '../brep-kit/sheet.ts';

const COLORS: Readonly<Record<string, RGB>> = {
  Default: [150, 150, 150],
  body: [76, 140, 214],
  boss: [230, 128, 60],
  rib: [96, 190, 110],
};

const VIEWS: readonly ViewSpec[] = ['iso', 'front', 'top'];

export interface RoleSlotResult {
  readonly slotNames: readonly string[];
  readonly submeshes: number;
  readonly triangles: number;
  readonly sheet: string;
}

function buildBracket(): Model {
  const m = model({ exact });
  m.brep.box('plate', { size: [2, 0.2, 1], label: 'plate', role: 'body' });
  m.brep.cylinder('boss', {
    radius: 0.25,
    height: 0.6,
    frame: { o: [-0.5, 0.1, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
    label: 'boss',
    role: 'boss',
  });
  m.brep.box('rib', {
    size: [0.15, 0.7, 0.8],
    frame: { o: [0.7, 0.1, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
    label: 'rib',
    role: 'rib',
  });
  m.brep.box('pad', {
    size: [0.3, 0.05, 0.3],
    frame: { o: [0, 0.125, 0.2], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
    label: 'pad',
  });
  for (const name of ['plate', 'boss', 'rib', 'pad']) m.fromShape(name);
  return m;
}

export function renderRoleSlots(outDir: string, size = 420): RoleSlotResult {
  const m = buildBracket();
  const out = m.toMesh();
  if (!out.ok) throw new Error(JSON.stringify(out.error));
  const { mesh, report } = out.value;
  const slotNames = mesh.materialSlots.map((s) => s.slotName);
  const pos = mesh.attributes.position as Float32Array;
  const idx = mesh.indices as Uint16Array | Uint32Array;

  const tris: SceneTri[] = [];
  for (const sub of mesh.submeshes) {
    const color = COLORS[slotNames[sub.materialSlot] ?? 'Default'] ?? [200, 200, 200];
    for (let i = sub.indexOffset; i < sub.indexOffset + sub.indexCount; i += 3) {
      const at = (k: number): [number, number, number] => {
        const v = idx[i + k] as number;
        return [pos[v * 3] as number, pos[v * 3 + 1] as number, pos[v * 3 + 2] as number];
      };
      tris.push({ a: at(0), b: at(1), c: at(2), color, unlit: true });
    }
  }
  const scene: Scene = { tris, lines: [], markers: [] };
  const options: RenderOptions = { size };
  const cells: SheetCell[] = VIEWS.map((view) => ({
    image: renderScene(scene, view, options),
    caption: `${view}: flat colour per role slot`,
  }));
  const sheet = `${outDir}/role-slots-sheet.png`;
  contactSheet(cells, {
    columns: VIEWS.length,
    cell: size,
    title: `Bracket role slots: ${slotNames.join(', ')}`,
    path: sheet,
  });
  return { slotNames, submeshes: mesh.submeshes.length, triangles: report.triangles, sheet };
}
