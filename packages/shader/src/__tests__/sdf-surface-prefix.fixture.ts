import { SDF_SURFACE_TRACE_WGSL } from '../sdf-surface-trace-wgsl';

/** One sample at the origin. The far triangle has exact distance 2; the near
 * triangle is outside x+y>=3, so its distance squared is at least 19/4.
 * This is authored canonical geometry, not a second scene registry. */
export function surfacePrefixInput(single = false, error = 0, code = 16384) {
  const positions = single
    ? [-16, -16, 2, 16, -16, 2, 0, 16, 2]
    : [3, 0, 0.5, 0, 3, 0.5, 3, 3, 0.5, -16, -16, 2, 16, -16, 2, 0, 16, 2];
  const indices = single ? [0, 1, 2] : [0, 1, 2, 3, 4, 5];
  const nodes = single
    ? [{ lo: [-16, -16, 2], hi: [16, 16, 2], escape: 1, leaf: 1 }]
    : [
        { lo: [-16, -16, 0.5], hi: [16, 16, 2], escape: 3, leaf: 0 },
        { lo: [0, 0, 0.5], hi: [3, 3, 0.5], escape: 2, leaf: 1 },
        { lo: [-16, -16, 2], hi: [16, 16, 2], escape: 3, leaf: 5 },
      ];
  // Scene header + one row header + its explicit V4 constant-opaque record.
  let next = 28;
  const span = (length: number) => {
    const first = next;
    next = Math.ceil((next + length) / 4) * 4;
    return first;
  };
  const samples = span(33),
    vertices = span(positions.length),
    triangles = span(indices.length),
    tree = span(nodes.length * 8),
    order = span(indices.length / 3),
    sides = span(1),
    fields = new Uint32Array(next),
    floats = new Float32Array(fields.buffer);
  fields.set([0x53534650, 4, 1, next]);
  fields.set(
    [
      28,
      next,
      1,
      24,
      samples,
      33,
      bits(error),
      1,
      vertices,
      positions.length / 3,
      triangles,
      indices.length / 3,
      tree,
      nodes.length,
      order,
      indices.length / 3,
      sides,
      1,
      0,
      0,
    ],
    4,
  );
  fields.set([0, indices.length / 3, 0, 0], 24);
  fields[samples] = 1;
  fields[samples + 1] = code & 65535;
  floats.set(positions, vertices);
  fields.set(indices, triangles);
  nodes.forEach((node, index) => {
    const at = tree + index * 8;
    floats.set(node.lo, at);
    fields[at + 3] = node.escape;
    floats.set(node.hi, at + 4);
    fields[at + 7] = node.leaf;
  });
  for (let i = 0; i < indices.length / 3; i++) fields[order + i] = i;
  const instances = new Uint32Array(36),
    values = new Float32Array(instances.buffer);
  for (const at of [0, 5, 10, 15]) values[at] = 1;
  instances.set([73, 0, 0, 255, 4, 1, 1, 1], 16);
  values[27] = 1;
  values[31] = 4;
  values[35] = 2;
  return { fields, instances, samples, tree, order };
}

export function bits(value: number): number {
  return new Uint32Array(new Float32Array([value]).buffer)[0] ?? 0;
}

/** Exact dyadic integer units of 2^-149, independent of the WGSL arithmetic. */
export function prefixDyadic(word: number): bigint {
  const exponent = (word >>> 23) & 255,
    fraction = word & 0x7fffff;
  if (exponent === 255) throw Error('Finite source required');
  const magnitude = exponent
    ? BigInt(fraction | 0x800000) << BigInt(exponent - 1)
    : BigInt(fraction);
  return word >>> 31 ? -magnitude : magnitude;
}

export const surfacePrefixKernel = `${SDF_SURFACE_TRACE_WGSL}
@group(0) @binding(0) var<storage,read> fields:array<u32>;
@group(0) @binding(1) var<storage,read> instances:array<u32>;
@group(0) @binding(2) var<storage,read> queries:array<vec4u>;
@group(0) @binding(3) var<storage,read_write> output:array<vec4u>;
fn sdfFieldWordCount()->u32{return arrayLength(&fields);}
fn sdfFieldWord(index:u32)->u32{return fields[index];}
fn sdfInstanceRowCount()->u32{return arrayLength(&instances)/36u;}
fn sdfInstanceWord(row:u32,word:u32)->u32{return instances[row*36u+word];}
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3u){
 let base=id.x*6u;if(base+5u>=arrayLength(&queries)){return;}
 let ray=SdfSurfaceRay(queries[base].xyz,queries[base+1u].xyz,
  queries[base+2u].xyz,queries[base+3u].xyz,queries[base+4u].xy,queries[base+4u].z);
 var remaining=queries[base+5u].x;let row=queries[base+5u].y;
 let hit=sdfSurfaceTraceRow(row,ray,&remaining);
 let packet=sdfSurfacePacket(row);
 let local=sdfSurfaceLocalRay(ray,sdfSurfaceInverse(row),packet.coefficients.yz);
 let prefix=sdfSurfaceRootPrefix(row,packet,local);
 output[id.x*3u]=vec4u(hit.state,hit.primitive,hit.frontFace,hit.prefixSamples);
 output[id.x*3u+1u]=vec4u(bitcast<u32>(hit.lower),bitcast<u32>(hit.upper),remaining,hit.reserved);
 output[id.x*3u+2u]=vec4u(prefix.valid,bitcast<u32>(prefix.end),prefix.samples,0u);
}`;
