import { readFileSync } from 'node:fs';
import { attachRecorder, buildFrameModel } from '@forgeax/engine-rhi-debug';
import { createShaderModule, rhi } from '@forgeax/engine-rhi-null';
import type { ShaderRegistry } from '@forgeax/engine-shader';
import type { MaterialAsset } from '@forgeax/engine-types';
import ts from 'typescript';
import { expect, it } from 'vitest';
import {
  recordedForwardGtaoFragmentEntryPoints,
  resolveForwardGtaoMaterialLineage,
} from './helpers/forward-gtao-material-lineage';

const material: MaterialAsset = {
  kind: 'material',
  passes: [{ name: 'forward', program: { module: 'forgeax_material::standard' } }],
};

it('keeps the Browser lineage callers aligned with the required capture arguments', () => {
  const parse = (relativePath: string) =>
    ts.createSourceFile(
      relativePath,
      readFileSync(new URL(relativePath, import.meta.url), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
  const helper = parse('./helpers/forward-gtao-material-lineage.ts');
  const declaration = helper.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'resolveForwardGtaoMaterialLineage',
  );
  if (declaration === undefined) throw new Error('lineage capture contract is missing');
  const required = declaration.parameters.filter(
    (parameter) => parameter.questionToken === undefined && parameter.initializer === undefined,
  ).length;
  for (const relativePath of [
    './forward-gtao-webgpu.browser.test.ts',
    './forward-gtao-surface-semantics.browser.test.ts',
  ]) {
    const source = parse(relativePath);
    const calls: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === declaration.name?.text
      ) {
        calls.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(calls.length, relativePath).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.arguments.length, relativePath).toBeGreaterThanOrEqual(required);
    }
  }
});

function registryWith(
  variants: readonly unknown[],
  source = 'default-source',
  facts: Record<string, unknown> = {},
) {
  const publication = {
    ...facts,
    identifier: 'forgeax::default-standard-pbr',
    sourcePath: 'packages/shader/src/default-standard-pbr.wgsl',
    composedWgsl: source,
    paramSchema: '[]',
    variants,
  };
  return {
    findMaterialArtifact: () => ({ ok: true as const, value: {} }),
    materialShaderManifestEntry: (identifier: string) =>
      identifier === publication.identifier ? publication : undefined,
  } as unknown as Pick<ShaderRegistry, 'findMaterialArtifact' | 'materialShaderManifestEntry'>;
}

it('resolves the authored forward module to the uniquely captured admitted variant', () => {
  const registry = registryWith([
    { definesKey: 'AO=false', defines: { AO: false }, composedWgsl: 'variant-no-ao' },
    {
      definesKey: 'AO=true',
      defines: { AO: true },
      composedWgsl: 'captured-ao-source',
      hash: 'captured-hash',
      sourceDigest: 'captured-digest',
      compilerProfile: { profile: 'browser-webgpu' },
      receipt: { receiptIdentity: 'captured-receipt' },
      entryPoints: [{ name: 'fs_main', stage: 'fragment' }],
      reflection: {
        schemaVersion: 'shader-reflection/3',
        entryPoints: [{ name: 'fs_main', stage: 'fragment' }],
      },
    },
  ]);

  expect(
    resolveForwardGtaoMaterialLineage(registry, material, 'captured-ao-source', ['fs_main']),
  ).toMatchObject({
    shaderIdentifier: 'forgeax::default-standard-pbr',
    passName: 'forward',
    module: 'forgeax_material::standard',
    variantSelection: { kind: 'single', definesKey: 'AO=true', defines: { AO: true } },
    hash: 'captured-hash',
    sourceDigest: 'captured-digest',
    compilerProfile: { profile: 'browser-webgpu' },
  });
});

it('rejects a source that is not in the authored module publication', () => {
  expect(() =>
    resolveForwardGtaoMaterialLineage(registryWith([]), material, 'unrelated-source', ['fs_main']),
  ).toThrow('captured forward shader source must match exactly one admitted variant');
});

it('uses complete direct publication facts when the admitted material has no variants', () => {
  const registry = registryWith([], 'captured-no-variant', {
    hash: 'direct-hash',
    sourceDigest: 'direct-digest',
    compilerProfile: { profile: 'browser-webgpu' },
    receipt: { receiptIdentity: 'direct-receipt' },
    entryPoints: [{ name: 'fs_main', stage: 'fragment' }],
    reflection: {
      schemaVersion: 'shader-reflection/3',
      entryPoints: [{ name: 'fs_main', stage: 'fragment' }],
    },
  });
  expect(
    resolveForwardGtaoMaterialLineage(registry, material, 'captured-no-variant', ['fs_main']),
  ).toMatchObject({
    variantSelection: { kind: 'single', definesKey: '', defines: {} },
    hash: 'direct-hash',
    sourceDigest: 'direct-digest',
    compilerProfile: { profile: 'browser-webgpu' },
    reflection: { schemaVersion: 'shader-reflection/3' },
  });
});

it('rejects ambiguous identical variant sources instead of choosing an arbitrary row', () => {
  const duplicate = { definesKey: 'MODE=one', defines: { MODE: true }, composedWgsl: 'same' };
  const registry = registryWith([
    duplicate,
    { ...duplicate, definesKey: 'MODE=two', defines: { MODE: false } },
  ]);
  expect(() =>
    resolveForwardGtaoMaterialLineage(registry, material, 'same', ['fs_opaque']),
  ).toThrow('identity is incomplete');
});

const sharedProgram = {
  composedWgsl: 'same',
  hash: 'hash',
  sourceDigest: 'digest',
  compilerProfile: { profile: 'browser-webgpu', version: 1 },
  receipt: {
    receiptIdentity: 'shared-receipt',
    directEntry: 'vs_main',
    sceneIndexEntry: 'vs_scene_index',
  },
  entryPoints: [{ name: 'fs_opaque', stage: 'fragment' }],
  reflection: {
    schemaVersion: 'shader-reflection/3',
    entryPoints: [{ name: 'fs_opaque', stage: 'fragment' }],
  },
};
const aliases = [
  { ...sharedProgram, definesKey: 'WATER_INFO_RGBA16=true', defines: { WATER_INFO_RGBA16: true } },
  {
    ...sharedProgram,
    definesKey: 'WATER_INFO_RGBA16=false',
    defines: { WATER_INFO_RGBA16: false },
  },
];

it('reports all admitted same-program aliases without claiming an arbitrary selected variant', () => {
  const result = resolveForwardGtaoMaterialLineage(registryWith(aliases), material, 'same', [
    'fs_opaque',
  ]);
  expect(result).toMatchObject({
    variantSelection: {
      kind: 'shared-program',
      aliases: [
        { definesKey: 'WATER_INFO_RGBA16=true', defines: { WATER_INFO_RGBA16: true } },
        { definesKey: 'WATER_INFO_RGBA16=false', defines: { WATER_INFO_RGBA16: false } },
      ],
    },
    hash: 'hash',
    sourceDigest: 'digest',
  });
  expect(result).not.toHaveProperty('variantDefinesKey');
});

it('compares complete program facts canonically rather than object insertion order', () => {
  const second = { ...aliases[1], compilerProfile: { version: 1, profile: 'browser-webgpu' } };
  expect(
    resolveForwardGtaoMaterialLineage(registryWith([aliases[0], second]), material, 'same', [
      'fs_opaque',
    ]),
  ).toMatchObject({ variantSelection: { kind: 'shared-program' } });
});

for (const field of [
  'hash',
  'sourceDigest',
  'compilerProfile',
  'receipt',
  'entryPoints',
  'reflection',
]) {
  it(`rejects identical source with different admitted ${field}`, () => {
    expect(() =>
      resolveForwardGtaoMaterialLineage(
        registryWith([aliases[0], { ...aliases[1], [field]: 'different-program' }]),
        material,
        'same',
        ['fs_opaque'],
      ),
    ).toThrow('distinct admitted programs');
  });
}

it('rejects missing or non-fragment entry points in either the publication or shader reflection', () => {
  expect(() =>
    resolveForwardGtaoMaterialLineage(registryWith(aliases), material, 'same', []),
  ).toThrow('captured fragment entry points');
  expect(() =>
    resolveForwardGtaoMaterialLineage(registryWith(aliases), material, 'same', ['unknown']),
  ).toThrow('captured fragment entry points');
  for (const field of ['entryPoints', 'reflection']) {
    const rows = aliases.map((alias) => ({
      ...alias,
      [field]:
        field === 'entryPoints'
          ? [{ name: 'fs_opaque', stage: 'vertex' }]
          : { entryPoints: [{ name: 'fs_opaque', stage: 'vertex' }] },
    }));
    expect(() =>
      resolveForwardGtaoMaterialLineage(registryWith(rows), material, 'same', ['fs_opaque']),
    ).toThrow('captured fragment entry points');
  }
});

for (const field of [
  'hash',
  'sourceDigest',
  'compilerProfile',
  'receipt',
  'entryPoints',
  'reflection',
]) {
  it(`rejects a same-source alias with missing ${field}`, () => {
    expect(() =>
      resolveForwardGtaoMaterialLineage(
        registryWith([aliases[0], { ...aliases[1], [field]: undefined }]),
        material,
        'same',
        ['fs_opaque'],
      ),
    ).toThrow('identity is incomplete');
  });
}

it('reads the actual main fragment entry and rejects a foreign source without a shader-label guess', async () => {
  const recorder = attachRecorder({ rhi, createShaderModule }).unwrap();
  try {
    const device = (
      await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
    ).unwrap();
    const source =
      '@vertex fn vs() -> @builtin(position) vec4f { return vec4f(0); } @fragment fn fs_opaque() -> @location(0) vec4f { return vec4f(1); }';
    const module = (await recorder.backend.createShaderModule(device, { code: source })).unwrap();
    const pipeline = device
      .createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs', buffers: [] },
        fragment: { module, entryPoint: 'fs_opaque', targets: [{ format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-list' },
      })
      .unwrap();
    const pending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const encoder = device.createCommandEncoder().unwrap();
    const pass = encoder.beginRenderPass({ colorAttachments: [] });
    pass.setPipeline(pipeline);
    pass.draw(3);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    (await recorder.frameBoundary()).unwrap();
    const model = buildFrameModel((await pending).unwrap().tape);
    expect(recordedForwardGtaoFragmentEntryPoints(model, source)).toEqual(['fs_opaque']);
    const registry = registryWith([], source, sharedProgram);
    expect(
      resolveForwardGtaoMaterialLineage(
        registry,
        material,
        source,
        recordedForwardGtaoFragmentEntryPoints(model, source),
      ),
    ).toMatchObject({
      capturedFragmentEntryPoints: ['fs_opaque'],
      variantSelection: { kind: 'single' },
      hash: sharedProgram.hash,
      sourceDigest: sharedProgram.sourceDigest,
    });
    expect(() => recordedForwardGtaoFragmentEntryPoints(model, 'foreign')).toThrow(
      'entry points are missing',
    );
  } finally {
    (await recorder.dispose()).unwrap();
  }
});

it('fails closed when the selected publication omits compiler or reflection identity', () => {
  const registry = registryWith([
    { definesKey: '', defines: {}, composedWgsl: 'captured-source', hash: 'hash' },
  ]);
  expect(() =>
    resolveForwardGtaoMaterialLineage(registry, material, 'captured-source', ['fs_main']),
  ).toThrow('publication identity is incomplete');
});

it('preserves ShaderRegistry admission errors without reading a publication row', () => {
  const failure = new Error('material admission failed');
  const registry = {
    findMaterialArtifact: () => ({ ok: false as const, error: failure }),
    materialShaderManifestEntry: () => {
      throw new Error('publication must not be queried after failed admission');
    },
  } as unknown as Pick<ShaderRegistry, 'findMaterialArtifact' | 'materialShaderManifestEntry'>;
  expect(() =>
    resolveForwardGtaoMaterialLineage(registry, material, 'captured-source', ['fs_main']),
  ).toThrow(failure);
});
