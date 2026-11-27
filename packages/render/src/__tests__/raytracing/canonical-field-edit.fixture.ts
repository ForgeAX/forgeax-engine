import { mkdirSync, writeFileSync } from 'node:fs';
import { buildVisibilityDistanceField, createBoxGeometry } from '@forgeax/engine-geometry';
import type { Buffer, RhiDevice } from '@forgeax/engine-rhi';
import { disposeDevice, requestAdapterFrom } from '@forgeax/engine-rhi-webgpu';
import { ok } from '@forgeax/engine-types';
import { adoptFieldEdit, type FieldEdit, FieldEditState } from '../../raytracing/field-edit';
import { packGlobalSdfComposition } from '../../raytracing/global-sdf';
import { writeFieldEdit } from '../../raytracing/irradiance-field-edit';
import type { SdfMeshInstance } from '../../raytracing/sdf-query';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const VARIANTS = [
  'production',
  'omit-invalidation',
  'omit-row-header',
  'wrong-row-header',
] as const;
type Variant = (typeof VARIANTS)[number];
type Composition = Extract<ReturnType<typeof packGlobalSdfComposition>, { ok: true }>['value'];

export async function prepareCanonicalFieldEdit() {
  const mesh = createBoxGeometry(1, 1, 1).unwrap();
  if (!mesh.indices) throw new Error('The authored indexed box is required');
  const field = (
    await buildVisibilityDistanceField(mesh.attributes.position as Float32Array, mesh.indices, {
      voxelSize: 0.25,
      triangleSidedness: new Uint8Array(mesh.indices.length / 3),
    })
  ).unwrap();
  const pose = Float32Array.from(IDENTITY);
  pose[0] = 1.3;
  const sources: SdfMeshInstance[] = [
    { instanceId: 41, geometryId: 7, mask: 255, transform: pose, field, surfaceCoverage: 'opaque' },
    {
      instanceId: 99,
      geometryId: 7,
      mask: 255,
      transform: Float32Array.from(IDENTITY),
      field,
      surfaceCoverage: 'opaque',
    },
  ];
  const composition = packGlobalSdfComposition(
    sources,
    {
      origin: [-2, -2, -2],
      dimensions: [5, 5, 5],
      spacing: 1,
      maxDistance: 2,
      coverageDistance: 0.5,
    },
    { capacity: 2, index: true, sourceEpoch: 1 },
  ).unwrap();
  // Independent simple-affine oracle: forward diag(2,1,1), x=.5 has exact
  // inverse diag(.5,1,1), x=-.25. Its residual k and b are exactly zero.
  const expectedInstances = composition.data.instances.slice();
  const inverse = Float32Array.from(IDENTITY);
  inverse[0] = 0.5;
  inverse[12] = -0.25;
  expectedInstances.set(new Uint8Array(inverse.buffer), 0);
  const expectedHeaders = composition.surface.headers.slice();
  expectedHeaders[22] = 0;
  expectedHeaders[23] = 0;
  if (!(composition.surface.headers[22] ?? 0))
    throw new Error('The initial non-exact inverse residual must be nonzero');
  return { composition, sources, expectedInstances, expectedHeaders };
}

type Prepared = Awaited<ReturnType<typeof prepareCanonicalFieldEdit>>;
function movingState(source: SdfMeshInstance) {
  const state = new FieldEditState(),
    from = Float32Array.from(source.transform),
    to = from.slice();
  to[0] = 2;
  to[12] = 0.5;
  const local = { min: [-0.5, -0.5, -0.5] as const, max: [0.5, 0.5, 0.5] as const };
  const id = '0:1:0:7:0';
  state.set(id, {
    index: 0,
    geometry: [],
    material: [],
    coverage: source.surfaceCoverage ?? 'unknown',
    transform: from,
    local,
  });
  const edit: FieldEdit = {
    moved: [{ id, index: 0, from, to, local }],
    added: [],
    removed: [],
    rematerialized: [],
  };
  return { state, edit };
}

function buffers(device: RhiDevice, composition: Composition) {
  const owned: Buffer[] = [];
  const make = (bytes: Uint8Array, usage = 128 | 8 | 4) => {
    const buffer = device.createBuffer({ size: bytes.byteLength, usage }).unwrap();
    owned.push(buffer);
    device.queue.writeBuffer(buffer, 0, bytes).unwrap();
    return { buffer, size: bytes.byteLength };
  };
  const input = {
    settings: make(composition.data.settings, 64 | 8 | 4),
    instances: make(composition.data.instances),
    fields: make(composition.data.fields),
    bounds: make(composition.data.bounds),
  };
  const headerBytes = composition.surface.headers.byteLength;
  const count = input.instances.size + headerBytes + input.bounds.size;
  const readback = device.createBuffer({ size: count, usage: 1 | 8 }).unwrap();
  owned.push(readback);
  return { input, owned, readback, count, headerBytes };
}

async function readPhase(device: RhiDevice, allocation: ReturnType<typeof buffers>) {
  const { input, readback, count, headerBytes } = allocation;
  const encoder = device
    .createCommandEncoder({ label: 'canonical-field-edit.actual-row-readback' })
    .unwrap();
  encoder.copyBufferToBuffer(input.instances.buffer, 0, readback, 0, input.instances.size);
  encoder.copyBufferToBuffer(input.fields.buffer, 0, readback, input.instances.size, headerBytes);
  encoder.copyBufferToBuffer(
    input.bounds.buffer,
    0,
    readback,
    input.instances.size + headerBytes,
    input.bounds.size,
  );
  device.queue.submit([encoder.finish().unwrap()]).unwrap();
  const mapped = (await readback.mapAsync(1, 0, count)).unwrap();
  const raw = new Uint8Array(mapped.getMappedRange(0, count).unwrap().slice(0));
  mapped.unmap();
  return {
    instances: [...raw.slice(0, input.instances.size)],
    headers: [
      ...new Uint32Array(
        raw.buffer.slice(input.instances.size, input.instances.size + headerBytes),
      ),
    ],
    bounds: [...raw.slice(input.instances.size + headerBytes)],
  };
}

function controlledWriter(device: RhiDevice, fields: Buffer, variant: Variant) {
  const writes: { offset: number; target: string; bytes: number[] }[] = [];
  const writer = {
    queue: {
      writeBuffer(target: Buffer, offset: number, data: Uint8Array) {
        writes.push({ offset, target: target === fields ? 'fields' : 'other', bytes: [...data] });
        if (target === fields) {
          if (
            variant === 'omit-invalidation' &&
            offset === 0 &&
            new DataView(data.buffer, data.byteOffset).getUint32(0, true) === 0
          )
            return ok(undefined);
          if (variant === 'omit-row-header' && offset === 16) return ok(undefined);
          if (variant === 'wrong-row-header' && offset === 16) offset = 96;
        }
        return device.queue.writeBuffer(target, offset, data);
      },
    },
  } as unknown as RhiDevice;
  return { writer, writes };
}

async function variantRun(device: RhiDevice, prepared: Prepared, variant: Variant) {
  const allocation = buffers(device, prepared.composition);
  try {
    const placement = {
      current: {
        instances: prepared.sources,
        instanceData: prepared.composition.data.instances,
        surface: prepared.composition.surface,
      },
    };
    const initial = placement.current;
    const source = prepared.sources[0];
    if (!source) throw new Error('Moving source missing');
    const { state, edit } = movingState(source);
    const transport = controlledWriter(device, allocation.input.fields.buffer, variant);
    const cold = await readPhase(device, allocation);
    const written = writeFieldEdit(
      transport.writer,
      { input: allocation.input, grid: prepared.composition.grid, placement } as Parameters<
        typeof writeFieldEdit
      >[1],
      { capture: { has: () => false } } as unknown as Parameters<typeof writeFieldEdit>[2],
      edit,
      state,
      2,
    );
    const unpublished = await readPhase(device, allocation);
    const publicationHeld = placement.current === initial;
    adoptFieldEdit(state, edit);
    written.publish();
    const published = await readPhase(device, allocation);
    return {
      variant,
      cold,
      unpublished,
      published,
      publicationHeld,
      writes: transport.writes,
      previousUnchanged:
        initial.instanceData === prepared.composition.data.instances &&
        initial.surface.headers === prepared.composition.surface.headers,
    };
  } finally {
    await device.queue.onSubmittedWorkDone();
    for (const buffer of allocation.owned) device.destroyBuffer(buffer).unwrap();
  }
}

export async function runCanonicalFieldEdit() {
  const prepared = await prepareCanonicalFieldEdit();
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('A real GPU is required');
  const wrapped = (await requestAdapterFrom({ requestAdapter: async () => adapter })).unwrap();
  const device = (await wrapped.requestDevice()).unwrap();
  try {
    const rows = [];
    for (const variant of VARIANTS) rows.push(await variantRun(device, prepared, variant));
    const result = {
      scope:
        'Actual RHI row/header transport and ready ordering; no World shader, Card pixels, physical GI or timing qualification.',
      adapter: {
        vendor: adapter.info.vendor,
        device: adapter.info.device,
        description: adapter.info.description,
        architecture: adapter.info.architecture,
      },
      expectedInstances: [...prepared.expectedInstances],
      expectedHeaders: [...prepared.expectedHeaders],
      rows,
    };
    const directory = process.env.FORGEAX_GI_SCENE_ARTIFACTS;
    if (directory) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(`${directory}/canonical-field-edit.json`, JSON.stringify(result, null, 2));
    }
    return result;
  } finally {
    await device.queue.onSubmittedWorkDone();
    disposeDevice(device);
  }
}
