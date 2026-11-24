import { SDF_SCENE_TEXTURE_READ_WGSL } from '../sdf-scene-texture-wgsl';
import { SDF_SURFACE_POOL_WGSL } from '../sdf-surface-pool-wgsl';
import { surfacePoolCases } from './sdf-surface-pool.fixture';

/** Authored transport/metadata only, not qualified triangle geometry. */
export interface SceneTextureCase {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly words: Uint32Array;
  readonly source: Uint32Array;
  readonly row: number;
  readonly expected: readonly number[];
}
function positive(name: string, row = 0): SceneTextureCase {
  const packet = surfacePoolCases()[0];
  if (!packet) throw Error('Authored source packet missing');
  const words = new Uint32Array(192).fill(0xdeadbeef);
  words.set([0x46585354, 1, 7, 1, 16, 72, 88, 89, 1, 36, 8, 6, 177, 0, 0, 0]);
  words.set(packet.instances, 16);
  words.set(packet.fields, 88);
  words[16] = 1;
  return {
    name,
    width: 8,
    height: 6,
    words,
    source: new Uint32Array([72, 89, 1, 7]),
    row,
    expected: [
      1,
      2,
      1,
      89,
      0x53534650,
      0xffffffff,
      0,
      1,
      7,
      9,
      0,
      0,
      1,
      52,
      88,
      row === 0 ? 1 : 0,
      0,
      0,
      0,
      0,
      1,
      1,
      1,
      0,
    ],
  };
}
function unavailable(row: SceneTextureCase): SceneTextureCase {
  const expected = new Array<number>(24).fill(0);
  expected[22] = 1;
  return { ...row, expected };
}
export function sceneTextureCases(): SceneTextureCase[] {
  const rows = [
    positive('qualified-transport-row0'),
    positive('raw-capacity-is-not-candidate-highwater', 1),
  ];
  const full = positive('full-highwater-row1', 1);
  full.words[8] = 2;
  full.source[2] = 2;
  const fullExpected = [...full.expected];
  fullExpected[2] = 2;
  fullExpected[15] = 1;
  fullExpected[21] = 2;
  rows.push({ ...full, expected: fullExpected });
  const zero = positive('zero-highwater-retains-raw-capacity');
  zero.words[8] = 0;
  zero.source[2] = 0;
  const zeroExpected = [...zero.expected];
  zeroExpected[2] = 0;
  zeroExpected[15] = 0;
  zeroExpected[21] = 0;
  rows.push({ ...zero, expected: zeroExpected });
  const empty = positive('accepted-empty-canonical-pools');
  empty.words.fill(0xdeadbeef);
  empty.words.set([0x46585354, 1, 7, 1, 16, 0, 16, 0, 0, 36, 8, 6, 16, 0, 0, 0]);
  empty.source.set([0, 0, 0, 7]);
  const emptyExpected = new Array<number>(24).fill(0);
  emptyExpected[0] = 1;
  emptyExpected[20] = 1;
  emptyExpected[22] = 1;
  rows.push({ ...empty, expected: emptyExpected });
  for (const [name, word, value] of [
    ['unknown-magic', 0, 0],
    ['unknown-version', 1, 2],
    ['stale-header-epoch', 2, 6],
    ['unpublished-header', 3, 0],
    ['unknown-ready-flag', 3, 2],
    ['wrong-instance-start', 4, 0],
    ['wrong-instance-source-count', 5, 36],
    ['wrong-field-start', 6, 92],
    ['wrong-field-source-count', 7, 88],
    ['wrong-row-limit', 8, 0],
    ['wrong-canonical-stride', 9, 20],
    ['wrong-width', 10, 16],
    ['wrong-height', 11, 3],
    ['wrong-logical-word-count', 12, 178],
    ['reserved-word13', 13, 1],
    ['reserved-word14', 14, 1],
    ['reserved-word15', 15, 1],
  ] as const) {
    const changed = positive(name);
    changed.words[word] = value;
    rows.push(unavailable(changed));
  }
  for (const [name, word, value] of [
    ['unaccepted-owner-epoch', 3, 0],
    ['stale-expected-epoch', 3, 8],
    ['different-canonical-instance-span', 0, 36],
    ['different-canonical-field-span', 1, 90],
    ['different-canonical-highwater', 2, 2],
  ] as const) {
    const changed = positive(name);
    changed.source[word] = value;
    rows.push(unavailable(changed));
  }
  const padding = positive('self-consistent-header-lies-about-field-padding');
  padding.words[7] = 104;
  padding.words[12] = 192;
  rows.push(unavailable(padding));
  const truncated = positive('logical-end-past-real-texture');
  truncated.words[11] = 5;
  rows.push(unavailable({ ...truncated, height: 5, words: truncated.words.slice(0, 160) }));
  const unaligned = positive('owner-and-header-agree-on-invalid-stride');
  unaligned.source[0] = 73;
  unaligned.words[5] = 73;
  unaligned.words[6] = 89;
  unaligned.words[12] = 178;
  rows.push(unavailable(unaligned));
  const highwater = positive('owner-and-header-agree-on-row-overflow');
  highwater.source[2] = 3;
  highwater.words[8] = 3;
  rows.push(unavailable(highwater));
  const address = positive('instance-end-address-wrap');
  address.source[0] = 0xfffffffc;
  address.source[1] = 0;
  address.words[5] = 0xfffffffc;
  address.words[6] = 12;
  address.words[7] = 0;
  address.words[12] = 12;
  rows.push(unavailable(address));
  const fieldAddress = positive('field-end-address-wrap');
  fieldAddress.source[1] = 0xfffffff0;
  fieldAddress.words[7] = 0xfffffff0;
  fieldAddress.words[12] = 72;
  rows.push(unavailable(fieldAddress));
  return rows;
}
const adapter = `
struct SceneReaderSettings { expected:vec4u, selected:vec4u }
@group(0) @binding(0) var sdfSceneTexture:texture_2d<u32>;
@group(0) @binding(1) var<uniform> readerSettings:SceneReaderSettings;
@group(0) @binding(2) var<storage,read_write> readerOutput:array<vec4u>;
var<private> expectedReads:u32;
fn sdfSceneExpected()->vec4u{expectedReads+=1u;return readerSettings.expected;}
`;
const main = `
@compute @workgroup_size(1) fn main(){
 let view=sdfSceneView();let packet=sdfSurfacePacket(0u);let first=readerSettings.selected.x*6u;
 var candidate=0u;
 if(readerSettings.selected.y<sdfSceneRowLimit()){candidate=sdfSurfacePacket(readerSettings.selected.y).valid;}
 readerOutput[first]=vec4u(view.valid,sdfInstanceRowCount(),sdfSceneRowLimit(),sdfFieldWordCount());
 readerOutput[first+1u]=vec4u(sdfFieldWord(0u),sdfFieldWord(88u),sdfFieldWord(89u),sdfInstanceWord(0u,0u));
 readerOutput[first+2u]=vec4u(sdfInstanceWord(0u,16u),sdfInstanceWord(1u,16u),sdfInstanceWord(2u,0u),sdfInstanceWord(0u,36u));
 readerOutput[first+3u]=vec4u(packet.valid,packet.meshRegion,candidate);
 readerOutput[first+4u]=vec4u(sdfSceneWord(16u+readerSettings.expected.x+readerSettings.expected.y),sdfSceneWord(0xffffffffu),sdfFieldWord(52u),sdfInstanceWord(1u,0u));
 let again=sdfSceneView();
 readerOutput[first+5u]=vec4u(again.valid,sdfSceneRowLimit(),expectedReads,0x51df0000u|readerSettings.selected.x);
}`;
export function sceneTextureReaderKernel(fragment = SDF_SCENE_TEXTURE_READ_WGSL) {
  return `${adapter}\n${fragment}\n${SDF_SURFACE_POOL_WGSL}\n${main}`;
}
/** The production projection UBO's first vector is the independent source tuple.
 * Its second vector stays projection shape; the single test receiver is literal. */
export function boundSceneTextureReaderKernel() {
  return sceneTextureReaderKernel()
    .replaceAll('readerSettings.selected.x', '0u')
    .replaceAll('readerSettings.selected.y', '0u');
}
/** Observe the same production word functions before and after the explicit
 * per-invocation header initialization. No replacement CPU decoder. */
export function sceneTextureInitializationKernel() {
  return `${adapter}\n${SDF_SCENE_TEXTURE_READ_WGSL}\n${SDF_SURFACE_POOL_WGSL}\n
@compute @workgroup_size(1) fn main(){
 let first=readerSettings.selected.x*6u;
 readerOutput[first]=vec4u(sdfFieldWordCount(),sdfInstanceRowCount(),sdfSceneRowLimit(),expectedReads);
 readerOutput[first+1u]=vec4u(sdfFieldWord(0u),sdfInstanceWord(0u,0u),sdfSceneWord(0u),expectedReads);
 let view=sdfSceneView();let packet=sdfSurfacePacket(0u);
 readerOutput[first+2u]=vec4u(view.valid,sdfInstanceRowCount(),sdfSceneRowLimit(),sdfFieldWordCount());
 readerOutput[first+3u]=vec4u(sdfFieldWord(0u),sdfFieldWord(88u),sdfFieldWord(89u),sdfInstanceWord(0u,0u));
 readerOutput[first+4u]=vec4u(sdfInstanceWord(0u,16u),sdfInstanceWord(1u,16u),sdfInstanceWord(2u,0u),sdfInstanceWord(0u,36u));
 readerOutput[first+5u]=vec4u(packet.valid,packet.meshRegion.x,expectedReads,0x51df0000u|readerSettings.selected.x);
}`;
}
export function sceneTextureInitializationExpected(rows: readonly SceneTextureCase[]) {
  return Uint32Array.from(
    rows.flatMap((row, index) => [
      ...new Array<number>(8).fill(0),
      ...row.expected.slice(0, 12),
      row.expected[12] ?? 0,
      row.expected[13] ?? 0,
      1,
      0x51df0000 | index,
    ]),
  );
}
export function sceneTextureReaderVariants() {
  const replace = (before: string, after: string) => {
    if (SDF_SCENE_TEXTURE_READ_WGSL.split(before).length !== 2)
      throw Error('Unique reader mutation required');
    return SDF_SCENE_TEXTURE_READ_WGSL.replace(before, after);
  };
  return [
    { name: 'reader', negative: false, source: sceneTextureReaderKernel() },
    {
      name: 'epoch-ignored',
      negative: true,
      source: sceneTextureReaderKernel(replace('u,expected.w,1u)', 'u,tag.z,1u)')),
    },
    {
      name: 'self-described-padding',
      negative: true,
      source: sceneTextureReaderKernel(replace('spans.w!=expected.y ||', 'false ||')),
    },
    {
      name: 'capacity-is-highwater',
      negative: true,
      source: sceneTextureReaderKernel(
        replace(
          'fn sdfSceneRowLimit()->u32{return sdfSceneHeaderView.rowLimit;}',
          'fn sdfSceneRowLimit()->u32{return sdfInstanceRowCount();}',
        ),
      ),
    },
  ];
}
export function sceneTextureExpected(rows: readonly SceneTextureCase[]) {
  return Uint32Array.from(
    rows.flatMap((row, index) =>
      row.expected.map((word, at) => (at === 23 ? 0x51df0000 | index : word)),
    ),
  );
}
