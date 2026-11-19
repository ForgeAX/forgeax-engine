import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AssetGuid, definePackageId } from '@forgeax/engine/pack/source';
import { loadScriptablePack } from '@forgeax/engine/pack/source-node';
import type { MeshAsset } from '@forgeax/engine/types';
import { normalizePath } from 'vite';
import { expect, it } from 'vitest';
import { loadPreviewProjectCookers } from '../project-cookers';

it('executes the selected external TS recipe and retires its watched build session', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-preview-cookers-'));
  const sessions: Awaited<ReturnType<typeof loadPreviewProjectCookers>>[] = [];
  const packageId = definePackageId('019fb7ce-4200-7000-8000-00000000c00f');
  const buildGuid = AssetGuid.format(
    AssetGuid.derive(definePackageId('019fb7ce-4200-7000-8000-00000000c010'), 'plugin/build'),
  );
  const guid = (key: string) => AssetGuid.format(AssetGuid.derive(packageId, key));
  const helper = resolve(root, 'assets/helper.ts');
  try {
    await mkdir(resolve(root, 'assets'));
    await symlink(
      fileURLToPath(new URL('../../../../templates/game-3d/node_modules', import.meta.url)),
      resolve(root, 'node_modules'),
      'junction',
    );
    await writeFile(
      resolve(root, 'package.json'),
      JSON.stringify({ name: 'preview-cooker-fixture', type: 'module' }),
    );
    await writeFile(
      resolve(root, 'forge.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        id: 'preview-cooker-fixture',
        name: 'Preview fixture',
        assetRoots: ['assets'],
        roots: { build: buildGuid },
      }),
    );
    await writeFile(
      resolve(root, 'assets/build.pack.ts'),
      `
      import {definePack,definePackageId} from '@forgeax/engine/pack/source';
      import {createMeshJobCooker} from '@forgeax/engine/modeling';
      import {ok} from '@forgeax/engine/types';
      import {JOB} from './job.ts';
      export const build={inject:['nativeCookers'],apply(ctx){ctx.effect(()=>ctx.nativeCookers.register(createMeshJobCooker([JOB],{timeoutMs:180000})));}};
      export default definePack({schemaVersion:'2.0.0',plugins:true,packageId:definePackageId('019fb7ce-4200-7000-8000-00000000c010'),build:()=>ok({'plugin/build':{kind:'plugin',module:{specifier:'./build.pack.ts',export:'build'}}})});
    `,
    );
    await writeFile(
      resolve(root, 'assets/job.ts'),
      `
      import {createBoxGeometry} from '@forgeax/engine/geometry';
      import {ok} from '@forgeax/engine/types';
      import {selectedWidth} from './helper.ts';
      export const JOB={kind:'assets',name:'game-3d-convoy',build(){const mesh=createBoxGeometry(selectedWidth(),0.2,0.3);return mesh.ok?ok({'mesh/selected':mesh.value}):mesh;}};
    `,
    );
    await writeFile(
      resolve(root, 'assets/character.pack.ts'),
      `
      import {definePack,definePackageId} from '@forgeax/engine/pack/source';
      import {assetsJobSources} from '@forgeax/engine/modeling';
      import {JOB} from './job.ts';
      export default definePack({schemaVersion:'2.0.0',packageId:definePackageId('019fb7ce-4200-7000-8000-00000000c00f'),build:context=>assetsJobSources(JOB,{key:'convoy',packageId:context.packageId,params:{},outputs:['mesh/selected']})});
    `,
    );
    await writeFile(
      helper,
      'enum SelectedDimensions { Width = 0.73 } export function selectedWidth(): number { return SelectedDimensions.Width; }',
    );
    const source = await loadScriptablePack(resolve(root, 'assets/character.pack.ts'));
    if (!source.ok) throw source.error;
    const built = await source.value.build({
      packageId,
      values: {},
      readByGuid: async () => {
        throw new Error('Unexpected dependency');
      },
    });
    if (!built.ok) throw built.error;
    const entry = built.value['mesh/selected'];
    if (!entry || !('source' in entry)) throw new Error('Expected a selected deferred asset');
    const first = await loadPreviewProjectCookers(root, resolve(root, '.forgeax/cache'));
    sessions.push(first);
    const cooker = first.session.cookers.find((value) => value.key === 'modeling-mesh-job');
    if (!cooker) throw new Error('Selected project cooker missing');
    expect(cooker.timeoutMs).toBe(180000);
    const mesh = (await cooker.cook({ guid: guid('mesh/selected'), source: entry.source }))
      .payload as MeshAsset;
    const x = (mesh.attributes.position as Float32Array).filter((_, index) => index % 3 === 0);
    expect(Math.max(...x) - Math.min(...x)).toBeCloseTo(0.73, 5);
    const config = { configFileDependencies: [] as string[] };
    await (first.plugin.configResolved as (resolved: typeof config) => unknown)(config);
    expect(config.configFileDependencies).toContain(normalizePath(helper));
    await (first.plugin.closeBundle as () => Promise<void>)();
    await first.session.dispose();
    await expect(
      cooker.cook({ guid: guid('mesh/selected'), source: entry.source }),
    ).rejects.toThrow('unavailable');
  } finally {
    await Promise.all(sessions.map((value) => value.session.dispose()));
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
