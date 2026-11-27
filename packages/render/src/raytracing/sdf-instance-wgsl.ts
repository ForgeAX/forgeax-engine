/** The storage ABI stays 144 bytes. GI surface consumers check raw normal-or-zero
 * words before sdfInstanceAt. CPU-admitted static fields retain their wider domain. */
export const SDF_INSTANCE_WORD_ACCESS_WGSL = `
struct RawInstance { words:array<vec4u,9> }
`;
const INSTANCE_ACCESSORS_WGSL = `
fn sdfInstanceRowCount() -> u32 { return arrayLength(&instances); }
fn sdfInstanceWord(row:u32,word:u32) -> u32 {
 if(row>=sdfInstanceRowCount() || word>=36u){return 0u;}
 return instances[row].words[word>>2u][word&3u];
}
`;

/** Raw transport shared with the triangle-free Screen preparation. */
export const SDF_INSTANCE_RAW_WGSL = SDF_INSTANCE_WORD_ACCESS_WGSL + INSTANCE_ACCESSORS_WGSL;

export const SDF_INSTANCE_WGSL = `${SDF_INSTANCE_WORD_ACCESS_WGSL}struct Instance { inverse:mat4x4f, ids:vec4u, field:vec4u, origin:vec4f, extent:vec4f, error:vec4f }
${INSTANCE_ACCESSORS_WGSL.slice(1)}${SDF_INSTANCE_WORD_GUARDS_WGSL}
fn sdfInstanceAt(row:u32) -> Instance {
 let raw=instances[row].words;
 return Instance(mat4x4f(bitcast<vec4f>(raw[0]),bitcast<vec4f>(raw[1]),bitcast<vec4f>(raw[2]),bitcast<vec4f>(raw[3])),
  raw[4],raw[5],bitcast<vec4f>(raw[6]),bitcast<vec4f>(raw[7]),bitcast<vec4f>(raw[8]));
}
`;

import { SDF_INSTANCE_WORD_GUARDS_WGSL } from '@forgeax/engine-shader';
