import { createHash } from 'node:crypto';
import { projectRuntimePack } from '@forgeax/engine-pack';
import {
  createRuntimePackPublication,
  projectExternalCatalogEntries,
} from '@forgeax/engine-pack/build';
import { NativeCookerRegistry } from '@forgeax/engine-pack/native-cooker';
import type {
  ArtifactDescriptor,
  AssetDecoder,
  AssetDecoderInput,
  AssetLoadError,
  CatalogEntry,
  PackV2,
  Result,
} from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createAssetRegistry, createCatalogSource, defineAssetKind } from '../index.js';

type VoxelShapePayload = {
  readonly schemaVersion: 'voxel-shape/1';
  readonly cellSize: number;
  readonly filled: readonly [number, number, number][];
};

type ProviderInput = {
  readonly guid: string;
  readonly sourceKey: string;
  readonly filled: readonly [number, number, number][];
  readonly refs?: readonly string[];
};

const voxelShapeKind = defineAssetKind<VoxelShapePayload, 'voxel-shape'>('voxel-shape');
const brickGuid = '77777777-7777-4777-8777-777777777777';
const paletteGuid = '88888888-8888-4888-8888-888888888888';
const reloadGuid = '99999999-9999-4999-8999-999999999999';
const packageUrl = '/provider/walls.pack.json';
const scopeId = 'provider-cold-load';

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function makeCooker(): NativeCookerRegistry {
  const registry = new NativeCookerRegistry();
  registry.register({
    key: 'provider.voxel-shape',
    discover: (input) => input as ProviderInput,
    cook: (rawInput) => {
      const input = rawInput as ProviderInput;
      const payload: VoxelShapePayload = {
        schemaVersion: 'voxel-shape/1',
        cellSize: 1,
        filled: input.filled,
      };
      const bytes = new TextEncoder().encode(JSON.stringify(payload));
      return {
        guid: input.guid,
        payload,
        refs: [...(input.refs ?? [])],
        artifacts: {
          body: {
            mediaType: 'application/json',
            assetCodec: { name: 'provider-voxel-json', version: '1' },
            bytes,
          },
        },
        inputFingerprint: `sha256:${input.sourceKey}`,
      };
    },
  });
  return registry;
}

function runtimeArtifact(
  guid: string,
  bytes: Uint8Array,
): Readonly<Record<string, ArtifactDescriptor>> {
  return {
    body: {
      path: `walls/${guid}.json`,
      mediaType: 'application/json',
      assetCodec: { name: 'provider-voxel-json', version: '1' },
      contentEncoding: 'identity',
      byteLength: bytes.byteLength,
      integrity: { algorithm: 'sha256', digest: digest(bytes) },
    },
  };
}

function decoder(): AssetDecoder<VoxelShapePayload> {
  return {
    decode: async ({
      envelope,
      artifacts,
    }: AssetDecoderInput<VoxelShapePayload>): Promise<
      Result<VoxelShapePayload, AssetLoadError>
    > => {
      const descriptor = envelope.artifacts.body;
      if (descriptor === undefined) {
        return err({
          code: 'asset-decode-failed',
          expected: 'provider voxel artifact body descriptor',
          hint: 'recook the provider output with its artifact declaration',
          detail: { guid: envelope.guid, kind: envelope.kind },
        });
      }
      const bytes = await artifacts.read(descriptor);
      if (!bytes.ok) return bytes;
      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder().decode(bytes.value));
      } catch {
        return err({
          code: 'asset-decode-failed',
          expected: 'provider JSON artifact to contain voxel-shape/1',
          hint: 'recook the provider artifact',
          detail: { guid: envelope.guid, kind: envelope.kind },
        });
      }
      if (
        payload === null ||
        typeof payload !== 'object' ||
        (payload as { readonly schemaVersion?: unknown }).schemaVersion !== 'voxel-shape/1'
      ) {
        return err({
          code: 'asset-decode-failed',
          expected: 'provider voxel-shape/1 artifact payload',
          hint: 'recook the provider payload with its owner decoder',
          detail: { guid: envelope.guid, kind: envelope.kind },
        });
      }
      return ok(payload as VoxelShapePayload);
    },
  };
}

describe('external voxel provider cold-load route', () => {
  it('runs provider Cook, publishes verified artifacts and refs, then revokes and reloads a GUID', async () => {
    const cooker = makeCooker();
    const inputs: readonly ProviderInput[] = [
      {
        guid: brickGuid,
        sourceKey: 'provider://walls/brick',
        filled: [[-1, 0, 2]],
        refs: [paletteGuid],
      },
      {
        guid: paletteGuid,
        sourceKey: 'provider://walls/palette',
        filled: [[0, 0, 0]],
      },
      {
        guid: reloadGuid,
        sourceKey: 'provider://walls/reload',
        filled: [[1, 0, 0]],
      },
    ];
    const drafts = await Promise.all(
      inputs.map((input) =>
        cooker.runDraft<VoxelShapePayload, ProviderInput>('provider.voxel-shape', input),
      ),
    );
    const products = await Promise.all(
      inputs.map((input) =>
        cooker.run<VoxelShapePayload, ProviderInput>('provider.voxel-shape', input),
      ),
    );
    expect(drafts.every((result) => result.ok)).toBe(true);
    expect(products.every((result) => result.ok)).toBe(true);
    if (drafts.some((result) => !result.ok) || products.some((result) => !result.ok)) return;

    const assets = inputs.map((input, index) => {
      const draft = drafts[index];
      if (draft === undefined) throw new Error(`missing draft ${input.guid}`);
      if (!draft.ok) throw draft.error;
      const body = draft.value.artifacts.body;
      if (body === undefined) throw new Error(`missing artifact ${input.guid}`);
      return {
        guid: input.guid,
        kind: 'voxel-shape',
        payload: draft.value.payload,
        refs: draft.value.refs,
        artifacts: runtimeArtifact(input.guid, body.bytes),
      };
    });
    const outputs = inputs.map((input, index) => {
      const product = products[index];
      if (product === undefined) throw new Error(`missing product ${input.guid}`);
      if (!product.ok) throw product.error;
      return {
        guid: input.guid,
        sourceKey: input.sourceKey,
        kind: 'voxel-shape',
        digest: product.value.digest,
        refs: product.value.refs,
      } as const;
    });
    const publication = createRuntimePackPublication({
      pack: { assets },
      scopeId,
      sourcePath: 'provider://walls',
      sourceRevision: 'wall-rev-1',
      packageUrl,
      inputFingerprint: 'sha256:provider-input',
      outputs,
      generation: 1,
    });
    const projected = projectRuntimePack(publication.pack);
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    const pack = projected.value as PackV2<unknown>;
    const producerRows = projectExternalCatalogEntries(
      {
        schemaVersion: 'provider/1',
        packageId: 'provider-walls',
        provenance: { provider: 'voxel-fixture', version: '1' },
        revision: { digest: 'sha256:provider-catalog', observedAt: 1, rootId: 'provider-root' },
      },
      'provider://walls',
      packageUrl,
      outputs,
    );
    const catalogEntries: readonly CatalogEntry[] = producerRows.map((row, index) => ({
      ...row,
      ...(outputs[index]?.refs === undefined ? {} : { refs: outputs[index].refs }),
      publication: publication.publication,
    }));
    const artifactBodies = new Map<string, Uint8Array>();
    for (const asset of assets) {
      const draft = drafts.find((result) => result.ok && result.value.guid === asset.guid);
      if (draft === undefined || !draft.ok) throw new Error(`missing draft ${asset.guid}`);
      const descriptor = asset.artifacts.body;
      if (descriptor === undefined) throw new Error(`missing artifact ${asset.guid}`);
      artifactBodies.set(
        `/provider/${descriptor.path}`,
        draft.value.artifacts.body?.bytes ?? new Uint8Array(),
      );
    }
    let fetchCount = 0;
    const fetcher: typeof globalThis.fetch = async (input) => {
      fetchCount += 1;
      const url = String(input);
      if (url === packageUrl) return new Response(JSON.stringify(pack), { status: 200 });
      const body = artifactBodies.get(url);
      return body === undefined
        ? new Response('not found', { status: 404 })
        : new Response(body as unknown as BodyInit);
    };
    const registry = createAssetRegistry({
      catalog: createCatalogSource({ entries: catalogEntries }),
      fetcher,
      scopeId,
    });
    const lease = registry.installDecoder(voxelShapeKind, decoder());

    const loaded = await registry.load(brickGuid, voxelShapeKind);
    expect(loaded).toEqual({
      ok: true,
      value: { schemaVersion: 'voxel-shape/1', cellSize: 1, filled: [[-1, 0, 2]] },
    });
    expect(fetchCount).toBeGreaterThanOrEqual(3);

    lease.dispose();
    const revoked = await registry.load(reloadGuid, voxelShapeKind);
    expect(revoked.ok).toBe(false);
    if (!revoked.ok) expect(revoked.error.code).toBe('asset-decoder-missing');

    const replacement = registry.installDecoder(voxelShapeKind, decoder());
    const reloaded = await registry.load(reloadGuid, voxelShapeKind);
    expect(reloaded).toEqual({
      ok: true,
      value: { schemaVersion: 'voxel-shape/1', cellSize: 1, filled: [[1, 0, 0]] },
    });
    replacement.dispose();
    registry.dispose();
  });
});
