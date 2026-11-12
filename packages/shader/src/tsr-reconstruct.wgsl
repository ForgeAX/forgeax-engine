@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var sceneTemporal: texture_2d<f32>;
@group(0) @binding(2) var previousColor: texture_2d<f32>;
@group(0) @binding(3) var previousTemporal: texture_2d<f32>;
@group(0) @binding(4) var previousMetadata: texture_2d<f32>;
@group(0) @binding(5) var decision: texture_2d<f32>;
@group(0) @binding(6) var secondary: texture_2d<f32>;
@group(0) @binding(7) var coverage: texture_2d<f32>;
@group(0) @binding(8) var linearSampler: sampler;
@group(0) @binding(9) var<uniform> params: TsrParams;
@group(0) @binding(10) var colorOutput: texture_storage_2d<rgba16float, write>;
@group(0) @binding(11) var temporalOutput: texture_storage_2d<rgba16float, write>;
@group(0) @binding(12) var metadataOutput: texture_storage_2d<rgba8unorm, write>;

// Cooperative read cache: 10,100 bytes, below the portable 16 KiB limit.
// Keep one coordinate guard beyond the ideal footprint: f32 UV rounding at
// phase boundaries can span nine source centers across eight output lanes.
// Every lane participates before the extent guard, including partial groups.
var<workgroup> reconstructSceneTile: array<vec4<f32>,169>;
var<workgroup> reconstructTemporalTile: array<vec4<f32>,169>;
var<workgroup> reconstructCoverageTile: array<vec4<f32>,225>;
// One exact nearest-tuple index, background bit and FP32 farthest depth per
// output column and coverage row. Center-first, strict-depth ties stay unchanged.
var<workgroup> reconstructCoverageRows: array<vec2<u32>,120>;
// An entirely hard-invalid tile needs no reductions. Zero-initialized once
// per workgroup; the raw-cache barrier publishes the participating lane votes.
var<workgroup> coverageNeedsRows: atomic<u32>;
// Integer coordinates from the actual lanes are authoritative for every cache
// reader. Rebuilding UVs from group/column arithmetic can round differently.
var<workgroup> reconstructInputX: array<i32,8>;
var<workgroup> reconstructInputY: array<i32,8>;
var<workgroup> reconstructCoverageX: array<i32,8>;
var<workgroup> reconstructCoverageY: array<i32,8>;

fn tsrCachedTuple(p:vec2<i32>, origin:vec2<i32>) -> vec4<f32> {
  let local = p-origin;
  return reconstructTemporalTile[u32(local.y*13+local.x)];
}

fn tsrCoverageGeometry(center:vec2<i32>,radius:i32,origin:vec2<i32>,column:u32) -> TsrGeometry {
  let extent=textureDimensions(coverage);
  let centerLocal=center-origin;
  var packed=reconstructCoverageTile[u32(centerLocal.y*15+centerLocal.x)];
  if(packed.z>=0.0 && packed.w>=1.0) { return TsrGeometry(packed,false); }
  var background=packed.z<0.0;
  var farthest=packed.z;
  for(var y=-radius;y<=radius;y++) {
    let row=clamp(center.y+y,0,i32(extent.y)-1)-origin.y;
    let summary=reconstructCoverageRows[u32(row)*8u+column];
    background=background || (summary.x & 65536u)!=0u;
    farthest=max(farthest,bitcast<f32>(summary.y));
    let selected=summary.x & 65535u;
    if(selected!=65535u) {
      let candidate=reconstructCoverageTile[selected];
      if(packed.z<0.0 || candidate.z<packed.z) { packed=candidate; }
    }
  }
  return TsrGeometry(packed,packed.z>=0.0 && (background || farthest-packed.z>0.0025+packed.z*0.01));
}

fn tsrInputGeometry(center:vec2<i32>, origin:vec2<i32>) -> TsrGeometry {
  let extent = textureDimensions(sceneTemporal);
  var packed = tsrCachedTuple(center,origin);
  if (packed.z >= 0.0 && packed.w >= 1.0) { return TsrGeometry(packed,false); }
  var background = packed.z < 0.0;
  var farthest = packed.z;
  for (var y=-1;y<=1;y++) {
    for (var x=-1;x<=1;x++) {
      let p=clamp(center+vec2<i32>(x,y),vec2<i32>(0),vec2<i32>(extent)-1);
      let candidate=tsrCachedTuple(p,origin);
      background=background || candidate.z < 0.0;
      farthest=max(farthest,candidate.z);
      if (candidate.z >= 0.0 && candidate.w < 2.0 && (packed.z < 0.0 || candidate.z < packed.z)) {
        packed=candidate;
      }
    }
  }
  return TsrGeometry(packed,packed.z >= 0.0 && (background || farthest-packed.z > 0.0025+packed.z*0.01));
}

fn tsrCachedScene(p:vec2<i32>,origin:vec2<i32>) -> vec4<f32> {
  let local=p-origin;
  return reconstructSceneTile[u32(local.y*13+local.x)];
}

@compute @workgroup_size(8, 8)
fn tsr_reconstruct(@builtin(global_invocation_id) id: vec3<u32>,
  @builtin(local_invocation_index) lane:u32) {
  let size = textureDimensions(colorOutput);
  let samplePixel=min(id.xy,size-vec2<u32>(1u));
  let sceneSize=textureDimensions(scene);
  let input=tsrReconstructionInput(samplePixel,size);
  let sourcePixel=input.sourcePixel;
  let coveragePixel=input.coveragePixel;
  let coverageSize=textureDimensions(coverage);
  if(lane<8u) {
    reconstructInputX[lane]=sourcePixel.x;
    reconstructCoverageX[lane]=coveragePixel.x;
  }
  if(lane%8u==0u) {
    reconstructInputY[lane/8u]=sourcePixel.y;
    reconstructCoverageY[lane/8u]=coveragePixel.y;
  }
  workgroupBarrier();
  let inputOrigin=vec2<i32>(reconstructInputX[0],reconstructInputY[0])-vec2<i32>(2);
  let inputLast=vec2<i32>(reconstructInputX[7],reconstructInputY[7])+vec2<i32>(2);
  let inputFootprint=inputLast-inputOrigin+vec2<i32>(1);
  let ratio=vec2<f32>(coverageSize)/params.inputSize;
  let coverageRadius=min(3,i32(ceil(max(ratio.x,ratio.y))));
  let coverageOrigin=vec2<i32>(reconstructCoverageX[0],reconstructCoverageY[0])-vec2<i32>(coverageRadius);
  for(var n=lane;n<u32(inputFootprint.y)*13u;n+=64u) {
    if(i32(n%13u)>=inputFootprint.x) { continue; }
    let p=clamp(inputOrigin+vec2<i32>(i32(n%13u),i32(n/13u)),vec2<i32>(0),vec2<i32>(sceneSize)-1);
    reconstructSceneTile[n]=textureLoad(scene,p,0);
    reconstructTemporalTile[n]=textureLoad(sceneTemporal,p,0);
  }
  var needsRows=false;
  if(params.hasCoverage!=0u) {
    let coverageLast=vec2<i32>(reconstructCoverageX[7],reconstructCoverageY[7])+vec2<i32>(coverageRadius);
    let coverageFootprint=coverageLast-coverageOrigin+vec2<i32>(1);
    for(var n=lane;n<u32(coverageFootprint.y)*15u;n+=64u) {
      if(i32(n%15u)>=coverageFootprint.x) { continue; }
      let p=clamp(coverageOrigin+vec2<i32>(i32(n%15u),i32(n/15u)),vec2<i32>(0),vec2<i32>(textureDimensions(coverage))-1);
      let packedCoverage=textureLoad(coverage,p,0);
      reconstructCoverageTile[n]=packedCoverage;
      needsRows=needsRows || packedCoverage.z<0.0 || packedCoverage.w<1.0;
    }
  }
  if(needsRows) { atomicOr(&coverageNeedsRows,1u); }
  workgroupBarrier();
  if(params.hasCoverage!=0u) {
    let extent=textureDimensions(coverage);
    let last=vec2<i32>(reconstructCoverageX[7],reconstructCoverageY[7]);
    let rows=last.y+coverageRadius-coverageOrigin.y+1;
    let count=select(0u,u32(rows)*8u,atomicLoad(&coverageNeedsRows)!=0u);
    for(var n=lane;n<count;n+=64u) {
      let column=n%8u;
      let row=n/8u;
      let xCenter=reconstructCoverageX[column];
      let pCenter=clamp(vec2<i32>(xCenter,coverageOrigin.y+i32(row)),vec2<i32>(0),vec2<i32>(extent)-1);
      let localCenter=pCenter-coverageOrigin;
      var farthest=reconstructCoverageTile[u32(localCenter.y*15+localCenter.x)].z;
      var background=false;
      var selected=65535u;
      var nearestDepth=0.0;
      for(var x=-coverageRadius;x<=coverageRadius;x++) {
        let pixel=clamp(pCenter+vec2<i32>(x,0),vec2<i32>(0),vec2<i32>(extent)-1);
        let local=pixel-coverageOrigin;
        let index=u32(local.y*15+local.x);
        let candidate=reconstructCoverageTile[index];
        background=background || candidate.z<0.0;
        farthest=max(farthest,candidate.z);
        if(candidate.z>=0.0 && candidate.w<2.0 && (selected==65535u || candidate.z<nearestDepth)) {
          selected=index;
          nearestDepth=candidate.z;
        }
      }
      reconstructCoverageRows[n]=vec2<u32>(selected | select(0u,65536u,background),bitcast<u32>(farthest));
    }
    // The vote controls work only. Every lane still reaches this barrier,
    // even when no summary was needed or this is a partial output group.
    workgroupBarrier();
  }
  if (any(id.xy >= size)) { return; }
  let pixel = vec2<i32>(id.xy);
  let result = tsrReconstruct(input, size, inputOrigin, coverageOrigin);
  textureStore(colorOutput, pixel, result.color);
  textureStore(temporalOutput, pixel, result.temporal);
  textureStore(metadataOutput, pixel, result.metadata);
}
