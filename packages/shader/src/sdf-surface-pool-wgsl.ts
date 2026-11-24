/** Private GPU packet layout, independent of the asset codec and cook generation.
 * V4 separates complete geometry from placement-owned primitive coverage.
 * Rebuild older transient packets with the matching producer. Asset V5 is unchanged. */
export const SDF_SURFACE_POOL_LAYOUT = {
  magic: 0x53534650,
  version: 4,
  indexedVersion: 0x80000004,
  candidateMagic: 0x53434256,
  candidateFooterWords: 8,
  sceneWords: 4,
  rowWords: 20,
  coverageRecordWords: 4,
  coveragePayloadWords: 4,
  coverageMagic: 0x53434f56,
  instanceWords: 36,
  maxRows: 1024,
  maxBytes: 16 * 1024 * 1024,
  maxVertices: 1_048_576,
  maxPrimitives: 1_048_576,
  maxNodes: 2_097_151,
  candidateRowWords: 8,
  candidateNodeWords: 8,
} as const;

/** Raw inverse access shared by exact tracing and unsigned-distance preparation. */
export const SDF_SURFACE_INVERSE_WGSL = `fn sdfSurfaceInverse(row:u32) -> array<vec4u,4> {
 var inverse:array<vec4u,4>;
 for(var column=0u;column<4u;column++){
  let first=column*4u;
  inverse[column]=vec4u(sdfInstanceWord(row,first),sdfInstanceWord(row,first+1u),sdfInstanceWord(row,first+2u),sdfInstanceWord(row,first+3u));
 }
 return inverse;
}`;

/** Binding-free integer decoder. The adapter supplies sdfFieldWordCount(),
 * sdfFieldWord(index), sdfInstanceRowCount() and sdfInstanceWord(row,word).
 * Counts describe actual bound source storage, including real headroom but
 * excluding texture padding. The canonical owner separately supplies rowLimit,
 * the highest potentially active row plus one; holes are not member counts.
 * A rejected view/epoch must not expose these fetches as a qualified source.
 */
export const SDF_SURFACE_POOL_WGSL = `
struct SdfSurfacePacket {
 valid: u32, meshRegion: vec2u, samples: vec2u,
 positions: vec2u, triangles: vec2u, nodes: vec2u,
 order: vec2u, sidedness: vec2u, coefficients: vec3u, prefixEligible:u32, coverage:vec2u
}
fn sdfSurfacePacketInvalid() -> SdfSurfacePacket {
 return SdfSurfacePacket(0u,vec2u(0),vec2u(0),vec2u(0),vec2u(0),vec2u(0),vec2u(0),vec2u(0),vec3u(0),0u,vec2u(0));
}
fn sdfSurfacePositiveCoefficient(word:u32) -> bool {
 return word==0u || (word>=0x00800000u && word<0x7f800000u);
}
fn sdfSurfacePoolVector(first:u32) -> vec4u {
 return vec4u(sdfFieldWord(first),sdfFieldWord(first+1u),sdfFieldWord(first+2u),sdfFieldWord(first+3u));
}
// Retained candidates must associate the raw row with its own canonical packet.
// This is separate from metadata decoding and from proving an envelope empty.
fn sdfSurfaceRowAssociated(row:u32) -> bool {
 return sdfInstanceWord(row,35u)==0x40000000u &&
  sdfInstanceWord(row,20u)==${SDF_SURFACE_POOL_LAYOUT.sceneWords}u+row*${SDF_SURFACE_POOL_LAYOUT.rowWords}u;
}
struct SdfSurfaceDirectory {
 valid:u32, geometryEnd:u32, first:u32, words:u32, nodes:u32, rowLimit:u32, epoch:u32, indexed:u32
}
fn sdfSurfaceDirectoryInvalid() -> SdfSurfaceDirectory {return SdfSurfaceDirectory(0u,0u,0u,0u,0u,0u,0u,0u);}
fn sdfSurfaceDirectory() -> SdfSurfaceDirectory {
 let count=sdfFieldWordCount();let capacity=sdfInstanceRowCount();
 if(count<${SDF_SURFACE_POOL_LAYOUT.sceneWords}u || count>${SDF_SURFACE_POOL_LAYOUT.maxBytes / 4}u ||
  capacity==0u || capacity>${SDF_SURFACE_POOL_LAYOUT.maxRows}u){return sdfSurfaceDirectoryInvalid();}
 let scene=sdfSurfacePoolVector(0u);let reserved=${SDF_SURFACE_POOL_LAYOUT.sceneWords}u+capacity*${SDF_SURFACE_POOL_LAYOUT.rowWords + SDF_SURFACE_POOL_LAYOUT.coverageRecordWords}u;
 if(scene.x!=${SDF_SURFACE_POOL_LAYOUT.magic}u || scene.z!=capacity || scene.w<reserved || scene.w>count){return sdfSurfaceDirectoryInvalid();}
 if(scene.y==${SDF_SURFACE_POOL_LAYOUT.version}u){return SdfSurfaceDirectory(1u,scene.w,0u,0u,0u,0u,0u,0u);}
 if(scene.y!=${SDF_SURFACE_POOL_LAYOUT.indexedVersion}u || scene.w<reserved+${SDF_SURFACE_POOL_LAYOUT.candidateFooterWords}u){return sdfSurfaceDirectoryInvalid();}
 let footer=scene.w-${SDF_SURFACE_POOL_LAYOUT.candidateFooterWords}u;
 let a=sdfSurfacePoolVector(footer);let b=sdfSurfacePoolVector(footer+4u);
 let expected=capacity*${SDF_SURFACE_POOL_LAYOUT.candidateRowWords}u+(2u*capacity-1u)*${SDF_SURFACE_POOL_LAYOUT.candidateNodeWords}u;
 if(a.x!=${SDF_SURFACE_POOL_LAYOUT.candidateMagic}u || b.w!=0u || b.z==0u || b.y>capacity ||
  a.y<reserved || a.y>a.z || (a.z&3u)!=0u || a.z>footer || a.w!=expected || a.w!=footer-a.z){return sdfSurfaceDirectoryInvalid();}
 if(b.y==0u){if(b.x!=0u){return sdfSurfaceDirectoryInvalid();}}
 else{if(b.x>2u*b.y-1u){return sdfSurfaceDirectoryInvalid();}}
 return SdfSurfaceDirectory(1u,a.y,a.z,a.w,b.x,b.y,b.z,1u);
}
// The transport first compares its observed source tuple with the independent
// expected facts. Storage World and texture Field share this directory policy.
fn sdfSurfaceExpectedDirectory(rowLimit:u32,expectedSource:vec4u) -> SdfSurfaceDirectory {
 let capacity=sdfInstanceRowCount();let directory=sdfSurfaceDirectory();
 if(expectedSource.w==0u || expectedSource.x%${SDF_SURFACE_POOL_LAYOUT.instanceWords}u!=0u ||
  expectedSource.x/${SDF_SURFACE_POOL_LAYOUT.instanceWords}u!=capacity || expectedSource.y!=sdfFieldWordCount() ||
  expectedSource.z!=rowLimit || rowLimit>capacity || directory.valid==0u){return sdfSurfaceDirectoryInvalid();}
 if(directory.indexed!=0u && (directory.epoch!=expectedSource.w || directory.rowLimit!=rowLimit)){
  return sdfSurfaceDirectoryInvalid();
 }
 return directory;
}
// Return the next aligned word, or an invalid sentinel. Validate before subtract/add.
fn sdfSurfacePoolSpan(first:u32,length:u32,expected:u32,end:u32) -> u32 {
 if(first!=expected || first>end || length==0u){return 0xffffffffu;}
 if(length>end-first){return 0xffffffffu;}
 return (first+length+3u)&0xfffffffcu;
}
fn sdfSurfacePoolCounts(positions:vec2u,triangles:vec2u,nodes:vec2u,order:vec2u,sides:vec2u) -> bool {
 return positions.y>=3u && positions.y<=${SDF_SURFACE_POOL_LAYOUT.maxVertices}u &&
  triangles.y>=1u && triangles.y<=${SDF_SURFACE_POOL_LAYOUT.maxPrimitives}u &&
  nodes.y>=1u && nodes.y<=${SDF_SURFACE_POOL_LAYOUT.maxNodes}u &&
  order.y>=1u && order.y<=triangles.y && sides.y==(triangles.y+31u)/32u;
}
// One canonical SNORM sample, not interpolation or a signed-union distance.
// Every directory/payload access is guarded by its own admitted sample span.
fn sdfSurfaceSampleCode(packet:SdfSurfacePacket,dimensions:vec3u,cell:vec3u) -> vec3u {
 if(packet.valid!=1u || any(dimensions==vec3u(0)) || any(dimensions>vec3u(16777216u)) ||
  any(cell>=dimensions)){return vec3u(0);}
 let bricks=(dimensions+vec3u(3u))/4u;
 if(bricks.x>packet.samples.y/bricks.y){return vec3u(0);}
 let plane=bricks.x*bricks.y;
 if(plane>packet.samples.y/bricks.z){return vec3u(0);}
 let table=plane*bricks.z;
 if(table>packet.samples.y || packet.samples.y-table<32u){return vec3u(0);}
 let index=((cell.z/4u)*bricks.y+cell.y/4u)*bricks.x+cell.x/4u;
 let offset=sdfFieldWord(packet.samples.x+index);
 if(offset<table || offset>packet.samples.y-32u){return vec3u(0);}
 let lane=((cell.z&3u)*4u+(cell.y&3u))*4u+(cell.x&3u);
 let code=(sdfFieldWord(packet.samples.x+offset+(lane>>1u))>>((lane&1u)*16u))&65535u;
 // -32768 is never emitted by the canonical encoder.
 return vec3u(select(1u,0u,code==32768u),code,1u);
}
// valid=0 is unavailable, never an empty Mesh or a ray miss. All other fields are zero.
// Coverage records belong to rows. Only partial immutable content is shared.
fn sdfSurfaceCoverage(row:u32,primitives:u32,meshFirst:u32) -> vec3u {
 let capacity=sdfInstanceRowCount();
 let first=${SDF_SURFACE_POOL_LAYOUT.sceneWords}u+capacity*${SDF_SURFACE_POOL_LAYOUT.rowWords}u+row*${SDF_SURFACE_POOL_LAYOUT.coverageRecordWords}u;
 let record=sdfSurfacePoolVector(first);
 if(record.x!=row || record.y!=primitives || record.z>2u){return vec3u(0);}
 if(record.z<2u){if(record.w!=0u){return vec3u(0);}return vec3u(1u,record.z,0u);}
 let start=${SDF_SURFACE_POOL_LAYOUT.sceneWords}u+capacity*${SDF_SURFACE_POOL_LAYOUT.rowWords + SDF_SURFACE_POOL_LAYOUT.coverageRecordWords}u;
 let pointer=record.w;
 if(pointer<start || (pointer&3u)!=0u || pointer>meshFirst){return vec3u(0);}
 if(${SDF_SURFACE_POOL_LAYOUT.coveragePayloadWords}u>meshFirst-pointer){return vec3u(0);}
 let payload=sdfSurfacePoolVector(pointer);let count=(primitives+31u)/32u;
 if(payload.x!=${SDF_SURFACE_POOL_LAYOUT.coverageMagic}u || payload.y!=primitives || payload.z!=count || payload.w!=0u){return vec3u(0);}
 if(((count+3u)/4u)*4u>meshFirst-pointer-${SDF_SURFACE_POOL_LAYOUT.coveragePayloadWords}u){return vec3u(0);}
 let bits=pointer+${SDF_SURFACE_POOL_LAYOUT.coveragePayloadWords}u;let tail=primitives&31u;
 if(tail!=0u){if((sdfFieldWord(bits+count-1u)>>tail)!=0u){return vec3u(0);}}
 return vec3u(1u,2u,bits);
}
fn sdfSurfacePrimitiveOpaque(packet:SdfSurfacePacket,primitive:u32) -> bool {
 if(packet.valid==0u || primitive>=packet.triangles.y){return false;}
 if(packet.coverage.x<2u){return packet.coverage.x==0u;}
 return ((sdfFieldWord(packet.coverage.y+(primitive>>5u))>>(primitive&31u))&1u)!=0u;
}
fn sdfSurfacePacket(row:u32) -> SdfSurfacePacket {
 let capacity=sdfInstanceRowCount();let directory=sdfSurfaceDirectory();
 if(directory.valid==0u || row>=capacity){return sdfSurfacePacketInvalid();}
 let reserved=${SDF_SURFACE_POOL_LAYOUT.sceneWords}u+capacity*${SDF_SURFACE_POOL_LAYOUT.rowWords + SDF_SURFACE_POOL_LAYOUT.coverageRecordWords}u;
 let first=${SDF_SURFACE_POOL_LAYOUT.sceneWords}u+row*${SDF_SURFACE_POOL_LAYOUT.rowWords}u;
 let a=sdfSurfacePoolVector(first);let b=sdfSurfacePoolVector(first+4u);
 let c=sdfSurfacePoolVector(first+8u);let d=sdfSurfacePoolVector(first+12u);let e=sdfSurfacePoolVector(first+16u);
 if(a.z!=1u || a.w!=${SDF_SURFACE_POOL_LAYOUT.sceneWords}u+capacity*${SDF_SURFACE_POOL_LAYOUT.rowWords}u+row*${SDF_SURFACE_POOL_LAYOUT.coverageRecordWords}u || b.w>1u ||
  !sdfSurfacePositiveCoefficient(b.z) || !sdfSurfacePositiveCoefficient(e.z) || !sdfSurfacePositiveCoefficient(e.w)){
  return sdfSurfacePacketInvalid();
 }
 if(a.x<reserved || (a.x&3u)!=0u || a.y>directory.geometryEnd || a.y<=a.x){return sdfSurfacePacketInvalid();}
 if(!sdfSurfacePoolCounts(c.xy,c.zw,d.xy,d.zw,e.xy)){return sdfSurfacePacketInvalid();}
 let coverage=sdfSurfaceCoverage(row,c.w,a.x);if(coverage.x==0u){return sdfSurfacePacketInvalid();}
 var next=sdfSurfacePoolSpan(b.x,b.y,a.x,a.y);
 next=sdfSurfacePoolSpan(c.x,c.y*3u,next,a.y);
 next=sdfSurfacePoolSpan(c.z,c.w*3u,next,a.y);
 next=sdfSurfacePoolSpan(d.x,d.y*8u,next,a.y);
 next=sdfSurfacePoolSpan(d.z,d.w,next,a.y);
 next=sdfSurfacePoolSpan(e.x,e.y,next,a.y);
 if(next!=a.y){return sdfSurfacePacketInvalid();}
 let tail=c.w&31u;
 if(tail!=0u){if((sdfFieldWord(e.x+e.y-1u)>>tail)!=0u){return sdfSurfacePacketInvalid();}}
 return SdfSurfacePacket(1u,a.xy,b.xy,c.xy,c.zw,d.xy,d.zw,e.xy,vec3u(b.z,e.z,e.w),b.w,coverage.yz);
}
`;
