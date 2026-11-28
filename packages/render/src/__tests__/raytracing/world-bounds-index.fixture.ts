import { mkdirSync, writeFileSync } from 'node:fs';
import { buildVisibilityDistanceField, createBoxGeometry } from '@forgeax/engine-geometry';
import { encodePng } from '@forgeax/engine-image/png';
import type { Buffer, RhiDevice } from '@forgeax/engine-rhi';
import { SDF_SURFACE_POOL_LAYOUT } from '@forgeax/engine-shader';
import { ok } from '@forgeax/engine-types';
import { adoptFieldEdit, type FieldEdit, FieldEditState } from '../../raytracing/field-edit';
import { GLOBAL_SDF_COMPOSE_WGSL, packGlobalSdfComposition } from '../../raytracing/global-sdf';
import { writeFieldEdit } from '../../raytracing/irradiance-field-edit';
import { worldTraversalWgsl } from '../../raytracing/world-traversal';

const COUNT = 128;
const CAPACITY = 1024;
const OUTPUT_VECTORS = 6;
type V = readonly [number, number, number];
interface Probe {
  readonly name: string;
  readonly point: V;
  readonly normal: V;
  readonly status: number;
  readonly id: number;
}
interface Variant {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly bindingSize?: number;
  readonly instancesSize?: number;
  readonly edit?: 'apply' | 'omit-disable' | 'small';
}
interface EditWrite {
  readonly target: 'bounds' | 'instances' | 'fields' | 'settings';
  readonly offset: number;
  readonly bytes: readonly number[];
}

// Record the real edit owner, including its inverse/scales and ordering. Only
// the RHI transport is intercepted; these exact bytes are replayed on the GPU.
function recordMove(
  composition: Extract<ReturnType<typeof packGlobalSdfComposition>, { ok: true }>['value'],
  sources: Parameters<typeof packGlobalSdfComposition>[0],
  destination: readonly [number, number],
): EditWrite[] {
  const bounds = {} as Buffer,
    instances = {} as Buffer,
    fields = {} as Buffer,
    settings = {} as Buffer,
    writes: EditWrite[] = [];
  const device = {
    queue: {
      writeBuffer(target: Buffer, offset: number, bytes: Uint8Array) {
        if (target !== bounds && target !== instances && target !== fields && target !== settings)
          throw Error('Unexpected edit target');
        writes.push({
          target:
            target === bounds
              ? 'bounds'
              : target === instances
                ? 'instances'
                : target === settings
                  ? 'settings'
                  : 'fields',
          offset,
          bytes: [...bytes],
        });
        return ok(undefined);
      },
    },
  } as unknown as RhiDevice;
  const source = sources[5];
  if (!source) throw Error('The canonical moving row is required');
  const from = Float32Array.from(source.transform),
    to = from.slice();
  to[12] = destination[0];
  to[13] = destination[1];
  const edit: FieldEdit = {
    moved: [
      { id: 'row-5', index: 5, from, to, local: { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] } },
    ],
    removed: [],
    added: [],
    rematerialized: [],
  };
  const state = new FieldEditState();
  state.set('row-5', {
    index: 5,
    geometry: [],
    material: [],
    coverage: 'opaque',
    transform: from,
    local: { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
  });
  const written = writeFieldEdit(
    device,
    {
      grid: composition.grid,
      input: {
        settings: { buffer: settings, size: composition.data.settings.byteLength },
        bounds: { buffer: bounds, size: composition.data.bounds.byteLength },
        instances: { buffer: instances, size: composition.data.instances.byteLength },
        fields: { buffer: fields, size: composition.data.fields.byteLength },
      },
      placement: {
        current: {
          instances: sources,
          instanceData: composition.data.instances,
          surface: composition.surface,
          ...(composition.boundsIndexCoverage === undefined
            ? {}
            : { boundsIndex: { sourceEpoch: 1, coverage: composition.boundsIndexCoverage } }),
        },
      },
    } as Parameters<typeof writeFieldEdit>[1],
    { capture: { has: () => false } } as unknown as Parameters<typeof writeFieldEdit>[2],
    edit,
    state,
    2,
  );
  adoptFieldEdit(state, edit);
  written.publish();
  return writes;
}

// Frozen c5dad selection and full-scan ordering with current raw-row ABI reads.
// Admission precedes decoded float loads. No index or cursor is consulted.
export const WORLD_BOUNDS_INDEX_QUERY_WGSL = `
@group(0) @binding(9) var<uniform> expectedWorld:vec4u;
fn worldSceneExpected()->vec4u{return expectedWorld;}
fn referenceCandidates(hit:SdfHit)->Candidates {
 var out=Candidates(vec4u(0,0,hit.state.x,0),vec4u(0xffffffffu));
 if(hit.state.x!=1u){return out;}
 if(!worldBoundsValid(grid.dimensionsCount.w)){out.state.y=1u;return out;}
 if(dot(hit.normal.xyz,hit.normal.xyz)<0.5){out.state.y=4u;return out;}
 let halfSpacing=grid.originSpacing.w*0.5;let world=hit.position.xyz+hit.normal.xyz*halfSpacing;
 let radius=3.0*halfSpacing;var distances=vec4f(3.402823466e+38);
 for(var i=0u;i<grid.dimensionsCount.w;i++){
  if(sdfInstanceMask(i)==0u){continue;}
  if(!sdfInstanceValid(i)){out.state.y|=1u;continue;}
  let m=sdfInstanceAt(i);
  let b=worldBoundsAt(i);let p=(m.inverse*vec4f(world,1)).xyz;
  let toBox=max(b.lo.xyz-p,p-b.hi.xyz)*b.scale.xyz;
  let boxDistance=length(max(toBox,vec3f(0)))+min(0.0,max(toBox.x,max(toBox.y,toBox.z)));
  if(boxDistance>=radius){continue;}
  if(m.field.x==0xffffffffu){out.state.y|=1u;continue;}
  let distance=max(sdfValue(m,clamp(p,b.lo.xyz,b.hi.xyz))*b.scale.w+max(boxDistance,0.0),boxDistance);
  if(abs(distance)>=radius){continue;}
  out.state.w++;var slot=4u;
  for(var k=0u;k<4u;k++){if(distance<distances[k]||(distance==distances[k]&&m.ids.x<out.ids[k])){slot=k;break;}}
  if(slot<4u){for(var k=3u;k>slot;k--){distances[k]=distances[k-1u];out.ids[k]=out.ids[k-1u];}distances[slot]=distance;out.ids[slot]=m.ids.x;}
 }
 out.state.x=min(out.state.w,4u);if(out.state.w>4u){out.state.y|=2u;}return out;
}
@group(0) @binding(6) var<storage,read> tests:array<SdfHit>;
@group(0) @binding(7) var<storage,read_write> output:array<vec4u>;
@group(0) @binding(8) var<storage,read_write> order:array<u32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid:vec3u){
 let i=gid.x;if(i>=arrayLength(&tests)){return;}let hit=tests[i];let base=i*6u;
 let actual=findCandidates(hit);let reference=referenceCandidates(hit);
 output[base]=actual.state;output[base+1u]=actual.ids;output[base+2u]=reference.state;output[base+3u]=reference.ids;
 var count=0u;var indexed=0u;var wrongFirst=0xffffffffu;var orderedFirst=0xffffffffu;
 if(worldBoundsValid(grid.dimensionsCount.w)){
  var cursor=worldBoundsCursor(hit.position.xyz+hit.normal.xyz*grid.originSpacing.w*0.5,grid.dimensionsCount.w,grid.originSpacing.w*1.5);
  indexed=cursor.x;
  if(worldBoundsCursorCount(cursor)>0u){var first=cursor;orderedFirst=worldBoundsCursorRow(&first);wrongFirst=orderedFirst;}
  if(cursor.x==1u&&bounds[5].x>0u){wrongFirst=worldBoundsWord(bounds[4].w);}
  while(worldBoundsCursorCount(cursor)>0u){order[i*grid.dimensionsCount.w+count]=worldBoundsCursorRow(&cursor);count++;}
 }
 let row=worldBoundsRowForId(hit.state.w,grid.dimensionsCount.w,grid.originSpacing.w*1.5);
 var referenceRow=0xffffffffu;if(worldBoundsValid(grid.dimensionsCount.w)){for(var r=0u;r<grid.dimensionsCount.w;r++){if(sdfInstanceWord(r,16u)==hit.state.w){referenceRow=r;break;}}}
 output[base+4u]=vec4u(count,indexed,row,referenceRow);
 var unknown=0xffffffffu;var disabled=0xffffffffu;
 if(!worldBoundsValid(grid.dimensionsCount.w)){
  unknown=traceWorld(Ray(vec3f(0),0,vec3f(0,0,1),1,vec4u(1,0,0,0)),16u,1.0).state.x;
  disabled=traceWorld(Ray(vec3f(0),0,vec3f(0,0,1),1,vec4u(0)),16u,1.0).state.x;
 }
 output[base+5u]=vec4u(unknown,disabled,wrongFirst,orderedFirst);
}`;

async function scenario() {
  const mesh = createBoxGeometry(1, 1, 1).unwrap();
  if (!mesh.indices) throw Error('Indexed geometry required');
  const field = (
    await buildVisibilityDistanceField(mesh.attributes.position as Float32Array, mesh.indices, {
      voxelSize: 0.25,
      triangleSidedness: new Uint8Array(mesh.indices.length / 3),
    })
  ).unwrap();
  const sources = Array.from({ length: COUNT }, (_, row) => {
    const point: V = row < 6 ? [0, 0, 0] : [(row % 8) * 3, (Math.floor(row / 8) % 8) * 3, 0];
    const plane = row === 63;
    const transform = [
      plane ? 50 : 1,
      0,
      0,
      0,
      0,
      plane ? 50 : 1,
      0,
      0,
      0,
      0,
      1,
      0,
      ...(plane ? [0, 0, 0] : point),
      1,
    ];
    return {
      instanceId: plane ? 500 : 1000 + row,
      geometryId: 1,
      mask: 255,
      transform,
      field:
        row === 127
          ? {
              missing: true as const,
              bounds: { min: [-0.5, -0.5, -0.5] as V, max: [0.5, 0.5, 0.5] as V },
            }
          : field,
    };
  });
  const composition = packGlobalSdfComposition(
    sources,
    {
      origin: [-1, -1, -1],
      dimensions: [5, 5, 5],
      spacing: 0.5,
      maxDistance: 1,
      coverageDistance: 0.5,
    },
    { capacity: CAPACITY, index: true, sourceEpoch: 1 },
  ).unwrap();
  const probes: Probe[] = sources.map((source, row) => ({
    name: `row-${row}`,
    point: [source.transform[12] ?? NaN, (source.transform[13] ?? NaN) - 0.25, 0.5],
    normal: [0, 1, 0],
    status: 1,
    id: source.instanceId,
  }));
  probes.push(
    {
      name: 'moved-row-5-within-cell-coverage',
      point: [0.03125, -0.25, 0.5],
      normal: [0, 1, 0],
      status: 1,
      id: 1005,
    },
    {
      name: 'moved-row-5-inside-old-domain',
      point: [15, -15.25, 0.5],
      normal: [0, 1, 0],
      status: 1,
      id: 1005,
    },
    { name: 'not-surface', point: [0, 0, 0], normal: [0, 1, 0], status: 0, id: 0xffffffff },
    { name: 'invalid-normal', point: [0, 0, 0], normal: [0, 0, 0], status: 1, id: 0xffffffff },
    {
      name: 'outside-domain',
      point: [1000, 1000, 1000],
      normal: [0, 1, 0],
      status: 1,
      id: 0xffffffff,
    },
  );
  const bytes = new Uint8Array(probes.length * 64),
    v = new DataView(bytes.buffer);
  for (const [i, p] of probes.entries()) {
    v.setUint32(i * 64, p.status, true);
    v.setUint32(i * 64 + 12, p.id, true);
    [...p.point, 1, ...p.normal, 0].forEach((value, k) => {
      v.setFloat32(i * 64 + 32 + k * 4, value, true);
    });
  }
  return {
    composition,
    probes,
    bytes,
    editWrites: recordMove(composition, sources, [15, -15]),
    smallEditWrites: recordMove(composition, sources, [0.03125, 0]),
  };
}

/** The same production edit and data as the device comparison, with a CPU
 * copy of the resulting upload spans for a focused owner regression. */
export async function recordWorldBoundsIndexMoves() {
  const { composition, editWrites, smallEditWrites } = await scenario();
  function replay(writes: readonly EditWrite[]) {
    const data = {
      bounds: composition.data.bounds.slice(),
      instances: composition.data.instances.slice(),
      fields: composition.data.fields.slice(),
      settings: composition.data.settings.slice(),
    };
    for (const write of writes) data[write.target].set(write.bytes, write.offset);
    return data;
  }
  return {
    originalBounds: composition.data.bounds,
    small: replay(smallEditWrites),
    crossing: replay(editWrites),
    smallEditWrites,
    editWrites,
  };
}

function variants(original: Uint8Array): Variant[] {
  const copy = (name: string, word: number, value: number) => {
    const bytes = original.slice();
    new DataView(bytes.buffer).setUint32(word * 4, value, true);
    return { name, bytes };
  };
  const header = new DataView(original.buffer, original.byteOffset, original.byteLength);
  const mutant = original.slice(),
    mv = new DataView(mutant.buffer),
    first = header.getUint32(68, true),
    count = header.getUint32(72, true);
  for (let i = 0; i < count; i++)
    if (mv.getUint32((first + i) * 4, true) === 0) mv.setUint32((first + i) * 4, 1, true);
  return [
    { name: 'indexed', bytes: original },
    { name: 'edited-disabled', bytes: original, edit: 'apply' },
    { name: 'edited-retained', bytes: original, edit: 'small' },
    { name: 'mutant-edit-without-disable', bytes: original, edit: 'omit-disable' },
    copy('disabled', 7, 0),
    copy('wrong-radius', 11, 0),
    copy('unaligned-index', 16, header.getUint32(64, true) + 1),
    copy('reference-overflow', 18, 262145),
    copy('bad-canonical-magic', 0, 0),
    copy('bad-canonical-count', 2, COUNT + 1),
    copy('bad-canonical-span', 5, 0),
    {
      name: 'bad-canonical-truncated-binding',
      bytes: original,
      bindingSize: original.byteLength - 16,
    },
    {
      name: 'bad-canonical-short-instance-window',
      bytes: original,
      instancesSize: (COUNT - 1) * 144,
    },
    { name: 'mutant-row-omission', bytes: mutant },
    copy('mutant-canonical-guard', 0, 0),
  ];
}

export async function runWorldBoundsIndexCases(scope: 'strict' | 'retained-move' | 'guard-mutant') {
  const start = performance.now();
  const mark = (phase: string) => {
    if (process.env.CI) {
      const elapsedMs = Math.round(performance.now() - start);
      process.stderr.write(`[world-bounds-index] ${scope} ${phase} ${elapsedMs}\n`);
    }
  };
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw Error('Real GPU required');
  const device = await adapter.requestDevice(),
    owned: GPUBuffer[] = [],
    errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const make = (bytes: Uint8Array, usage: number) => {
    const b = device.createBuffer({ size: bytes.length, usage, mappedAtCreation: true });
    new Uint8Array(b.getMappedRange()).set(bytes);
    b.unmap();
    owned.push(b);
    return b;
  };
  try {
    const input = await scenario(),
      storage = GPUBufferUsage.STORAGE,
      data = input.composition.data;
    mark('scenario-ready-ms');
    const instanceBytes = new Uint8Array(CAPACITY * 144);
    instanceBytes.set(data.instances);
    const common = [
      make(data.voxels, storage),
      make(data.settings, GPUBufferUsage.UNIFORM),
      make(instanceBytes, storage),
      make(data.fields, storage),
    ];
    const probes = make(input.bytes, storage),
      code = worldTraversalWgsl('global-sdf') + WORLD_BOUNDS_INDEX_QUERY_WGSL;
    const queryCode = scope === 'guard-mutant' ? withoutCanonicalGuard(code) : code;
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: queryCode }), entryPoint: 'main' },
    });
    mark('query-pipeline-ready-ms');
    const compose = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: {
        module: device.createShaderModule({ code: GLOBAL_SDF_COMPOSE_WGSL }),
        entryPoint: 'main',
      },
    });
    mark('compose-pipeline-ready-ms');
    const validCompose =
      scope === 'strict'
        ? await runCompose(
            device,
            make,
            compose,
            common,
            make(data.bounds, storage),
            { name: 'baseline', bytes: data.bounds },
            data.voxels.byteLength,
          )
        : undefined;
    if (validCompose) mark('baseline-readback-ms');
    const rows = [];
    const selected = variants(data.bounds).filter(({ name }) => {
      if (scope === 'guard-mutant') return name === 'mutant-canonical-guard';
      if (scope === 'retained-move') return name === 'edited-retained';
      return name !== 'edited-retained' && name !== 'mutant-canonical-guard';
    });
    for (const variant of selected) {
      rows.push(
        await runVariant(
          device,
          make,
          pipeline,
          common,
          probes,
          variant,
          input.probes.length,
          compose,
          data.voxels.byteLength,
          instanceBytes,
          data.fields,
          variant.edit === 'small' ? input.smallEditWrites : input.editWrites,
          input.composition.sourceExpected,
          data.settings,
        ),
      );
      if (rows.length === 1) mark('first-variant-readback-ms');
    }
    await device.queue.onSubmittedWorkDone();
    const { candidates, headers } = input.composition.surface;
    const result = {
      scope:
        'Actual production candidate/identity index vs frozen c5 full-roster shader reference. Complete candidate payload and canonical enumeration order; not triangle, Card radiance, frame or timing acceptance.',
      adapter: {
        vendor: adapter.info.vendor,
        device: adapter.info.device,
        description: adapter.info.description,
      },
      errors,
      probes: input.probes,
      editWrites: input.editWrites,
      smallEditWrites: input.smallEditWrites,
      candidatePayloadSpans: candidates
        ? [
            [candidates.first * 4, candidates.words * 4],
            [
              ((headers[3] ?? 0) - SDF_SURFACE_POOL_LAYOUT.candidateFooterWords) * 4,
              SDF_SURFACE_POOL_LAYOUT.candidateFooterWords * 4,
            ],
          ]
        : [],
      initialCapacity: CAPACITY,
      initialCount: COUNT,
      rows,
      baselineComposeBytes: validCompose && Array.from(validCompose.bytes),
    };
    const directory = process.env.FORGEAX_GI_SCENE_ARTIFACTS;
    if (directory) {
      mkdirSync(directory, { recursive: true });
      const suffix = scope === 'strict' ? '' : `-${scope}`;
      writeFileSync(`${directory}/bounds-index${suffix}.json`, JSON.stringify(result, null, 2));
      if (scope === 'guard-mutant')
        writeFileSync(`${directory}/bounds-index-guard-mutant.wgsl`, queryCode);
      if (validCompose) {
        writeFileSync(`${directory}/bounds-index-production.wgsl`, code);
        writeFileSync(`${directory}/bounds-index-compose.wgsl`, GLOBAL_SDF_COMPOSE_WGSL);
        writeFileSync(`${directory}/bounds-index-valid-compose.bin`, validCompose.bytes);
        writeFileSync(`${directory}/bounds-index-input.bin`, input.bytes);
        writeFileSync(`${directory}/bounds-index-pool.bin`, data.bounds);
        saveImage(directory, rows, input.probes.length);
      }
    }
    return result;
  } finally {
    for (const buffer of owned) buffer.destroy();
    device.destroy();
  }
}

async function runVariant(
  device: GPUDevice,
  make: (bytes: Uint8Array, usage: number) => GPUBuffer,
  pipeline: GPUComputePipeline,
  common: readonly GPUBuffer[],
  tests: GPUBuffer,
  variant: Variant,
  count: number,
  compose: GPUComputePipeline,
  voxelBytes: number,
  instanceBytes: Uint8Array,
  fieldBytes: Uint8Array,
  editWrites: readonly EditWrite[],
  expectedSource: readonly [number, number, number, number] | undefined,
  settingsBytes: Uint8Array,
) {
  const storage = GPUBufferUsage.STORAGE,
    bounds = make(variant.bytes, storage | GPUBufferUsage.COPY_DST),
    output = make(new Uint8Array(count * OUTPUT_VECTORS * 16), storage | GPUBufferUsage.COPY_SRC),
    order = make(new Uint8Array(count * COUNT * 4).fill(255), storage | GPUBufferUsage.COPY_SRC);
  const result = make(
      new Uint8Array(output.size),
      GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    ),
    ordered = make(new Uint8Array(order.size), GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
  const variantCommon = [...common];
  if (variant.edit) {
    const instances = make(instanceBytes, storage | GPUBufferUsage.COPY_DST);
    const fields = make(fieldBytes, storage | GPUBufferUsage.COPY_DST);
    variantCommon[2] = instances;
    variantCommon[3] = fields;
    const settings = make(settingsBytes, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    variantCommon[1] = settings;
    for (const write of editWrites) {
      if (variant.edit === 'omit-disable' && write.target === 'bounds' && write.offset === 28)
        continue;
      device.queue.writeBuffer(
        write.target === 'bounds'
          ? bounds
          : write.target === 'instances'
            ? instances
            : write.target === 'settings'
              ? settings
              : fields,
        write.offset,
        Uint8Array.from(write.bytes),
      );
    }
  }
  const produced = await runCompose(
    device,
    make,
    compose,
    variantCommon,
    bounds,
    variant,
    voxelBytes,
  );
  // The strict World query has no voxel input. A failed composition cannot
  // hide a missing World guard by replacing the query's source with unknowns.
  const entries = variantCommon.slice(1).map((buffer, index) => ({
    binding: index + 1,
    resource: {
      buffer,
      ...(index === 1 && variant.instancesSize !== undefined
        ? { size: variant.instancesSize }
        : {}),
    },
  }));
  entries.push(
    {
      binding: 4,
      resource: {
        buffer: bounds,
        ...(variant.bindingSize !== undefined ? { size: variant.bindingSize } : {}),
      },
    },
    { binding: 6, resource: { buffer: tests } },
    { binding: 7, resource: { buffer: output } },
    { binding: 8, resource: { buffer: order } },
  );
  if (!expectedSource) throw Error('Accepted producer source tuple is required');
  const expected = [...expectedSource];
  if (variant.edit) expected[3] = 2;
  entries.push({
    binding: 9,
    resource: {
      buffer: make(new Uint8Array(Uint32Array.from(expected).buffer), GPUBufferUsage.UNIFORM),
    },
  });
  const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
  const encoder = device.createCommandEncoder(),
    pass = encoder.beginComputePass({ label: `bounds-index.${variant.name}` });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, group);
  pass.dispatchWorkgroups(Math.ceil(count / 64));
  pass.end();
  encoder.copyBufferToBuffer(output, 0, result, 0, output.size);
  encoder.copyBufferToBuffer(order, 0, ordered, 0, order.size);
  device.queue.submit([encoder.finish()]);
  await result.mapAsync(GPUMapMode.READ);
  const raw = new Uint8Array(result.getMappedRange()).slice();
  result.unmap();
  await ordered.mapAsync(GPUMapMode.READ);
  const orderedRaw = new Uint8Array(ordered.getMappedRange()).slice();
  ordered.unmap();
  const words = new Uint32Array(raw.buffer),
    indices = new Uint32Array(orderedRaw.buffer),
    cases = Array.from({ length: count }, (_, i) => {
      const values = Array.from(words.slice(i * 24, (i + 1) * 24)),
        length = values[16] ?? 0,
        enumeration = Array.from(indices.slice(i * COUNT, i * COUNT + length));
      return { values, enumeration };
    });
  const directory = process.env.FORGEAX_GI_SCENE_ARTIFACTS;
  if (directory) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(`${directory}/${variant.name}.u32`, raw);
    writeFileSync(`${directory}/${variant.name}-order.u32`, orderedRaw);
    writeFileSync(`${directory}/${variant.name}-compose.bin`, produced.bytes);
  }
  return {
    name: variant.name,
    cases,
    composeBytes: Array.from(produced.bytes),
  };
}

function withoutCanonicalGuard(code: string) {
  const needle = 'if(!worldBoundsValid(grid.dimensionsCount.w)){\n  return Hit(';
  const start = code.indexOf(needle);
  if (start < 0 || code.lastIndexOf(needle) !== start)
    throw Error('Unique actual World guard required');
  const open = code.indexOf('{', start);
  let depth = 1,
    end = open + 1;
  for (; end < code.length && depth; end++) {
    if (code[end] === '{') depth++;
    if (code[end] === '}') depth--;
  }
  if (depth) throw Error('Unclosed World guard');
  return code.slice(0, start) + code.slice(end);
}

async function runCompose(
  device: GPUDevice,
  make: (bytes: Uint8Array, usage: number) => GPUBuffer,
  pipeline: GPUComputePipeline,
  common: readonly GPUBuffer[],
  bounds: GPUBuffer,
  variant: Variant,
  size: number,
) {
  const instances = common[2],
    fields = common[3],
    settings = common[1];
  if (!instances || !fields || !settings) throw Error('Complete producer bindings required');
  const voxels = make(new Uint8Array(size), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC),
    staging = make(new Uint8Array(size), GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
  const entries = [
    {
      binding: 0,
      resource: {
        buffer: instances,
        ...(variant.instancesSize !== undefined ? { size: variant.instancesSize } : {}),
      },
    },
    { binding: 1, resource: { buffer: fields } },
    {
      binding: 2,
      resource: {
        buffer: bounds,
        ...(variant.bindingSize !== undefined ? { size: variant.bindingSize } : {}),
      },
    },
    { binding: 3, resource: { buffer: settings } },
    { binding: 4, resource: { buffer: voxels } },
  ];
  const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }),
    encoder = device.createCommandEncoder(),
    pass = encoder.beginComputePass({ label: `bounds-index.${variant.name}.actual-compose` });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, group);
  pass.dispatchWorkgroups(Math.ceil(size / 16 / 64));
  pass.end();
  encoder.copyBufferToBuffer(voxels, 0, staging, 0, size);
  device.queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const bytes = new Uint8Array(staging.getMappedRange()).slice();
  staging.unmap();
  return { buffer: voxels, bytes };
}

function saveImage(
  directory: string,
  rows: readonly { name: string; cases: readonly { values: readonly number[] }[] }[],
  count: number,
) {
  const width = rows.length * 12,
    height = count * 4,
    image = new Uint8Array(width * height * 4);
  for (const [column, row] of rows.entries())
    for (const [i, item] of row.cases.entries()) {
      const equal = item.values.slice(0, 8).every((value, k) => value === item.values[k + 8]);
      const badCanonical =
        row.name.startsWith('bad-canonical') || row.name === 'mutant-canonical-guard';
      const worldCorrect = !badCanonical || (item.values[20] === 4 && item.values[21] === 0);
      const color = equal && worldCorrect ? [40, 200, 120, 255] : [255, 55, 55, 255];
      for (let y = i * 4; y < i * 4 + 4; y++)
        for (let x = column * 12; x < column * 12 + 12; x++) image.set(color, (y * width + x) * 4);
    }
  writeFileSync(
    `${directory}/bounds-index-reference-equality.png`,
    encodePng(width, height, image),
  );
}
