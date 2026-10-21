import { defineComponent } from '@forgeax/engine-ecs';
import { materialAssetOutputProducer } from '@forgeax/engine-import';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { sceneAssetContribution } from '@forgeax/engine-scene';
import { type AssetDecoderInput, type AssetEnvelopeV2, ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import {
  materialContribution,
  renderPipelineContribution,
} from '../../../render/src/assets/asset-decoders';
import { defineAssetKind } from '../asset-kind';
import { AssetRegistry } from '../asset-registry';
import { createCatalogSource } from '../catalog-source';
import { runtimeAssetReference } from '../internal/runtime-assets';
import * as sceneHandleFields from '../scene-handle-fields';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function publish(registry: AssetRegistry, assets: readonly AssetEnvelopeV2<unknown>[]) {
  const packageUrl = 'https://graph.invalid/pack.json';
  const publication = createRuntimePackPublication({
    scopeId: 'asset-runtime',
    packageUrl,
    sourcePath: 'graph.pack',
    sourceRevision: '1',
    pack: { assets },
  });
  registry.setCatalogSource(
    createCatalogSource({
      entries: assets.map(({ guid, kind }) => ({
        guid,
        kind,
        packageUrl,
        sourcePath: 'graph.pack',
        publication: publication.publication,
      })),
      fetch: async () => new Response(JSON.stringify(publication.pack)),
    }),
  );
}

const nodeKind = defineAssetKind<{ name: string }>('graph-node');
function node(guid: string, refs: readonly string[] = []): AssetEnvelopeV2<unknown> {
  return { guid, kind: nodeKind.kind, payload: { name: guid }, refs, artifacts: {} };
}
function graph(
  decode = async (input: AssetDecoderInput<{ name: string }>) => ok(input.envelope.payload),
) {
  const registry = new AssetRegistry();
  registry.installDecoder(nodeKind, { decode });
  return registry;
}

describe('registry load graph', () => {
  it('admits GUID-only scene references without scanning entity origin fields during load', async () => {
    const component = defineComponent('SceneOriginRefs', { pipeline: 'asset<render-pipeline>' });
    const registry = new AssetRegistry({ components: new Map([[component.name, component]]) });
    registry.installDecoder(sceneAssetContribution.kind, sceneAssetContribution.decoder);
    registry.installDecoder(renderPipelineContribution.kind, renderPipelineContribution.decoder);
    publish(registry, [
      {
        guid: A,
        kind: 'scene',
        payload: {
          kind: 'scene',
          entities: Object.fromEntries(
            [B, C, D].map((guid, i) => [
              `entity-${i}`,
              { components: { SceneOriginRefs: { pipeline: guid } } },
            ]),
          ),
        },
        refs: [B, C, D],
        artifacts: {},
      },
      ...[B, C, D].map((guid) => ({
        guid,
        kind: 'render-pipeline',
        payload: {
          kind: 'render-pipeline',
          pipelineId: 'forgeax::standard',
          renderPath: 'forward',
        },
        refs: [],
        artifacts: {},
      })),
    ]);
    const extract = vi.spyOn(sceneHandleFields, 'extractSceneEntityHandleGuids');
    try {
      const result = await registry.load(A, 'scene');
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(
        [A, B, C, D].every((guid) => runtimeAssetReference(registry, guid) !== undefined),
      ).toBe(true);
      expect(extract).not.toHaveBeenCalled();
    } finally {
      extract.mockRestore();
      registry.dispose();
    }
  });

  it('preserves zero and integer child values through production, JSON and source inheritance', async () => {
    const registry = new AssetRegistry();
    registry.installDecoder(materialContribution.kind, materialContribution.decoder);
    const values = { emissionStrength: 0, pigmentStrength: 0, surfaceMetallic: 0, bandCount: 1 };
    const root = (
      await materialAssetOutputProducer.produce({
        guid: A,
        sourceKey: 'root',
        asset: {
          kind: 'material',
          passes: [{ name: 'Forward', program: { module: 'test::toon' } }],
          parameters: Object.keys(values).map((name) => ({ name, type: 'f32' as const })),
          values: { emissionStrength: 2, pigmentStrength: 2, surfaceMetallic: 2, bandCount: 2 },
        },
      })
    ).unwrap();
    const child = (
      await materialAssetOutputProducer.produce({
        guid: B,
        sourceKey: 'child',
        asset: { kind: 'material', parent: registry.parseGuid(A), values },
      })
    ).unwrap();
    expect(root.artifacts).toEqual({});
    expect(child.artifacts).toEqual({});
    publish(registry, [
      {
        guid: A,
        kind: 'material',
        payload: root.payload,
        artifacts: {},
        refs: root.refs.map((ref) => ref.guid),
      },
      {
        guid: B,
        kind: 'material',
        payload: child.payload,
        artifacts: {},
        refs: child.refs.map((ref) => ref.guid),
      },
    ]);
    try {
      const material = registry.read((await registry.load(B, 'material')).unwrap()).unwrap();
      expect(material).toMatchObject({ kind: 'material', values });
      expect(material).not.toHaveProperty('parent');
    } finally {
      registry.dispose();
    }
  });

  it('restores descriptor payloads through the verified Pack path', async () => {
    const registry = new AssetRegistry();
    registry.installDecoder(renderPipelineContribution.kind, renderPipelineContribution.decoder);
    publish(registry, [
      {
        guid: C,
        kind: 'render-pipeline',
        refs: [],
        artifacts: {},
        payload: {
          kind: 'render-pipeline',
          pipelineId: 'forgeax::standard',
          renderPath: 'forward',
        },
      },
    ]);
    try {
      expect(
        registry.read((await registry.load(C, 'render-pipeline')).unwrap()).unwrap(),
      ).toMatchObject({
        kind: 'render-pipeline',
        pipelineId: 'forgeax::standard',
        renderPath: 'forward',
      });
    } finally {
      registry.dispose();
    }
  });

  it('keeps a parent unadopted while its declared dependency is unavailable', async () => {
    const registry = graph();
    publish(registry, [node(A, [B])]);
    try {
      expect(await registry.load(A, nodeKind)).toMatchObject({ ok: false });
      expect(runtimeAssetReference(registry, A)).toBeUndefined();
    } finally {
      registry.dispose();
    }
  });

  it('rejects eager cycles without exposing provisional handles', async () => {
    const registry = graph();
    publish(registry, [node(A, [B]), node(B, [A])]);
    try {
      expect(await registry.load(A, nodeKind)).toMatchObject({
        ok: false,
        error: { code: 'asset-reference-invalid' },
      });
      expect(runtimeAssetReference(registry, A)).toBeUndefined();
      expect(runtimeAssetReference(registry, B)).toBeUndefined();
    } finally {
      registry.dispose();
    }
  });

  it('keeps concurrent callers pending until the complete dependency closure is decoded', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const decode = vi.fn(async (input: AssetDecoderInput<{ name: string }>) => {
      if (input.envelope.guid === B) {
        entered();
        await gate;
      }
      return ok(input.envelope.payload);
    });
    const registry = graph(decode);
    publish(registry, [node(A, [B]), node(B)]);
    const first = registry.load(A, nodeKind);
    try {
      await started;
      let settled = false;
      const concurrent = registry.load(A, nodeKind).then((value) => {
        settled = true;
        return value;
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      expect(runtimeAssetReference(registry, A)).toBeUndefined();
      release();
      const [a, b] = await Promise.all([first, concurrent]);
      expect(a.ok, JSON.stringify(a)).toBe(true);
      expect(b).toEqual(a);
      expect(decode).toHaveBeenCalledTimes(2);
    } finally {
      release();
      await first;
      registry.dispose();
    }
  });

  it('adopts a shared sibling dependency once', async () => {
    const decode = vi.fn(async (input: AssetDecoderInput<{ name: string }>) =>
      ok(input.envelope.payload),
    );
    const registry = graph(decode);
    publish(registry, [node(A, [B, C]), node(B, [D]), node(C, [D]), node(D)]);
    try {
      expect((await registry.load(A, nodeKind)).ok).toBe(true);
      expect(decode).toHaveBeenCalledTimes(4);
      for (const guid of [A, B, C, D]) {
        const handle = (await registry.load(guid, nodeKind)).unwrap();
        expect(handle).toBe(runtimeAssetReference(registry, guid));
        expect(registry.read(handle).unwrap()).toMatchObject({ name: guid });
      }
      expect(decode).toHaveBeenCalledTimes(4);
    } finally {
      registry.dispose();
    }
  });
});
