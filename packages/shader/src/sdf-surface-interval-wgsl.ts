/** Shared conservative arithmetic and raw affine preparation. These fragments
 * contain no triangle predicate or traversal and retain their exact operator order.
 * Complete consumers compose their required geometry separately at build time. */
export const SDF_INTERVAL_RAY_TYPES_WGSL = `
struct SdfRealInterval { lo: f32, hi: f32, valid: u32 }
struct SdfIntervalVector { axis: array<SdfRealInterval,3> }
struct SdfSurfaceRay {
 originLo: vec3u, originHi: vec3u,
 directionLo: vec3u, directionHi: vec3u,
 tRange: vec2u, valid: u32
}
`;

export const SDF_INTERVAL_OPERATIONS_WGSL = `fn sdfIntervalInvalid() -> SdfRealInterval { return SdfRealInterval(0,0,0u); }
fn sdfIntervalZero() -> SdfRealInterval { return SdfRealInterval(0,0,1u); }
fn sdfSurfaceBitsUsable(bits:u32) -> bool {
 let magnitude=bits&0x7fffffffu;
 return magnitude==0u || (magnitude>=0x00800000u && magnitude<=0x7f7fffffu);
}
fn sdfIntervalRaw(lo:u32,hi:u32) -> SdfRealInterval {
 if(!sdfSurfaceBitsUsable(lo) || !sdfSurfaceBitsUsable(hi)){return sdfIntervalInvalid();}
 let a=bitcast<f32>(lo);let b=bitcast<f32>(hi);
 if(a>b){return sdfIntervalInvalid();}
 return SdfRealInterval(a,b,1u);
}
fn sdfIntervalPoint(bits:u32) -> SdfRealInterval { return sdfIntervalRaw(bits,bits); }
fn sdfIntervalNegate(a:SdfRealInterval) -> SdfRealInterval {
 return SdfRealInterval(-a.hi,-a.lo,a.valid);
}
// Integer-observed rounding boundaries prevent expression reassociation across
// primitive operations. A zero/subnormal result includes permitted FTZ and the
// division accuracy fringe at the minimum normal. No subnormal endpoint is used.
fn sdfIntervalOutward(value:f32,steps:u32) -> SdfRealInterval {
 let bits=bitcast<u32>(value);let magnitude=bits&0x7fffffffu;
 if(magnitude<=0x00800008u){
  // A normal rounded result may itself be eight minimum ULP above the
  // normal boundary. Include its permitted division-error fringe as well.
  return SdfRealInterval(bitcast<f32>(0x80800010u),bitcast<f32>(0x00800010u),1u);
 }
 if(magnitude>0x7f7ffff0u){return sdfIntervalInvalid();}
 if((bits&0x80000000u)==0u){
  return SdfRealInterval(bitcast<f32>(bits-steps),bitcast<f32>(bits+steps),1u);
 }
 return SdfRealInterval(bitcast<f32>(bits+steps),bitcast<f32>(bits-steps),1u);
}
// Try an exact normal/zero dyadic point without evaluating a floating operator.
// A failed exact attempt still takes the existing outward arithmetic path.
fn sdfIntervalTryExactMagnitude(magnitude:u32,commonExponent:u32,sign:u32) -> u32 {
 if(magnitude==0u){return 0u;}
 let leading=31u-countLeadingZeros(magnitude);
 let exponent=i32(commonExponent)+i32(leading)-23;
 if(exponent<1 || exponent>254){return 0x7f800000u;}
 var mantissa=magnitude;
 if(leading>23u){
  let shift=leading-23u;
  if((magnitude&((1u<<shift)-1u))!=0u){return 0x7f800000u;}
  mantissa=magnitude>>shift;
 }else{mantissa=magnitude<<(23u-leading);}
 return sign|(u32(exponent)<<23u)|(mantissa&0x7fffffu);
}
fn sdfIntervalTryExactSum(a:u32,b:u32) -> u32 {
 if((a&0x7fffffffu)==0u){return b;}
 if((b&0x7fffffffu)==0u){return a;}
 let ae=(a>>23u)&255u;let be=(b>>23u)&255u;
 var minimumExponent=min(ae,be);
 var am=(a&0x7fffffu)|0x800000u;
 var bm=(b&0x7fffffu)|0x800000u;
 if(max(ae,be)-minimumExponent<=7u){
  // Preserve the narrow alignment: its unsigned sum is below 2^32.
  am<<=ae-minimumExponent;bm<<=be-minimumExponent;
 }else{
  // Strip only exact powers of two from each nonzero 24-bit significand.
  let aTrailing=countTrailingZeros(am);let bTrailing=countTrailingZeros(bm);
  am>>=aTrailing;bm>>=bTrailing;
  let aExponent=ae+aTrailing;let bExponent=be+bTrailing;
  minimumExponent=min(aExponent,bExponent);
  let aShift=aExponent-minimumExponent;let bShift=bExponent-minimumExponent;
  if(aShift>=32u || bShift>=32u){return 0x7f800000u;}
  if(am>(0xffffffffu>>aShift) || bm>(0xffffffffu>>bShift)){return 0x7f800000u;}
  am<<=aShift;bm<<=bShift;
  if(((a^b)&0x80000000u)==0u && am>0xffffffffu-bm){return 0x7f800000u;}
 }
 var magnitude=0u;var sign=a&0x80000000u;
 if(((a^b)&0x80000000u)==0u){magnitude=am+bm;}
 else if(am>=bm){magnitude=am-bm;}
 else{magnitude=bm-am;sign=b&0x80000000u;}
 return sdfIntervalTryExactMagnitude(magnitude,minimumExponent,sign);
}
fn sdfIntervalTryExactScale(bits:u32,exponent:i32,sign:u32) -> u32 {
 if(exponent<1 || exponent>254){return 0x7f800000u;}
 return sign|(u32(exponent)<<23u)|(bits&0x7fffffu);
}
fn sdfIntervalSumEndpoint(a:f32,b:f32) -> SdfRealInterval {
 let ab=bitcast<u32>(a);let bb=bitcast<u32>(b);
 if(!sdfSurfaceBitsUsable(ab) || !sdfSurfaceBitsUsable(bb)){return sdfIntervalInvalid();}
 // Reject before evaluating an expression that could overflow under finite math.
 if((ab&0x7fffffffu)>0x7e800000u ||
    (bb&0x7fffffffu)>0x7e800000u){return sdfIntervalInvalid();}
 let exact=sdfIntervalTryExactSum(ab,bb);
 if(exact!=0x7f800000u){let value=bitcast<f32>(exact);return SdfRealInterval(value,value,1u);}
 return sdfIntervalOutward(a+b,2u);
}
fn sdfIntervalAdd(a:SdfRealInterval,b:SdfRealInterval) -> SdfRealInterval {
 if(a.valid==0u || b.valid==0u){return sdfIntervalInvalid();}
 if(a.lo==0 && a.hi==0){return b;}
 if(b.lo==0 && b.hi==0){return a;}
 let lo=sdfIntervalSumEndpoint(a.lo,b.lo);let hi=sdfIntervalSumEndpoint(a.hi,b.hi);
 return SdfRealInterval(lo.lo,hi.hi,lo.valid&hi.valid);
}
fn sdfIntervalSubtract(a:SdfRealInterval,b:SdfRealInterval) -> SdfRealInterval {
 if(a.valid==0u || b.valid==0u){return sdfIntervalInvalid();}
 if(a.lo==a.hi && b.lo==b.hi && a.lo==b.lo){return sdfIntervalZero();}
 return sdfIntervalAdd(a,sdfIntervalNegate(b));
}
fn sdfSurfaceExponent(bits:u32) -> i32 { return i32((bits>>23u)&255u)-127; }
fn sdfIntervalProductEndpoint(a:f32,b:f32) -> SdfRealInterval {
 let ab=bitcast<u32>(a);let bb=bitcast<u32>(b);
 if(!sdfSurfaceBitsUsable(ab) || !sdfSurfaceBitsUsable(bb)){return sdfIntervalInvalid();}
 if(a==0 || b==0){return sdfIntervalZero();}
 if(sdfSurfaceExponent(bitcast<u32>(a))+sdfSurfaceExponent(bitcast<u32>(b))>125){return sdfIntervalInvalid();}
 let ap=(ab&0x7fffffu)==0u;let bp=(bb&0x7fffffu)==0u;
 if(ap || bp){
  let exponent=i32((ab>>23u)&255u)+i32((bb>>23u)&255u)-127;
  let exact=sdfIntervalTryExactScale(select(ab,bb,ap),exponent,(ab^bb)&0x80000000u);
  if(exact!=0x7f800000u){let value=bitcast<f32>(exact);return SdfRealInterval(value,value,1u);}
 }
 return sdfIntervalOutward(a*b,2u);
}
fn sdfIntervalQuotientEndpoint(a:f32,b:f32) -> SdfRealInterval {
 let ab=bitcast<u32>(a);let bb=bitcast<u32>(b);let bm=bb&0x7fffffffu;
 if(!sdfSurfaceBitsUsable(ab) || !sdfSurfaceBitsUsable(bb)){return sdfIntervalInvalid();}
 // WGSL division has bounded accuracy only over this denominator domain.
 if(bm<0x00800000u || bm>0x7e800000u){return sdfIntervalInvalid();}
 if(a==0){return sdfIntervalZero();}
 if(sdfSurfaceExponent(ab)-sdfSurfaceExponent(bb)>125){return sdfIntervalInvalid();}
 if((bb&0x7fffffu)==0u){
  let exponent=i32((ab>>23u)&255u)-i32((bb>>23u)&255u)+127;
  let exact=sdfIntervalTryExactScale(ab,exponent,(ab^bb)&0x80000000u);
  if(exact!=0x7f800000u){let value=bitcast<f32>(exact);return SdfRealInterval(value,value,1u);}
 }
 // Eight adjacent values cover 2.5 ULP even across a binade boundary.
 return sdfIntervalOutward(a/b,8u);
}
fn sdfIntervalEnvelope(a:SdfRealInterval,b:SdfRealInterval,c:SdfRealInterval,d:SdfRealInterval) -> SdfRealInterval {
 var result=a;
 // Preserve the original endpoint fold order without a by-value array.
 result.lo=min(result.lo,b.lo);result.hi=max(result.hi,b.hi);result.valid&=b.valid;
 result.lo=min(result.lo,c.lo);result.hi=max(result.hi,c.hi);result.valid&=c.valid;
 result.lo=min(result.lo,d.lo);result.hi=max(result.hi,d.hi);result.valid&=d.valid;
 return result;
}
fn sdfIntervalMultiply(a:SdfRealInterval,b:SdfRealInterval) -> SdfRealInterval {
 if(a.valid==0u || b.valid==0u){return sdfIntervalInvalid();}
 return sdfIntervalEnvelope(
  sdfIntervalProductEndpoint(a.lo,b.lo),sdfIntervalProductEndpoint(a.lo,b.hi),
  sdfIntervalProductEndpoint(a.hi,b.lo),sdfIntervalProductEndpoint(a.hi,b.hi));
}
fn sdfIntervalDivide(a:SdfRealInterval,b:SdfRealInterval) -> SdfRealInterval {
 if(a.valid==0u || b.valid==0u || (b.lo<=0 && b.hi>=0)){return sdfIntervalInvalid();}
 return sdfIntervalEnvelope(
  sdfIntervalQuotientEndpoint(a.lo,b.lo),sdfIntervalQuotientEndpoint(a.lo,b.hi),
  sdfIntervalQuotientEndpoint(a.hi,b.lo),sdfIntervalQuotientEndpoint(a.hi,b.hi));
}
fn sdfIntervalVector(lo:vec3u,hi:vec3u) -> SdfIntervalVector {
 var v:SdfIntervalVector;
 for(var i=0u;i<3u;i++){v.axis[i]=sdfIntervalRaw(lo[i],hi[i]);}
 return v;
}
fn sdfIntervalVectorValid(v:SdfIntervalVector) -> bool {
 return v.axis[0].valid==1u && v.axis[1].valid==1u && v.axis[2].valid==1u;
}
fn sdfIntervalVectorSubtract(a:SdfIntervalVector,b:SdfIntervalVector) -> SdfIntervalVector {
 var v:SdfIntervalVector;
 for(var i=0u;i<3u;i++){v.axis[i]=sdfIntervalSubtract(a.axis[i],b.axis[i]);}
 return v;
}
fn sdfIntervalCross(a:SdfIntervalVector,b:SdfIntervalVector) -> SdfIntervalVector {
 var v:SdfIntervalVector;
 for(var i=0u;i<3u;i++){
  let j=(i+1u)%3u;let k=(i+2u)%3u;
  v.axis[i]=sdfIntervalSubtract(sdfIntervalMultiply(a.axis[j],b.axis[k]),sdfIntervalMultiply(a.axis[k],b.axis[j]));
 }
 return v;
}
fn sdfIntervalDot(a:SdfIntervalVector,b:SdfIntervalVector) -> SdfRealInterval {
 return sdfIntervalAdd(sdfIntervalAdd(sdfIntervalMultiply(a.axis[0],b.axis[0]),
  sdfIntervalMultiply(a.axis[1],b.axis[1])),sdfIntervalMultiply(a.axis[2],b.axis[2]));
}
`;

export const SDF_SURFACE_AFFINE_LOCAL_RAY_WGSL = `
// Producer certificate: rho = ||I - A_f32 M_forward||_inf < 1,
// k >= rho/(1-rho), b >= ||A_f32 t_forward + t_inverse||_inf/(1-rho).
// Canonical local x obeys |x-v|_inf <= k |v|_inf + b for v=A_f32 w+t_inverse.
// Directions use w=0 and b=0. No shader-constructed floating-point inverse is truth.
fn sdfSurfaceInvalidRay(range:vec2u) -> SdfSurfaceRay {
 return SdfSurfaceRay(vec3u(0u),vec3u(0u),vec3u(0u),vec3u(0u),range,0u);
}
fn sdfSurfaceAffineInputValid(inverse:array<vec4u,4>,certificate:vec2u) -> bool {
 for(var column=0u;column<4u;column++){
  for(var axis=0u;axis<4u;axis++){
   if(!sdfSurfaceBitsUsable(inverse[column][axis])){return false;}
  }
 }
 if(any((vec3u(inverse[0].w,inverse[1].w,inverse[2].w)&vec3u(0x7fffffffu))!=vec3u(0u)) || inverse[3].w!=0x3f800000u){return false;}
 for(var axis=0u;axis<2u;axis++){
  let bits=certificate[axis];
  if(!sdfSurfaceBitsUsable(bits) || ((bits&0x80000000u)!=0u && (bits&0x7fffffffu)!=0u)){return false;}
 }
 return true;
}
fn sdfSurfaceAffineValue(inverse:array<vec4u,4>,input:SdfIntervalVector,position:bool) -> SdfIntervalVector {
 var result:SdfIntervalVector;
 for(var axis=0u;axis<3u;axis++){
  var value=sdfIntervalZero();
  for(var column=0u;column<3u;column++){
   value=sdfIntervalAdd(value,sdfIntervalMultiply(sdfIntervalPoint(inverse[column][axis]),input.axis[column]));
  }
  if(position){value=sdfIntervalAdd(value,sdfIntervalPoint(inverse[3][axis]));}
  result.axis[axis]=value;
 }
 return result;
}
fn sdfSurfaceAffineEnvelope(value:SdfIntervalVector,certificate:vec2u,position:bool) -> SdfIntervalVector {
 if(!sdfIntervalVectorValid(value)){return value;}
 var maximum=0f;
 for(var axis=0u;axis<3u;axis++){maximum=max(maximum,max(abs(value.axis[axis].lo),abs(value.axis[axis].hi)));}
 var radius=sdfIntervalMultiply(sdfIntervalPoint(certificate.x),sdfIntervalPoint(bitcast<u32>(maximum)));
 if(position){radius=sdfIntervalAdd(radius,sdfIntervalPoint(certificate.y));}
 var result:SdfIntervalVector;
 for(var axis=0u;axis<3u;axis++){
  if(radius.valid==0u){result.axis[axis]=sdfIntervalInvalid();}
  else {result.axis[axis]=sdfIntervalAdd(value.axis[axis],SdfRealInterval(-radius.hi,radius.hi,1u));}
 }
 return result;
}
fn sdfSurfaceLocalRay(world:SdfSurfaceRay,inverse:array<vec4u,4>,certificate:vec2u) -> SdfSurfaceRay {
 let empty=sdfSurfaceInvalidRay(world.tRange);
 if(world.valid!=1u || !sdfSurfaceAffineInputValid(inverse,certificate) || sdfIntervalRaw(world.tRange.x,world.tRange.y).valid==0u){return empty;}
 let origin=sdfIntervalVector(world.originLo,world.originHi);
 let direction=sdfIntervalVector(world.directionLo,world.directionHi);
 if(!sdfIntervalVectorValid(origin) || !sdfIntervalVectorValid(direction)){return empty;}
 let localOrigin=sdfSurfaceAffineEnvelope(sdfSurfaceAffineValue(inverse,origin,true),certificate,true);
 let localDirection=sdfSurfaceAffineEnvelope(sdfSurfaceAffineValue(inverse,direction,false),certificate,false);
 if(!sdfIntervalVectorValid(localOrigin) || !sdfIntervalVectorValid(localDirection)){return empty;}
 var result=empty;
 for(var axis=0u;axis<3u;axis++){
  result.originLo[axis]=bitcast<u32>(localOrigin.axis[axis].lo);result.originHi[axis]=bitcast<u32>(localOrigin.axis[axis].hi);
  result.directionLo[axis]=bitcast<u32>(localDirection.axis[axis].lo);result.directionHi[axis]=bitcast<u32>(localDirection.axis[axis].hi);
 }
 result.valid=1u;return result;
}
`;
