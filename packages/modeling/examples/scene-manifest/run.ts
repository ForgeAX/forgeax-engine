// Builds the scene, measures it, and writes scene.json plus the iso and top pictures.
// Output directory: SCENE_MANIFEST_OUT, default /tmp/scene-manifest. The kernel itself writes nothing.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { toPng } from '../brep-kit/image.ts';
import { renderScene } from './render.ts';
import { SCENE_ASSETS, SCENE_PLACEMENTS } from './scene.ts';
import { sceneManifest, type SceneManifest, sceneTrianglesAt, SCENE_OUTPUT_PROFILES } from '../../src/scene-manifest.ts';

export const OUT_DIR = process.env.SCENE_MANIFEST_OUT ?? '/tmp/scene-manifest';

export function buildManifest(): SceneManifest {
  const r = sceneManifest(SCENE_ASSETS, SCENE_PLACEMENTS, 'mobile-scene');
  if (!r.ok) throw new Error(`manifest refused: ${r.error.code} ${JSON.stringify(r.error.detail)}`);
  return r.value;
}

export function writeOutputs(dir: string, manifest: SceneManifest): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'scene.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const pictures = renderScene(manifest, SCENE_ASSETS);
  for (const [name, picture] of Object.entries(pictures)) {
    writeFileSync(join(dir, `scene-${name}.png`), toPng(picture.image));
  }
}

function main(): void {
  const manifest = buildManifest();
  writeOutputs(OUT_DIR, manifest);
  const t = manifest.totals;
  const p = SCENE_OUTPUT_PROFILES['mobile-scene'];
  const lines = [
    `out ${OUT_DIR}`,
    `placements ${t.instances} unique assets ${t.uniqueAssets}`,
    `triangles lod0 ${t.trianglesLod0} lowest ${t.trianglesLowest} unique ${t.trianglesUnique}`,
    `draw calls per-instance ${t.drawCallsPerInstance} instanced ${t.drawCallsInstanced}`,
    `texture bytes ${t.textureBytes} mesh bytes ${t.meshBytes}`,
    `budget ok ${manifest.budget.ok} issues ${manifest.budget.issues.map((i) => i.code).join(',') || 'none'}`,
    `profile ${manifest.profile} triangles<=${p.maxTriangles} draw<=${p.maxDrawCalls} mesh<=${p.maxMeshBytes}`,
    `lod camera near triangles ${sceneTrianglesAt(manifest, [0, -5, 0])} far ${sceneTrianglesAt(manifest, [0, -500, 0])}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
