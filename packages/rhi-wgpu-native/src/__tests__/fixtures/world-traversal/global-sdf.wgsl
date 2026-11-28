
const WORLD_HIT_NORMAL_EXACT: bool = false;


struct RawInstance { words:array<vec4u,9> }
struct Instance { inverse:mat4x4f, ids:vec4u, field:vec4u, origin:vec4f, extent:vec4f, error:vec4f }
fn sdfInstanceRowCount() -> u32 { return arrayLength(&instances); }
fn sdfInstanceWord(row:u32,word:u32) -> u32 {
 if(row>=sdfInstanceRowCount() || word>=36u){return 0u;}
 return instances[row].words[word>>2u][word&3u];
}

fn sdfInstanceMask(row:u32) -> u32 { return sdfInstanceWord(row,19u); }
fn sdfInstanceFloatUsable(word:u32) -> bool {
 let magnitude=word&0x7fffffffu;
 return magnitude==0u || (magnitude>=0x00800000u && magnitude<=0x7f7fffffu);
}
fn sdfInstanceValid(row:u32) -> bool {
 if(row>=sdfInstanceRowCount() || sdfInstanceRowCount()>1024u){return false;}
 if(sdfInstanceMask(row)>255u){return false;}
 for(var word=0u;word<36u;word++){
  if(word>=16u && word<24u){continue;}
  if(!sdfInstanceFloatUsable(sdfInstanceWord(row,word))){return false;}
 }
 if((sdfInstanceWord(row,3u)&0x7fffffffu)!=0u ||
    (sdfInstanceWord(row,7u)&0x7fffffffu)!=0u ||
    (sdfInstanceWord(row,11u)&0x7fffffffu)!=0u || sdfInstanceWord(row,15u)!=0x3f800000u){return false;}
 let mode=sdfInstanceWord(row,35u);
 return mode==0u || mode==0x3f800000u || mode==0x40000000u;
}

fn sdfInstanceAt(row:u32) -> Instance {
 let raw=instances[row].words;
 return Instance(mat4x4f(bitcast<vec4f>(raw[0]),bitcast<vec4f>(raw[1]),bitcast<vec4f>(raw[2]),bitcast<vec4f>(raw[3])),
  raw[4],raw[5],bitcast<vec4f>(raw[6]),bitcast<vec4f>(raw[7]),bitcast<vec4f>(raw[8]));
}

struct Ray { origin: vec3f, tMin: f32, direction: vec3f, tMax: f32, mask: vec4u }
struct SdfHit { state: vec4u, metrics: vec4f, position: vec4f, normal: vec4f }
fn sdfTexel(m: Instance, c: vec3u) -> f32 {
  if(m.error.w==1.0 || m.error.w==2.0){
    let first=select(m.field.x,fields[m.field.x+4u],m.error.w==2.0);
    let edge=4u;
    let dims=(m.field.yzw+vec3u(edge-1u))/edge;
    let b=c/edge;
    let entry=fields[first+(b.z*dims.y+b.y)*dims.x+b.x];
    let p=c%edge;let local=(p.z*edge+p.y)*edge+p.x;
    return unpack2x16snorm(fields[first+entry+(local>>1u)])[local&1u]*m.extent.w;
  }
  return bitcast<f32>(fields[m.field.x+(c.z*m.field.z+c.y)*m.field.y+c.x]);
}
fn sdfValue(m: Instance, p: vec3f) -> f32 {
  let q=clamp((p-m.origin.xyz)/m.origin.w,vec3f(0),vec3f(m.field.yzw-vec3u(1u)));
  let cell=vec3u(min(floor(q),vec3f(m.field.yzw-vec3u(2u))));
  let f=q-vec3f(cell); var value=0.0;
  for(var z=0u;z<2u;z++){ for(var y=0u;y<2u;y++){for(var x=0u;x<2u;x++){
    let c=cell+vec3u(x,y,z); let w=select(vec3f(1)-f,f,vec3u(x,y,z)>vec3u(0));
    value+=sdfTexel(m,c)*w.x*w.y*w.z;
  }}}
  return value;
}

fn sdfNormal(m: Instance,p: vec3f) -> vec3f {
  let h=select(m.origin.w,m.origin.w*0.5,m.error.w>0.5);let g=vec3f(sdfValue(m,p+vec3f(h,0,0))-sdfValue(m,p-vec3f(h,0,0)),
    sdfValue(m,p+vec3f(0,h,0))-sdfValue(m,p-vec3f(0,h,0)),sdfValue(m,p+vec3f(0,0,h))-sdfValue(m,p-vec3f(0,0,h)));
  let n=transpose(mat3x3f(m.inverse[0].xyz,m.inverse[1].xyz,m.inverse[2].xyz))*g;
  return n/max(length(n),1e-20);
}
fn traceSdf(ray: Ray, instanceCount: u32, maxSteps: u32, rayDistanceExpansion: bool) -> SdfHit {
var result=SdfHit(vec4u(0u,0xffffffffu,0xffffffffu,0xffffffffu),vec4f(ray.tMax,0,0,0),vec4f(0),vec4f(0));
  var totalSteps=0u;
  for(var i=0u;i<instanceCount;i++){
    if((sdfInstanceMask(i)&ray.mask.x)==0u){continue;}
    if(!sdfInstanceValid(i)){result.state.x=4u;return result;}
    let m=sdfInstanceAt(i);
    let o=(m.inverse*vec4f(ray.origin,1)).xyz;let d=(m.inverse*vec4f(ray.direction,0)).xyz;
    let visibility=m.error.w>0.5;let lo=select(m.origin.xyz,m.origin.xyz+vec3f(m.origin.w),visibility);
    var near=ray.tMin;var far=ray.tMax;var overlap=true;
    for(var axis=0u;axis<3u;axis++){
      if(d[axis]==0.0){if(o[axis]<lo[axis]||o[axis]>m.extent[axis]){overlap=false;}}
      else{let a=(lo[axis]-o[axis])/d[axis];let b=(m.extent[axis]-o[axis])/d[axis];near=max(near,min(a,b));far=min(far,max(a,b));}
    }
    if(!overlap||near>far||near>result.metrics.x){continue;}
    var t=near;var status=0u;var steps=0u;var insideHeuristic=0.0;
    if(m.field.x==0xffffffffu){status=4u;}
    else if(visibility){
      let speed=length(d);var maxDistance=0.0;
      for(var step=0u;step<maxSteps;step++){
        steps++;let value=sdfValue(m,o+d*t);
        if(step==0u && near==ray.tMin && value<0.0){insideHeuristic=1.0;}
        maxDistance=max(maxDistance,value);
        let expansionDistance=select(maxDistance,t*speed,rayDistanceExpansion);
        let expansion=m.error.x*clamp(expansionDistance/(2.0*m.error.x),0.0,1.0);
        // A zero sample at the first closed-interval contact is a surface even
        // when clearance history has not accumulated any expansion yet.
        if(value<=expansion){
          t=clamp(t+(value-expansion)/speed,near,far);status=5u;break;
        }
        let next=t+max(value,m.error.z)/speed;
        if(next<=t){status=3u;break;}
        t=next;
        if(t>far+expansion/speed || t>result.metrics.x){break;}
        if(step+1u==maxSteps){status=3u;}
      }
    }else {
      for(var step=0u;step<maxSteps;step++){
        if(t>far||t>result.metrics.x){break;}
        steps++;let p=o+d*t;let value=sdfValue(m,p);
        if(value < -m.error.x && step==0u && near==ray.tMin){status=2u;break;}
        if(value<=m.error.x+m.origin.w*0.02){status=1u;break;}
        let advance=(value-m.error.x)*0.9/length(d);
        if(t+advance<=t){status=3u;break;}
        t+=advance;
        if(step+1u==maxSteps && t<=far){status=3u;}
      }
    }
    totalSteps+=steps;
    if(status!=0u && t<=result.metrics.x){
      var n=vec3f(0);if(status==1u||status==5u){n=sdfNormal(m,o+d*t);}
      result=SdfHit(vec4u(status,m.ids.xyz),vec4f(t,m.error.y,0,insideHeuristic),vec4f(ray.origin+ray.direction*t,1),vec4f(n,0));
    }
  }
  result.metrics.z=f32(totalSteps);return result;
}


struct SdfRealInterval { lo: f32, hi: f32, valid: u32 }
struct SdfIntervalVector { axis: array<SdfRealInterval,3> }
struct SdfSurfaceRay {
 originLo: vec3u, originHi: vec3u,
 directionLo: vec3u, directionHi: vec3u,
 tRange: vec2u, valid: u32
}
// state: clear=0, hit=1, uncertain=2. Only hit certifies a primitive intersection.
struct SdfSurfaceIntersection { state: u32, tLower: f32, tUpper: f32, frontFace: u32 }
// A caller may prune only when certified=1; possible=1 is not a surface hit.
struct SdfSurfaceBounds { possible: u32, certified: u32, near: f32, far: f32 }

fn sdfIntervalInvalid() -> SdfRealInterval { return SdfRealInterval(0,0,0u); }
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
fn sdfSurfaceTriangleTighten(a:SdfRealInterval,b:SdfRealInterval) -> SdfRealInterval {
 if(a.valid==0u || b.valid==0u){return sdfIntervalInvalid();}
 let lo=max(a.lo,b.lo);let hi=min(a.hi,b.hi);
 if(lo>hi){return sdfIntervalInvalid();}
 return SdfRealInterval(lo,hi,1u);
}
fn sdfSurfaceTriangle(ray:SdfSurfaceRay,aBits:vec3u,bBits:vec3u,cBits:vec3u) -> SdfSurfaceIntersection {
 let unknown=SdfSurfaceIntersection(2u,0,0,0u);
 let range=sdfIntervalRaw(ray.tRange.x,ray.tRange.y);
 if(ray.valid!=1u || range.valid==0u){return unknown;}
 let o=sdfIntervalVector(ray.originLo,ray.originHi);
 let d=sdfIntervalVector(ray.directionLo,ray.directionHi);
 let a=sdfIntervalVector(aBits,aBits);
 let e1=sdfIntervalVectorSubtract(sdfIntervalVector(bBits,bBits),a);
 let e2=sdfIntervalVectorSubtract(sdfIntervalVector(cBits,cBits),a);
 let p=sdfIntervalCross(d,e2);var det=sdfIntervalDot(e1,p);
 if(det.valid==0u || (det.lo<=0 && det.hi>=0)){return unknown;}
 let s=sdfIntervalVectorSubtract(o,a);let q=sdfIntervalCross(s,e1);
 var u=sdfIntervalDot(s,p);var v=sdfIntervalDot(d,q);var t=sdfIntervalDot(e2,q);
 let frontFace=select(0u,1u,det.lo>0);
 if(det.hi<0){det=sdfIntervalNegate(det);u=sdfIntervalNegate(u);v=sdfIntervalNegate(v);t=sdfIntervalNegate(t);}
 let sum=sdfIntervalAdd(u,v);
 if(u.valid==0u || v.valid==0u || t.valid==0u || sum.valid==0u){return unknown;}
 if(u.hi<0 || v.hi<0 || sum.lo>det.hi){return SdfSurfaceIntersection(0u,0,0,frontFace);}
 let time=sdfIntervalDivide(t,det);
 if(time.valid==0u){return unknown;}
 if(time.hi<range.lo || time.lo>range.hi){return SdfSurfaceIntersection(0u,0,0,frontFace);}
 let lo=max(time.lo,range.lo);let hi=min(time.hi,range.hi);
 if(u.lo>=0 && v.lo>=0 && sum.hi<=det.lo && time.lo>=range.lo && time.hi<=range.hi){
  return SdfSurfaceIntersection(1u,lo,hi,frontFace);
 }
 // Only refine the unresolved path. The cyclic W numerator retains the shared
 // origin dependence lost by adding independently bounded U and V.
 let b=sdfIntervalVector(bBits,bBits);let c=sdfIntervalVector(cBits,cBits);
 var affineV=sdfIntervalDot(s,sdfIntervalCross(e1,d));
 var affineT=sdfIntervalDot(s,sdfIntervalCross(e1,e2));
 var affineW=sdfIntervalDot(sdfIntervalVectorSubtract(b,o),sdfIntervalCross(d,sdfIntervalVectorSubtract(c,b)));
 if(frontFace==0u){affineV=sdfIntervalNegate(affineV);affineT=sdfIntervalNegate(affineT);affineW=sdfIntervalNegate(affineW);}
 let refinedV=sdfSurfaceTriangleTighten(v,affineV);
 let refinedT=sdfSurfaceTriangleTighten(t,affineT);
 let refinedW=sdfSurfaceTriangleTighten(sdfIntervalSubtract(det,sum),affineW);
 let refinedTime=sdfIntervalDivide(refinedT,det);
 if(refinedV.valid==1u && refinedW.valid==1u && refinedTime.valid==1u){
  if(refinedV.hi<0 || refinedW.hi<0 || refinedTime.hi<range.lo || refinedTime.lo>range.hi){
   return SdfSurfaceIntersection(0u,0,0,frontFace);
  }
  if(u.lo>=0 && refinedV.lo>=0 && refinedW.lo>=0 &&
     refinedTime.lo>=range.lo && refinedTime.hi<=range.hi){
   return SdfSurfaceIntersection(1u,refinedTime.lo,refinedTime.hi,frontFace);
  }
 }
 return SdfSurfaceIntersection(2u,lo,hi,frontFace);
}
fn sdfSurfaceSlab(ray:SdfSurfaceRay,loBits:vec3u,hiBits:vec3u) -> SdfSurfaceBounds {
 let unknown=SdfSurfaceBounds(1u,0u,0,0);
 let range=sdfIntervalRaw(ray.tRange.x,ray.tRange.y);
 if(ray.valid!=1u || range.valid==0u){return unknown;}
 var near=range.lo;var far=range.hi;
 let origin=sdfIntervalVector(ray.originLo,ray.originHi);
 let direction=sdfIntervalVector(ray.directionLo,ray.directionHi);
 let boxBounds=sdfIntervalVector(loBits,hiBits);
 if(!sdfIntervalVectorValid(origin) || !sdfIntervalVectorValid(direction) || !sdfIntervalVectorValid(boxBounds)){return unknown;}
 for(var i=0u;i<3u;i++){
  let box=boxBounds.axis[i];let o=origin.axis[i];let d=direction.axis[i];
  if(d.lo==0 && d.hi==0){
   if(o.hi<box.lo || o.lo>box.hi){return SdfSurfaceBounds(0u,1u,near,far);}
   continue;
  }
  if(d.lo<=0 && d.hi>=0){return unknown;}
  let first=sdfIntervalDivide(sdfIntervalSubtract(SdfRealInterval(box.lo,box.lo,1u),o),d);
  let last=sdfIntervalDivide(sdfIntervalSubtract(SdfRealInterval(box.hi,box.hi,1u),o),d);
  if(first.valid==0u || last.valid==0u){return unknown;}
  near=max(near,min(first.lo,last.lo));far=min(far,max(first.hi,last.hi));
  if(near>far){return SdfSurfaceBounds(0u,1u,near,far);}
 }
 return SdfSurfaceBounds(1u,1u,near,far);
}

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
  sdfInstanceWord(row,20u)==4u+row*20u;
}
struct SdfSurfaceDirectory {
 valid:u32, geometryEnd:u32, first:u32, words:u32, nodes:u32, rowLimit:u32, epoch:u32, indexed:u32
}
fn sdfSurfaceDirectoryInvalid() -> SdfSurfaceDirectory {return SdfSurfaceDirectory(0u,0u,0u,0u,0u,0u,0u,0u);}
fn sdfSurfaceDirectory() -> SdfSurfaceDirectory {
 let count=sdfFieldWordCount();let capacity=sdfInstanceRowCount();
 if(count<4u || count>4194304u ||
  capacity==0u || capacity>1024u){return sdfSurfaceDirectoryInvalid();}
 let scene=sdfSurfacePoolVector(0u);let reserved=4u+capacity*24u;
 if(scene.x!=1397966416u || scene.z!=capacity || scene.w<reserved || scene.w>count){return sdfSurfaceDirectoryInvalid();}
 if(scene.y==4u){return SdfSurfaceDirectory(1u,scene.w,0u,0u,0u,0u,0u,0u);}
 if(scene.y!=2147483652u || scene.w<reserved+8u){return sdfSurfaceDirectoryInvalid();}
 let footer=scene.w-8u;
 let a=sdfSurfacePoolVector(footer);let b=sdfSurfacePoolVector(footer+4u);
 let expected=capacity*8u+(2u*capacity-1u)*8u;
 if(a.x!=1396916822u || b.w!=0u || b.z==0u || b.y>capacity ||
  a.y<reserved || a.y>a.z || (a.z&3u)!=0u || a.z>footer || a.w!=expected || a.w!=footer-a.z){return sdfSurfaceDirectoryInvalid();}
 if(b.y==0u){if(b.x!=0u){return sdfSurfaceDirectoryInvalid();}}
 else{if(b.x>2u*b.y-1u){return sdfSurfaceDirectoryInvalid();}}
 return SdfSurfaceDirectory(1u,a.y,a.z,a.w,b.x,b.y,b.z,1u);
}
// The transport first compares its observed source tuple with the independent
// expected facts. Storage World and texture Field share this directory policy.
fn sdfSurfaceExpectedDirectory(rowLimit:u32,expectedSource:vec4u) -> SdfSurfaceDirectory {
 let capacity=sdfInstanceRowCount();let directory=sdfSurfaceDirectory();
 if(expectedSource.w==0u || expectedSource.x%36u!=0u ||
  expectedSource.x/36u!=capacity || expectedSource.y!=sdfFieldWordCount() ||
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
 return positions.y>=3u && positions.y<=1048576u &&
  triangles.y>=1u && triangles.y<=1048576u &&
  nodes.y>=1u && nodes.y<=2097151u &&
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
 let first=4u+capacity*20u+row*4u;
 let record=sdfSurfacePoolVector(first);
 if(record.x!=row || record.y!=primitives || record.z>2u){return vec3u(0);}
 if(record.z<2u){if(record.w!=0u){return vec3u(0);}return vec3u(1u,record.z,0u);}
 let start=4u+capacity*24u;
 let pointer=record.w;
 if(pointer<start || (pointer&3u)!=0u || pointer>meshFirst){return vec3u(0);}
 if(4u>meshFirst-pointer){return vec3u(0);}
 let payload=sdfSurfacePoolVector(pointer);let count=(primitives+31u)/32u;
 if(payload.x!=1396920150u || payload.y!=primitives || payload.z!=count || payload.w!=0u){return vec3u(0);}
 if(((count+3u)/4u)*4u>meshFirst-pointer-4u){return vec3u(0);}
 let bits=pointer+4u;let tail=primitives&31u;
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
 let reserved=4u+capacity*24u;
 let first=4u+row*20u;
 let a=sdfSurfacePoolVector(first);let b=sdfSurfacePoolVector(first+4u);
 let c=sdfSurfacePoolVector(first+8u);let d=sdfSurfacePoolVector(first+12u);let e=sdfSurfacePoolVector(first+16u);
 if(a.z!=1u || a.w!=4u+capacity*20u+row*4u || b.w>1u ||
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

struct SdfSurfaceTrace {
 state:u32, row:u32, primitive:u32, frontFace:u32,
 lower:f32, upper:f32, uncertain:f32, reserved:u32, prefixSamples:u32, hasUncertainty:u32
}
fn sdfSurfaceTraceEmpty(last:f32) -> SdfSurfaceTrace {
 return SdfSurfaceTrace(0u,0xffffffffu,0xffffffffu,0u,last,last,last,0u,0u,0u);
}
fn sdfSurfaceRayUsable(ray:SdfSurfaceRay) -> bool {
 return ray.valid==1u && sdfIntervalRaw(ray.tRange.x,ray.tRange.y).valid==1u &&
  sdfIntervalVectorValid(sdfIntervalVector(ray.originLo,ray.originHi)) &&
  sdfIntervalVectorValid(sdfIntervalVector(ray.directionLo,ray.directionHi));
}
fn sdfSurfaceCharge(remaining:ptr<function,u32>) -> bool {
 if(*remaining==0u){return false;}*remaining-=1u;return true;
}
struct SdfSurfacePrefix { end:f32, samples:u32, valid:u32 }
fn sdfSurfaceIntervalMagnitude(a:SdfRealInterval) -> SdfRealInterval {
 if(a.valid==0u){return sdfIntervalInvalid();}
 return sdfIntervalPoint(bitcast<u32>(max(abs(a.lo),abs(a.hi))));
}
// Source certificate E bounds the stored f32 magnitude against capped unsigned
// distance. Nearest SNORM encoding adds <one code unit band/32767, including
// binary64 encoder rounding. Interval operations cover GPU arithmetic and the
// canonical fround(origin+fround(index*spacing)) lattice reconstruction.
// D(P)>=max(0,abs(code)*band/32767-band/32767-E-|P-C|_1).
// Dividing by |direction|_1 gives an empty prefix in the ORIGINAL ray parameter.
fn sdfSurfaceRootPrefix(row:u32,packet:SdfSurfacePacket,ray:SdfSurfaceRay) -> SdfSurfacePrefix {
 let none=SdfSurfacePrefix(0,0u,0u);
 if(packet.valid!=1u || packet.prefixEligible!=1u || ray.valid!=1u ||
  sdfInstanceWord(row,35u)!=0x40000000u){return none;}
 let dimensions=vec3u(sdfInstanceWord(row,21u),sdfInstanceWord(row,22u),sdfInstanceWord(row,23u));
 if(any(dimensions==vec3u(0)) || any(dimensions>vec3u(16777216u))){return none;}
 let spacing=sdfIntervalPoint(sdfInstanceWord(row,27u));
 let band=sdfIntervalPoint(sdfInstanceWord(row,31u));
 if(spacing.valid==0u || band.valid==0u || spacing.lo<=0 || band.lo<=0){return none;}
 let origin=sdfIntervalVector(ray.originLo,ray.originHi);
 let direction=sdfIntervalVector(ray.directionLo,ray.directionHi);
 let first=sdfIntervalPoint(ray.tRange.x);
 if(!sdfIntervalVectorValid(origin) || !sdfIntervalVectorValid(direction) || first.valid==0u){return none;}
 var cell:vec3u;var radius=sdfIntervalZero();var speed=sdfIntervalZero();
 for(var axis=0u;axis<3u;axis++){
  let latticeOrigin=sdfIntervalPoint(sdfInstanceWord(row,24u+axis));
  let position=sdfIntervalAdd(origin.axis[axis],sdfIntervalMultiply(direction.axis[axis],first));
  let coordinate=sdfIntervalDivide(sdfIntervalSubtract(position,latticeOrigin),spacing);
  if(coordinate.valid==0u){return none;}
  // Any in-range lattice point is sound; nearest-cell accuracy is not a premise.
  cell[axis]=u32(clamp(floor(coordinate.lo),0.0,f32(dimensions[axis]-1u)));
  let index=sdfIntervalPoint(bitcast<u32>(f32(cell[axis])));
  let corner=sdfIntervalAdd(latticeOrigin,sdfIntervalMultiply(index,spacing));
  radius=sdfIntervalAdd(radius,sdfSurfaceIntervalMagnitude(sdfIntervalSubtract(position,corner)));
  speed=sdfIntervalAdd(speed,sdfSurfaceIntervalMagnitude(direction.axis[axis]));
 }
 if(radius.valid==0u || speed.valid==0u || speed.hi<=0){return none;}
 let sample=sdfSurfaceSampleCode(packet,dimensions,cell);
 if(sample.x==0u){return SdfSurfacePrefix(0,sample.z,0u);}
 let magnitude=min(sample.y,65536u-sample.y);
 let unit=sdfIntervalDivide(band,sdfIntervalPoint(bitcast<u32>(32767.0)));
 let quantized=sdfIntervalMultiply(sdfIntervalPoint(bitcast<u32>(f32(magnitude))),unit);
 let error=sdfIntervalPoint(packet.coefficients.x);
 let distance=sdfIntervalSubtract(sdfIntervalSubtract(sdfIntervalSubtract(quantized,unit),error),radius);
 if(distance.valid==0u || distance.lo<=0){return SdfSurfacePrefix(0,1u,0u);}
 let time=sdfIntervalDivide(sdfIntervalPoint(bitcast<u32>(distance.lo)),sdfIntervalPoint(bitcast<u32>(speed.hi)));
 let end=sdfIntervalAdd(first,time);
 if(end.valid==0u || end.lo<=first.lo){return SdfSurfacePrefix(0,1u,0u);}
 return SdfSurfacePrefix(end.lo,1u,1u);
}
fn sdfSurfaceVertex(packet:SdfSurfacePacket,index:u32) -> vec3u {
 let first=packet.positions.x+index*3u;
 return vec3u(sdfFieldWord(first),sdfFieldWord(first+1u),sdfFieldWord(first+2u));
}
fn sdfSurfaceSegmentEnclosure(ray:SdfSurfaceRay) -> SdfIntervalVector {
 var segment:SdfIntervalVector;
 let origin=sdfIntervalVector(ray.originLo,ray.originHi);
 let direction=sdfIntervalVector(ray.directionLo,ray.directionHi);
 let time=sdfIntervalRaw(ray.tRange.x,ray.tRange.y);
 if(!sdfIntervalVectorValid(origin) || !sdfIntervalVectorValid(direction) || time.valid==0u){return segment;}
 for(var axis=0u;axis<3u;axis++){
  segment.axis[axis]=sdfIntervalAdd(origin.axis[axis],sdfIntervalMultiply(direction.axis[axis],time));
 }
 return segment;
}
fn sdfSurfaceSegmentBoundsClear(segment:ptr<function,SdfIntervalVector>,lo:vec3u,hi:vec3u) -> bool {
 let bounds=sdfIntervalVector(lo,hi);
 if(!sdfIntervalVectorValid(bounds)){return false;}
 for(var axis=0u;axis<3u;axis++){
  let position=(*segment).axis[axis];
  if(position.valid!=0u && (position.hi<bounds.axis[axis].lo || position.lo>bounds.axis[axis].hi)){return true;}
 }
 return false;
}
fn sdfSurfaceSegmentBoxClear(ray:SdfSurfaceRay,lo:vec3u,hi:vec3u) -> bool {
 var segment=sdfSurfaceSegmentEnclosure(ray);
 return sdfSurfaceSegmentBoundsClear(&segment,lo,hi);
}
fn sdfSurfaceInverse(row:u32) -> array<vec4u,4> {
 var inverse:array<vec4u,4>;
 for(var column=0u;column<4u;column++){
  let first=column*4u;
  inverse[column]=vec4u(sdfInstanceWord(row,first),sdfInstanceWord(row,first+1u),sdfInstanceWord(row,first+2u),sdfInstanceWord(row,first+3u));
 }
 return inverse;
}
fn sdfSurfaceLeafTrianglePrepared(packet:SdfSurfacePacket,slot:u32,ray:SdfSurfaceRay,segment:ptr<function,SdfIntervalVector>) -> SdfSurfaceTrace {
 var out=sdfSurfaceTraceEmpty(bitcast<f32>(ray.tRange.y));
 if(slot>=packet.order.y){out.state=2u;out.lower=bitcast<f32>(ray.tRange.x);return out;}
 let primitive=sdfFieldWord(packet.order.x+slot);
 if(primitive>=packet.triangles.y){out.state=2u;out.lower=bitcast<f32>(ray.tRange.x);return out;}
 let first=packet.triangles.x+primitive*3u;
 let indices=vec3u(sdfFieldWord(first),sdfFieldWord(first+1u),sdfFieldWord(first+2u));
 if(any(indices>=vec3u(packet.positions.y))){out.state=2u;out.lower=bitcast<f32>(ray.tRange.x);return out;}
 let a=sdfSurfaceVertex(packet,indices.x);let b=sdfSurfaceVertex(packet,indices.y);let c=sdfSurfaceVertex(packet,indices.z);
 for(var axis=0u;axis<3u;axis++){
  if(!sdfSurfaceBitsUsable(a[axis]) || !sdfSurfaceBitsUsable(b[axis]) || !sdfSurfaceBitsUsable(c[axis])){out.state=2u;out.lower=bitcast<f32>(ray.tRange.x);return out;}
 }
 let lo=bitcast<vec3u>(min(bitcast<vec3f>(a),min(bitcast<vec3f>(b),bitcast<vec3f>(c))));
 let hi=bitcast<vec3u>(max(bitcast<vec3f>(a),max(bitcast<vec3f>(b),bitcast<vec3f>(c))));
 if(sdfSurfaceSegmentBoundsClear(segment,lo,hi)){return out;}
 let hit=sdfSurfaceTriangle(ray,a,b,c);
 out.state=hit.state;out.primitive=primitive;out.frontFace=hit.frontFace;
 // Unknown alpha can remove geometry, but cannot create a certified opaque hit.
 // Keep the actual intersection lower bound so only prior/equal unknown blocks.
 if(hit.state==1u && !sdfSurfacePrimitiveOpaque(packet,primitive)){out.state=2u;}
 out.reserved=(sdfFieldWord(packet.sidedness.x+(primitive>>5u))>>(primitive&31u))&1u;
 out.lower=hit.tLower;out.upper=hit.tUpper;return out;
}
fn sdfSurfaceLeafTriangle(packet:SdfSurfacePacket,slot:u32,ray:SdfSurfaceRay) -> SdfSurfaceTrace {
 var segment=sdfSurfaceSegmentEnclosure(ray);
 return sdfSurfaceLeafTrianglePrepared(packet,slot,ray,&segment);
}
fn sdfSurfacePrimitiveAxisPlane(packet:SdfSurfacePacket,primitive:u32,axis:u32) -> vec2u {
 if(packet.valid!=1u || primitive>=packet.triangles.y || axis>=3u){return vec2u(0u);}
 let first=packet.triangles.x+primitive*3u;
 let indices=vec3u(sdfFieldWord(first),sdfFieldWord(first+1u),sdfFieldWord(first+2u));
 if(any(indices>=vec3u(packet.positions.y))){return vec2u(0u);}
 let a=sdfFieldWord(packet.positions.x+indices.x*3u+axis);
 let b=sdfFieldWord(packet.positions.x+indices.y*3u+axis);
 let c=sdfFieldWord(packet.positions.x+indices.z*3u+axis);
 if(!sdfSurfaceBitsUsable(a) || a!=b || a!=c){return vec2u(0u);}
 return vec2u(1u,a);
}
// Both hits must come from this packet and the same original local ray.
// Certified intersections with one identical authored axis plane have the same
// exact parameter for each ray, even when their numeric intervals are not points.
// Numeric interval equality alone is never this certificate.
fn sdfSurfaceAcceptAxisTie(best:ptr<function,SdfSurfaceTrace>,hit:SdfSurfaceTrace,packet:SdfSurfacePacket) -> bool {
 if((*best).state!=1u || hit.state!=1u || hit.primitive==(*best).primitive ||
  hit.upper<(*best).lower || hit.lower>(*best).upper){return false;}
 // Preserve the existing exact-point/signed-zero path byte for byte.
 if((*best).lower==(*best).upper && hit.lower==hit.upper){return false;}
 if(!sdfSurfacePrimitiveOpaque(packet,(*best).primitive) || !sdfSurfacePrimitiveOpaque(packet,hit.primitive)){return false;}
 for(var axis=0u;axis<3u;axis++){
  let a=sdfSurfacePrimitiveAxisPlane(packet,(*best).primitive,axis);
  let b=sdfSurfacePrimitiveAxisPlane(packet,hit.primitive,axis);
  if(a.x==1u && b.x==1u && a.y==b.y){
   let lower=max((*best).lower,hit.lower);let upper=min((*best).upper,hit.upper);
   if(hit.primitive<(*best).primitive){
    let uncertain=(*best).uncertain;let hasUncertainty=(*best).hasUncertainty;
    *best=hit;(*best).uncertain=uncertain;(*best).hasUncertainty=hasUncertainty;
   }
   // Equal exact t is in both intervals. Never widen a bound already used to prune.
   (*best).lower=lower;(*best).upper=upper;
   return true;
  }
 }
 return false;
}
fn sdfSurfaceAccept(best:ptr<function,SdfSurfaceTrace>,hit:SdfSurfaceTrace) {
 if(hit.state==2u){(*best).uncertain=min((*best).uncertain,hit.lower);(*best).hasUncertainty=1u;return;}
 if(hit.state!=1u){return;}
 if((*best).state==0u || hit.upper<(*best).lower){
  let uncertain=(*best).uncertain;let hasUncertainty=(*best).hasUncertainty;
  *best=hit;(*best).uncertain=uncertain;(*best).hasUncertainty=hasUncertainty;return;
 }
 if(hit.lower>(*best).upper){return;}
 if(hit.primitive!=(*best).primitive){
  // This reducer visits one packet. Two certified point intersections at
  // exactly the same parameter are genuine ties, not interval overlap.
  // Choose the smaller primitive without discarding a prior unknown.
  if(hit.lower==hit.upper){
   if((*best).lower==(*best).upper){
    if(hit.lower==(*best).lower){
     if(hit.primitive<(*best).primitive){
      let uncertain=(*best).uncertain;let hasUncertainty=(*best).hasUncertainty;
      *best=hit;(*best).uncertain=uncertain;(*best).hasUncertainty=hasUncertainty;
     }
     return;
    }
   }
  }
  // A different primitive is never inferred from approximate overlap.
  (*best).uncertain=min((*best).uncertain,min(hit.lower,(*best).lower));(*best).hasUncertainty=1u;
 }
 (*best).lower=min((*best).lower,hit.lower);(*best).upper=min((*best).upper,hit.upper);
}
fn sdfSurfaceTraceRow(row:u32,world:SdfSurfaceRay,remaining:ptr<function,u32>) -> SdfSurfaceTrace {
 if(!sdfSurfaceRayUsable(world)){return SdfSurfaceTrace(2u,row,0xffffffffu,0u,0,0,0,0u,0u,1u);}
 let last=bitcast<f32>(world.tRange.y);let first=bitcast<f32>(world.tRange.x);
 var best=sdfSurfaceTraceEmpty(last);best.row=row;
 let packet=sdfSurfacePacket(row);
 if(packet.valid==0u){best.state=2u;best.lower=first;return best;}
 let ray=sdfSurfaceLocalRay(world,sdfSurfaceInverse(row),packet.coefficients.yz);
 if(ray.valid==0u){best.state=2u;best.lower=first;return best;}
 var segment=sdfSurfaceSegmentEnclosure(ray);
 var node=0u;var prefix=SdfSurfacePrefix(0,0u,0u);
 loop {
  if(node>=packet.nodes.y){break;}
  if(!sdfSurfaceCharge(remaining)){best.state=3u;best.lower=first;return best;}
  let at=packet.nodes.x+node*8u;
  let escape=sdfFieldWord(at+3u);let leaf=sdfFieldWord(at+7u);
  if(escape<=node || escape>packet.nodes.y){best.state=2u;best.lower=first;return best;}
  let lo=vec3u(sdfFieldWord(at),sdfFieldWord(at+1u),sdfFieldWord(at+2u));
  let hi=vec3u(sdfFieldWord(at+4u),sdfFieldWord(at+5u),sdfFieldWord(at+6u));
  if(sdfSurfaceSegmentBoundsClear(&segment,lo,hi)){node=escape;continue;}
  let bounds=sdfSurfaceSlab(ray,lo,hi);
  // A later node cannot resolve geometry before the earliest unknown.
  // Keep the closed boundary and unqualified slabs on the original path.
  var traversalLimit=best.upper;
  if(best.hasUncertainty==1u){traversalLimit=min(traversalLimit,best.uncertain);}
  if(bounds.certified==1u && (bounds.possible==0u || bounds.near>traversalLimit)){node=escape;continue;}
  if(node==0u){prefix=sdfSurfaceRootPrefix(row,packet,ray);best.prefixSamples=prefix.samples;}
  // Strict far comparison preserves closed endpoints, primitive/facing identity
  // and every original slab/triangle input. Failure simply keeps the old path.
  if(prefix.valid==1u && bounds.certified==1u && bounds.far<prefix.end){node=escape;continue;}
  let count=leaf&3u;let start=leaf>>2u;
  if(count==0u){
   if(start>=packet.order.y || node+1u>=escape){best.state=2u;best.lower=first;return best;}
   node++;continue;
  }
  if(count>2u || start>packet.order.y || count>packet.order.y-start || escape!=node+1u){best.state=2u;best.lower=first;return best;}
  for(var slot=0u;slot<count;slot++){
   if(!sdfSurfaceCharge(remaining)){best.state=3u;best.lower=first;return best;}
   let hit=sdfSurfaceLeafTrianglePrepared(packet,start+slot,ray,&segment);
   if(!sdfSurfaceAcceptAxisTie(&best,hit,packet)){sdfSurfaceAccept(&best,hit);}best.row=row;best.prefixSamples=prefix.samples;
  }
  node=escape;
 }
 // Presence is independent of the bound: an unknown at the closed endpoint
 // must not collide with the empty trace's initial numeric bound.
 if(best.hasUncertainty==1u && best.uncertain<=best.upper){best.state=2u;best.lower=min(best.lower,best.uncertain);}
 return best;
}


struct SdfSurfaceCandidates { rows:array<u32,32>, state:u32, nodeVisits:u32 }
fn sdfSurfaceCandidatesUnknown(visits:u32) -> SdfSurfaceCandidates {
 var out:SdfSurfaceCandidates;out.state=2u;out.nodeVisits=visits;return out;
}
fn sdfSurfaceCandidateContains(candidates:ptr<function,SdfSurfaceCandidates>,row:u32) -> bool {
 return (*candidates).state!=2u && row<1024u && ((*candidates).rows[row>>5u]&(1u<<(row&31u)))!=0u;
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
 let at=directory.first+row*8u;
 let a=sdfSurfacePoolVector(at);let b=sdfSurfacePoolVector(at+4u);
 if(a.w>1u || b.w!=0u || a.w!=select(0u,1u,(flags&0x40000000u)!=0u)){return false;}
 return all(a.xyz==lo) && all(b.xyz==hi);
}
fn sdfSurfaceCandidateChildrenValid(first:u32,node:u32,escape:u32,count:u32) -> bool {
 if(node+1u>=escape){return false;}
 let left=first+(node+1u)*8u;
 let right=sdfFieldWord(left+7u);
 if(right<=node+1u || right>=escape || right>=count){return false;}
 return sdfFieldWord(first+right*8u+7u)==escape;
}
// Candidate directory work is separately bounded and reported. It never
// consumes or increases the caller's original Mesh/triangle/sample ledger.
fn sdfSurfaceSceneCandidates(world:SdfSurfaceRay,rowLimit:u32,mask:u32,actualSource:vec4u,expectedSource:vec4u) -> SdfSurfaceCandidates {
 var out:SdfSurfaceCandidates;
 let capacity=sdfInstanceRowCount();let directory=sdfSurfaceExpectedDirectory(rowLimit,expectedSource);
 if(any(actualSource!=expectedSource) || directory.valid==0u || !sdfSurfaceRayUsable(world)){
  return sdfSurfaceCandidatesUnknown(0u);
 }
 var selected=0u;
 for(var row=0u;row<rowLimit;row++){
  if((sdfInstanceMask(row)&mask)==0u){continue;}
  if(!sdfInstanceValid(row)){return sdfSurfaceCandidatesUnknown(0u);}selected++;
 }
 if(directory.indexed==0u){
  out.state=1u;
  for(var row=0u;row<rowLimit;row++){
   if((sdfInstanceMask(row)&mask)!=0u){out.rows[row>>5u]|=1u<<(row&31u);}
  }
  return out;
 }
 if(selected>0u && directory.nodes<2u*selected-1u){return sdfSurfaceCandidatesUnknown(0u);}
 let first=directory.first+capacity*8u;
 var node=0u;
 loop {
  if(node>=directory.nodes){break;}
  if(out.nodeVisits>=2u*capacity-1u){return sdfSurfaceCandidatesUnknown(out.nodeVisits);}
  out.nodeVisits++;
  let at=first+node*8u;
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

fn sdfFieldWordCount() -> u32 { return arrayLength(&fields); }
fn sdfFieldWord(index:u32) -> u32 {
 if(index>=sdfFieldWordCount()){return 0u;}return fields[index];
}
fn sdfSceneObservedRayUsable(ray:Ray) -> bool {
 return sdfSurfaceRayUsable(SdfSurfaceRay(bitcast<vec3u>(ray.origin),bitcast<vec3u>(ray.origin),
  bitcast<vec3u>(ray.direction),bitcast<vec3u>(ray.direction),bitcast<vec2u>(vec2f(ray.tMin,ray.tMax)),1u));
}
fn sdfSceneSurfaceReady(count:u32,mask:u32) -> bool {
 let words=sdfFieldWordCount();let capacity=sdfInstanceRowCount();
 if(words<4u || words>4194304u || capacity==0u || capacity>1024u){return false;}
 let scene=sdfSurfacePoolVector(0u);
 if(scene.x!=1397966416u || (scene.y!=4u && scene.y!=2147483652u) || scene.z!=capacity ||
    scene.w<4u+capacity*24u || scene.w>words){return false;}
 if(count>sdfInstanceRowCount()){return false;}
 for(var row=0u;row<count;row++){
  if((sdfInstanceMask(row)&mask)==0u){continue;}
  if(!sdfInstanceValid(row) || sdfInstanceWord(row,35u)!=0x40000000u ||
     sdfInstanceWord(row,20u)!=4u+row*20u || sdfSurfacePacket(row).valid==0u){return false;}
 }
 return true;
}
fn sdfSceneSurfaceTraceRows(ray:Ray,count:u32,remaining:ptr<function,u32>,candidates:ptr<function,SdfSurfaceCandidates>) -> SdfSurfaceTrace {
 var best=sdfSurfaceTraceEmpty(ray.tMax);
 if((*candidates).state==2u || count>sdfInstanceRowCount() || count>1024u){best.state=2u;best.lower=ray.tMin;return best;}
 let world=SdfSurfaceRay(bitcast<vec3u>(ray.origin),bitcast<vec3u>(ray.origin),
  bitcast<vec3u>(ray.direction),bitcast<vec3u>(ray.direction),bitcast<vec2u>(vec2f(ray.tMin,ray.tMax)),1u);
 for(var row=0u;row<count;row++){
  if(!sdfSurfaceCandidateContains(candidates,row)){continue;}
  // A culled legal missing row needs no packet. A retained row must still
  // name its own canonical packet in the sampled-surface mode.
  if(!sdfSurfaceRowAssociated(row)){
   best.uncertain=min(best.uncertain,ray.tMin);best.hasUncertainty=1u;continue;
  }
  var hit=sdfSurfaceTraceRow(row,world,remaining);
  if(hit.state==3u){
   best.state=3u;best.lower=ray.tMin;return best;
  }
  if(hit.state==2u){best.uncertain=min(best.uncertain,hit.lower);best.hasUncertainty=1u;continue;}
  if(hit.state==0u){continue;}
  if(best.state==0u || hit.upper<best.lower){
   let uncertain=best.uncertain;let hasUncertainty=best.hasUncertainty;
   best=hit;best.uncertain=uncertain;best.hasUncertainty=hasUncertainty;
  }else if(hit.lower<=best.upper){
   best.uncertain=min(best.uncertain,min(best.lower,hit.lower));best.hasUncertainty=1u;
  }
 }
 if(best.hasUncertainty==1u && best.uncertain<=best.upper){
  best.state=2u;best.lower=min(best.lower,best.uncertain);return best;
 }
 return best;
}
// Full-roster exact reference/fallback entry. World admission and epoch checks
// live at traceWorld; this low-level entry does not qualify a Scene source.
fn sdfSceneSurfaceTrace(ray:Ray,count:u32,remaining:ptr<function,u32>) -> SdfSurfaceTrace {
 var candidates:SdfSurfaceCandidates;candidates.state=1u;
 if(count>sdfInstanceRowCount() || count>1024u){candidates.state=2u;}
 else{
  for(var row=0u;row<count;row++){
   if((sdfInstanceMask(row)&ray.mask.x)!=0u){candidates.rows[row>>5u]|=1u<<(row&31u);}
  }
 }
 return sdfSceneSurfaceTraceRows(ray,count,remaining,&candidates);
}
struct SdfScenePoint { position:vec3f, error:f32, valid:u32 }
fn sdfSceneRepresentative(value:SdfRealInterval) -> SdfRealInterval {
 if(value.valid==0u){return sdfIntervalInvalid();}
 let lo=bitcast<u32>(value.lo);let hi=bitcast<u32>(value.hi);
 let checked=sdfIntervalRaw(lo,hi);
 if(checked.valid==0u || (lo&0x7fffffffu)>0x7e800000u || (hi&0x7fffffffu)>0x7e800000u){return sdfIntervalInvalid();}
 // Both endpoints are finite and bounded before ordinary FP. Each half has
 // magnitude<=2^125; adding the halves cannot overflow. Underflow/FTZ of a
 // small representative is covered by the caller's interval radius.
 return sdfIntervalPoint(bitcast<u32>(checked.lo*0.5+checked.hi*0.5));
}
fn sdfSceneSurfacePoint(ray:Ray,best:SdfSurfaceTrace) -> SdfScenePoint {
 let origin=sdfIntervalVector(bitcast<vec3u>(ray.origin),bitcast<vec3u>(ray.origin));
 let direction=sdfIntervalVector(bitcast<vec3u>(ray.direction),bitcast<vec3u>(ray.direction));
 let time=sdfIntervalRaw(bitcast<u32>(best.lower),bitcast<u32>(best.upper));
 var point=SdfScenePoint(vec3f(0),0,0u);var radius=sdfIntervalZero();
 for(var axis=0u;axis<3u;axis++){
  let value=sdfIntervalAdd(origin.axis[axis],sdfIntervalMultiply(direction.axis[axis],time));
  if(value.valid==0u){return point;}
  let representative=sdfSceneRepresentative(value);
  if(representative.valid==0u){return point;}
  let delta=sdfIntervalSubtract(value,representative);
  if(delta.valid==0u){return point;}
  point.position[axis]=representative.lo;
  radius=sdfIntervalAdd(radius,sdfIntervalPoint(bitcast<u32>(max(abs(delta.lo),abs(delta.hi)))));
 }
 if(radius.valid==0u){return point;}point.error=radius.hi;point.valid=1u;return point;
}
fn sdfSceneSurfaceNormal(best:SdfSurfaceTrace) -> vec4f {
 let packet=sdfSurfacePacket(best.row);let first=packet.triangles.x+best.primitive*3u;
 let a=sdfSurfaceVertex(packet,sdfFieldWord(first));
 let b=sdfSurfaceVertex(packet,sdfFieldWord(first+1u));
 let c=sdfSurfaceVertex(packet,sdfFieldWord(first+2u));
 let origin=sdfIntervalVector(a,a);
 let normal=sdfIntervalCross(sdfIntervalVectorSubtract(sdfIntervalVector(b,b),origin),sdfIntervalVectorSubtract(sdfIntervalVector(c,c),origin));
 let inverse=sdfSurfaceInverse(best.row);var center=vec3f(0);
 for(var axis=0u;axis<3u;axis++){
  var value=sdfIntervalZero();
  for(var local=0u;local<3u;local++){
   value=sdfIntervalAdd(value,sdfIntervalMultiply(normal.axis[local],sdfIntervalPoint(inverse[axis][local])));
  }
  let representative=sdfSceneRepresentative(value);
  if(representative.valid==0u){return vec4f(0);}
  center[axis]=representative.lo;
 }
 let scale=max(abs(center.x),max(abs(center.y),abs(center.z)));
 let scaleBits=bitcast<u32>(scale);
 if(scaleBits<0x00800000u || scaleBits>0x7e800000u){return vec4f(0);}
 let unit=center/scale;return vec4f(unit/length(unit),1);
}
fn sdfSceneSurfaceHit(ray:Ray,best:SdfSurfaceTrace) -> SdfHit {
 var hit=SdfHit(vec4u(0u,0xffffffffu,0xffffffffu,0xffffffffu),vec4f(best.lower,0,0,0),vec4f(0),vec4f(0));
 if(best.state==2u){hit.state.x=4u;return hit;}
 if(best.state==3u){hit.state.x=3u;return hit;}
 if(best.state==0u){return hit;}
 let m=sdfInstanceAt(best.row);let t=best.lower;
 let point=sdfSceneSurfacePoint(ray,best);let normal=sdfSceneSurfaceNormal(best);
 if(point.valid==0u || normal.w==0.0){hit.state.x=4u;return hit;}
 // Identity and facing come from the certified primitive, never from a
 // second point-candidate search. The representative normal is derived from
 // that primitive and the stored inverse, not a blended field gradient.
 return SdfHit(vec4u(1u,m.ids.xyz),
  vec4f(t,point.error,0,0),vec4f(point.position,1),vec4f(select(normal.xyz,-normal.xyz,best.reserved==1u && best.frontFace==0u),0));
}


struct Grid { originSpacing: vec4f, dimensionsCount: vec4u, ranges: vec4f, source:vec4u }
struct Voxel { distance: f32, coverage: f32, status: u32, nearestInstance: u32 }
struct Sample { distance: f32, coverage: f32, status: u32 }
fn sampleGlobal(p: vec3f) -> Sample {
 let dims=grid.dimensionsCount.xyz;
 let q=clamp((p-grid.originSpacing.xyz)/grid.originSpacing.w,vec3f(0),vec3f(dims-vec3u(1u)));
 let cell=vec3u(min(floor(q),vec3f(dims-vec3u(2u))));let f=q-vec3f(cell);
 var result=Sample(0,0,1u);
 for(var z=0u;z<2u;z++){for(var y=0u;y<2u;y++){for(var x=0u;x<2u;x++){
  let offset=vec3u(x,y,z);let w=select(vec3f(1)-f,f,offset>vec3u(0));let weight=w.x*w.y*w.z;
  if(weight>0.0){
   let c=cell+offset;let v=voxels[(c.z*dims.y+c.y)*dims.x+c.x];
   if(v.status!=1u){return Sample(0,0,v.status);}
   result.distance+=v.distance*weight;result.coverage+=v.coverage*weight;
  }
 }}}
 return result;
}

@group(0) @binding(0) var<storage,read> voxels: array<Voxel>;
@group(0) @binding(1) var<uniform> grid: Grid;
@group(0) @binding(2) var<storage,read> instances: array<RawInstance>;
@group(0) @binding(3) var<storage,read> fields: array<u32>;
@group(0) @binding(4) var<storage,read> bounds: array<vec4u>;


struct ObjectBounds { lo:vec4f, hi:vec4f, scale:vec4f }
fn worldBoundsWord(word:u32)->u32 {return bounds[word>>2u][word&3u];}
fn worldBoundsValid(count:u32)->bool {
 if(arrayLength(&bounds)<6u){return false;}
 let a=bounds[0];let b=bounds[1];let words=arrayLength(&bounds)*4u;
 return a.x==1463963697u&&a.y==1u&&a.z==count&&
  count<=a.w&&a.w<=1024u&&count<=arrayLength(&instances)&&b.x==6u&&b.y==max(1u,a.w)*3u&&b.z==1u&&
  (b.x+b.y)*4u<=words&&bounds[5].w==words&&words<=309404u;
}
fn worldBoundsAt(row:u32)->ObjectBounds {
 let first=bounds[1].x+row*3u;
 return ObjectBounds(bitcast<vec4f>(bounds[first]),bitcast<vec4f>(bounds[first+1u]),bitcast<vec4f>(bounds[first+2u]));
}
fn worldBoundsIndexValid(count:u32,radius:f32)->bool {
 if(!worldBoundsValid(count)||bounds[1].w!=1u){return false;}
 let shape=bounds[2];let grid=bitcast<vec4f>(bounds[3]);let spans=bounds[4];let tail=bounds[5];
 if(any(shape.xyz<vec3u(1u))||any(shape.xyz>vec3u(32u))||bitcast<f32>(shape.w)!=radius||
  !all(abs(grid.xyz)<=vec3f(3.402823466e+38))||!(grid.w>0.0)||grid.w>3.402823466e+38){return false;}
 let cells=shape.x*shape.y*shape.z;let first=(bounds[1].x+bounds[1].y)*4u;
 if(any((vec4u(spans.x,spans.y,spans.w,tail.y)&vec4u(3u))!=vec4u(0u))){return false;}
 return spans.x>=first&&spans.x<=tail.w&&cells+1u<=tail.w-spans.x&&
  spans.y>=spans.x+cells+1u&&spans.y<=tail.w&&spans.z<=262144u&&spans.z<=tail.w-spans.y&&
  spans.w>=spans.y+spans.z&&spans.w<=tail.w&&tail.x<=128u&&tail.x<=tail.w-spans.w&&
  tail.y>=spans.w+tail.x&&tail.y<=tail.w&&tail.z<=count&&tail.z*2u<=tail.w-tail.y;
}
// x=0: full roster [y,z). x=1: remaining CSR [y,z), next oversized index w.
fn worldBoundsCursor(position:vec3f,count:u32,radius:f32)->vec4u {
 let scan=vec4u(0u,0u,count,0u);
 if(!worldBoundsIndexValid(count,radius)){return scan;}
 let dims=bounds[2].xyz;let grid=bitcast<vec4f>(bounds[3]);let q=(position-grid.xyz)/grid.w;
 // Outside the admitted index domain retains the complete original scan.
 if(!all(abs(q)<=vec3f(3.402823466e+38))||any(q<vec3f(0))||any(q>=vec3f(dims))){return scan;}
 let cell=vec3u(floor(q));let linear=(cell.z*dims.y+cell.y)*dims.x+cell.x;
 let start=worldBoundsWord(bounds[4].x+linear);let end=worldBoundsWord(bounds[4].x+linear+1u);
 if(start>end||end>bounds[4].z){return scan;}
 for(var k=0u;k<bounds[5].x;k++){if(worldBoundsWord(bounds[4].w+k)>=count){return scan;}}
 for(var k=start;k<end;k++){if(worldBoundsWord(bounds[4].y+k)>=count){return scan;}}
 return vec4u(1u,start,end,0u);
}
fn worldBoundsCursorCount(cursor:vec4u)->u32 {
 if(cursor.x==0u){return cursor.z-cursor.y;}
 return cursor.z-cursor.y+bounds[5].x-cursor.w;
}
fn worldBoundsCursorRow(cursor:ptr<function,vec4u>)->u32 {
 let current=*cursor;
 if(current.x==0u){(*cursor).y++;return current.y;}
 var extra=0xffffffffu;var regular=0xffffffffu;
 if(current.w<bounds[5].x){extra=worldBoundsWord(bounds[4].w+current.w);}
 if(current.y<current.z){regular=worldBoundsWord(bounds[4].y+current.y);}
 // Both streams are canonical-row sorted. Merge without changing tie order.
 if(extra<regular){(*cursor).w++;return extra;}
 (*cursor).y++;return regular;
}
fn worldBoundsRowForId(id:u32,count:u32,radius:f32)->u32 {
 if(!worldBoundsValid(count)){return 0xffffffffu;}
 if(worldBoundsIndexValid(count,radius)){
  var lo=0u;var hi=bounds[5].z;
  while(lo<hi){let mid=lo+(hi-lo)/2u;let key=worldBoundsWord(bounds[5].y+mid*2u);if(key<id){lo=mid+1u;}else{hi=mid;}}
  if(lo<bounds[5].z&&worldBoundsWord(bounds[5].y+lo*2u)==id){
   let row=worldBoundsWord(bounds[5].y+lo*2u+1u);
   if(row<count&&sdfInstanceWord(row,16u)==id){return row;}
  }
 }
 // Incomplete/malformed identity acceleration never hides a canonical instance.
 for(var i=0u;i<count;i++){if(sdfInstanceWord(i,16u)==id){return i;}}
 return 0xffffffffu;
}

struct Candidates { state: vec4u, ids: vec4u }
fn findCandidates(hit: SdfHit) -> Candidates {
 var out=Candidates(vec4u(0,0,hit.state.x,0),vec4u(0xffffffffu));
 if(hit.state.x!=1u){return out;}
 if(!worldBoundsValid(grid.dimensionsCount.w)){out.state.y=1u;return out;}
 if(dot(hit.normal.xyz,hit.normal.xyz)<0.5){out.state.y=4u;return out;}
 let halfSpacing=grid.originSpacing.w*0.5;
 let world=hit.position.xyz+hit.normal.xyz*halfSpacing;
 // Association support only: this radius is not a bound on geometric error.
 let radius=3.0*halfSpacing;
 var distances=vec4f(3.402823466e+38);
 var cursor=worldBoundsCursor(world,grid.dimensionsCount.w,radius);
 while(worldBoundsCursorCount(cursor)>0u){
  let i=worldBoundsCursorRow(&cursor);
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
  out.state.w++;
  // Signed-distance ordering with stable instance-ID ties, independent of roster order.
  var slot=4u;
  for(var k=0u;k<4u;k++){
   if(distance<distances[k]||(distance==distances[k]&&m.ids.x<out.ids[k])){slot=k;break;}
  }
  if(slot<4u){
   for(var k=3u;k>slot;k--){distances[k]=distances[k-1u];out.ids[k]=out.ids[k-1u];}
   distances[slot]=distance;out.ids[slot]=m.ids.x;
  }
 }
 out.state.x=min(out.state.w,4u);
 if(out.state.w>4u){out.state.y|=2u;}
 return out;
}


fn worldLocalBoundsInterval(origin: vec3f, direction: vec3f, lo: vec3f, hi: vec3f,
    first: f32, last: f32) -> vec2f {
 var near=first;var far=last;
 for(var axis=0u;axis<3u;axis++){
  if(direction[axis]==0.0){if(origin[axis]<lo[axis]||origin[axis]>hi[axis]){return vec2f(1,-1);}}
  else {let a=(lo[axis]-origin[axis])/direction[axis];let b=(hi[axis]-origin[axis])/direction[axis];near=max(near,min(a,b));far=min(far,max(a,b));}
 }
 return vec2f(near,far);
}


// state: status, unavailable voxel status, steps, reserved.
// metrics: ray t, surface expansion, first sampled distance, geometry coverage.
struct Hit { state: vec4u, metrics: vec4f, position: vec4f, normal: vec4f }
fn traceGlobal(ray: Ray, maxSteps: u32, minStepFactor: f32) -> Hit {
 var result=Hit(vec4u(0u,0,0,0),vec4f(ray.tMax,0,0,0),vec4f(0),vec4f(0));
 if(ray.mask.x==0u){return result;}
 let h=grid.originSpacing.w*0.5;
 // Keep one stored sample border for hit-normal differences.
 let lo=grid.originSpacing.xyz+vec3f(grid.originSpacing.w);
 let hi=grid.originSpacing.xyz+vec3f(grid.dimensionsCount.xyz-vec3u(2u))*grid.originSpacing.w;
 let start=ray.origin+ray.direction*ray.tMin;
 if(any(start<lo)||any(start>hi)){
  result.state.x=5u;result.metrics.x=ray.tMin;result.position=vec4f(start,1);return result;
 }
 var far=ray.tMax;
 for(var a=0u;a<3u;a++){
  if(ray.direction[a]>0.0){far=min(far,(hi[a]-ray.origin[a])/ray.direction[a]);}
  else if(ray.direction[a]<0.0){far=min(far,(lo[a]-ray.origin[a])/ray.direction[a]);}
 }
 let scale=max(abs(ray.direction.x),max(abs(ray.direction.y),abs(ray.direction.z)));
 let speed=scale*length(ray.direction/scale);
 var t=ray.tMin;var maxDistance=0.0;var expansion=0.0;
 for(var step=0u;step<maxSteps;step++){
  result.state.z=step+1u;let p=ray.origin+ray.direction*t;let sample=sampleGlobal(p);
  result.metrics.x=t;result.position=vec4f(p,1);
  if(sample.status!=1u){result.state.x=4u;result.state.y=sample.status;return result;}
  if(step==0u){result.metrics.z=sample.distance;}
  result.metrics.w=sample.coverage;
  if(step==0u && sample.distance<0.0){result.state.x=2u;return result;}
  maxDistance=max(maxDistance,sample.distance);
  expansion=h*clamp(maxDistance/(2.0*h),0.0,1.0);result.metrics.y=expansion;
  if(sample.distance<expansion){
   let hitT=clamp(t+(sample.distance-expansion)/speed,ray.tMin,far);
   var hitPosition=ray.origin+ray.direction*hitT;
   var gradient=vec3f(0);
   for(var a=0u;a<3u;a++){
    var offset=vec3f(0);offset[a]=h;
    let positive=sampleGlobal(hitPosition+offset);let negative=sampleGlobal(hitPosition-offset);
    if(positive.status!=1u || negative.status!=1u){
     result.state.x=4u;result.state.y=select(negative.status,positive.status,positive.status!=1u);return result;
    }
    gradient[a]=positive.distance-negative.distance;
   }
   result.state.x=1u;result.metrics.x=hitT;result.position=vec4f(hitPosition,1);
   result.normal=vec4f(gradient/max(length(gradient),1e-20),0);return result;
  }
  let next=t+max(sample.distance,h*minStepFactor)/speed;
  if(next<=t){result.state.x=3u;return result;}
  if(next>far){
   // Only a fully covered requested interval can report an approximate miss.
   result.state.x=select(5u,0u,far==ray.tMax);
   result.metrics.x=far;result.position=vec4f(ray.origin+ray.direction*far,1);return result;
  }
  t=next;
 }
 result.state.x=3u;return result;
}

fn traceWorld(ray: Ray, maxSteps: u32, minStepFactor: f32) -> Hit {
 if(ray.mask.x==0u){return Hit(vec4u(0u),vec4f(ray.tMax,0,0,0),vec4f(0),vec4f(0));}
 if(!sdfSceneObservedRayUsable(ray)){return Hit(vec4u(4u,0u,0u,0u),vec4f(0),vec4f(0),vec4f(0));}
 // Source owner epochs are independent of the metadata being queried. The
 // lookup retains complete selected raw admission before any interval cull.
 if(!worldBoundsValid(grid.dimensionsCount.w)){
  return Hit(vec4u(4u,0u,0u,0u),vec4f(ray.tMin,0,0,0),vec4f(0),vec4f(0));
 }
 let world=SdfSurfaceRay(bitcast<vec3u>(ray.origin),bitcast<vec3u>(ray.origin),
  bitcast<vec3u>(ray.direction),bitcast<vec3u>(ray.direction),bitcast<vec2u>(vec2f(ray.tMin,ray.tMax)),1u);
 var candidates=sdfSurfaceSceneCandidates(world,grid.dimensionsCount.w,ray.mask.x,grid.source,worldSceneExpected());
 if(candidates.state==2u){return Hit(vec4u(4u,0u,0u,0u),vec4f(ray.tMin,0,0,0),vec4f(0),vec4f(0));}
 // A coarse signed union currently supplies no certified empty prefix or
 // useful qualified advance. Do not execute its redundant ordinary-f32 hint.
 // Nodes and triangles consume the original shared remaining-work budget.
 var remaining=maxSteps;
 let detail=sdfSceneSurfaceTraceRows(ray,grid.dimensionsCount.w,&remaining,&candidates);
 let surface=sdfSceneSurfaceHit(ray,detail);
 var status=surface.state.x;
 let steps=maxSteps-remaining;
 var state=vec4u(status,0u,steps,0xffffffffu);
 if(detail.state==1u && surface.state.x==1u){
  // Private World metadata: bit31 marks a certified triangle, bit0 facing,
  // bit1 two-sided, bits2..22 primitive. Identity stays explicit for Card lookup.
  state.y=0x80000000u|(detail.primitive<<2u)|(detail.reserved<<1u)|detail.frontFace;
  state.w=surface.state.y;
 }
 return Hit(state,surface.metrics,surface.position,surface.normal);
}
fn traceWorldVisibility(ray: Ray, maxSteps: u32, minStepFactor: f32) -> Hit {
 return traceWorld(ray,maxSteps,minStepFactor);
}
fn worldHitCandidates(hit: Hit) -> Candidates {
 if(hit.state.x==1u && (hit.state.y&0x80000000u)!=0u){return Candidates(vec4u(1u,0u,hit.state.x,1u),vec4u(hit.state.w,0xffffffffu,0xffffffffu,0xffffffffu));}
 return findCandidates(SdfHit(hit.state,hit.metrics,hit.position,hit.normal));
}
// A conservative Global SDF hit can lie outside the actual source silhouette.
// It may occlude, but cannot lend radiance from an instance the ray never enters.
fn worldRayIntersectsBounds(i: u32, ray: Ray) -> bool {
  if(!sdfInstanceValid(i)){return false;}
  let m=sdfInstanceAt(i);
  let b=worldBoundsAt(i);let origin=(m.inverse*vec4f(ray.origin,1)).xyz;
  let direction=(m.inverse*vec4f(ray.direction,0)).xyz;
  let interval=worldLocalBoundsInterval(origin,direction,b.lo.xyz,b.hi.xyz,ray.tMin,ray.tMax);
  return interval.x<=interval.y;
}
fn worldCandidateOnRay(id: u32, ray: Ray) -> bool {
 if(!worldBoundsValid(grid.dimensionsCount.w)){return false;}
 let row=worldBoundsRowForId(id,grid.dimensionsCount.w,grid.originSpacing.w*1.5);
 if(row==0xffffffffu){return false;}
 return worldRayIntersectsBounds(row,ray);
}

fn worldSurfaceOrigin(position: vec3f, normal: vec3f, fieldBias: f32) -> vec3f {
 // Positive coarse interpolation does not certify an exact receiver start.
 // Retain software field clearance instead of borrowing a hardware precision
 // offset that can skip unresolved near-surface geometry.
 return position + normal * fieldBias;
}

@group(0) @binding(5) var<storage,read> cards: array<Card>;
@group(0) @binding(6) var<storage,read> cardLit: array<vec4f>;
@group(0) @binding(7) var<storage,read> rays: array<Ray>;
struct Traced { hit: Hit, radiance: vec4f }
@group(0) @binding(8) var<storage,read_write> traced: array<Traced>;
struct Parity { trace:vec4f, expectedSource:vec4u }
@group(0) @binding(9) var<uniform> parity: Parity;
fn worldSceneExpected()->vec4u{return parity.expectedSource;}
@group(0) @binding(10) var<uniform> settings: vec4u;
@group(0) @binding(11) var albedo: texture_2d<f32>;
@group(0) @binding(12) var normal: texture_2d<f32>;
@group(0) @binding(13) var emission: texture_2d<f32>;
@group(0) @binding(14) var f0: texture_2d<f32>;
@group(0) @binding(15) var cardDepth: texture_depth_2d;


fn decodeCardNormal(p: vec2f) -> vec3f {
 var n = vec3f(p,1.0-abs(p.x)-abs(p.y));
 if(n.z<0.0){n=vec3f((vec2f(1)-abs(n.yx))*select(vec2f(-1),vec2f(1),n.xy>=vec2f(0)),n.z);}
 return normalize(n);
}
struct Card { origin: vec4f, u: vec4f, v: vec4f, n: vec4f, ids: vec4u }
struct Lookup { state: vec4u, albedoRoughness: vec4f, normalDepth: vec4f, emissionMetallic: vec4f, f0: vec4f, texels: vec4u, weights: vec4f }

fn firstOwnerCard(instanceId: u32, count: u32) -> u32 {
 var lo=0u;var hi=count;
 while(lo<hi){
  let mid=lo+(hi-lo)/2u;let head=cards[mid].ids.z;
  if(head==0u){hi=mid;continue;}
  if(head>count){return 0u;}
  if(cards[head-1u].ids.x<instanceId){lo=mid+1u;}else{hi=mid;}
 }
 if(lo>=count){return 0u;}
 let head=cards[lo].ids.z;
 if(head==0u||head>count){return 0u;}
 return select(0u,head,cards[head-1u].ids.x==instanceId&&instanceId!=0xffffffffu);
}

fn lookupCardPoint(position: vec3f, hitNormal: vec3f, instanceId: u32, projectionMargin: f32, queryStatus: u32, cardCount: u32, resolution: u32) -> Lookup {
 var out=Lookup(vec4u(2u,queryStatus,0xffffffffu,instanceId),vec4f(0),vec4f(0),vec4f(0),vec4f(0),vec4u(0xffffffffu),vec4f(0));
 var best=-1.0;
 let count=min(cardCount,arrayLength(&cards));
 var cursor=firstOwnerCard(instanceId,count);var previous=0u;
 while(cursor!=0u){
  let i=cursor-1u;if(i>=count||cursor<=previous){break;}previous=cursor;
  let card=cards[i];cursor=card.ids.w;if(card.ids.x!=instanceId){break;}
  if(card.ids.y!=1u){out.state.x=3u;continue;}
  let alignment=dot(hitNormal,card.n.xyz);if(alignment<0.5){continue;}
  let rel=position-card.origin.xyz;let uv=vec2f(dot(rel,card.u.xyz)/card.u.w,dot(rel,card.v.xyz)/card.v.w);
  // The caller owns the world-space projection margin and its approximation.
  // Preserve depth/orientation tests when admitting a point outside the silhouette.
  // Interior points have exact zero edge distance. Keep that decision separate
  // from GPU distance arithmetic, especially for zero-allowance visibility hits.
  if(any(uv<vec2f(0))||any(uv>vec2f(1))){
   let edge=clamp(uv,vec2f(0),vec2f(1));
   if(length((uv-edge)*vec2f(card.u.w,card.v.w))>projectionMargin){continue;}
  }
  let depth=-dot(rel,card.n.xyz)/card.n.w;
  let pixelRadius=0.5*length(vec2f(card.u.w,card.v.w))/f32(resolution);
  let tolerance=projectionMargin+pixelRadius+card.n.w/1024.0;
  let xy=clamp(uv*f32(resolution)-vec2f(0.5),vec2f(0),vec2f(f32(resolution-1u)));
  let base=vec2u(floor(xy));let fraction=fract(xy);
  let tile=vec2u(i%(textureDimensions(f0).x/resolution),i/(textureDimensions(f0).x/resolution))*resolution;
  var texels=vec4u(0xffffffffu);var weights=vec4f(0);
  var a=vec4f(0);var e=vec4f(0);var specular=vec3f(0);var n=vec3f(0);var z=0.0;var error=0.0;var materialFlags=0u;var materialWeight=-1.0;
  for(var tap=0u;tap<4u;tap++){
   let offset=vec2u(tap&1u,tap>>1u);
   let axisWeight=select(vec2f(1)-fraction,fraction,offset>vec2u(0));let weight=axisWeight.x*axisWeight.y;
   if(weight<=0.0){continue;}
   let pixel=vec2i(tile+min(base+offset,vec2u(resolution-1u)));
   let material=textureLoad(f0,pixel,0);if((u32(material.w)&3u)!=1u){continue;}
   let frame=textureLoad(normal,pixel,0);if(dot(decodeCardNormal(frame.zw),hitNormal)<0.5){continue;}
   let sampleDepth=textureLoad(cardDepth,pixel,0);let delta=abs(depth-sampleDepth)*card.n.w;
   if(delta>tolerance){continue;}
   // Discrete material metadata follows the strongest accepted sample.
   if(weight>materialWeight){materialFlags=u32(material.w);materialWeight=weight;}
   texels[tap]=u32(pixel.y)*textureDimensions(f0).x+u32(pixel.x);weights[tap]=weight;
   a+=textureLoad(albedo,pixel,0)*weight;e+=textureLoad(emission,pixel,0)*weight;specular+=material.xyz*weight;
   n+=decodeCardNormal(frame.xy)*weight;z+=sampleDepth*weight;error+=delta*weight;
  }
  let support=dot(weights,vec4f(1));if(support<=0.0||length(n)<1e-10){continue;}
  let score=alignment-error/support/max(tolerance,1e-8)*0.1;
  if(score>best){best=score;out=Lookup(vec4u(1u,queryStatus,i,instanceId),a/support,vec4f(normalize(n),z/support),e/support,vec4f(specular/support,f32(materialFlags)),texels,weights/support);}
 }
 return out;
}

// A Global SDF gradient blends nearby faces. Only an exact triangle normal
// can decide facing before the supported Card geometric sample is available.
fn worldHitBackface(hit: Hit, ray: Ray) -> bool {
 if((hit.state.y&0x80000000u)!=0u){return (hit.state.y&3u)==0u;}
 return WORLD_HIT_NORMAL_EXACT && dot(ray.direction,hit.normal.xyz)>0.0;
}
fn worldCardRadiance(hit: Hit, projectionMargin: f32, pointSample: bool, ray: Ray) -> vec4f {
 let candidates=worldHitCandidates(hit);
 if(candidates.state.y!=0u){return vec4f(0);}
 var admitted=0u;
 for(var k=0u;k<candidates.state.x;k++){
  if((hit.state.y&0xc0000000u)==0u && !worldCandidateOnRay(candidates.ids[k],ray)){continue;}
  admitted|=1u<<k;
  // Approximate DF geometry keeps its uncertainty at the Card projection seam;
  // it never borrows the exact-triangle facing or primitive qualification.
  let margin=select(projectionMargin,max(projectionMargin,hit.metrics.y),(hit.state.y&0x20000000u)!=0u);
  let lookup=lookupCardPoint(hit.position.xyz,hit.normal.xyz,candidates.ids[k],margin,hit.state.x,settings.x,settings.y);
  if(lookup.state.x!=1u){continue;}
  var radiance=vec3f(0);var nearest=0u;
  for(var t=0u;t<4u;t++){
   if(lookup.texels[t]==0xffffffffu){continue;}
   if(lookup.weights[t]>lookup.weights[nearest]){nearest=t;}
  }
  if(!WORLD_HIT_NORMAL_EXACT && (hit.state.y&0x80000000u)==0u){
   let texel=lookup.texels[nearest];let width=textureDimensions(normal).x;
   let pixel=vec2i(i32(texel%width),i32(texel/width));
   let geometric=decodeCardNormal(textureLoad(normal,pixel,0).zw);
   if(dot(ray.direction,geometric)>0.0){return vec4f(0,0,0,2.0);}
  }
  if(pointSample){
   let value=cardLit[lookup.texels[nearest]];
   if(!(value.w>0.0)){return vec4f(0,0,0,-1);}
   radiance=value.xyz;
  }else{
   for(var t=0u;t<4u;t++){
    if(lookup.texels[t]==0xffffffffu||!(lookup.weights[t]>0.0)){continue;}
    let value=cardLit[lookup.texels[t]];
    if(!(value.w>0.0)){return vec4f(0,0,0,-1);}
    radiance+=value.xyz*lookup.weights[t];
   }
  }
  return vec4f(radiance,1.0);
 }
 if(admitted==0u){return vec4f(0);}
 if(settings.z!=0u){
  let count=min(settings.x,arrayLength(&cards));
  for(var k=0u;k<candidates.state.x;k++){
   if((admitted&(1u<<k))==0u){continue;}
   var cursor=firstOwnerCard(candidates.ids[k],count);var previous=0u;
   while(cursor!=0u){
    let c=cursor-1u;if(c>=count||cursor<=previous){break;}previous=cursor;
    let card=cards[c];cursor=card.ids.w;if(card.ids.x!=candidates.ids[k]){break;}
    if(card.ids.y==1u){return vec4f(0);}
   }
  }
  return vec4f(0,0,0,-1);
 }
 return vec4f(0);
}

@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid: vec3u) {
 if(gid.x>=arrayLength(&rays)){return;}
 let hit=traceWorld(rays[gid.x],settings.w,parity.trace.y);
 traced[gid.x]=Traced(hit,worldCardRadiance(hit,parity.trace.x,false,rays[gid.x]));
}
