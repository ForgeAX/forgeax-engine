#define_import_path forgeax_ray::screen_candidate

const RAY_SCREEN_CANDIDATE = 1024u;
const RAY_SCREEN_ENDPOINT_TESTED = 2048u;

// 31 payload bits in a normal finite f32: sign, seven exponent bits,
// and 23 mantissa bits. No subnormal, infinity, NaN, or numeric conversion.
fn screenCandidateWord(word:u32)->f32 {
  let sign=(word&0x40000000u)<<1u;
  let exponent=(((word>>23u)&127u)+1u)<<23u;
  return bitcast<f32>(sign|exponent|(word&0x007fffffu));
}
fn screenCandidateWordBits(value:f32)->u32 {
  let raw=bitcast<u32>(value);
  return ((raw&0x80000000u)>>1u)|(((((raw>>23u)&255u)-1u)&127u)<<23u)|(raw&0x007fffffu);
}
fn screenCandidateValid(payload:vec3f)->bool {
  let exponent=(bitcast<vec3u>(payload)>>vec3u(23u))&vec3u(255u);
  return all(exponent>=vec3u(1u))&&all(exponent<=vec3u(128u))&&
    (screenCandidateWordBits(payload.x)&0x40000000u)==0u;
}
fn screenCandidatePack(pixel:vec2u,frame:u32,revision:u32)->vec3f {
  let first=pixel.x|(pixel.y<<14u)|((frame>>31u)<<28u)|((revision>>31u)<<29u);
  return vec3f(screenCandidateWord(first),screenCandidateWord(frame&0x7fffffffu),screenCandidateWord(revision&0x7fffffffu));
}
fn screenCandidateUnpack(payload:vec3f)->vec3u {
  let first=screenCandidateWordBits(payload.x);
  let pixel=(first&16383u)|(((first>>14u)&16383u)<<16u);
  let frame=screenCandidateWordBits(payload.y)|(((first>>28u)&1u)<<31u);
  let revision=screenCandidateWordBits(payload.z)|(((first>>29u)&1u)<<31u);
  return vec3u(pixel,frame,revision);
}
