#define_import_path forgeax_pbr::sky_sh_polynomial

struct SkyShPolynomial {
  terms: array<vec4f, 7>,
}

fn evaluateSkyPolynomial(packed: SkyShPolynomial, n: vec3f) -> vec3f {
  let linear = vec4f(n, 1.0);
  let quadratic = n.xyzz * n.yzzx;
  let axisDifference = n.x * n.x - n.y * n.y;
  let a = vec3f(dot(packed.terms[0], linear), dot(packed.terms[1], linear), dot(packed.terms[2], linear));
  let b = vec3f(dot(packed.terms[3], quadratic), dot(packed.terms[4], quadratic), dot(packed.terms[5], quadratic));
  return max(a + b + packed.terms[6].xyz * axisDifference, vec3f(0.0));
}
