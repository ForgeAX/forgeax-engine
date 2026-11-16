import { readFileSync } from 'node:fs';
import { WATER_DEFORMATION_INPUTS } from '@forgeax/engine-types';
import { continuityInput } from '../../../water/src/__tests__/water-mesh-continuity.fixture.js';
import { buildWaterMeshView } from '../../../water/src/water-mesh.js';
export function continuityShaderImports() {
  const root = new URL('../', import.meta.url);
  const imports = Object.fromEntries(
    [
      'water-waves',
      'water-deformation-input',
      'water-deformation-default',
      'water-transition-continuity',
    ].map((name) => {
      const source = readFileSync(new URL(`${name}.wgsl`, root), 'utf8');
      const module = /^#define_import_path\s+(\S+)/m.exec(source)?.[1];
      if (!module) throw Error('missing production module');
      return [module, source];
    }),
  );
  imports['forgeax_material::water_deformation_v1'] =
    `#define_import_path forgeax_material::water_deformation_v1
struct WaterDeformationInput { ${WATER_DEFORMATION_INPUTS.map((f) => `${f.name}: ${f.type},`).join('\n')} }
struct WaterDeformationOutput {currentPositionM:vec3<f32>, previousPositionM:vec3<f32>, currentNormalYUp:vec3<f32>,previousNormalYUp:vec3<f32>,waterMask:f32,bodyRenderIndex:u32}`;
  imports['forgeax_material::parameters'] = `#define_import_path forgeax_material::parameters
struct Parameters {maximumFlowVelocityMPerSec:f32,waveVelocityMaskThresholdMPerSec:f32,pad:vec2<f32>}
@group(1) @binding(0) var<uniform> material:Parameters;`;
  return imports;
}
export const continuityShaderDefines = {
  WATER_DEFAULT_DEFORMATION_AVAILABLE: true,
  WATER_ENABLE_WAVES: false,
  WATER_TRANSITION_AVAILABLE: true,
  WATER_TRANSITION_OCEAN: true,
  WATER_TRANSITION_LAKE: false,
  WATER_HEIGHT_MAPPING_AVAILABLE: true,
  WATER_USE_FIXED_HEIGHT: true,
  WATER_USE_FIXED_DEPTH: true,
  WATER_USE_FIXED_VELOCITY: true,
  WATER_USE_INFO: false,
  WATER_USE_BAKED_SIMULATION: false,
  WATER_BAKED_HEIGHT_DEPTH_AVAILABLE: false,
  WATER_SHALLOW_SIMULATION: false,
  WATER_OCEAN_PATCH: false,
  WATER_VERTEX_FLOW_AVAILABLE: false,
};
export const continuityComputeSource = `
#import forgeax_material::water_deformation_input::{waterDeformationInput}
#import forgeax_material::water_deformation_default::{deform_water_vertex}
#import forgeax_material::water_transition_continuity::{waterMeshTransitionContinuity,waterMeshContinuityWeight}
#import forgeax_material::water_waves::{waterMeshTileVertex,waterBodyVelocity,waterWaveDepthAt,evaluateWaterWavesForward,waterBodyData,waterWrappedPhase}
@group(0) @binding(0) var<storage,read_write> result:array<vec4<f32>>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3<u32>){
 var grid=vec2<f32>(0.0);
 if(id.x==0u){grid=vec2<f32>(0.375,0.25);}
 if(id.x==1u){grid=vec2<f32>(0.375,0.375);}
 if(id.x==2u){grid=vec2<f32>(0.5,0.25);}
 if(id.x==3u){grid=vec2<f32>(0.4,0.275);}
 let tile=waterMeshTileVertex(vec3<f32>(grid.x,0.0,grid.y),0u);
 let current=tile.position;let previous=current-vec3<f32>(0.5,0.0,0.0);
 let input=waterDeformationInput(0u,1u,current,previous,vec3<f32>(0.0,1.0,0.0),vec3<f32>(0.0),tile.waveRelativeXZ,0u,vec2<f32>(0.0));
 let original=deform_water_vertex(input);
 let joined=waterMeshTransitionContinuity(input,original,0u,grid);
 let depth=waterWaveDepthAt(0u,current.xz,vec3<f32>(0.0));
 let reference=evaluateWaterWavesForward(1u,input.waveRelativeXZ,depth.x,input.timeSeconds);
 let offset=id.x*8u;
 result[offset]=vec4<f32>(joined.currentPositionM,waterMeshContinuityWeight(0u,grid));
 result[offset+1u]=vec4<f32>(joined.previousPositionM,input.prevTimeSeconds);
 result[offset+2u]=vec4<f32>(original.currentPositionM,depth.x);
 result[offset+3u]=vec4<f32>(vec3<f32>(current.x,waterBodyData[1u].tileMeta.z,current.z)+reference.displacement,input.timeSeconds);
 result[offset+4u]=vec4<f32>(waterBodyVelocity(0u,joined.currentPositionM.xz,vec2<f32>(0.0)),f32(input.bodyRenderIndex),f32(input.waveBodyRenderIndex));
 result[offset+5u]=vec4<f32>(joined.currentNormalYUp,0.0);
 result[offset+6u]=vec4<f32>(joined.previousNormalYUp,0.0);
 let previousDepth=waterWaveDepthAt(0u,previous.xz,vec3<f32>(0.0));
 let previousWave=evaluateWaterWavesForward(1u,waterWrappedPhase(1u,input.waveRelativeXZ+previous.xz-current.xz),previousDepth.x,input.prevTimeSeconds);
 result[offset+7u]=vec4<f32>(vec3<f32>(previous.x,waterBodyData[1u].tileMeta.z,previous.z)+previousWave.displacement,0.0);
}`;
export function continuityTilePayload(enabled = true) {
  const mesh = buildWaterMeshView(continuityInput(enabled), {
    viewId: 'dawn',
    observerM: [8, 8, 8],
  }).unwrap();
  const draw = mesh.buckets
    .flatMap((b) => b.ownerDraws)
    .find(
      (d) => d.ownerGuid === 'river' && d.instances.some((t) => t.transitionBodyGuid === 'ocean'),
    );
  if (!draw) throw Error('missing production transition draw');
  const bytes = new Uint8Array(draw.instanceBytes.byteLength + draw.coverageBytes.byteLength);
  bytes.set(draw.instanceBytes);
  bytes.set(draw.coverageBytes, draw.instanceBytes.byteLength);
  const data = new DataView(bytes.buffer);
  for (let i = 0; i < draw.instances.length; i++) data.setUint32(i * 96 + 32, 2, true);
  return bytes;
}

/** The production tile ABI with nonzero first-level morph, close to the observer. */
export function continuityMorphCase(heightMorph01: number) {
  const mesh = buildWaterMeshView(continuityInput(false), {
    viewId: 'morph-parity',
    observerM: [8, 8, 8],
  }).unwrap();
  const original = mesh.instances[0];
  if (original === undefined) throw new Error('Missing production tile');
  const tile = {
    ...original,
    originXZ: [0, 0] as const,
    extentXZ: [16, 16] as const,
    quadsPerEdge: 16,
    lod0: 0,
    maxMorphLod: 1,
    lodScaleM: 64,
    cameraRelativeXZ: [1, 0] as const,
    heightMorph01,
    shouldMorph: true,
  };
  const bytes = mesh.instanceBytes.slice(0, 96);
  const data = new DataView(bytes.buffer);
  data.setFloat32(0, 0, true);
  data.setFloat32(4, 0, true);
  data.setFloat32(8, 16, true);
  data.setFloat32(12, 16, true);
  data.setUint32(36, tile.lod0, true);
  data.setFloat32(44, tile.lodScaleM, true);
  data.setUint16(58, 2 | (Math.round(heightMorph01 * 8191) << 3), true);
  data.setUint32(60, tile.quadsPerEdge, true);
  data.setFloat32(80, tile.cameraRelativeXZ[0], true);
  data.setFloat32(84, tile.cameraRelativeXZ[1], true);
  data.setUint32(88, tile.maxMorphLod, true);
  return { tile, bytes };
}
export const continuityMorphComputeSource = `
#import forgeax_material::water_waves::{waterMeshTileVertex}
@group(0) @binding(0) var<storage,read_write> result:array<vec4<f32>>;
@compute @workgroup_size(1) fn main(){
 let vertex=waterMeshTileVertex(vec3<f32>(1.0/16.0,0.0,0.0),0u);
 result[0]=vec4<f32>(vertex.position,1.0);
}`;
