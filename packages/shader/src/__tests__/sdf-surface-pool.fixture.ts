import { SDF_SURFACE_POOL_WGSL } from '../sdf-surface-pool-wgsl';

/** Metadata-only packets. These authored words do not certify sampled geometry. */
export interface SurfacePoolCase {
  readonly name: string;
  readonly fields: Uint32Array;
  readonly instances: Uint32Array;
  readonly fieldCount: number;
  readonly row: number;
  readonly expected: readonly number[];
}
function authoredPool() {
  const words = new Uint32Array(89);
  words.set([0x53534650, 4, 2, 88]);
  const row = [52, 88, 1, 44, 52, 4, 0, 0, 56, 3, 68, 1, 72, 1, 80, 1, 84, 1, 0, 0];
  words.set(row, 4);
  words.set(row, 24);
  words[27] = 48;
  words.set([0, 1, 0, 0, 1, 1, 0, 0], 44);
  words[84] = 1;
  words[88] = 0xffffffff; // Real bound headroom, outside published source regions.
  return words;
}
function authoredInstances() {
  const words = new Uint32Array(72);
  words[16] = 7;
  words[19] = 255;
  words[52] = 9;
  words[55] = 255;
  return words;
}
function record(valid: boolean, row: number): readonly number[] {
  // Literal independent expected layout, not a call to the decoder or CPU packer.
  const id = row === 0 ? 7 : row === 1 ? 9 : 0,
    mask = row < 2 ? 255 : 0;
  return valid
    ? [1, 0, 0, 0, 52, 88, 52, 4, 56, 3, 68, 1, 72, 1, 80, 1, 84, 1, 0, 0, 0, id, mask, 0]
    : [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, id, mask, 0];
}
export function surfacePoolCases(): SurfacePoolCase[] {
  const create = (name: string, valid: boolean, row = 0): SurfacePoolCase => ({
    name,
    fields: authoredPool(),
    instances: authoredInstances(),
    fieldCount: 89,
    row,
    expected: record(valid, row),
  });
  const cases = [
    create('shared-row0', true),
    create('shared-row1', true, 1),
    create('row-past-capacity', false, 2),
  ];
  const eligible = create('source-lattice-prefix-eligible', true);
  eligible.fields[11] = 1;
  const eligibleExpected = [...eligible.expected];
  eligibleExpected[23] = 1;
  cases.push({ ...eligible, expected: eligibleExpected });
  const old = create('old-private-version1-not-mixed', false);
  old.fields[1] = 1;
  cases.push(old);
  const previous = create('old-private-version2-not-mixed', false);
  previous.fields[1] = 2;
  cases.push(previous);
  const v3 = create('old-private-version3-not-mixed', false);
  v3.fields[1] = 3;
  cases.push(v3);
  const hole = create('live-row1-after-hole', true, 1);
  hole.fields[6] = 0;
  hole.instances[19] = 0;
  cases.push(hole);
  const unavailable = create('disabled-row-header', false);
  unavailable.fields[6] = 0;
  cases.push(unavailable);
  for (const [name, offset, value] of [
    ['unknown-scene-version', 1, 5],
    ['capacity-overflow', 2, 0xffffffff],
    ['capacity-does-not-match-instance-allocation', 2, 1],
    ['used-words-overflow', 3, 0xffffffff],
    ['mesh-before-reserved-headers', 4, 24],
    ['mesh-after-bound-end', 5, 90],
    ['unknown-row-flags', 6, 2],
    ['missing-owned-coverage-pointer', 7, 0],
    ['unaligned-sample-span', 8, 53],
    ['zero-samples', 9, 0],
    ['subnormal-unsigned-bound', 10, 1],
    ['unknown-prefix-eligibility', 11, 2],
    ['overlapping-positions', 12, 52],
    ['vertex-count-overflow', 13, 0xffffffff],
    ['primitive-count-overflow', 15, 0xffffffff],
    ['node-count-overflow', 17, 0xffffffff],
    ['order-count-overflow', 19, 0xffffffff],
    ['missing-sidedness-words', 21, 0],
    ['infinite-relative-bound', 22, 0x7f800000],
    ['subnormal-absolute-bound', 23, 1],
    ['nonzero-unused-sidedness-tail', 84, 0x80000001],
    ['wrong-coverage-owner', 44, 1],
    ['wrong-coverage-primitive-count', 45, 2],
    ['unknown-coverage-mode', 46, 3],
    ['constant-coverage-with-payload', 47, 52],
  ] as const) {
    const changed = create(name, false);
    changed.fields[offset] = value;
    cases.push(changed);
  }
  for (const [name, unsigned, relative, absolute] of [
    ['positive-minnormal-relative3-absoluteHalf', 0x00800000, 0x40400000, 0x3f000000],
    ['positive-maxfinite-coefficients', 0x7f7fffff, 0x7f7fffff, 0x7f7fffff],
  ] as const) {
    const changed = create(name, true),
      expected = [...changed.expected];
    changed.fields[10] = unsigned;
    changed.fields[22] = relative;
    changed.fields[23] = absolute;
    expected[18] = unsigned;
    expected[19] = relative;
    expected[20] = absolute;
    cases.push({ ...changed, expected });
  }
  const truncated = create('logical-field-span-truncated', false);
  cases.push({ ...truncated, fieldCount: 87 });
  const empty = create('logical-field-span-empty', false);
  cases.push({ ...empty, fieldCount: 0 });
  return cases;
}

const settings = '@group(0) @binding(3) var<uniform> settings:vec4u;';
const output = `@group(0) @binding(2) var<storage,read_write> output:array<vec4u>;
@compute @workgroup_size(1) fn main(){
 let p=sdfSurfacePacket(settings.y);
 output[0]=vec4u(p.valid,0,0,0);
 output[1]=vec4u(p.meshRegion,p.samples);
 output[2]=vec4u(p.positions,p.triangles);
 output[3]=vec4u(p.nodes,p.order);
 output[4]=vec4u(p.sidedness,p.coefficients.xy);
 output[5]=vec4u(p.coefficients.z,sdfInstanceWord(settings.y,16u),sdfInstanceWord(settings.y,19u),p.prefixEligible);
}`;
const storageAdapter = `
@group(0) @binding(0) var<storage,read> fieldWords:array<u32>;
@group(0) @binding(1) var<storage,read> instanceWords:array<u32>;
fn sdfFieldWordCount()->u32{return min(settings.x,arrayLength(&fieldWords));}
fn sdfFieldWord(index:u32)->u32{if(index>=sdfFieldWordCount()){return 0u;}return fieldWords[index];}
fn sdfInstanceRowCount()->u32{
 let n=min(settings.z,arrayLength(&instanceWords));if(n%36u!=0u){return 0u;}return n/36u;
}
fn sdfInstanceWord(row:u32,word:u32)->u32{
 if(row>=sdfInstanceRowCount() || word>=36u){return 0u;}return instanceWords[row*36u+word];
}`;
const textureAdapter = `
@group(0) @binding(0) var sourceWords:texture_2d<u32>;
fn rawSourceWord(index:u32)->u32{
 let dims=textureDimensions(sourceWords);let texel=index/4u;
 if(texel>=dims.x*dims.y){return 0u;}
 return textureLoad(sourceWords,vec2i(i32(texel%dims.x),i32(texel/dims.x)),0)[index%4u];
}
fn sdfFieldWordCount()->u32{return settings.x;}
fn sdfFieldWord(index:u32)->u32{if(index>=sdfFieldWordCount()){return 0u;}return rawSourceWord(settings.w+index);}
fn sdfInstanceRowCount()->u32{if(settings.z%36u!=0u){return 0u;}return settings.z/36u;}
fn sdfInstanceWord(row:u32,word:u32)->u32{
 if(row>=sdfInstanceRowCount() || word>=36u){return 0u;}return rawSourceWord(row*36u+word);
}`;
export function surfacePoolKernel(kind: 'storage' | 'texture', fragment = SDF_SURFACE_POOL_WGSL) {
  return `${settings}\n${kind === 'storage' ? storageAdapter : textureAdapter}\n${fragment}\n${output}`;
}
export function surfacePoolVariants() {
  const tail = 'if((sdfFieldWord(e.x+e.y-1u)>>tail)!=0u){return sdfSurfacePacketInvalid();}';
  if (SDF_SURFACE_POOL_WGSL.split(tail).length !== 2)
    throw Error('Tail control must change exactly one actual guard');
  const wrongTail = SDF_SURFACE_POOL_WGSL.replace(tail, 'let unusedTailWasIgnored=0u;');
  const sourceCount = 'fn sdfFieldWordCount()->u32{return settings.x;}';
  const wrongPadding = surfacePoolKernel('texture').replace(
    sourceCount,
    'fn sdfFieldWordCount()->u32{return textureDimensions(sourceWords).x*textureDimensions(sourceWords).y*4u-settings.w;}',
  );
  if (wrongPadding === surfacePoolKernel('texture'))
    throw Error('Padding control did not change adapter');
  return [
    {
      name: 'storage-production',
      kind: 'storage' as const,
      source: surfacePoolKernel('storage'),
      negative: false,
    },
    {
      name: 'texture-production',
      kind: 'texture' as const,
      source: surfacePoolKernel('texture'),
      negative: false,
    },
    {
      name: 'negative-unused-tail-accepted',
      kind: 'storage' as const,
      source: surfacePoolKernel('storage', wrongTail),
      negative: true,
    },
    {
      name: 'negative-texture-padding-is-source',
      kind: 'texture' as const,
      source: wrongPadding,
      negative: true,
    },
  ];
}
