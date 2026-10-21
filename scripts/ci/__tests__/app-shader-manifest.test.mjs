import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  readShaderManifestPublication,
  SHADER_MANIFEST_PUBLICATION_VERSION,
} from '../../../packages/shader/src/manifest-publication.ts';
import { publishShaderManifest } from '../../../packages/vite-plugin-shader/src/manifest-publication.ts';
import {
  APP_SHADER_MANIFEST_DELTA,
  mergeAppShaderManifest,
  projectAppShaderManifest,
} from '../app-shader-manifest.mjs';

const sharedEntry = { hash: 'engine-hash', wgsl: 'engine', bindings: '{}', glsl: '' };
const customEntry = { hash: 'custom-hash', wgsl: 'custom', bindings: '{}', glsl: '' };
const sharedMaterial = {
  identifier: 'forgeax::default-standard-pbr',
  sourcePath: 'engine/default-standard-pbr.wgsl',
  composedWgsl: 'engine',
  paramSchema: '{}',
  variants: [],
};
const customMaterial = {
  identifier: 'demo::custom',
  sourcePath: 'apps/demo/src/custom.wgsl',
  composedWgsl: 'custom',
  paramSchema: '{}',
  variants: [],
};

function compactV4Digest(fragments) {
  const count = Buffer.alloc(4);
  count.writeUInt32BE(fragments.length);
  const hash = createHash('sha256').update('forgeax.shader.source.v4\0').update(count);
  for (const fragment of fragments) {
    hash.update(createHash('sha256').update(fragment).digest());
  }
  return hash.digest('hex');
}

test('projects only app-owned shader rows for shard transport', () => {
  const delta = projectAppShaderManifest(
    {
      entries: [sharedEntry, customEntry],
      materialShaders: [sharedMaterial, customMaterial],
    },
    { entries: [sharedEntry], materialShaders: [sharedMaterial] },
  );

  assert.equal(delta.forgeaxTransport, APP_SHADER_MANIFEST_DELTA);
  assert.deepEqual(delta.entries, [customEntry]);
  assert.deepEqual(delta.materialShaders, [customMaterial]);
});

test('projecting an app-owned delta again is idempotent', () => {
  const shared = { entries: [sharedEntry], materialShaders: [sharedMaterial] };
  const delta = projectAppShaderManifest(
    {
      entries: [sharedEntry, customEntry],
      materialShaders: [sharedMaterial, customMaterial],
    },
    shared,
  );

  assert.deepEqual(projectAppShaderManifest(delta, shared), delta);
});

test('merges an app delta back into one runtime manifest', () => {
  const merged = mergeAppShaderManifest(
    { schemaVersion: '1.0.0', entries: [sharedEntry], materialShaders: [sharedMaterial] },
    {
      forgeaxTransport: APP_SHADER_MANIFEST_DELTA,
      entries: [customEntry],
      materialShaders: [customMaterial],
    },
  );

  assert.equal(merged.schemaVersion, '1.0.0');
  assert.deepEqual(merged.entries, [sharedEntry, customEntry]);
  assert.deepEqual(merged.materialShaders, [sharedMaterial, customMaterial]);
});

test('app-owned rows replace a same-identity shared material row', () => {
  const replacement = { ...sharedMaterial, composedWgsl: 'replacement' };
  const merged = mergeAppShaderManifest(
    { entries: [sharedEntry], materialShaders: [sharedMaterial] },
    {
      forgeaxTransport: APP_SHADER_MANIFEST_DELTA,
      entries: [],
      materialShaders: [replacement],
    },
  );

  assert.deepEqual(merged.materialShaders, [replacement]);
});

const sharedReceipt = { layout: 'shared' };
const customReceipt = { layout: 'custom' };
const variantReceipt = { layout: 'variant' };
const sharedReads = [
  { name: 'vertex_main', stage: 'vertex', bindings: [{ group: 2, binding: 0, fields: ['model'] }] },
];
const customReads = [
  {
    name: 'fragment_main',
    stage: 'fragment',
    bindings: [{ group: 1, binding: 0, fields: ['color', 'roughness'] }],
  },
];
const variantReads = [
  { name: 'fragment_main', stage: 'fragment', bindings: [{ group: 1, binding: 0 }] },
];
const compactSharedMaterial = {
  ...sharedMaterial,
  receipt: sharedReceipt,
  entryPoints: sharedReads,
};
const compactCustomMaterial = {
  ...customMaterial,
  receipt: customReceipt,
  entryPoints: customReads,
  variants: [
    {
      defines: { MODE: '1' },
      definesKey: 'MODE=1',
      composedWgsl: 'variant',
      receipt: variantReceipt,
      entryPoints: variantReads,
    },
  ],
};

test('a source-less empty app delta preserves the compact shared publication', () => {
  const shared = publishShaderManifest([sharedEntry], [compactSharedMaterial]);
  const empty = { forgeaxTransport: APP_SHADER_MANIFEST_DELTA, entries: [], materialShaders: [] };
  assert.equal(mergeAppShaderManifest(shared, empty), shared);
  assert.throws(
    () => mergeAppShaderManifest(shared, { ...empty, entries: [customEntry] }),
    /versions differ/,
  );
});

test('compact app deltas preserve source bytes, receipts and exact entry reads through materialization', async () => {
  const engine = publishShaderManifest([sharedEntry], [compactSharedMaterial]);
  // The custom material changes every shared receipt index in the app pool.
  const app = publishShaderManifest(
    [sharedEntry, customEntry],
    [compactCustomMaterial, compactSharedMaterial],
  );
  assert.notEqual(engine.materialShaders[0].receiptIndex, app.materialShaders[1].receiptIndex);
  assert.notEqual(
    engine.materialShaders[0].entryPointsIndex,
    app.materialShaders[1].entryPointsIndex,
  );
  const delta = projectAppShaderManifest(app, engine);
  assert.deepEqual(
    delta.materialShaders.map((row) => row.identifier),
    [customMaterial.identifier],
  );
  assert.deepEqual(delta.receipts, [customReceipt, variantReceipt]);
  assert.deepEqual(delta.entryPoints, [customReads, variantReads]);
  assert.deepEqual(projectAppShaderManifest(delta, engine), delta);
  assert.deepEqual(await readShaderManifestPublication(delta), {
    entries: [customEntry],
    materialShaders: [compactCustomMaterial],
  });
  const merged = mergeAppShaderManifest(engine, delta);
  assert.equal(merged.schemaVersion, app.schemaVersion);
  assert.deepEqual(await readShaderManifestPublication(merged), {
    entries: [sharedEntry, customEntry],
    materialShaders: [compactSharedMaterial, compactCustomMaterial],
  });
});

test('replacing a compact material prunes unused sources, receipts and entry reads', async () => {
  const engine = publishShaderManifest([], [compactSharedMaterial]);
  const replacement = {
    ...compactCustomMaterial,
    identifier: sharedMaterial.identifier,
    sourcePath: sharedMaterial.sourcePath,
  };
  const app = publishShaderManifest([], [replacement]);
  const merged = mergeAppShaderManifest(engine, projectAppShaderManifest(app, engine));
  assert.deepEqual(merged.receipts, [customReceipt, variantReceipt]);
  assert.deepEqual(merged.entryPoints, [customReads, variantReads]);
  assert.deepEqual(await readShaderManifestPublication(merged), {
    entries: [],
    materialShaders: [replacement],
  });
});

test('compact transport rejects missing receipt references and unsupported versions', () => {
  const engine = publishShaderManifest([], [compactSharedMaterial]);
  const app = publishShaderManifest([], [compactCustomMaterial]);
  assert.throws(
    () => projectAppShaderManifest({ ...app, receipts: [] }, engine),
    /receipt is missing/,
  );
  assert.throws(
    () => projectAppShaderManifest({ ...app, receipts: undefined }, engine),
    /missing receipts/,
  );
  const delta = projectAppShaderManifest(app, engine);
  assert.throws(
    () => mergeAppShaderManifest(engine, { ...delta, receipts: [] }),
    /receipt is missing/,
  );
  assert.throws(
    () =>
      projectAppShaderManifest(
        { ...app, schemaVersion: '2.0.0' },
        { ...engine, schemaVersion: '2.0.0' },
      ),
    /unsupported shader manifest publication version/,
  );
  assert.throws(
    () => projectAppShaderManifest({ entries: [], materialShaders: [] }, engine),
    /versions differ/,
  );
});

test('compact app delta retains custom shader sources through materialization', () => {
  const sharedSource = 'fn shared() {}\n';
  const sharedDigest = compactV4Digest([sharedSource]);
  const customDigest = compactV4Digest([sharedSource, 'fn custom() {}\n']);
  const sharedReceipt = { material: 'engine' };
  const customReceipt = { material: 'custom' };
  const sharedMaterial = {
    identifier: 'engine::material',
    sourcePath: 'engine/material.wgsl',
    sourceDigest: sharedDigest,
    receiptIndex: 0,
    variants: [],
  };
  const engine = {
    schemaVersion: SHADER_MANIFEST_PUBLICATION_VERSION,
    entryPoints: [],
    fragments: [sharedSource],
    sources: { [sharedDigest]: [0] },
    receipts: [sharedReceipt],
    entries: [{ hash: 'engine', bindings: '{}', glsl: '', sourceDigest: sharedDigest }],
    materialShaders: [sharedMaterial],
  };
  const app = {
    schemaVersion: SHADER_MANIFEST_PUBLICATION_VERSION,
    entryPoints: [],
    fragments: [sharedSource, 'fn custom() {}\n'],
    sources: { [sharedDigest]: [0], [customDigest]: [0, 1] },
    receipts: [customReceipt, sharedReceipt],
    entries: [
      ...engine.entries,
      { hash: 'custom', bindings: '{}', glsl: '', sourceDigest: customDigest },
    ],
    materialShaders: [
      { ...sharedMaterial, receiptIndex: 1 },
      {
        identifier: 'demo::custom',
        sourcePath: 'apps/demo/custom.wgsl',
        paramSchema: '{}',
        sourceDigest: customDigest,
        receiptIndex: 0,
        variants: [{ defines: {}, definesKey: '', sourceDigest: customDigest, receiptIndex: 0 }],
      },
    ],
  };

  const delta = projectAppShaderManifest(app, engine);
  assert.equal(delta.materialShaders.length, 1);
  assert.deepEqual(projectAppShaderManifest(delta, engine), delta);
  assert.equal(app.materialShaders[0].receiptIndex, 1, 'projection preserves producer indices');
  const merged = mergeAppShaderManifest(engine, delta);
  assert.equal(delta.schemaVersion, SHADER_MANIFEST_PUBLICATION_VERSION);
  assert.deepEqual(delta.receipts, [customReceipt]);
  assert.equal(delta.materialShaders[0].receiptIndex, 0);
  assert.equal(delta.materialShaders[0].variants[0].receiptIndex, 0);
  assert.equal(merged.schemaVersion, SHADER_MANIFEST_PUBLICATION_VERSION);
  assert.deepEqual(merged.receipts, [sharedReceipt, customReceipt]);
  assert.equal(merged.materialShaders[1].receiptIndex, 1);
  assert.equal(merged.materialShaders[1].variants[0].receiptIndex, 1);
  assert.deepEqual(
    merged.entries.map((row) => row.hash),
    ['engine', 'custom'],
  );
  assert.deepEqual(Object.keys(merged.sources).sort(), [sharedDigest, customDigest].sort());
  for (const [hash, indices] of Object.entries(merged.sources)) {
    assert.equal(compactV4Digest(indices.map((index) => merged.fragments[index])), hash);
  }
});

test('compact app overrides discard replaced receipts and remap the surviving material', () => {
  const digest = (source) => compactV4Digest([source]);
  const sharedSource = 'fn shared() {}\n';
  const customSource = 'fn custom() {}\n';
  const sharedDigest = digest(sharedSource);
  const customDigest = digest(customSource);
  const sharedReceipt = { material: 'shared' };
  const customReceipt = { material: 'custom' };
  const key = { identifier: 'forgeax::default-standard-pbr', sourcePath: 'engine/standard.wgsl' };
  const merged = mergeAppShaderManifest(
    {
      schemaVersion: SHADER_MANIFEST_PUBLICATION_VERSION,
      entryPoints: [],
      fragments: [sharedSource],
      sources: { [sharedDigest]: [0] },
      receipts: [sharedReceipt],
      entries: [{ hash: 'engine', bindings: '{}', glsl: '', sourceDigest: sharedDigest }],
      materialShaders: [{ ...key, sourceDigest: sharedDigest, receiptIndex: 0, variants: [] }],
    },
    {
      forgeaxTransport: APP_SHADER_MANIFEST_DELTA,
      schemaVersion: SHADER_MANIFEST_PUBLICATION_VERSION,
      entryPoints: [],
      fragments: [customSource],
      sources: { [customDigest]: [0] },
      receipts: [customReceipt],
      entries: [],
      materialShaders: [{ ...key, sourceDigest: customDigest, receiptIndex: 0, variants: [] }],
    },
  );

  assert.deepEqual(merged.receipts, [customReceipt]);
  assert.equal(merged.materialShaders.length, 1);
  assert.equal(merged.materialShaders[0].sourceDigest, customDigest);
  assert.equal(merged.materialShaders[0].receiptIndex, 0);
});

test('schema 5 app deltas close source and receipt tables after projection and merge', () => {
  const engineEntrySource = 'fn engine_entry() {}\n';
  const sharedMaterialSource = 'fn shared_material() {}\n';
  const engineEntryDigest = compactV4Digest([engineEntrySource]);
  const sharedMaterialDigest = compactV4Digest([sharedMaterialSource]);
  const customDigest = compactV4Digest([sharedMaterialSource, 'fn custom() {}\n']);
  const replacementDigest = compactV4Digest([sharedMaterialSource, 'fn replacement() {}\n']);
  const variantDigest = compactV4Digest([sharedMaterialSource, 'fn variant() {}\n']);
  const sharedEntry = {
    hash: 'engine-entry',
    bindings: '{}',
    glsl: '',
    sourceDigest: engineEntryDigest,
  };
  const customEntry = { hash: 'app-entry', bindings: '{}', glsl: '', sourceDigest: customDigest };
  const sharedMaterial = {
    identifier: 'demo::replace',
    sourcePath: 'src/replace.wgsl',
    paramSchema: '{}',
    sourceDigest: sharedMaterialDigest,
    receiptIndex: 0,
    variants: [
      {
        defines: { SHARED: true },
        definesKey: 'SHARED=true',
        sourceDigest: sharedMaterialDigest,
        receiptIndex: 1,
      },
    ],
  };
  const replacementMaterial = {
    ...sharedMaterial,
    paramSchema: '{"roughness":{"type":"f32"}}',
    sourceDigest: replacementDigest,
    receiptIndex: 2,
    variants: [
      {
        defines: { REPLACEMENT: true },
        definesKey: 'REPLACEMENT=true',
        sourceDigest: variantDigest,
        receiptIndex: 3,
      },
    ],
  };
  const freshMaterial = {
    identifier: 'demo::fresh',
    sourcePath: 'src/fresh.wgsl',
    paramSchema: '{}',
    sourceDigest: customDigest,
    receiptIndex: 4,
    variants: [{ defines: {}, definesKey: '', sourceDigest: customDigest }],
  };
  const sharedReceipts = [{ owner: 'shared-material' }, { owner: 'shared-variant' }];
  const engine = {
    schemaVersion: SHADER_MANIFEST_PUBLICATION_VERSION,
    entryPoints: [],
    fragments: [engineEntrySource, sharedMaterialSource],
    sources: { [engineEntryDigest]: [0], [sharedMaterialDigest]: [1] },
    receipts: sharedReceipts,
    entries: [sharedEntry],
    materialShaders: [sharedMaterial],
  };
  const app = {
    schemaVersion: SHADER_MANIFEST_PUBLICATION_VERSION,
    entryPoints: [],
    fragments: [
      engineEntrySource,
      sharedMaterialSource,
      'fn custom() {}\n',
      'fn replacement() {}\n',
      'fn variant() {}\n',
    ],
    sources: {
      [engineEntryDigest]: [0],
      [sharedMaterialDigest]: [1],
      [customDigest]: [1, 2],
      [replacementDigest]: [1, 3],
      [variantDigest]: [1, 4],
    },
    receipts: [
      ...sharedReceipts,
      { owner: 'app-replacement' },
      { owner: 'app-variant' },
      { owner: 'app-fresh' },
    ],
    entries: [sharedEntry, customEntry],
    materialShaders: [sharedMaterial, replacementMaterial, freshMaterial],
  };

  const delta = projectAppShaderManifest(app, engine);
  assert.equal(delta.schemaVersion, SHADER_MANIFEST_PUBLICATION_VERSION);
  assert.deepEqual(delta.entries, [customEntry]);
  assert.deepEqual(delta.receipts, [
    { owner: 'app-replacement' },
    { owner: 'app-variant' },
    { owner: 'app-fresh' },
  ]);
  assert.deepEqual(
    Object.keys(delta.sources).sort(),
    [customDigest, replacementDigest, variantDigest].sort(),
  );
  assert.equal(delta.materialShaders[0].receiptIndex, 0);
  assert.equal(delta.materialShaders[0].variants[0].receiptIndex, 1);
  assert.equal(delta.materialShaders[1].receiptIndex, 2);
  assert.deepEqual(projectAppShaderManifest(delta, engine), delta);

  const merged = mergeAppShaderManifest(engine, delta);
  assert.equal(merged.schemaVersion, SHADER_MANIFEST_PUBLICATION_VERSION);
  assert.deepEqual(
    merged.entries.map((entry) => entry.hash),
    ['engine-entry', 'app-entry'],
  );
  assert.deepEqual(
    merged.materialShaders.map(({ identifier }) => identifier),
    ['demo::replace', 'demo::fresh'],
  );
  assert.deepEqual(merged.receipts, delta.receipts);
  assert.equal(merged.materialShaders[0].receiptIndex, 0);
  assert.equal(merged.materialShaders[0].variants[0].receiptIndex, 1);
  assert.equal(merged.materialShaders[1].receiptIndex, 2);
  assert.deepEqual(
    Object.keys(merged.sources).sort(),
    [engineEntryDigest, customDigest, replacementDigest, variantDigest].sort(),
  );
  for (const [sourceDigest, indices] of Object.entries(merged.sources)) {
    assert.equal(compactV4Digest(indices.map((index) => merged.fragments[index])), sourceDigest);
  }
  const rows = [
    ...merged.entries,
    ...merged.materialShaders,
    ...merged.materialShaders.flatMap((material) => material.variants),
  ];
  for (const row of rows) {
    assert.ok(!Object.hasOwn(row, 'wgsl'));
    assert.ok(!Object.hasOwn(row, 'composedWgsl'));
    assert.ok(!Object.hasOwn(row, 'receipt'));
  }
});

test('same row and receipt index with different receipt bytes remains an app override', () => {
  const source = 'fn main() {}';
  const digest = compactV4Digest([source]);
  const shared = {
    schemaVersion: SHADER_MANIFEST_PUBLICATION_VERSION,
    entryPoints: [],
    receipts: [{ binding: 1 }],
    fragments: [source],
    sources: { [digest]: [0] },
    entries: [],
    materialShaders: [
      {
        identifier: 'material',
        sourcePath: 'material.wgsl',
        sourceDigest: digest,
        receiptIndex: 0,
        variants: [{ definesKey: '', sourceDigest: digest, receiptIndex: 0 }],
      },
    ],
  };
  const app = { ...shared, receipts: [{ binding: 2 }] };
  const delta = projectAppShaderManifest(app, shared);
  assert.equal(delta.materialShaders.length, 1);
  const merged = mergeAppShaderManifest(shared, delta);
  assert.deepEqual(merged.receipts, app.receipts);
  assert.deepEqual(merged.materialShaders, app.materialShaders);
});

test('rejects invalid delta receipt indices before concatenating receipt tables', () => {
  const source = 'fn main() {}';
  const digest = compactV4Digest([source]);
  const shared = {
    schemaVersion: SHADER_MANIFEST_PUBLICATION_VERSION,
    entryPoints: [],
    receipts: [],
    fragments: [],
    sources: {},
    entries: [],
    materialShaders: [],
  };
  for (const receiptIndex of [-1, 1, 0.5, '0']) {
    const delta = {
      forgeaxTransport: APP_SHADER_MANIFEST_DELTA,
      schemaVersion: SHADER_MANIFEST_PUBLICATION_VERSION,
      entryPoints: [],
      receipts: [{}],
      fragments: [source],
      sources: { [digest]: [0] },
      entries: [],
      materialShaders: [
        { identifier: 'material', sourceDigest: digest, receiptIndex, variants: [] },
      ],
    };
    assert.throws(() => mergeAppShaderManifest(shared, delta), /receipt is missing/);
  }
});

test('entry-read pool order does not change shared rows or producer-owned publications', async () => {
  const utility = { ...sharedEntry, entryPoints: sharedReads };
  const customUtility = { ...customEntry, entryPoints: customReads };
  const shared = publishShaderManifest([utility], [compactSharedMaterial]);
  const app = publishShaderManifest(
    [customUtility, utility],
    [compactCustomMaterial, compactSharedMaterial],
  );
  assert.notEqual(shared.entries[0].entryPointsIndex, app.entries[1].entryPointsIndex);
  const original = JSON.stringify({ app, shared });
  const delta = projectAppShaderManifest(app, shared);
  assert.deepEqual(
    delta.entries.map((row) => row.hash),
    [customEntry.hash],
  );
  assert.deepEqual(delta.entryPoints, [customReads, variantReads]);
  assert.equal(delta.entries[0].entryPointsIndex, delta.materialShaders[0].entryPointsIndex);
  assert.notEqual(
    delta.materialShaders[0].entryPointsIndex,
    delta.materialShaders[0].variants[0].entryPointsIndex,
  );
  const merged = mergeAppShaderManifest(shared, delta);
  assert.deepEqual(await readShaderManifestPublication(merged), {
    entries: [utility, customUtility],
    materialShaders: [compactSharedMaterial, compactCustomMaterial],
  });
  assert.equal(JSON.stringify({ app, shared }), original);
});

test('same utility and material indices with different entry reads remain app overrides', async () => {
  const utility = { ...sharedEntry, entryPoints: sharedReads };
  const material = {
    ...compactSharedMaterial,
    variants: [{ definesKey: '', composedWgsl: 'engine', entryPoints: sharedReads }],
  };
  const shared = publishShaderManifest([utility], [material]);
  const app = { ...shared, entryPoints: [customReads] };
  const delta = projectAppShaderManifest(app, shared);
  assert.equal(delta.entries.length, 1);
  assert.equal(delta.materialShaders.length, 1);
  const merged = mergeAppShaderManifest(shared, delta);
  assert.deepEqual(merged.entryPoints, [customReads]);
  const decoded = await readShaderManifestPublication(merged);
  assert.deepEqual(decoded.entries[0].entryPoints, customReads);
  assert.deepEqual(decoded.materialShaders[0].entryPoints, customReads);
  assert.deepEqual(decoded.materialShaders[0].variants[0].entryPoints, customReads);
});

test('transport preserves unknown reflection, known empty entries and complete-resource reads', async () => {
  const variants = [
    { definesKey: 'unknown', composedWgsl: 'unknown' },
    { definesKey: 'empty', composedWgsl: 'empty', entryPoints: [] },
    { definesKey: 'complete', composedWgsl: 'complete', entryPoints: variantReads },
    {
      definesKey: 'no-fields',
      composedWgsl: 'no-fields',
      entryPoints: [
        {
          name: 'fragment_main',
          stage: 'fragment',
          bindings: [{ group: 1, binding: 0, fields: [] }],
        },
      ],
    },
  ];
  const material = { ...customMaterial, entryPoints: [], variants };
  const shared = publishShaderManifest([], [customMaterial]);
  const app = publishShaderManifest([], [material]);
  const delta = projectAppShaderManifest(app, shared);
  assert.equal(delta.materialShaders.length, 1);
  assert.equal(delta.entryPoints.length, 3);
  assert.equal(delta.materialShaders[0].variants[0].entryPointsIndex, undefined);
  assert.equal(
    delta.materialShaders[0].variants[1].entryPointsIndex,
    delta.materialShaders[0].entryPointsIndex,
  );
  const merged = mergeAppShaderManifest(shared, delta);
  assert.deepEqual(await readShaderManifestPublication(merged), {
    entries: [],
    materialShaders: [material],
  });
  const removed = mergeAppShaderManifest(app, projectAppShaderManifest(shared, app));
  assert.deepEqual(removed.entryPoints, []);
  assert.deepEqual(await readShaderManifestPublication(removed), {
    entries: [],
    materialShaders: [customMaterial],
  });
});

const reflectedPublication = () =>
  publishShaderManifest(
    [{ ...sharedEntry, entryPoints: sharedReads }],
    [
      {
        ...compactSharedMaterial,
        variants: [{ definesKey: '', composedWgsl: 'engine', entryPoints: sharedReads }],
      },
    ],
  );
const reflectedRows = (publication) => [
  publication.entries[0],
  publication.materialShaders[0],
  publication.materialShaders[0].variants[0],
];

test('all row entry-read indices are checked against their original pool before filtering or rebasing', () => {
  const shared = reflectedPublication();
  for (let rowIndex = 0; rowIndex < 3; rowIndex++) {
    for (const entryPointsIndex of [
      -1,
      1,
      0.5,
      '0',
      null,
      undefined,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      const invalid = reflectedPublication();
      reflectedRows(invalid)[rowIndex].entryPointsIndex = entryPointsIndex;
      assert.throws(() => projectAppShaderManifest(invalid, shared), /entry reads is missing/);
      assert.throws(() => projectAppShaderManifest(shared, invalid), /entry reads is missing/);
      assert.throws(
        () =>
          mergeAppShaderManifest(shared, {
            ...invalid,
            forgeaxTransport: APP_SHADER_MANIFEST_DELTA,
          }),
        /entry reads is missing/,
      );
      assert.throws(
        () =>
          mergeAppShaderManifest(invalid, {
            ...shared,
            forgeaxTransport: APP_SHADER_MANIFEST_DELTA,
          }),
        /entry reads is missing/,
      );
    }
  }
});

test('compact transport rejects absent or malformed entry-read pools and inline facts', () => {
  const shared = reflectedPublication();
  const malformed = [
    undefined,
    {},
    [null],
    [{}],
    [[{ name: 'bad', stage: 'geometry', bindings: [] }]],
    [
      [
        {
          name: 'bad',
          stage: 'fragment',
          bindings: [{ group: 0, binding: 0, fields: ['x', 'x'] }],
        },
      ],
    ],
  ];
  for (const entryPoints of malformed) {
    const invalid = { ...shared, entryPoints };
    assert.throws(
      () => projectAppShaderManifest(invalid, shared),
      /missing entryPoints|entry reads is invalid/,
    );
    assert.throws(
      () =>
        mergeAppShaderManifest(shared, { ...invalid, forgeaxTransport: APP_SHADER_MANIFEST_DELTA }),
      /missing entryPoints|entry reads is invalid/,
    );
  }
  for (let rowIndex = 0; rowIndex < 3; rowIndex++) {
    const invalid = reflectedPublication();
    reflectedRows(invalid)[rowIndex].entryPoints = sharedReads;
    assert.throws(() => projectAppShaderManifest(invalid, shared), /inline entry reads/);
    assert.throws(
      () =>
        mergeAppShaderManifest(shared, { ...invalid, forgeaxTransport: APP_SHADER_MANIFEST_DELTA }),
      /inline entry reads/,
    );
  }
});

test('delta source fragments are checked before adding the shared fragment offset', () => {
  const shared = publishShaderManifest([sharedEntry], []);
  for (const index of [-1, 1, 0.5, '0', null]) {
    const delta = projectAppShaderManifest(publishShaderManifest([customEntry], []), shared);
    delta.sources[delta.entries[0].sourceDigest] = [index];
    assert.throws(() => mergeAppShaderManifest(shared, delta), /invalid source fragment/);
  }
});
