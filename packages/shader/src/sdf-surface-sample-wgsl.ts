/** One certified unsigned sample lower bound in the original local-ray parameter.
 * It proves only an empty prefix, never a primitive hit or Card availability.
 * The caller owns source, raw-row and packet admission before using this result. */
export const SDF_SURFACE_SAMPLE_WGSL = `struct SdfSurfacePrefix { end:f32, samples:u32, valid:u32 }
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
`;
