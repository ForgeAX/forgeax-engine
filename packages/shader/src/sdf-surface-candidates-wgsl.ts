import { SDF_SURFACE_POOL_LAYOUT as LAYOUT } from './sdf-surface-pool-wgsl';

export const SDF_SURFACE_CANDIDATE_STATE = { indexed: 0, fullRoster: 1, unknown: 2 } as const;

/** Fragment composed with the existing complete surface TRACE and raw word
 * guards, once each. It adds no binding. Both tuples come from the admitted
 * source owner; expected is independently captured by the reader's frame.
 * Complete topology/enclosure admission belongs to the immutable producer.
 * Per-ray checks cover raw selected rows and all visited node accesses. */
export const SDF_SURFACE_CANDIDATES_WGSL = sdfSurfaceCandidatesWgsl();

/** The rendering estimator pays every visited row/node before testing it.
 * The strict reference keeps its existing separately bounded directory lane. */
export function sdfSurfaceCandidatesWgsl(metered = false): string {
  const charge = metered
    ? 'if(!sdfSurfaceCharge(remaining)){out.state=3u;return out;}(*work)++;\n'
    : '';
  return `
struct SdfSurfaceCandidates { rows:array<u32,32>, state:u32, nodeVisits:u32 }
fn sdfSurfaceCandidatesUnknown(visits:u32) -> SdfSurfaceCandidates {
 var out:SdfSurfaceCandidates;out.state=2u;out.nodeVisits=visits;return out;
}
fn sdfSurfaceCandidateContains(candidates:ptr<function,SdfSurfaceCandidates>,row:u32) -> bool {
 return (*candidates).state!=2u && row<${LAYOUT.maxRows}u && ((*candidates).rows[row>>5u]&(1u<<(row&31u)))!=0u;
}
fn sdfSurfaceCandidateBoxValid(lo:vec3u,hi:vec3u,enclosed:bool) -> bool {
 if(!enclosed){return all(lo==vec3u(0u)) && all(hi==vec3u(0u));}
 for(var axis=0u;axis<3u;axis++){
  if(!sdfInstanceFloatUsable(lo[axis]) || !sdfInstanceFloatUsable(hi[axis])){return false;}
 }
 return all(bitcast<vec3f>(lo)<=bitcast<vec3f>(hi));
}
fn sdfSurfaceCandidateLeafValid(directory:SdfSurfaceDirectory,row:u32,flags:u32,lo:vec3u,hi:vec3u) -> bool {
 if(row>=directory.rowLimit){return false;}
 let at=directory.first+row*${LAYOUT.candidateRowWords}u;
 let a=sdfSurfacePoolVector(at);let b=sdfSurfacePoolVector(at+4u);
 if(a.w>1u || b.w!=0u || a.w!=select(0u,1u,(flags&0x40000000u)!=0u)){return false;}
 return all(a.xyz==lo) && all(b.xyz==hi);
}
fn sdfSurfaceCandidateChildrenValid(first:u32,node:u32,escape:u32,count:u32) -> bool {
 if(node+1u>=escape){return false;}
 let left=first+(node+1u)*${LAYOUT.candidateNodeWords}u;
 let right=sdfFieldWord(left+7u);
 if(right<=node+1u || right>=escape || right>=count){return false;}
 return sdfFieldWord(first+right*${LAYOUT.candidateNodeWords}u+7u)==escape;
}
// Candidate directory work is separately bounded and reported. It never
// consumes or increases the caller's original Mesh/triangle/sample ledger.
fn sdfSurfaceSceneCandidates(world:SdfSurfaceRay,rowLimit:u32,mask:u32,actualSource:vec4u,expectedSource:vec4u${metered ? ',remaining:ptr<function,u32>,work:ptr<function,u32>' : ''}) -> SdfSurfaceCandidates {
 var out:SdfSurfaceCandidates;
 let capacity=sdfInstanceRowCount();let directory=sdfSurfaceExpectedDirectory(rowLimit,expectedSource);
 if(any(actualSource!=expectedSource) || directory.valid==0u || !sdfSurfaceRayUsable(world)){
  return sdfSurfaceCandidatesUnknown(0u);
 }
 var selected=0u;
 for(var row=0u;row<rowLimit;row++){
${charge}  if((sdfInstanceMask(row)&mask)==0u){continue;}
  if(!sdfInstanceValid(row)){return sdfSurfaceCandidatesUnknown(0u);}selected++;
 }
 if(directory.indexed==0u){
  out.state=1u;
  for(var row=0u;row<rowLimit;row++){
${charge}   if((sdfInstanceMask(row)&mask)!=0u){out.rows[row>>5u]|=1u<<(row&31u);}
  }
  return out;
 }
 if(selected>0u && directory.nodes<2u*selected-1u){return sdfSurfaceCandidatesUnknown(0u);}
 let first=directory.first+capacity*${LAYOUT.candidateRowWords}u;
 var node=0u;
 loop {
  if(node>=directory.nodes){break;}
  if(out.nodeVisits>=2u*capacity-1u){return sdfSurfaceCandidatesUnknown(out.nodeVisits);}
${charge}  out.nodeVisits++;
  let at=first+node*${LAYOUT.candidateNodeWords}u;
  let a=sdfSurfacePoolVector(at);let b=sdfSurfacePoolVector(at+4u);
  let flags=a.w;let escape=b.w;let leaf=(flags&0x80000000u)!=0u;
  if(escape<=node || escape>directory.nodes || (node==0u && escape!=directory.nodes) ||
    (flags&0x3ffffc00u)!=0u || !sdfSurfaceCandidateBoxValid(a.xyz,b.xyz,(flags&0x40000000u)!=0u)){
   return sdfSurfaceCandidatesUnknown(out.nodeVisits);
  }
  if(leaf){
   let row=flags&1023u;
   if(escape!=node+1u || !sdfSurfaceCandidateLeafValid(directory,row,flags,a.xyz,b.xyz)){
    return sdfSurfaceCandidatesUnknown(out.nodeVisits);
   }
  }else{
   if((flags&1023u)!=0u || !sdfSurfaceCandidateChildrenValid(first,node,escape,directory.nodes)){
    return sdfSurfaceCandidatesUnknown(out.nodeVisits);
   }
  }
  if((flags&0x40000000u)!=0u){
   let slab=sdfSurfaceSlab(world,a.xyz,b.xyz);
   if(slab.certified==1u && slab.possible==0u){node=escape;continue;}
  }
  if(leaf){
   let row=flags&1023u;
   if((sdfInstanceMask(row)&mask)!=0u){out.rows[row>>5u]|=1u<<(row&31u);}
   node=escape;
  }else{node++;}
 }
 return out;
}
`;
}
