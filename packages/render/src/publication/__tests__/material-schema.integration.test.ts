import { AssetRegistry, HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import { Transform } from '@forgeax/engine-scene';
import {
  DEFAULT_SPRITE_PARAM_SCHEMA,
  ShaderRegistry,
  STANDARD_PIPELINE_PARAM_SCHEMA,
} from '@forgeax/engine-shader';
import {
  derive,
  getAdmittedParamSchemaInterface,
  type ParamSchemaEntry,
} from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { ownReceivedPublicationMaterials } from '../../../../app/src/execution/received-publication-materials';
import { createRenderTargetHost } from '../../assembly/render-target-host';
import { MeshFilter, MeshRenderer } from '../../components';
import type { RenderFrameState } from '../../record/frame-snapshot';
import { buildPbrMaterialUboPayload } from '../../record/main-pass-material';
import { uploadMaterialUniforms } from '../../record/material-uniforms';
import {
  type _InternalRenderPipelineContext,
  MATERIAL_PER_ENTITY_STRIDE,
} from '../../record/render-context';
import { type RenderPublication, renderPublicationTransfers } from '../contract';
import { installPublicationPrograms, publicationMaterialSchemaRebinder } from '../programs';
import { createRenderPublisher } from '../publisher';
import { RenderPublicationReceiver } from '../receiver';

function fixture(
  schema: readonly ParamSchemaEntry[],
  snapshotSchema = schema,
  shaderId = 'game::forward',
) {
  const source = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  source.shaderRegistry.installMaterialArtifact(shaderId, { source: '', paramSchema: schema });
  const admitted = source.shaderRegistry.findMaterialArtifact(shaderId).unwrap().paramSchema;
  const world = new World();
  world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: {} },
    )
    .unwrap();
  const identity = { source: 'schema-publication-test', epoch: 1 };
  const publisher = createRenderPublisher(world, source, identity);
  const candidate = publisher.prepare(0).unwrap();
  const templates = candidate.packet.templates.map((template) => {
    const material = {
      ...template.snapshot.material,
      materialShaderId: shaderId,
      materialProgramKeys: { Forward: shaderId, ShadowCaster: 'game::shadow' },
      materialParamSchema: snapshotSchema === schema ? admitted : snapshotSchema,
      paramSnapshot: { factor: 0.25 },
    };
    return { ...template, snapshot: { ...template.snapshot, material, materials: [material] } };
  });
  const packet = structuredClone(
    {
      ...candidate.packet,
      templates,
      programs: [
        { key: shaderId, shader: { source: '', paramSchema: admitted } },
        {
          key: 'game::shadow',
          shader: { source: '', paramSchema: [{ name: 'shadow', type: 'vec4' }] },
        },
      ],
    } satisfies RenderPublication,
    { transfer: renderPublicationTransfers(candidate.packet) },
  );
  candidate.accept();
  const receiver = new RenderPublicationReceiver(identity);
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const copied = packet.templates[0]?.snapshot.material.materialParamSchema;
  if (copied === undefined) throw new Error('Missing published material schema');
  return { admitted, packet, receiver, assets, publisher, copied };
}

it('rebinds a Worker clone to the selected program owner before retaining accepted snapshots', () => {
  const f = fixture([{ name: 'factor', type: 'f32', default: 0.75 }]);
  expect(getAdmittedParamSchemaInterface(f.admitted)).toBeDefined();
  expect(getAdmittedParamSchemaInterface(f.copied)).toBeUndefined();
  installPublicationPrograms(f.assets, f.packet.programs);
  const accepted = f.receiver.accept(f.packet, f.assets).unwrap();
  const owned = f.assets.shaderRegistry.findMaterialArtifact('game::forward').unwrap().paramSchema;
  const material = accepted.frame.renderables[0]?.material;
  if (material?.materialParamSchema === undefined) throw new Error('Missing accepted schema');
  expect(material.materialParamSchema).toBe(owned);
  expect(getAdmittedParamSchemaInterface(material.materialParamSchema)).toBe(derive(owned));
  expect(accepted.frame.renderables[0]?.materials[0]).toBe(material);
  expect(f.receiver.snapshot(accepted).frame.renderables[0]?.material).toBe(material);
  expect(
    accepted.operations[0]?.kind === 'update' && accepted.operations[0].snapshot?.material,
  ).toBe(material);
  // Native transfer did not confer immutability on arbitrary parameter values.
  expect(Object.isFrozen(material.paramSnapshot)).toBe(false);
  const firstPayload = buildPbrMaterialUboPayload(material);
  const values = f.packet.templates[0]?.snapshot.material.paramSnapshot;
  if (values === undefined) throw new Error('Missing published parameter values');
  expect(material.paramSnapshot).toBe(values);
  values.factor = 0.5;
  const secondPayload = buildPbrMaterialUboPayload(material);
  expect(new DataView(firstPayload.buffer).getFloat32(0, true)).toBe(0.25);
  expect(new DataView(secondPayload.buffer).getFloat32(0, true)).toBe(0.5);
  expect(f.copied).not.toBe(owned);
  expect(getAdmittedParamSchemaInterface(f.copied)).toBeUndefined();
  f.receiver.dispose();
  f.publisher.dispose();
});

it('finishes exclusive native material values without changing public receiver ownership', async () => {
  const f = fixture([{ name: 'factor', type: 'f32', default: 0.75 }]);
  const sourceMaterial = f.packet.templates[0]?.snapshot.material;
  if (sourceMaterial === undefined) throw new Error('Missing published material');
  const received = ownReceivedPublicationMaterials(f.packet);
  const owned = received.templates[0]?.snapshot.material;
  expect(owned).not.toBe(sourceMaterial);
  expect(owned?.immutableValues).toBe(true);
  expect(Object.isFrozen(owned)).toBe(true);
  expect(owned?.paramSnapshot).not.toBe(sourceMaterial.paramSnapshot);
  expect(owned?.paramSnapshot).toEqual(sourceMaterial.paramSnapshot);
  expect(owned?.materialParamSchema).not.toBe(sourceMaterial.materialParamSchema);
  expect(owned?.baseColor).not.toBe(sourceMaterial.baseColor);
  expect(owned?.baseColor).toEqual(sourceMaterial.baseColor);
  expect(received.templates[0]?.snapshot.materials[0]).toBe(owned);
  expect(sourceMaterial.immutableValues).toBeUndefined();
  expect(received.transforms).toBe(f.packet.transforms);
  expect(received.assets).toBe(f.packet.assets);
  expect(received.targets).toBe(f.packet.targets);
  // A Feature/asset consumer can retain an alias in the original native clone.
  // Only the detached numeric subtree belongs to the material packer.
  const aliased = sourceMaterial.paramSnapshot;
  if (aliased === undefined) throw new Error('Missing source values');
  (aliased as Record<string, number>).factor = 0.9;
  expect(owned?.paramSnapshot?.factor).toBe(0.25);

  const accepted = f.receiver.accept(received, f.assets).unwrap();
  const material = accepted.frame.renderables[0]?.material;
  if (material === undefined) throw new Error('Missing received material');
  expect(material.immutableValues).toBe(true);
  expect(material.materialParamSchema).toBe(
    f.assets.shaderRegistry.findMaterialArtifact('game::forward').unwrap().paramSchema,
  );
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const buffer = device.createBuffer({ size: MATERIAL_PER_ENTITY_STRIDE, usage: 0x48 }).unwrap();
  const frameState = {} as RenderFrameState;
  const context = (value = material) =>
    ({
      runtime: { device },
      frameState,
      materialSlotCount: 1,
      materialSlots: [value],
      materialSlotOwners: [{ renderableIndex: 0 }],
      validatedOrdered: [],
      pipelineState: { materialUniformBuffer: { buffer } },
    }) as unknown as _InternalRenderPipelineContext;
  try {
    for (let frame = 0; frame < 3; frame++) uploadMaterialUniforms(context());
    expect(frameState.materialUboCounters).toMatchObject({
      packHits: 1,
      packMisses: 2,
      packMissMutable: 0,
      packMissCold: 1,
      skippedUploads: 2,
    });
    const previousBytes = frameState.materialUboPayloadCache?.payload.slice();
    const next = structuredClone({
      ...f.packet,
      base: 1,
      revision: 2,
      baseline: false,
      programs: [],
    });
    for (const template of next.templates) template.snapshot.material.paramSnapshot.factor = 0.5;
    const changed = f.receiver.accept(ownReceivedPublicationMaterials(next), f.assets).unwrap();
    const updated = changed.frame.renderables[0]?.material;
    if (updated === undefined) throw new Error('Missing updated material');
    expect(updated).not.toBe(material);
    expect(updated.paramSnapshot?.factor).toBe(0.5);
    expect(material.paramSnapshot?.factor).toBe(0.25);
    uploadMaterialUniforms(context(updated));
    expect(frameState.materialUboPayloadCache?.payload).not.toEqual(previousBytes);
    expect(
      new DataView(
        frameState.materialUboPayloadCache?.payload.buffer ?? new ArrayBuffer(0),
      ).getFloat32(0, true),
    ).toBe(0.5);
    const moved = {
      ...next,
      base: 2,
      revision: 3,
      templates: [],
      upserts: new Uint32Array(),
    };
    expect(ownReceivedPublicationMaterials(moved)).toBe(moved);
    const transformed = f.receiver.accept(moved, f.assets).unwrap();
    expect(f.receiver.snapshot(transformed).frame.renderables[0]?.material).toBe(updated);
  } finally {
    device.destroyBuffer(buffer).unwrap();
    f.receiver.dispose();
    f.publisher.dispose();
  }
});

it('detaches numeric and ABI aliases while preserving dynamic resource identities', () => {
  const f = fixture([{ name: 'factor', type: 'f32', default: 0.75 }]);
  const template = f.packet.templates[0];
  if (template === undefined) throw new Error('Missing published template');
  const values = { factor: -0, vector: [NaN, -0, Infinity, 1] };
  const coordinates = new Map([['albedo', { transform: { offset: [0, 0] as [number, number] } }]]);
  const baseColor = new Float32Array(new SharedArrayBuffer(12));
  baseColor.set([0.25, 0.5, 0.75]);
  const material = {
    ...template.snapshot.material,
    baseColor: baseColor as typeof template.snapshot.material.baseColor,
    paramSnapshot: values,
    textureCoordinates: coordinates,
    textureHandles: new Map(),
    samplerHandles: new Map(),
    textureSources: new Map(),
  };
  const sibling = { ...material, roughness: 0.125 };
  const packet = {
    ...f.packet,
    templates: [
      { ...template, snapshot: { ...template.snapshot, material, materials: [material, sibling] } },
    ],
  };
  const received = ownReceivedPublicationMaterials(packet);
  const owned = received.templates[0]?.snapshot.material;
  const second = received.templates[0]?.snapshot.materials[1];
  if (owned === undefined || second === undefined) throw new Error('Missing owned values');
  expect(owned.materialParamSchema).toBe(second.materialParamSchema);
  expect(owned.materialParamSchema).not.toBe(material.materialParamSchema);
  expect(owned.paramSnapshot).toBe(second.paramSnapshot);
  expect(owned.paramSnapshot).not.toBe(values);
  expect(owned.baseColor.buffer).toBeInstanceOf(ArrayBuffer);
  expect(Object.is(owned.paramSnapshot?.factor, -0)).toBe(true);
  expect(owned.paramSnapshot?.vector).toEqual([NaN, -0, Infinity, 1]);
  if (material.materialParamSchema?.[0] !== undefined)
    Reflect.set(material.materialParamSchema[0], 'default', 0.125);
  expect(owned.materialParamSchema?.[0]).toMatchObject({ default: 0.75 });
  for (const field of [
    'textureCoordinates',
    'textureHandles',
    'samplerHandles',
    'textureSources',
  ] as const)
    expect(owned[field]).toBe(material[field]);
  baseColor[0] = 1;
  values.vector[0] = 1;
  expect(owned.baseColor[0]).toBe(0.25);
  expect((owned.paramSnapshot?.vector as number[])[0]).toBeNaN();
  coordinates.get('albedo')?.transform.offset.splice(0, 1, 0.5);
  expect(owned.textureCoordinates?.get('albedo')?.transform?.offset?.[0]).toBe(0.5);
  f.receiver.dispose();
  f.publisher.dispose();
});

it.each([
  [{ name: 'factor', type: 'f32', default: 0.5 }],
  [{ name: 'factor', type: 'vec4', default: [1, 1, 1, 1] }],
  [
    { name: 'factor', type: 'f32', default: 0.75 },
    { name: 'extra', type: 'f32' },
  ],
] as readonly (readonly ParamSchemaEntry[])[])('preserves a distinct authored or merged schema: %j', (...snapshotSchema) => {
  const f = fixture([{ name: 'factor', type: 'f32', default: 0.75 }], snapshotSchema);
  const accepted = f.receiver.accept(f.packet, f.assets).unwrap();
  expect(accepted.frame.renderables[0]?.material.materialParamSchema).toBe(f.copied);
  expect(getAdmittedParamSchemaInterface(f.copied)).toBeUndefined();
  f.receiver.dispose();
  f.publisher.dispose();
});

it('retains the program schema while accepting new values and transform-only publications', () => {
  const f = fixture([{ name: 'factor', type: 'f32', default: 0.75 }]);
  const accepted = f.receiver.accept(f.packet, f.assets).unwrap();
  const first = accepted.frame.renderables[0]?.material;
  const next = structuredClone({
    ...f.packet,
    base: 1,
    revision: 2,
    baseline: false,
    programs: [],
  });
  for (const row of next.templates) row.snapshot.material.paramSnapshot.factor = 0.5;
  const changed = f.receiver.accept(next, f.assets).unwrap();
  const second = changed.frame.renderables[0]?.material;
  expect(second?.paramSnapshot?.factor).toBe(0.5);
  expect(first?.paramSnapshot?.factor).toBe(0.25);
  expect(second?.materialParamSchema).toBe(first?.materialParamSchema);
  expect(f.assets.shaderRegistry.paramSchemaProjectionStats()).toEqual({
    admissions: 2,
    derivations: 0,
    projections: 2,
  });
  const moved = f.receiver
    .accept(
      {
        ...next,
        base: 2,
        revision: 3,
        templates: [],
        upserts: new Uint32Array(),
      },
      f.assets,
    )
    .unwrap();
  expect(moved.frame.renderables).toHaveLength(0);
  expect(f.receiver.snapshot(moved).frame.renderables[0]?.material).toBe(second);
  f.receiver.dispose();
  f.publisher.dispose();
});

it.each([
  'shape',
  'epoch',
] as const)('does not install programs from a publication rejected for %s', (reason) => {
  const f = fixture([{ name: 'factor', type: 'f32' }]);
  const malformed =
    reason === 'shape'
      ? { ...f.packet, transformEntities: new Uint32Array() }
      : { ...f.packet, epoch: f.packet.epoch + 1 };
  expect(f.receiver.accept(malformed, f.assets).ok).toBe(false);
  expect(f.assets.shaderRegistry.paramSchemaProjectionStats().admissions).toBe(0);
  expect(f.receiver.accept(f.packet, f.assets).ok).toBe(true);
  f.receiver.dispose();
  f.publisher.dispose();
});

it('does not install programs when target descriptor admission fails', () => {
  const f = fixture([{ name: 'factor', type: 'f32' }]);
  const host = createRenderTargetHost();
  const receiver = new RenderPublicationReceiver(f.packet, host);
  const packet = {
    ...f.packet,
    targets: [
      {
        id: 1,
        token: {} as RenderPublication['targets'][number]['token'],
        descriptor: {
          shape: '2d',
          width: 0,
          height: 32,
          format: 'rgba8unorm',
          mipLevels: 1,
          sampleCount: 1,
          sampled: true,
          readback: false,
        },
      },
    ],
  } satisfies RenderPublication;
  expect(() => receiver.accept(packet, f.assets)).toThrow();
  expect(f.assets.shaderRegistry.paramSchemaProjectionStats().admissions).toBe(0);
  receiver.dispose();
  host.dispose();
  f.receiver.dispose();
  f.publisher.dispose();
});

it('preserves accepted resources and revision when program validation fails, then retries', () => {
  const f = fixture([{ name: 'factor', type: 'f32' }]);
  const accepted = f.receiver.accept(f.packet, f.assets).unwrap();
  const asset = f.packet.assets[0];
  if (asset === undefined) throw new Error('Missing fixture asset');
  const original = accepted.resources.resolveAsset(asset.handle).unwrap();
  const programs = f.packet.programs.map((row, index) =>
    index === 0 ? { ...row, shader: { ...row.shader, source: 'conflict' } } : row,
  );
  const rejected = {
    ...f.packet,
    base: 1,
    revision: 2,
    baseline: false,
    time: { ...f.packet.time, elapsed: 123 },
    programs,
    assets: f.packet.assets.map((row) => ({ ...row, value: { ...row.value } })),
  } satisfies RenderPublication;
  expect(() => f.receiver.accept(rejected, f.assets)).toThrow('conflicting immutable shader');
  expect(accepted.resources.revision).toBe(1);
  expect(accepted.resources.time).toBe(f.packet.time);
  expect(accepted.resources.resolveAsset(asset.handle).unwrap()).toBe(original);
  const corrected = f.receiver.accept({ ...rejected, programs: f.packet.programs }, f.assets);
  expect(corrected.ok).toBe(true);
  expect(accepted.resources.revision).toBe(2);
  f.receiver.dispose();
  f.publisher.dispose();
});

it('does not collapse distinct numeric defaults during schema admission', () => {
  const f = fixture(
    [{ name: 'factor', type: 'f32', default: 0 }],
    [{ name: 'factor', type: 'f32', default: -0 }],
  );
  const accepted = f.receiver.accept(f.packet, f.assets).unwrap();
  expect(accepted.frame.renderables[0]?.material.materialParamSchema).toBe(f.copied);
  const first = accepted.frame.renderables[0]?.material.materialParamSchema?.[0];
  expect(Object.is(first !== undefined && 'default' in first ? first.default : undefined, -0)).toBe(
    true,
  );
  f.receiver.dispose();
  f.publisher.dispose();
});

it('rebinds shared received schemas without merging distinct material values or programs', () => {
  const f = fixture([{ name: 'factor', type: 'f32', default: 0.75 }]);
  const first = f.packet.templates[0];
  if (first === undefined) throw new Error('Missing template');
  const material = first.snapshot.material;
  const received = ownReceivedPublicationMaterials({
    ...f.packet,
    templates: [
      {
        ...first,
        snapshot: {
          ...first.snapshot,
          materials: [
            material,
            { ...material, paramSnapshot: { factor: 0.5 } },
            { ...material, materialShaderId: 'game::other' },
            { ...material, paramSnapshot: { factor: 1 } },
          ],
        },
      },
    ],
  });
  installPublicationPrograms(f.assets, f.packet.programs);
  f.assets.shaderRegistry.installMaterialArtifact('game::other', {
    source: '',
    paramSchema: [{ name: 'factor', type: 'f32', default: 0.25 }],
  });
  const snapshot = received.templates[0]?.snapshot;
  if (snapshot === undefined) throw new Error('Missing received template');
  const canonical = f.assets.shaderRegistry
    .findMaterialArtifact('game::forward')
    .unwrap().paramSchema;
  const rebound = publicationMaterialSchemaRebinder(f.assets.shaderRegistry)(snapshot);
  expect(rebound.materials.map((row) => row.paramSnapshot?.factor)).toEqual([0.25, 0.5, 0.25, 1]);
  expect(rebound.materials[0]?.materialParamSchema).toBe(canonical);
  expect(rebound.materials[1]?.materialParamSchema).toBe(canonical);
  expect(rebound.materials[2]).toBe(snapshot.materials[2]);
  expect(rebound.materials[3]?.materialParamSchema).toBe(canonical);
  expect(rebound.materials[0]).not.toBe(rebound.materials[1]);
  f.receiver.dispose();
  f.publisher.dispose();
});

it('observes changed defaults on a shared mutable schema between raw material rows', () => {
  const f = fixture([{ name: 'factor', type: 'f32', default: 0.75 }]);
  installPublicationPrograms(f.assets, f.packet.programs);
  const original = f.packet.templates[0]?.snapshot;
  if (original === undefined) throw new Error('Missing template');
  const field = { name: 'factor', type: 'f32' as const, default: 0.75 };
  const schema = [field];
  const rebind = publicationMaterialSchemaRebinder(f.assets.shaderRegistry);
  const row = () => {
    const material = { ...original.material, materialParamSchema: schema };
    return { material, materials: [material] };
  };
  const canonical = f.assets.shaderRegistry
    .findMaterialArtifact('game::forward')
    .unwrap().paramSchema;
  expect(rebind(row()).material.materialParamSchema).toBe(canonical);
  field.default = 0.5;
  expect(rebind(row()).material.materialParamSchema).toBe(schema);
  field.default = 0.75;
  expect(rebind(row()).material.materialParamSchema).toBe(canonical);
  f.receiver.dispose();
  f.publisher.dispose();
});

it.each([
  ['forgeax::default-standard-pbr', STANDARD_PIPELINE_PARAM_SCHEMA],
  ['forgeax::sprite', DEFAULT_SPRITE_PARAM_SCHEMA],
] as const)('keeps the canonical built-in ABI admitted across native publication: %s', (id, schema) => {
  expect(getAdmittedParamSchemaInterface(schema)).toBeDefined();
  const f = fixture(schema, schema, id);
  const accepted = f.receiver.accept(f.packet, f.assets).unwrap();
  const owned = f.assets.shaderRegistry.findMaterialArtifact(id).unwrap().paramSchema;
  expect(accepted.frame.renderables[0]?.material.materialParamSchema).toBe(owned);
  expect(owned).toEqual(schema);
  f.receiver.dispose();
  f.publisher.dispose();
});
