import type { AssetPublicationEnvelope, CatalogEntry } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  scenePublicationFenceFromRegistry,
  validateKeyedScenePublication,
} from '../registry/instantiate';

const SCENE_GUID = '019ffdb4-1000-7000-8000-000000000008';
const CHILD_GUID = '019ffdb4-1000-7000-8000-000000000009';

function publicationFor(input: {
  readonly sourcePath: string;
  readonly guid: string;
  readonly generation: number;
  readonly digest: string;
  readonly outputDigest?: string;
  readonly outputSetDigest: string;
  readonly externalEvidence?: AssetPublicationEnvelope['externalEvidence'];
}): AssetPublicationEnvelope {
  const sourceRevision = `sha256:${input.guid}-source`;
  const externalEvidence = input.externalEvidence ?? [];
  return {
    schemaVersion: 'asset-publication/1',
    sourcePath: input.sourcePath,
    sourceRevision,
    generation: input.generation,
    digest: input.digest,
    outputSetDigest: input.outputSetDigest,
    outputs: [
      {
        guid: input.guid,
        sourceKey: input.guid === SCENE_GUID ? 'scene/main' : 'scene/child',
        kind: 'scene',
        digest: input.outputDigest ?? input.digest,
        refs: [],
      },
    ],
    receipt: {
      schemaVersion: 'asset-publication-receipt/1',
      sourcePath: input.sourcePath,
      sourceRevision,
      inputFingerprint: sourceRevision,
      outputDigest: input.digest,
      outputSetDigest: input.outputSetDigest,
      externalEvidence,
    },
    externalEvidence,
  };
}

function publication(sourcePath = 'assets/procedural-showcase.pack.ts') {
  return publicationFor({
    sourcePath,
    guid: SCENE_GUID,
    generation: 17,
    digest: 'sha256:scene-package',
    outputSetDigest: 'sha256:scene-outputs',
  });
}

function entry(
  pub: AssetPublicationEnvelope,
  guid = SCENE_GUID,
  packageUrl = '/assets/scene.pack.json',
): CatalogEntry {
  return {
    guid,
    kind: 'scene',
    sourcePath: pub.sourcePath,
    packageUrl,
    publication: pub,
  };
}

describe('scenePublicationFenceFromRegistry', () => {
  it('derives a fence from the complete Catalog projection', () => {
    const pub = publication();
    const registry = {
      catalogSnapshot: () => ({ entries: [entry(pub)] }),
      packIndexCache: undefined,
    };
    expect(scenePublicationFenceFromRegistry(registry as never, SCENE_GUID)).toMatchObject({
      ok: true,
      value: { publicationGeneration: 17, sourcePath: pub.sourcePath },
    });
  });

  it('uses the complete pack-index tuple during a Catalog handoff', () => {
    const stale = publication();
    const current = publication('assets/current.glb');
    const registry = {
      catalogSnapshot: () => ({ entries: [entry(stale)] }),
      packIndexCache: new Map([[SCENE_GUID, entry(current, '/assets/current.pack.json')]]),
    };
    expect(scenePublicationFenceFromRegistry(registry as never, SCENE_GUID)).toMatchObject({
      ok: true,
      value: { sourcePath: 'assets/current.glb' },
    });
  });

  it('checks keyed child publication evidence before spawning', () => {
    const childScene = { kind: 'scene' as const, entities: { door: { components: {} } } };
    const rootEvidence = [
      {
        guid: CHILD_GUID,
        usage: 'reference' as const,
        generation: 3,
        digest: 'sha256:child-output',
      },
    ];
    const rootPublication = publicationFor({
      sourcePath: 'assets/root.pack.ts',
      guid: SCENE_GUID,
      generation: 4,
      digest: 'sha256:root-package',
      outputSetDigest: 'sha256:root-outputs',
      externalEvidence: rootEvidence,
    });
    const childPublication = publicationFor({
      sourcePath: 'assets/child.pack.ts',
      guid: CHILD_GUID,
      generation: 3,
      digest: 'sha256:child-package',
      outputDigest: 'sha256:child-output',
      outputSetDigest: 'sha256:child-outputs',
    });
    const rootScene = {
      kind: 'scene' as const,
      entities: {
        child: { components: {}, instance: { source: CHILD_GUID } },
      },
    };
    const registry = {
      catalogSnapshot: () => ({
        entries: [entry(rootPublication), entry(childPublication, CHILD_GUID)],
      }),
      packIndexCache: undefined,
      assetCatalog: new Map([
        [CHILD_GUID, { guid: CHILD_GUID, kind: 'scene', payload: childScene, refs: [] }],
      ]),
    };

    expect(validateKeyedScenePublication(registry as never, rootScene, SCENE_GUID)).toEqual({
      ok: true,
      value: undefined,
    });

    const staleChild = publicationFor({
      sourcePath: 'assets/child.pack.ts',
      guid: CHILD_GUID,
      generation: 4,
      digest: 'sha256:child-current',
      outputDigest: 'sha256:child-output-current',
      outputSetDigest: 'sha256:child-outputs-current',
    });
    const staleRegistry = {
      ...registry,
      catalogSnapshot: () => ({
        entries: [entry(rootPublication), entry(staleChild, CHILD_GUID)],
      }),
    };
    expect(
      validateKeyedScenePublication(staleRegistry as never, rootScene, SCENE_GUID),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'asset-generation-fence-mismatch',
        phase: 'instantiate',
        hint: expect.stringContaining('child'),
        currentGeneration: 4,
      },
    });
  });
});
