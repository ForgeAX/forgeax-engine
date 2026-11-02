import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildScriptablePack,
  createStandardAssetOutputProducerRegistry,
} from '@forgeax/engine-import';
import { createMeshJobCooker, model, type RigJob, rig, sel } from '@forgeax/engine-modeling';
import { projectScriptablePackSceneComponents } from '@forgeax/engine-pack';
import { AssetGuid } from '@forgeax/engine-pack/source';
import { loadScriptablePack } from '@forgeax/engine-pack/source-node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The S7 route on the real Import build kernel: a Pack returns a rig job's outputs as
 * `modeling-mesh-job` cook sources, the project registers the cooker, and Import
 * publishes the part meshes, the scene (externalized through the Pack's sceneComponents)
 * and the clip as ordinary assets from one rig build.
 */
const root = fileURLToPath(new URL('../../', import.meta.url));
let directory = '';

let builds = 0;
const ARM: RigJob<{ readonly length: number }> = {
  kind: 'rig',
  name: 'test.arm',
  build: (p) => {
    builds++;
    const m = model();
    m.box({ size: [0.1, 0.1, 0.1], tag: 'base' });
    m.box({ size: [p.length, 0.05, 0.05], center: [p.length / 2 + 0.05, 0, 0], tag: 'arm' });
    m.uv.project({ mode: 'box', scale: 1 });
    const r = rig(m, {
      joints: [
        { name: 'root', parent: null, position: [0, 0, 0] },
        { name: 'elbow', parent: 'root', position: [0.05, 0, 0], kind: 'revolute', axis: 'z' },
      ],
    });
    r.bindRigid(sel.tag('base'), 'root', { part: 'base' });
    r.bindRigid(sel.tag('arm'), 'elbow', { part: 'arm' });
    return {
      rig: r,
      finish: {
        path: {
          keys: [
            { u: 0, pose: { elbow: 0 } },
            { u: 1, pose: { elbow: 90 } },
          ],
        },
        duration: 2,
      },
    };
  },
};

// The Pack builds the job's sources only: the job itself is registered with the cooker.
const PACK = `import { AnimationPlayer, AnimationTargetId } from '@forgeax/engine-animation';
import { rigJobSources } from '@forgeax/engine-modeling';
import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { ChildOf, Name, Transform } from '@forgeax/engine-scene';
const JOB = { kind: 'rig', name: 'test.arm', build: () => { throw new Error('the Pack never runs the job'); } };
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-00000000c0b7'),
  sceneComponents: [AnimationPlayer, AnimationTargetId, ChildOf, MeshFilter, MeshRenderer, Name, Transform],
  build: ({ packageId }) =>
    rigJobSources(JOB, {
      key: 'arm',
      packageId,
      params: { length: 0.3 },
      outputs: ['animation-clip/arm', 'mesh/arm.arm', 'mesh/arm.base', 'scene/arm'],
    }),
});
`;

beforeAll(async () => {
  directory = await mkdtemp(join(root, '.isolation-rig-job-'));
  await writeFile(join(directory, 'arm.pack.ts'), PACK);
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('rig jobs through the Import Pack build', () => {
  it('publishes meshes, scene and clip from one cooker build', { timeout: 120000 }, async () => {
    const path = join(directory, 'arm.pack.ts');
    const loaded = await loadScriptablePack(path);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.error));
    builds = 0;
    const built = await buildScriptablePack({
      definition: loaded.value,
      sourcePath: path,
      outputs: createStandardAssetOutputProducerRegistry(
        projectScriptablePackSceneComponents(loaded.value.sceneComponents),
      ),
      cookers: [createMeshJobCooker([ARM])],
    });
    if (!built.ok) throw new Error(JSON.stringify(built.error));
    expect(builds).toBe(1);
    const guid = (key: string) =>
      AssetGuid.format(AssetGuid.derive(loaded.value.packageId, key)).toLowerCase();
    const assets = built.value.product.assets;
    const kinds = new Map(assets.map((a) => [a.guid.toLowerCase(), a.kind]));
    expect(kinds.get(guid('mesh/arm.arm'))).toBe('mesh');
    expect(kinds.get(guid('mesh/arm.base'))).toBe('mesh');
    expect(kinds.get(guid('scene/arm'))).toBe('scene');
    expect(kinds.get(guid('animation-clip/arm'))).toBe('animation-clip');
    // The scene references the part meshes and the clip by their derived GUIDs.
    const scene = assets.find((a) => a.guid.toLowerCase() === guid('scene/arm'));
    const refs = new Set(
      (scene?.refs ?? []).map((r) => (typeof r === 'string' ? r : r.guid).toLowerCase()),
    );
    for (const key of ['mesh/arm.arm', 'mesh/arm.base', 'animation-clip/arm'])
      expect(refs.has(guid(key))).toBe(true);
  });
});
