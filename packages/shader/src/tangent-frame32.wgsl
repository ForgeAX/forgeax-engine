#define_import_path forgeax_geometry::tangent_frame32

struct TangentFrame32 {
  normal: vec3<f32>,
  tangent: vec4<f32>,
};

// oct11x2 + periodic diamond9 + bitangent orientation. Decode before skin,
// morph or interpolation; the packed integer itself is never interpolated.
fn decodeTangentFrame32(word:u32)->TangentFrame32 {
  var n=vec3<f32>(f32(word&2047u)/2047.0*2.0-1.0,
    f32((word>>11u)&2047u)/2047.0*2.0-1.0,0.0);
  n.z=1.0-abs(n.x)-abs(n.y);
  let fold=max(-n.z,0.0);
  n.x+=select(fold,-fold,n.x>=0.0);
  n.y+=select(fold,-fold,n.y>=0.0);
  n=normalize(n);
  let sign=select(-1.0,1.0,n.z>=0.0);
  let a=-1.0/(sign+n.z);let b=n.x*n.y*a;
  let axisA=vec3<f32>(1.0+sign*n.x*n.x*a,sign*b,-sign*n.x);
  let axisB=vec3<f32>(b,sign+n.y*n.y*a,-n.y);
  let diamond=f32((word>>22u)&511u)/512.0;
  let x=select(4.0*diamond-3.0,1.0-4.0*diamond,diamond<0.5);
  let y=(1.0-abs(x))*select(-1.0,1.0,diamond<0.5);
  let tangent=(axisA*x+axisB*y)*inverseSqrt(x*x+y*y);
  return TangentFrame32(n,vec4<f32>(tangent,select(1.0,-1.0,(word>>31u)!=0u)));
}
