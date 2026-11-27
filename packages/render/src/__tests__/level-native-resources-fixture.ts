import { createBoxGeometry } from '@forgeax/engine-geometry';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { ok, type SceneAsset, type TextureAsset } from '@forgeax/engine-types';
import { buildEngineShaderTemplateManifest } from '@forgeax/engine-vite-plugin-shader';
import { afterAll, assert } from 'vitest';
import { createLevelCandidate } from '../../../app/src/levels/candidate';
import type { CandidateRenderHost } from '../../../app/src/levels/candidate-render-source';
import { LEVEL_STREAMING_SOURCE_COMPONENTS } from '../../../app/src/levels/source-preflight';
import { prepareShaderProgramCompiler } from '../../../shader-compiler/src/program-template';
import { levelSourceHost } from '../assembly/level-source-access';
import { Materials } from '../materials';
import { rendererInputHandoffFixture } from './renderer-input-handoff-fixture';

let shaderManifestFixture: Promise<Blob> | undefined;

function levelShaderManifestBlob(): Promise<Blob> {
  shaderManifestFixture ??= buildEngineShaderTemplateManifest().then(
    (manifest) => new Blob([JSON.stringify(manifest)], { type: 'application/json' }),
  );
  return shaderManifestFixture;
}

let admittedManifestFixture:
  | Promise<{ readonly manifestUrl: string; readonly admittedShaderCatalog: ShaderRegistry }>
  | undefined;

afterAll(async () => {
  const fixture = admittedManifestFixture;
  admittedManifestFixture = undefined;
  const admitted = await fixture?.catch(() => undefined);
  if (admitted !== undefined) URL.revokeObjectURL(admitted.manifestUrl);
});

/** Keep the producer's validated CPU input alive across the suite's independent devices. */
export async function levelShaderManifestFixture() {
  admittedManifestFixture ??= (async () => {
    const url = URL.createObjectURL(await levelShaderManifestBlob());
    try {
      const registry = new ShaderRegistry({
        manifestUrl: url,
        prepareProgramCompiler: prepareShaderProgramCompiler,
      });
      (await registry.loadManifest()).unwrap();
      return { manifestUrl: url, admittedShaderCatalog: registry };
    } catch (cause) {
      URL.revokeObjectURL(url);
      throw cause;
    }
  })();
  return admittedManifestFixture;
}

export function dataOnlyLevelRenderHost(
  fixture: Pick<Awaited<ReturnType<typeof rendererInputHandoffFixture>>, 'renderer' | 'world'>,
): CandidateRenderHost {
  const host = levelSourceHost(fixture.renderer, fixture.world);
  assert(host);
  return {
    current: host.current,
    beginStagedGroup(observation, content) {
      const result = host.beginStagedGroup(observation, content);
      return result.ok ? ok({ source: result.value }) : result;
    },
  };
}

export async function levelNativeResourcesFixture(
  generate: boolean,
  members = 1,
  coldGeometry = false,
  residentMesh = true,
  rendererOptions: Parameters<typeof rendererInputHandoffFixture>[0] = {},
  alphaCutoff = 0,
) {
  const f = await rendererInputHandoffFixture({ ...rendererOptions, residentMesh });
  try {
    for (const component of LEVEL_STREAMING_SOURCE_COMPONENTS)
      f.world.components.register(component).unwrap();
    const data = new Uint8Array(64).fill(255);
    if (alphaCutoff > 0)
      for (let pixel = 0; pixel < 16; pixel++)
        data[pixel * 4 + 3] = (((pixel % 4) + Math.floor(pixel / 4)) % 2) * 255;
    const texture = f.assets
      .create<TextureAsset>({
        kind: 'texture',
        shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
        format: 'rgba8unorm',
        colorSpace: 'linear',
        mips: generate ? { kind: 'generate' } : { kind: 'none' },
        data,
      })
      .unwrap();
    const material = f.assets
      .create(
        Materials.standard({ baseColor: [1, 1, 1, 1], baseColorTexture: { texture }, alphaCutoff }),
      )
      .unwrap();
    const mesh = f.assets.create(createBoxGeometry(coldGeometry ? 3 : 1, 1, 1).unwrap()).unwrap();
    const scene = f.assets
      .create<SceneAsset>({
        kind: 'scene',
        entities: Object.fromEntries(
          Array.from({ length: members }, (_, index) => [
            index === 0 ? 'member' : `member-${index}`,
            {
              components: {
                Transform: {},
                MeshFilter: { assetHandle: mesh },
                MeshRenderer: { materials: [material] },
              },
            },
          ]),
        ),
      })
      .unwrap();
    const createCandidate = () =>
      createLevelCandidate({
        world: f.world,
        assets: f.assets,
        scene,
        render: dataOnlyLevelRenderHost(f),
      });
    const candidate = createCandidate();
    return {
      ...f,
      candidate,
      createCandidate,
      sceneAsset: scene,
      meshHandle: mesh,
      materialHandle: material,
    };
  } catch (cause) {
    const closed = await f.close();
    if (!closed.ok)
      throw new AggregateError([cause, closed.error], 'candidate setup and host cleanup failed');
    throw cause;
  }
}

/** Native Source ownership tests consume the real utility manifest, never the Data-only marker fixture. */
export async function levelInitialViewFixture() {
  const shaders = await levelShaderManifestFixture();
  const f = await levelNativeResourcesFixture(false, 1, true, false, shaders);
  const render = f.internals.device.createRenderPipeline.bind(f.internals.device);
  f.internals.device.createRenderPipelineAsync = (descriptor) =>
    Promise.resolve(render(descriptor));
  return f;
}
