import { buildMeshCardLayout } from '@forgeax/engine-geometry';
import { RhiError } from '@forgeax/engine-rhi';
import { createShaderModule } from '@forgeax/engine-rhi-null';
import { rayMaterialContract } from '@forgeax/engine-shader';
import { type AssetHandle, err, ok } from '@forgeax/engine-types';
import { assert, expect, it, vi } from 'vitest';
import { Materials } from '../../materials';
import { buildRaySurfaceScene, type RaySurfaceScene } from '../../raytracing/attributes';
import { packCardLookupProjections } from '../../raytracing/card-lookup';
import { rayGeometryKey } from '../../raytracing/scene';
import {
  CARD_PLANES,
  createSurfaceCapture,
  prepareSurfaceCapture,
  type SurfaceCaptureSource,
} from '../../raytracing/surface-cards';
import { defaultMaterialSnapshot } from '../../render-system-extract';
import { retiredDenseCardProjections } from './card-slot-reuse-control.fixture';
import { queryTestDevice } from './global-sdf-query-device.fixture';
import { sdfCubeIndices, sdfCubePositions } from './sdf-cards.geometry';

async function uploadedCaptureSections(
  device: Awaited<ReturnType<typeof queryTestDevice>>,
  source: SurfaceCaptureSource,
  transform?: readonly number[],
) {
  const buffers = vi.spyOn(device, 'createBuffer');
  const writes = vi.spyOn(device.queue, 'writeBuffer');
  const capture = (await prepareSurfaceCapture(device, createShaderModule, [source])).unwrap();
  try {
    if (transform !== undefined)
      capture.retransform(source.instance.instanceId, transform).unwrap();
    const uploaded = (label: string) =>
      buffers.mock.results.flatMap((result, index) => {
        if (
          buffers.mock.calls[index]?.[0].label !== label ||
          result.type !== 'return' ||
          !result.value.ok
        )
          return [];
        const target = result.value.value;
        const data = writes.mock.calls.filter(([buffer]) => buffer === target).at(-1)?.[2];
        assert(data, `${label} must be uploaded by the real capture producer`);
        return [
          data instanceof ArrayBuffer
            ? new Uint8Array(data).slice()
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice(),
        ];
      });
    return { triangles: uploaded('cards.triangles'), attributes: uploaded('cards.attributes') };
  } finally {
    capture.dispose();
    buffers.mockRestore();
    writes.mockRestore();
  }
}

function expectCapturePrimitives(
  whole: RaySurfaceScene,
  observed: Awaited<ReturnType<typeof uploadedCaptureSections>>,
  source: SurfaceCaptureSource,
  sections: SurfaceCaptureSource['sections'],
) {
  expect(observed.triangles).toHaveLength(sections.length);
  expect(observed.attributes).toHaveLength(sections.length);
  const wholeIds = new DataView(
    whole.triangles.buffer,
    whole.triangles.byteOffset,
    whole.triangles.byteLength,
  );
  for (const [sectionIndex, section] of sections.entries()) {
    const triangles = observed.triangles[sectionIndex];
    const attributes = observed.attributes[sectionIndex];
    assert(triangles && attributes);
    const ids = new DataView(triangles.buffer, triangles.byteOffset, triangles.byteLength);
    for (let local = 0; local < section.indexCount / 3; local++) {
      // The traversal BVH can reorder triangles. Match
      // the actual geometry independently before checking authored raster order.
      const geometry = triangles.subarray(local * 80, local * 80 + 48);
      const matches = Array.from({ length: whole.triangleCount }, (_, i) => i).filter((i) =>
        geometry.every((byte, j) => byte === whole.triangles[i * 80 + j]),
      );
      expect(matches).toHaveLength(1);
      const meshRow = matches[0];
      assert(meshRow !== undefined);
      const primitive = wholeIds.getUint32(meshRow * 80 + 56, true);
      expect(primitive).toBe(section.indexOffset / 3 + local);
      expect(
        ids.getUint32(local * 80 + 56, true),
        `section ${sectionIndex}, storage row ${local}`,
      ).toBe(primitive);
      expect(ids.getUint32(local * 80 + 48, true)).toBe(source.instance.instanceId);
      expect(ids.getUint32(local * 80 + 52, true)).toBe(source.instance.geometryId);
      expect(ids.getUint32(local * 80 + 60, true)).toBe(section.material.id);
      expect(attributes.slice(local * 384, (local + 1) * 384)).toEqual(
        whole.attributes.slice(meshRow * 384, (meshRow + 1) * 384),
      );
    }
  }
}

it.each([
  [6, 12, 18],
  [3, 9, 24],
])('keeps canonical source primitive identity after splitting Card capture into material sections: %j', async (...counts) => {
  const { device, source } = await acceptedCaptureFixture();
  const material = source.sections[0]?.material;
  assert(material);
  let offset = 0;
  const sections = counts.map((indexCount, index) => {
    const section = {
      indexOffset: offset,
      indexCount,
      material: { ...material, id: 10 + index },
    };
    offset += indexCount;
    return section;
  });
  expect(offset).toBe(source.instance.indices.length);
  const whole = buildRaySurfaceScene([{ ...source.instance, materialId: 10 }]).unwrap();
  const observed = await uploadedCaptureSections(device, { ...source, sections });
  expectCapturePrimitives(whole, observed, source, sections);
});

it('keeps canonical source primitive identity after an in-place multi-material Card transform', async () => {
  const { device, source } = await acceptedCaptureFixture();
  const material = source.sections[0]?.material;
  assert(material);
  const sections = [
    { indexOffset: 0, indexCount: 6, material },
    { indexOffset: 6, indexCount: 12, material: { ...material, id: 11 } },
    { indexOffset: 18, indexCount: 18, material: { ...material, id: 12 } },
  ];
  const transform = [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 7, -5, 2, 1];
  const whole = buildRaySurfaceScene([{ ...source.instance, transform, materialId: 10 }]).unwrap();
  const observed = await uploadedCaptureSections(device, { ...source, sections }, transform);
  expectCapturePrimitives(whole, observed, source, sections);
});

it.each([
  'unversioned',
  'v2',
  'v3',
])('refuses a retired Card contract (%s) before creating a shader module', async (version) => {
  const { device, source } = await acceptedCaptureFixture();
  const asset = Materials.standard({ baseColor: [0.25, 0.5, 0.75, 1] });
  const compile = vi.fn(createShaderModule);
  const result = await createSurfaceCapture(device, compile, [
    {
      instance: source.instance,
      layout: source.layout,
      sections: [
        {
          indexOffset: 0,
          indexCount: sdfCubeIndices.length,
          material: {
            id: 0,
            asset,
            program: {
              context: 'card-capture',
              wgsl: '',
              paramSchema: [],
              contract: JSON.stringify([
                ...(version === 'unversioned' ? [] : [`forgeax-material-card-${version}`]),
                asset.parameters,
                asset.passes,
                asset.surface,
                asset.colorSpace,
              ]),
              sourceClosureDigest: 'old-card-context-v1',
            },
          },
        },
      ],
    },
  ]);
  if (result.ok) result.value.dispose();
  expect(result).toMatchObject({
    ok: false,
    error: { code: 'ray-material-unsupported', hint: expect.stringContaining('recook') },
  });
  expect(compile).not.toHaveBeenCalled();
});

it.each([
  2, -2,
])('uploads the real object basis for Card install and transform edits: %s', async (scale) => {
  const { device, source } = await acceptedCaptureFixture();
  const transform = [0, scale, 0, 0, -3, 0, 0, 0, 0, 0, 4, 0, 7, -5, 2, 1];
  const buffers = vi.spyOn(device, 'createBuffer');
  const writes = vi.spyOn(device.queue, 'writeBuffer');
  const capture = (
    await prepareSurfaceCapture(device, createShaderModule, [
      {
        ...source,
        instance: { ...source.instance, transform },
      },
    ])
  ).unwrap();
  try {
    const contexts = buffers.mock.results.flatMap((r, index) => {
      const desc = buffers.mock.calls[index]?.[0];
      return desc?.label === 'cards.projection' && r.value.ok
        ? [{ buffer: r.value.value, desc }]
        : [];
    });
    expect(contexts.length).toBe(source.layout.cards.length);
    const assertBasis = (matrix: readonly number[]) => {
      for (const context of contexts) {
        expect(context.desc.size).toBe(144);
        const latest = writes.mock.calls
          .filter(([buffer]) => buffer === context.buffer)
          .at(-1)?.[2];
        assert(latest);
        const bytes =
          latest instanceof ArrayBuffer
            ? new Uint8Array(latest)
            : new Uint8Array(latest.buffer, latest.byteOffset, latest.byteLength);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        expect(view.getUint32(80, true)).toBe(1);
        for (let column = 0; column < 3; column++)
          for (let axis = 0; axis < 3; axis++)
            expect(view.getFloat32(96 + column * 16 + axis * 4, true)).toBe(
              matrix[column * 4 + axis],
            );
      }
    };
    assertBasis(transform);
    const changed = [0, scale * 2, 0, 0, -6, 0, 0, 0, 0, 0, 8, 0, -2, 9, 5, 1];
    capture.retransform(0, changed).unwrap();
    assertBasis(changed);
  } finally {
    capture.dispose();
  }
});

it('records the same Card draws into a caller-owned pass without ending or submitting it', async () => {
  const device = await queryTestDevice();
  Object.assign(device.caps, { rgba16floatRenderable: true, maxColorAttachments: 4 });
  const layout = (await buildMeshCardLayout(sdfCubePositions, sdfCubeIndices)).unwrap();
  const asset = Materials.standard({ baseColor: [0.25, 0.5, 0.75, 1] });
  const capture = (
    await createSurfaceCapture(device, createShaderModule, [
      {
        instance: {
          instanceId: 0,
          geometryId: 0,
          mask: 255,
          transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          positions: sdfCubePositions,
          indices: sdfCubeIndices,
        },
        layout,
        sections: [
          {
            indexOffset: 0,
            indexCount: sdfCubeIndices.length,
            material: {
              id: 0,
              asset,
              program: {
                context: 'card-capture',
                wgsl: '',
                paramSchema: [{ name: 'baseColor', type: 'color', default: [1, 1, 1, 1] }],
                contract: rayMaterialContract(asset, 'card-capture'),
                sourceClosureDigest: 'null-device-structural-fixture',
              },
            },
          },
        ],
      },
    ])
  ).unwrap();
  expect(capture).toHaveProperty('recordPass');
  const encoder = device.createCommandEncoder({}).unwrap();
  const pass = encoder.beginRenderPass({ colorAttachments: [] });
  const draw = vi.spyOn(pass, 'draw');
  const end = vi.spyOn(pass, 'end');
  const submit = vi.spyOn(device.queue, 'submit');
  const record = vi.spyOn(capture, 'recordPass');
  capture.recordPass(pass).unwrap();
  expect(draw).toHaveBeenCalledTimes(layout.cards.length);
  expect(end).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
  pass.end();
  capture.record(encoder).unwrap();
  expect(record).toHaveBeenCalledTimes(3);
  encoder.finish().unwrap();
  capture.dispose();
  expect(capture.recordPass(pass).ok).toBe(false);
});

async function acceptedCaptureFixture() {
  const device = await queryTestDevice();
  Object.assign(device.caps, { rgba16floatRenderable: true, maxColorAttachments: 4 });
  const layout = (await buildMeshCardLayout(sdfCubePositions, sdfCubeIndices)).unwrap();
  const source: SurfaceCaptureSource = {
    instance: {
      instanceId: 0,
      geometryId: 0,
      mask: 255,
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      positions: sdfCubePositions,
      indices: sdfCubeIndices,
    },
    layout,
    captureKey: 'accepted-card-source',
    sections: [
      {
        indexOffset: 0,
        indexCount: sdfCubeIndices.length,
        material: {
          id: 0,
          program: {
            source: '',
            paramSchema: [{ name: 'baseColor', type: 'color', default: [1, 1, 1, 1] }],
          },
          snapshot: {
            ...defaultMaterialSnapshot(),
            paramSnapshot: { baseColor: [0.25, 0.5, 0.75, 1] },
          },
        },
      },
    ],
  };
  return { device, source };
}

it('prepares an integer identity raster beside the unchanged four material attachments', async () => {
  const { device, source } = await acceptedCaptureFixture();
  const textures = vi.spyOn(device, 'createTexture');
  const pipelines = vi.spyOn(device, 'createRenderPipeline');
  const capture = (await prepareSurfaceCapture(device, createShaderModule, [source])).unwrap();
  try {
    expect(textures.mock.calls.filter(([desc]) => desc.format === 'r32uint')).toHaveLength(1);
    const material = pipelines.mock.calls.find(([desc]) => desc.fragment?.entryPoint === 'fs_card');
    const identity = pipelines.mock.calls.find(
      ([desc]) => desc.fragment?.entryPoint === 'fs_card_identity',
    );
    expect(material?.[0].fragment?.targets.map((target) => target?.format)).toEqual(
      Array(4).fill('rgba16float'),
    );
    expect(identity?.[0].fragment?.targets.map((target) => target?.format)).toEqual(['r32uint']);
    expect(identity?.[0].vertex).toEqual(material?.[0].vertex);
    expect(identity?.[0].depthStencil).toEqual(material?.[0].depthStencil);
    expect(capture.bytes).toBe(
      capture.width * capture.height * 40 +
        capture.bufferReads.reduce((sum, read) => sum + read.size, 0) +
        (capture.width / capture.resolution) * (capture.height / capture.resolution) * 320,
    );
  } finally {
    capture.dispose();
  }
});

it('rejects two-phase section and clear work beyond the unchanged draw ceiling before allocating an atlas', async () => {
  const { device, source } = await acceptedCaptureFixture();
  const section = source.sections[0];
  assert(section);
  const sections = Array.from({ length: 12 }, (_, index) => ({
    ...section,
    indexOffset: index * 3,
    indexCount: 3,
  }));
  const sources = Array.from({ length: 512 }, (_, instanceId) => ({
    ...source,
    instance: { ...source.instance, instanceId },
    sections,
  }));
  expect(sources.length * source.layout.cards.length * sections.length).toBeLessThanOrEqual(65536);
  const textures = vi.spyOn(device, 'createTexture');
  const result = await prepareSurfaceCapture(device, createShaderModule, sources);
  expect(result).toMatchObject({ ok: false, error: { code: 'ray-reference-limit' } });
  expect(textures).not.toHaveBeenCalled();
});

it.each([
  'view',
  'cards',
] as const)('clears full %s identity with exact uint shader draws before geometry', async (kind) => {
  const { device, source } = await acceptedCaptureFixture();
  const capture = (
    await prepareSurfaceCapture(
      device,
      createShaderModule,
      [source],
      kind === 'cards'
        ? { kind, resolution: 16 }
        : {
            kind,
            resolution: 16,
            projection: {
              origin: [-1, 1, 1],
              u: [1, 0, 0],
              v: [0, -1, 0],
              n: [0, 0, 1],
              width: 2,
              height: 2,
              depth: 2,
            },
          },
    )
  ).unwrap();
  try {
    const count = kind === 'cards' ? source.layout.cards.length : 1;
    expect(capture.rasterWork().unwrap().clears).toBe(count);
    const encoder = device.createCommandEncoder({}).unwrap();
    const begin = encoder.beginRenderPass.bind(encoder);
    let identityDraws: unknown[][] | undefined;
    vi.spyOn(encoder, 'beginRenderPass').mockImplementation((descriptor) => {
      const pass = begin(descriptor);
      if (descriptor.label === 'cards.capture-identity')
        identityDraws = vi.spyOn(pass, 'draw').mock.calls;
      return pass;
    });
    capture.record(encoder).unwrap();
    expect(identityDraws?.slice(0, count)).toEqual(Array.from({ length: count }, () => [3]));
    expect(capture.materialWork.clearDraws).toBe(count);
    encoder.finish().unwrap();
  } finally {
    capture.dispose();
  }
});

it('rebuilds only a selected identity tile and counts both physical phases without changing tile units', async () => {
  const { device, source } = await acceptedCaptureFixture();
  const capture = (await prepareSurfaceCapture(device, createShaderModule, [source])).unwrap();
  try {
    const slice = { first: 1, count: 1 };
    expect(capture.rasterWork(slice, true).unwrap()).toEqual({
      material: 1,
      identity: 1,
      clears: 2,
      total: 4,
    });
    const encoder = device.createCommandEncoder({}).unwrap();
    const material = encoder.beginRenderPass({
      colorAttachments: CARD_PLANES.map((name) => ({
        view: capture.views[name],
        loadOp: 'load' as const,
        storeOp: 'store' as const,
      })),
      depthStencilAttachment: {
        view: capture.views.depth,
        depthLoadOp: 'load',
        depthStoreOp: 'store',
      },
    });
    capture.clearTiles(material, slice).unwrap();
    capture.recordPass(material, slice).unwrap();
    material.end();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: capture.primitiveIndex.view, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: {
        view: capture.views.depth,
        depthLoadOp: 'load',
        depthStoreOp: 'store',
      },
    });
    const viewport = vi.spyOn(pass, 'setViewport');
    const scissor = vi.spyOn(pass, 'setScissorRect');
    const draw = vi.spyOn(pass, 'draw');
    capture.clearTiles(pass, slice, 'identity').unwrap();
    capture.recordPass(pass, slice, 'identity').unwrap();
    expect(draw.mock.calls).toEqual([[3], [source.instance.indices.length]]);
    expect(viewport.mock.calls).toEqual([
      [16, 0, 16, 16, 0, 1],
      [16, 0, 16, 16, 0, 1],
    ]);
    expect(scissor.mock.calls).toEqual([
      [16, 0, 16, 16],
      [16, 0, 16, 16],
    ]);
    expect(capture.materialWork).toMatchObject({ rasterDraws: 2, clearDraws: 2 });
    pass.end();
    encoder.finish().unwrap();
    const disposed = capture.rasterWork.bind(capture);
    capture.dispose();
    expect(disposed(slice).ok).toBe(false);
  } finally {
    capture.dispose();
  }
});

it('rejects an identity PSO failure before publishing a capture or creating an encoder', async () => {
  const { device, source } = await acceptedCaptureFixture();
  const create = device.createRenderPipeline.bind(device);
  const failure = new RhiError({
    code: 'rhi-descriptor-invalid',
    expected: 'identity PSO failure',
    hint: 'repair the material cook',
  });
  vi.spyOn(device, 'createRenderPipeline').mockImplementation((desc) =>
    desc.fragment?.entryPoint === 'fs_card_identity' ? err(failure) : create(desc),
  );
  const encoder = vi.spyOn(device, 'createCommandEncoder');
  const result = await prepareSurfaceCapture(device, createShaderModule, [source]);
  expect(result).toEqual(err(failure));
  expect(encoder).not.toHaveBeenCalled();
});

it('cooks both raster entries from the authored Card context with the actual Naga compiler', async () => {
  const { prepareSdfCardsBaseFixture } = await import('./sdf-cards.commands');
  const { compileShader } = await import('../../../../shader-compiler/src/compile');
  const { card } = await prepareSdfCardsBaseFixture();
  expect(card.program.contract).toContain('forgeax-material-card-v4');
  const result = await compileShader(card.program.wgsl, {
    id: 'card-primitive-identity-regression',
    renderEntries: { vertex: 'vs_card', fragment: 'fs_card_identity', colorFormats: ['r32uint'] },
  });
  expect(result.ok, result.ok ? '' : JSON.stringify(result.error)).toBe(true);
}, 30000);

it.each([
  'material',
  'pose',
  'remove',
  'dispose',
  'range',
  'duplicate',
] as const)('refuses identity clear before touching pixels when its prepared material facts change: %s', async (change) => {
  const { device, source } = await acceptedCaptureFixture();
  const capture = (await prepareSurfaceCapture(device, createShaderModule, [source])).unwrap();
  const encoder = device.createCommandEncoder({}).unwrap();
  const slice = { first: 0, count: 1 };
  const material = encoder.beginRenderPass({
    colorAttachments: CARD_PLANES.map((name) => ({
      view: capture.views[name],
      loadOp: 'load' as const,
      storeOp: 'store' as const,
    })),
    depthStencilAttachment: {
      view: capture.views.depth,
      depthLoadOp: 'load',
      depthStoreOp: 'store',
    },
  });
  capture.recordPass(material, slice).unwrap();
  material.end();
  const identity = encoder.beginRenderPass({
    colorAttachments: [{ view: capture.primitiveIndex.view, loadOp: 'load', storeOp: 'store' }],
    depthStencilAttachment: {
      view: capture.views.depth,
      depthLoadOp: 'load',
      depthStoreOp: 'store',
    },
  });
  const draw = vi.spyOn(identity, 'draw');
  try {
    const snapshot = source.sections[0]?.material.snapshot;
    assert(snapshot);
    switch (change) {
      case 'material':
        capture
          .adoptMaterial(snapshot, { ...snapshot, paramSnapshot: { baseColor: [1, 0, 0, 1] } })
          .unwrap();
        break;
      case 'pose':
        capture.retransform(0, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1]).unwrap();
        break;
      case 'remove':
        capture.remove(0).unwrap();
        break;
      case 'dispose':
        capture.dispose();
        break;
      case 'range':
        break;
      case 'duplicate':
        capture.recordPass(identity, slice, 'identity').unwrap();
        draw.mockClear();
        break;
    }
    expect(
      capture.clearTiles(identity, change === 'range' ? { first: 1, count: 1 } : slice, 'identity')
        .ok,
    ).toBe(false);
    expect(draw).not.toHaveBeenCalled();
  } finally {
    identity.end();
    const finished = encoder.finish();
    if (change === 'dispose') expect(finished.ok).toBe(false);
    else finished.unwrap();
    capture.dispose();
  }
});

it('uses accepted linear material values exactly once and preserves whole-Mesh validation', async () => {
  const { device, source } = await acceptedCaptureFixture();
  const write = vi.spyOn(device.queue, 'writeBuffer');
  const capture = (await prepareSurfaceCapture(device, createShaderModule, [source])).unwrap();
  const material = capture.bufferReads.at(-1);
  expect(material?.usage).toBe('uniform-read');
  const row = write.mock.calls.find(([buffer]) => buffer === material?.buffer)?.[2];
  assert(row);
  const bytes =
    row instanceof ArrayBuffer
      ? new Uint8Array(row)
      : new Uint8Array(row.buffer, row.byteOffset, row.byteLength);
  expect(Array.from(new Float32Array(bytes.slice(0, 16).buffer))).toEqual([0.25, 0.5, 0.75, 1]);
  expect(capture.entries[0]?.captureKey).toBe(source.captureKey);
  capture.dispose();
  const section = source.sections[0];
  assert(section);
  for (const sections of [
    [],
    [{ ...section, indexOffset: 3 }],
    [{ ...section, indexCount: 3 }],
    [
      {
        ...section,
        material: {
          ...section.material,
          snapshot: {
            ...section.material.snapshot,
            renderState: { cullMode: 'none' as const },
          },
        },
      },
    ],
  ]) {
    expect(
      (await prepareSurfaceCapture(device, createShaderModule, [{ ...source, sections }])).ok,
    ).toBe(false);
  }
});

it('rejects an explicit attachment budget before allocating GPU resources', async () => {
  const { device, source } = await acceptedCaptureFixture();
  const create = vi.spyOn(device, 'createTexture');
  const capture = await prepareSurfaceCapture(
    device,
    createShaderModule,
    [source],
    { kind: 'cards', resolution: 16 },
    1,
  );
  expect(capture.ok).toBe(false);
  expect(create).not.toHaveBeenCalled();
});

it('repacks real resident Cards at their allocated atlas slots after removal and reuse', async () => {
  const { device, source } = await acceptedCaptureFixture();
  const cards = source.layout.cards.length;
  const at = (instanceId: number): SurfaceCaptureSource => ({
    ...source,
    instance: { ...source.instance, instanceId },
  });
  const a = at(0),
    b = at(1),
    c = at(2);
  const capture = (
    await prepareSurfaceCapture(
      device,
      createShaderModule,
      [a],
      { kind: 'cards', resolution: 16 },
      256 * 1024 * 1024,
      cards,
    )
  ).unwrap();
  const sources = [a, b, c].map((s) => ({
    instanceId: s.instance.instanceId,
    key: rayGeometryKey(s.instance, s.layout.meshDigest),
  }));
  try {
    const bRun = capture.add(b).unwrap();
    expect(bRun).toEqual({ first: cards, count: cards });
    const initial = packCardLookupProjections(capture, sources, [a, b, c]);
    expect(new DataView(initial.bytes.buffer).getUint32(bRun.first * 80 + 64, true)).toBe(1);
    expect(capture.remove(0).unwrap()).toEqual({ first: 0, count: cards });
    const cRun = capture.add(c).unwrap();
    expect(cRun).toEqual({ first: 0, count: cards });
    expect(capture.entries.map((entry) => entry.instanceId)).toEqual([1, 2]);
    expect(capture.entry(1)?.firstTile).toBe(bRun.first);
    expect(capture.entry(2)?.firstTile).toBe(cRun.first);
    const packed = packCardLookupProjections(capture, sources, [a, b, c]);
    expect(packed.count).toBe(capture.allocatedTiles);
    const view = new DataView(packed.bytes.buffer);
    expect(view.getUint32(bRun.first * 80 + 64, true)).toBe(1);
    expect(view.getUint32(cRun.first * 80 + 64, true)).toBe(2);
    const retired = retiredDenseCardProjections(capture, sources, [a, b, c]);
    const old = new DataView(retired.bytes.buffer);
    expect(old.getUint32(bRun.first * 80 + 64, true)).toBe(2);
    expect(old.getUint32(cRun.first * 80 + 64, true)).toBe(1);
  } finally {
    capture.dispose();
  }
});

it('keeps holes, rematerialized slots and first-match source staleness in a real capture', async () => {
  const { device, source } = await acceptedCaptureFixture();
  const cards = source.layout.cards.length;
  const b = { ...source, instance: { ...source.instance, instanceId: 1 } };
  const current = [source, b].map((s) => ({
    instanceId: s.instance.instanceId,
    key: rayGeometryKey(s.instance, s.layout.meshDigest),
  }));
  const capture = (
    await prepareSurfaceCapture(
      device,
      createShaderModule,
      [source],
      { kind: 'cards', resolution: 16 },
      256 * 1024 * 1024,
      cards,
    )
  ).unwrap();
  try {
    const run = capture.add(b).unwrap();
    capture.remove(source.instance.instanceId).unwrap();
    const hole = packCardLookupProjections(capture, current, [source, b]);
    expect(hole.count).toBe(run.first + run.count);
    const holeView = new DataView(hole.bytes.buffer);
    for (let i = 0; i < cards; i++) {
      expect(holeView.getUint32(i * 80 + 64, true)).toBe(0xffffffff);
      expect(holeView.getUint32(i * 80 + 68, true)).toBe(0);
      expect(holeView.getUint32((run.first + i) * 80 + 64, true)).toBe(1);
    }
    const changed = { ...b, captureKey: 'new-material-revision' };
    expect(capture.rematerialize(1, changed).unwrap()).toEqual(run);
    expect(capture.entry(1)?.firstTile).toBe(run.first);
    const state = (sources: typeof current, expected: readonly SurfaceCaptureSource[]) => {
      const packed = packCardLookupProjections(capture, sources, expected);
      return new DataView(packed.bytes.buffer).getUint32(run.first * 80 + 68, true);
    };
    const live = current[1];
    assert(live);
    const stale = { ...live, key: 'stale-geometry' };
    expect(state(current, [changed])).toBe(1);
    expect(state(current, [b])).toBe(0);
    expect(state([stale, live], [changed])).toBe(0);
    expect(state([live, stale], [changed, b])).toBe(1);
    expect(state(current, [b, changed])).toBe(0);
    capture.remove(1).unwrap();
    const empty = packCardLookupProjections(capture, [], []);
    expect(empty.count).toBe(capture.allocatedTiles);
    for (let i = 0; i < empty.count; i++)
      expect(new DataView(empty.bytes.buffer).getUint32(i * 80 + 64, true)).toBe(0xffffffff);
  } finally {
    capture.dispose();
  }
});

it('reads frozen source metadata once per list when packing real resident Cards', async () => {
  const { device, source } = await acceptedCaptureFixture();
  const card = source.layout.cards[0];
  assert(card);
  const expected = Array.from({ length: 64 }, (_, instanceId) => ({
    ...source,
    layout: { ...source.layout, cards: [card] },
    instance: { ...source.instance, instanceId },
  }));
  const sources = expected.map((s) => ({
    instanceId: s.instance.instanceId,
    key: rayGeometryKey(s.instance, s.layout.meshDigest),
  }));
  const capture = (
    await prepareSurfaceCapture(device, createShaderModule, expected, {
      kind: 'cards',
      resolution: 8,
    })
  ).unwrap();
  let reads = 0;
  const observed = <T>(values: readonly T[]) =>
    new Proxy(values, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
        return Reflect.get(target, key, receiver);
      },
    });
  try {
    const packed = packCardLookupProjections(capture, observed(sources), observed(expected));
    expect(packed.count).toBe(64);
    expect(reads).toBeLessThanOrEqual(64 * 4);
    const view = new DataView(packed.bytes.buffer);
    for (let row = 0; row < 64; row++) {
      expect(view.getUint32(row * 80 + 64, true)).toBe(row);
      expect(view.getUint32(row * 80 + 68, true)).toBe(1);
    }
  } finally {
    capture.dispose();
  }
});

it('adds, rematerializes and removes Card instances in place within the reserved atlas', async () => {
  const { device, source } = await acceptedCaptureFixture();
  const cards = source.layout.cards.length;
  const capture = (
    await prepareSurfaceCapture(
      device,
      createShaderModule,
      [source],
      { kind: 'cards', resolution: 16 },
      256 * 1024 * 1024,
      cards,
    )
  ).unwrap();
  expect(capture.allocatedTiles).toBe(cards);
  expect(capture.capacity).toBeGreaterThanOrEqual(2 * cards);
  const at = (instanceId: number) => ({
    ...source,
    instance: { ...source.instance, instanceId },
  });
  expect(capture.admitted(at(1))).toBe(true);
  expect(capture.add(at(1)).unwrap()).toEqual({ first: cards, count: cards });
  expect(capture.add(at(1)).ok).toBe(false);
  expect(capture.entries.map((e) => e.instanceId)).toEqual([0, 1]);

  const section = source.sections[0];
  assert(section);
  const white = {
    ...at(0),
    sections: [
      {
        ...section,
        material: {
          ...section.material,
          snapshot: { ...section.material.snapshot, paramSnapshot: { baseColor: [1, 1, 1, 1] } },
        },
      },
    ],
  };
  const reads = capture.bufferReads.length;
  const revision = capture.revision;
  expect(capture.rematerialize(0, white).unwrap()).toEqual({ first: 0, count: cards });
  // Two bindings that shared one root now use distinct materials: one new
  // uniform is needed. Replacing that same material again retains the count.
  expect(capture.bufferReads.length).toBe(reads + 1);
  capture.rematerialize(0, white).unwrap();
  expect(capture.bufferReads.length).toBe(reads + 1);
  expect(capture.revision).toBeGreaterThan(revision);
  expect(capture.entries.map((e) => e.instanceId)).toEqual([0, 1]);
  expect(capture.rematerialize(0, { ...white, layout: { ...source.layout, cards: [] } }).ok).toBe(
    false,
  );

  expect(capture.remove(0).unwrap()).toEqual({ first: 0, count: cards });
  expect(capture.has(0)).toBe(false);
  expect(capture.bufferReads.length).toBeLessThan(reads);
  expect(capture.remove(0).ok).toBe(false);
  // A freed run is reused before the high-water mark grows.
  expect(capture.add(at(2)).unwrap()).toEqual({ first: 0, count: cards });
  expect(capture.allocatedTiles).toBe(2 * cards);

  let next = 3;
  for (; next < 3 + capture.capacity; next++) if (!capture.add(at(next)).ok) break;
  const full = capture.add(at(next));
  assert(!full.ok);
  expect(full.error.code).toBe('ray-reference-limit');
  // Overflow leaves the capture intact: no partial install, tiles stay inside the atlas.
  expect(capture.entries.some((e) => e.instanceId === next)).toBe(false);
  expect(capture.allocatedTiles).toBeLessThanOrEqual(capture.capacity);
  capture.dispose();
  expect(capture.add(at(99)).ok).toBe(false);
});

it('installs the priority prefix past the Card ceilings in residency mode instead of failing', async () => {
  const { device, source } = await acceptedCaptureFixture();
  const cards = source.layout.cards.length;
  const sources = Array.from({ length: 8 }, (_, instanceId) => ({
    ...source,
    instance: { ...source.instance, instanceId },
  }));
  // Room for about three instances' tiles at 16x16 rgba16f x4 + depth (36 B/texel).
  const maxBytes = 3 * cards * 16 * 16 * 36 * 2;
  const strict = await prepareSurfaceCapture(
    device,
    createShaderModule,
    sources,
    { kind: 'cards', resolution: 16 },
    maxBytes,
  );
  assert(!strict.ok);
  expect(strict.error.code).toBe('ray-reference-limit');
  const capture = (
    await prepareSurfaceCapture(
      device,
      createShaderModule,
      sources,
      { kind: 'cards', resolution: 16 },
      maxBytes,
      0,
      { maxTexels: 1 << 20 },
    )
  ).unwrap();
  const resident = capture.entries.map((e) => e.instanceId);
  expect(resident.length).toBeGreaterThan(0);
  expect(resident.length).toBeLessThan(sources.length);
  // The installed set is the leading prefix of the priority-ordered sources.
  expect(resident).toEqual(resident.map((_, i) => i));
  expect(capture.residency).toEqual({ maxTexels: 1 << 20 });
  expect(capture.allocatedTiles).toBeLessThanOrEqual(capture.capacity);
  expect(capture.width * capture.height * 36).toBeLessThanOrEqual(maxBytes);
  // Streaming swaps residents: an eviction frees tiles that the next install reuses.
  const last = resident[resident.length - 1];
  assert(last !== undefined);
  const evicted = capture.remove(last).unwrap();
  const next = sources[resident.length];
  assert(next);
  expect(capture.add(next).unwrap()).toEqual(evicted);
  expect(capture.has(next.instance.instanceId)).toBe(true);
  expect(capture.has(last)).toBe(false);
  // The texel ceiling bounds the atlas even when bytes would allow more.
  const narrow = (
    await prepareSurfaceCapture(
      device,
      createShaderModule,
      sources,
      { kind: 'cards', resolution: 16 },
      256 * 1024 * 1024,
      0,
      { maxTexels: 16 * 16 * cards },
    )
  ).unwrap();
  expect(narrow.width * narrow.height).toBeLessThanOrEqual(16 * 16 * cards);
  expect(narrow.entries.length).toBeGreaterThan(0);
  capture.dispose();
  narrow.dispose();
});

it('adopts shared numeric values without draw visits or uploads and pulls them in the selected tile', async () => {
  const { device, source } = await acceptedCaptureFixture();
  const shared = source.sections[0]?.material;
  assert(shared);
  const capture = (
    await prepareSurfaceCapture(
      device,
      createShaderModule,
      Array.from({ length: 64 }, (_, instanceId) => ({
        ...source,
        instance: { ...source.instance, instanceId },
      })),
    )
  ).unwrap();
  const write = vi.spyOn(device.queue, 'writeBuffer');
  const snapshot = { ...shared.snapshot, paramSnapshot: { baseColor: [0, 1, 0, 1] } };
  const work = capture.adoptMaterial(shared.snapshot, snapshot).unwrap();
  assert(work);
  expect(work.tiles).toBe(64 * source.layout.cards.length);
  expect(capture.materialWork).toEqual({
    roots: 1,
    drawVisits: 0,
    uniformUploads: 0,
    assetRoots: 0,
    bindingRefreshes: 0,
    rasterDraws: 0,
    clearDraws: 0,
  });
  expect(write).not.toHaveBeenCalled();
  const encoder = device.createCommandEncoder({}).unwrap();
  const pass = encoder.beginRenderPass({ colorAttachments: [] });
  capture.recordPass(pass, { first: 0, count: 1 }).unwrap();
  expect(capture.materialWork).toEqual({
    roots: 1,
    drawVisits: 1,
    uniformUploads: 1,
    assetRoots: 0,
    bindingRefreshes: 0,
    rasterDraws: 1,
    clearDraws: 0,
  });
  expect(write).toHaveBeenCalledTimes(1);
  const row = write.mock.calls[0]?.[2];
  assert(row && ArrayBuffer.isView(row));
  expect(Array.from(new Float32Array(row.buffer, row.byteOffset, 4))).toEqual([0, 1, 0, 1]);
  capture.recordPass(pass, { first: 1, count: 1 }).unwrap();
  expect(capture.materialWork).toEqual({
    roots: 1,
    drawVisits: 2,
    uniformUploads: 1,
    assetRoots: 0,
    bindingRefreshes: 0,
    rasterDraws: 2,
    clearDraws: 0,
  });
  expect(write).toHaveBeenCalledTimes(1);
  pass.end();
  encoder.finish().unwrap();
  capture.dispose();
  expect(capture.adoptMaterial(shared.snapshot, snapshot).ok).toBe(false);
});

it('rejects changed sampler bindings instead of accepting a numeric-row update', async () => {
  const { device, source } = await acceptedCaptureFixture();
  const material = source.sections[0]?.material;
  assert(material);
  const capture = (await prepareSurfaceCapture(device, createShaderModule, [source])).unwrap();
  for (const snapshot of [
    {
      ...material.snapshot,
      samplerHandles: new Map([['baseColorTexture', 9 as AssetHandle<'sampler'>]]),
    },
    { ...material.snapshot, authoredSamplerFields: new Set(['baseColorTexture']) },
  ]) {
    const adopted = capture.adoptMaterial(material.snapshot, snapshot);
    expect(adopted.ok).toBe(false);
    expect(capture.materialWork).toEqual({
      roots: 0,
      drawVisits: 0,
      uniformUploads: 0,
      assetRoots: 0,
      bindingRefreshes: 0,
      rasterDraws: 0,
      clearDraws: 0,
    });
  }
  capture.dispose();
});

it('queues texture and sampler roots without visiting material consumers and refreshes only scheduled bindings', async () => {
  const { device, source } = await acceptedCaptureFixture();
  const section = source.sections[0];
  assert(section);
  const original = section.material;
  const scope = {};
  const handle = 11 as AssetHandle<'texture'>;
  const samplerHandle = 12 as AssetHandle<'sampler'>;
  const texture = device
    .createTexture({ size: { width: 2, height: 2 }, format: 'rgba8unorm', usage: 4 })
    .unwrap();
  const firstView = device.createTextureView(texture, {}).unwrap();
  const nextView = device.createTextureView(texture, {}).unwrap();
  const sampler = device.createSampler({}).unwrap();
  let selected = firstView;
  const refresh = vi.fn(() => {
    selected = nextView;
  });
  const material = {
    ...original,
    scope,
    program: {
      ...original.program,
      paramSchema: [
        ...original.program.paramSchema,
        { name: 'baseColorTexture', type: 'texture2d' as const },
      ],
    },
    snapshot: {
      ...original.snapshot,
      textureHandles: new Map([['baseColorTexture', handle]]),
      samplerHandles: new Map([['baseColorTexture', samplerHandle]]),
    },
    resolveTexture: () => ok({ view: selected, sampler }),
    refreshTextures: refresh,
  };
  const sources = Array.from({ length: 32 }, (_, instanceId) => ({
    ...source,
    instance: {
      ...source.instance,
      instanceId,
      uvSets: [new Float32Array((sdfCubePositions.length / 3) * 2)],
    },
    sections: [{ ...section, material }],
  }));
  const capture = (await prepareSurfaceCapture(device, createShaderModule, sources)).unwrap();
  const groups = vi.spyOn(device, 'createBindGroup');
  const buffers = vi.spyOn(device, 'createBuffer');
  const work = capture.adoptAsset(scope, handle, 1);
  assert(work);
  expect(work.tiles).toBe(32 * source.layout.cards.length);
  expect(capture.materialWork).toMatchObject({ assetRoots: 1, drawVisits: 0, bindingRefreshes: 0 });
  expect(groups).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
  capture.prepareTiles({ first: 0, count: 1 });
  expect(groups).toHaveBeenCalledTimes(1);
  expect(buffers).not.toHaveBeenCalled();
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(capture.textureReads).toEqual([nextView]);
  capture.prepareTiles({ first: 1, count: 1 });
  expect(groups).toHaveBeenCalledTimes(1);
  expect(capture.adoptAsset({}, handle, 2)).toBeUndefined();
  expect(capture.adoptAsset(scope, samplerHandle, 2)).toBeDefined();
  expect(groups).toHaveBeenCalledTimes(1);
  capture.prepareTiles({ first: 6, count: 1 });
  expect(groups).toHaveBeenCalledTimes(2);
  expect(capture.materialWork.bindingRefreshes).toBe(2);
  const changed = {
    ...material.snapshot,
    samplerHandles: new Map([['baseColorTexture', 13 as AssetHandle<'sampler'>]]),
  };
  capture.adoptMaterial(material.snapshot, changed).unwrap();
  expect(capture.adoptAsset(scope, samplerHandle, 3)).toBeUndefined();
  expect(capture.adoptAsset(scope, 13, 3)).toBeDefined();
  expect(groups).toHaveBeenCalledTimes(2);
  capture.prepareTiles({ first: 12, count: 1 });
  expect(groups).toHaveBeenCalledTimes(3);
  capture.dispose();
  device.destroyTexture(texture);
});

it.each([
  128, 1024,
])('edits 8 captured rows without scanning N=%i entries or buffers', async (count) => {
  const { device, source } = await acceptedCaptureFixture();
  const card = source.layout.cards[0];
  assert(card);
  const sources = Array.from({ length: count }, (_, instanceId) => ({
    ...source,
    layout: { ...source.layout, cards: [card] },
    instance: { ...source.instance, instanceId },
  }));
  const capture = (
    await prepareSurfaceCapture(
      device,
      createShaderModule,
      sources,
      { kind: 'cards', resolution: 8 },
      256 * 1024 * 1024,
      8,
    )
  ).unwrap();
  const uploads = vi.spyOn(device.queue, 'writeBuffer');
  let bufferReads = 0,
    entryReads = 0;
  // Count real owner-array accesses, including manual indexed loops.
  for (const read of capture.bufferReads) {
    const buffer = read.buffer;
    Object.defineProperty(read, 'buffer', {
      get: () => {
        bufferReads++;
        return buffer;
      },
    });
  }
  for (const entry of capture.entries) {
    const instanceId = entry.instanceId;
    Object.defineProperty(entry, 'instanceId', {
      get: () => {
        entryReads++;
        return instanceId;
      },
    });
  }
  const moved = Array.from(source.instance.transform);
  moved[12] = 1;
  for (let instanceId = count - 8; instanceId < count; instanceId++) {
    capture.retransform(instanceId, moved).unwrap();
    capture.rematerialize(instanceId, sources[instanceId] as SurfaceCaptureSource).unwrap();
  }
  for (let instanceId = count - 8; instanceId < count; instanceId++) {
    expect(capture.entry(instanceId)?.instanceId).toBe(instanceId);
    capture.remove(instanceId).unwrap();
    expect(capture.entry(instanceId)).toBeUndefined();
  }
  expect(capture.entry(0)?.instanceId).toBe(0);
  expect(uploads.mock.calls.length).toBeLessThan(128);
  expect(uploads.mock.calls.reduce((bytes, call) => bytes + call[2].byteLength, 0)).toBeLessThan(
    128 * 1024,
  );
  expect(entryReads).toBeLessThan(128);
  expect(bufferReads).toBeLessThan(128);
  capture.dispose();
});
