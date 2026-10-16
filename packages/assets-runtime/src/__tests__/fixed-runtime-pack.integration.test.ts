import { serializeCookedMaterialRecord } from '@forgeax/engine-pack';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { type CatalogEntry, ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import {
  createFixedRuntimePackSnapshot,
  prepareRuntimePackContent,
  RuntimePackProducer,
} from '../../../import/src/runtime-pack.js';
import { parseRuntimePackSnapshot } from '../../../import/src/runtime-pack-content.js';
import { AssetRegistry } from '../asset-registry.js';
import { captureAssetPublication } from '../capture-publication.js';
import { createCatalogSource } from '../catalog-source.js';
import { validateAssetPublication } from '../validate-publication.js';
import { defined } from './assert-defined.js';
import { materialRecordFixture } from './fixtures/material-publication.js';

const root = '01900000-0000-7000-8000-000000000961';
const middle = '01900000-0000-7000-8000-000000000962';
const leaf = '01900000-0000-7000-8000-000000000963';

async function material(guid: string, parent?: string | readonly string[], generation?: number) {
  const original = materialRecordFixture({ guid });
  const refs = typeof parent === 'string' ? [parent] : (parent ?? []);
  const record = { ...original, refs: { ...original.refs, parent: refs } };
  const packageUrl = `https://fixed.invalid/${guid}/pack.json`;
  const publication = createRuntimePackPublication({
    scopeId: 'original',
    sourcePath: guid,
    sourceRevision: 'original',
    packageUrl,
    ...(generation === undefined ? {} : { generation }),
    pack: {
      assets: [
        {
          guid,
          kind: 'material',
          payload: {
            kind: 'material',
            ...record.resolved,
            cooked: JSON.parse(serializeCookedMaterialRecord(record)),
          },
          refs,
          artifacts: Object.fromEntries(
            record.programs.map(({ artifact }) => [
              artifact.path,
              {
                path: artifact.path,
                mediaType: artifact.mediaType,
                contentEncoding: 'identity',
                byteLength: artifact.bytes.length,
                integrity: { algorithm: 'sha256', digest: artifact.digest },
              },
            ]),
          ),
        },
      ],
    },
  });
  // Ordinary shipped refs need not have historical content-read evidence.
  expect(publication.publication.externalEvidence).toEqual([]);
  const row: CatalogEntry = {
    guid,
    kind: 'material',
    sourcePath: guid,
    packageUrl,
    publication: publication.publication,
  };
  const blobs = new Map(
    record.programs.map(({ artifact }) => [
      new URL(artifact.path, packageUrl).href,
      artifact.bytes,
    ]),
  );
  const fetcher: typeof fetch = async (url) => {
    if (String(url) === packageUrl) return new Response(JSON.stringify(publication.pack));
    const bytes = blobs.get(String(url));
    return bytes ? new Response(new Uint8Array(bytes)) : new Response('', { status: 404 });
  };
  const fixed = (
    await captureAssetPublication(row, [row], createCatalogSource({ entries: [row] }), fetcher)
  ).unwrap();
  return { row, fixed, fetcher };
}

function producer(current: readonly CatalogEntry[] = []) {
  return new RuntimePackProducer({
    scopeId: 'restored',
    assetSource: {
      currentRow: (guid) => current.find((row) => row.guid === guid),
      exportSource: async () => {
        throw new Error('saved fixed closure must not read live producer inputs');
      },
    },
    validate: (state, fetcher, dependencies) =>
      validateAssetPublication(state.rows, fetcher, undefined, { dependencies }),
  });
}

it('shares fixed rebuilds and reuses owned dependencies only while their full closure stays current', async () => {
  const right = '01900000-0000-7000-8000-000000000964';
  let child = await material(leaf);
  const left = await material(middle, leaf);
  const other = await material(right, leaf);
  const savedChild = await createFixedRuntimePackSnapshot(child.fixed);
  const sources = new Map([
    [middle, await createFixedRuntimePackSnapshot(left.fixed, new Map([[leaf, savedChild]]))],
    [right, await createFixedRuntimePackSnapshot(other.fixed, new Map([[leaf, savedChild]]))],
  ]);
  const validations: string[] = [];
  const target = new RuntimePackProducer({
    scopeId: 'shared-fixed',
    assetSource: {
      currentRow: (guid) => [child.row, left.row, other.row].find((row) => row.guid === guid),
      exportSource: async (versions) => {
        const selected = [...versions.keys()].map((guid) => {
          const source = sources.get(guid);
          if (!source) throw new Error(`missing source ${guid}`);
          return parseRuntimePackSnapshot(source);
        });
        return {
          schemaVersion: 'runtime-pack-source/2',
          packs: [],
          instances: [],
          recipeRoots: [...new Set(selected.flatMap((source) => source.recipeRoots ?? []))],
          closure: {
            contents: {},
            bindings: {},
            recipes: Object.assign({}, ...selected.map((source) => source.closure?.recipes)),
          },
        };
      },
    },
    validate: (state, fetcher, dependencies) => {
      validations.push(...state.rows.map((row) => row.guid));
      return validateAssetPublication(state.rows, fetcher, undefined, { dependencies });
    },
  });
  try {
    for (const packageId of [
      '01900000-0000-7000-8000-000000000965',
      '01900000-0000-7000-8000-000000000966',
      '01900000-0000-7000-8000-000000000967',
    ]) {
      if (packageId.endsWith('967')) {
        child = await material(leaf, undefined, child.fixed.pack.generation + 1);
        const saved = await createFixedRuntimePackSnapshot(child.fixed);
        sources.set(
          middle,
          await createFixedRuntimePackSnapshot(left.fixed, new Map([[leaf, saved]])),
        );
        sources.set(
          right,
          await createFixedRuntimePackSnapshot(other.fixed, new Map([[leaf, saved]])),
        );
      }
      validations.length = 0;
      const content = (
        await prepareRuntimePackContent(
          packageId,
          { sampler: { kind: 'sampler' } },
          {
            dependencies: Object.fromEntries(
              [left.row, other.row].map((row) => [
                row.guid,
                defined(defined(row.publication).outputs[0]).digest,
              ]),
            ),
          },
        )
      ).unwrap();
      (await target.admit(content)).unwrap();
      const rebuilds = packageId.endsWith('966') ? 0 : 1;
      expect(validations.filter((guid) => guid === leaf)).toHaveLength(rebuilds);
      expect(validations.filter((guid) => guid === middle)).toHaveLength(rebuilds);
      expect(validations.filter((guid) => guid === right)).toHaveLength(rebuilds);
    }
  } finally {
    target.dispose();
  }
});

it.each([
  false,
  true,
])('rejects conflicting shared source nodes regardless of root order (reverse=%s)', async (reverse) => {
  const right = '01900000-0000-7000-8000-000000000964';
  const child = await material(leaf);
  const left = await material(middle, leaf);
  const other = await material(right, leaf);
  const joined = await material(root, reverse ? [right, middle] : [middle, right]);
  const savedChild = await createFixedRuntimePackSnapshot(child.fixed);
  const savedLeft = await createFixedRuntimePackSnapshot(left.fixed, new Map([[leaf, savedChild]]));
  const savedRight = await createFixedRuntimePackSnapshot(
    other.fixed,
    new Map([[leaf, savedChild]]),
  );
  const id = defined(savedChild.recipeRoots?.[0]);
  const corrupt = defined(savedLeft.closure?.recipes[id]);
  if (!('fixed' in corrupt)) throw new Error('expected fixed child');
  Reflect.set(corrupt.fixed.pack, 'scopeId', 'corrupt-shared-source');
  await expect(
    createFixedRuntimePackSnapshot(
      joined.fixed,
      new Map([
        [middle, savedLeft],
        [right, savedRight],
      ]),
    ),
  ).rejects.toThrow('conflicting source node');
});

it('accepts shared source objects with different property order', async () => {
  const right = '01900000-0000-7000-8000-000000000964';
  const child = await material(leaf);
  const left = await material(middle, leaf);
  const other = await material(right, leaf);
  const joined = await material(root, [middle, right]);
  const savedChild = await createFixedRuntimePackSnapshot(child.fixed);
  const savedLeft = await createFixedRuntimePackSnapshot(left.fixed, new Map([[leaf, savedChild]]));
  const savedRight = await createFixedRuntimePackSnapshot(
    other.fixed,
    new Map([[leaf, savedChild]]),
  );
  const id = defined(savedChild.recipeRoots?.[0]);
  const recipe = defined(savedRight.closure?.recipes[id]);
  Reflect.set(
    defined(savedRight.closure).recipes,
    id,
    Object.fromEntries(Object.entries(recipe).reverse()),
  );
  const saved = await createFixedRuntimePackSnapshot(
    joined.fixed,
    new Map([
      [middle, savedLeft],
      [right, savedRight],
    ]),
  );
  const target = producer();
  try {
    expect((await target.restore(saved)).ok).toBe(true);
  } finally {
    target.dispose();
  }
});

it('uses native fingerprint hashing when capturing and restoring fixed dependencies', async () => {
  const source = await material(leaf);
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  let fingerprints = 0;
  const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation((algorithm, input) => {
    const bytes = ArrayBuffer.isView(input)
      ? new Uint8Array(input.buffer, input.byteOffset, Math.min(input.byteLength, 30))
      : new Uint8Array(input, 0, Math.min(input.byteLength, 30));
    if (new TextDecoder().decode(bytes).startsWith('scriptable-pack-fingerprint/3:'))
      fingerprints++;
    return digest(algorithm, input);
  });
  const target = producer();
  try {
    const pending = createFixedRuntimePackSnapshot(source.fixed);
    Reflect.set(source.fixed.pack, 'scopeId', 'mutated-after-capture');
    const snapshot = await pending;
    const saved = Object.values(snapshot.closure?.recipes ?? {})[0];
    expect(saved && 'fixed' in saved && saved.fixed.pack.scopeId).toBe('original');
    expect(fingerprints).toBeGreaterThan(0);
    fingerprints = 0;
    expect((await target.restore(snapshot)).ok).toBe(true);
    expect(fingerprints).toBeGreaterThanOrEqual(2);
  } finally {
    spy.mockRestore();
    target.dispose();
  }
});

it.each([
  1, 3,
])('cancels a fixed dependency restore at native fingerprint %s before publication', async (cancelAt) => {
  const source = await material(leaf);
  const snapshot = await createFixedRuntimePackSnapshot(source.fixed);
  const controller = new AbortController();
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  let fingerprints = 0;
  const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation((algorithm, input) => {
    const bytes = ArrayBuffer.isView(input)
      ? new Uint8Array(input.buffer, input.byteOffset, Math.min(input.byteLength, 30))
      : new Uint8Array(input, 0, Math.min(input.byteLength, 30));
    if (
      new TextDecoder().decode(bytes).startsWith('scriptable-pack-fingerprint/3:') &&
      ++fingerprints === cancelAt
    )
      controller.abort();
    return digest(algorithm, input);
  });
  const target = producer();
  try {
    const result = await target.restore(snapshot, controller.signal);
    expect(fingerprints).toBe(cancelAt);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('runtime-pack-cancelled');
    expect(target.rows()).toEqual([]);
  } finally {
    spy.mockRestore();
    target.dispose();
  }
});

it.each([
  'digest',
  'generation',
])('rejects a transitive fixed reference with a different %s even when the direct reference matches', async (difference) => {
  const c = await material(leaf);
  const b = await material(middle, leaf);
  const a = await material(root, middle);
  const savedC = await createFixedRuntimePackSnapshot(c.fixed);
  const savedB = await createFixedRuntimePackSnapshot(b.fixed, new Map([[leaf, savedC]]));
  const saved = await createFixedRuntimePackSnapshot(a.fixed, new Map([[middle, savedB]]));
  const publication = c.row.publication;
  if (!publication) throw new Error('missing publication');
  const changed = {
    ...c.row,
    publication:
      difference === 'generation'
        ? { ...publication, generation: publication.generation + 1 }
        : {
            ...publication,
            outputs: publication.outputs.map((output) => ({
              ...output,
              digest: `sha256:${'e'.repeat(64)}`,
            })),
          },
  };
  const target = producer([b.row, changed]);
  try {
    expect((await target.restore(saved)).ok).toBe(false);
    expect(target.rows()).toEqual([]);
  } finally {
    target.dispose();
  }
});

it('restores a missing transitive reference while reusing the matching middle publication', async () => {
  const c = await material(leaf);
  const b = await material(middle, leaf);
  const a = await material(root, middle);
  const saved = await createFixedRuntimePackSnapshot(
    a.fixed,
    new Map([
      [
        middle,
        await createFixedRuntimePackSnapshot(
          b.fixed,
          new Map([[leaf, await createFixedRuntimePackSnapshot(c.fixed)]]),
        ),
      ],
    ]),
  );
  const target = producer([b.row]);
  const registry = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  try {
    const result = await target.restore(JSON.parse(JSON.stringify(saved)));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(
      target
        .rows()
        .map((row) => row.guid)
        .sort(),
    ).toEqual([root, leaf].sort());
    registry.setCatalogSource(
      { enumerate: async () => ok([b.row, ...target.rows()]), subscribe: () => () => {} },
      async (url, init) => {
        const response = await target.fetch(url, init);
        return response.status === 404 ? b.fetcher(url, init) : response;
      },
    );
    expect((await registry.loadByGuid(registry.parseGuid(root))).ok).toBe(true);
  } finally {
    registry.clearCatalogSource();
    target.dispose();
  }
});

it('rejects two reference paths retaining different generations of the same content', async () => {
  const right = '01900000-0000-7000-8000-000000000964';
  const old = await material(leaf);
  const newer = await material(leaf, undefined, old.fixed.pack.generation + 1);
  expect(old.fixed.pack.digest).toBe(newer.fixed.pack.digest);
  const leftParent = await material(middle, leaf);
  const rightParent = await material(right, leaf);
  const joined = await material(root, [middle, right]);
  const saved = await createFixedRuntimePackSnapshot(
    joined.fixed,
    new Map([
      [
        middle,
        await createFixedRuntimePackSnapshot(
          leftParent.fixed,
          new Map([[leaf, await createFixedRuntimePackSnapshot(old.fixed)]]),
        ),
      ],
      [
        right,
        await createFixedRuntimePackSnapshot(
          rightParent.fixed,
          new Map([[leaf, await createFixedRuntimePackSnapshot(newer.fixed)]]),
        ),
      ],
    ]),
  );
  const target = producer();
  try {
    const result = await target.restore(saved);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain('reference closure has conflicting versions');
    expect(target.rows()).toEqual([]);
  } finally {
    target.dispose();
  }
});
