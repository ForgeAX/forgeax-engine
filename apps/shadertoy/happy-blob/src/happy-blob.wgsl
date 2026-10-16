#define_import_path shadertoy::happy_blob

// happy-blob.wgsl -- ORIGINAL raymarched SDF creature, written from scratch
// for forgeax. A round, blobby character that bounces in place, squashing on
// landing and stretching at the top of each hop, while glancing left/right.
//
// Technique notes (general, well-known SDF raymarching -- no third-party code):
//   - signed distance fields composed with a smooth-min (smin) so the body,
//     head and ears fuse into one blob.
//   - sphere-tracing the scene, then a few-tap soft shadow + ambient
//     occlusion estimate for shading.
//   - this is a fullscreen-quad effect: the vertex stage emits NDC clip
//     positions directly (unit plane scaled x2), bypassing the camera.
//     iResolution / iTime ride in the @group(1) @binding(0) material UBO.

struct VsIn {
  @location(0) pos    : vec3<f32>,
  @location(1) normal : vec3<f32>,
  @location(2) uv     : vec2<f32>,
};

struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0)       uv   : vec2<f32>,
};

@vertex
fn vs_main(in : VsIn) -> VsOut {
  var out : VsOut;
  out.clip = vec4<f32>(in.pos.xy * 2.0, 0.0, 1.0);
  out.uv = in.uv;
  return out;
}

// --- SDF helpers (standard formulas, hand-written) --------------------------

fn smin(a : f32, b : f32, k : f32) -> f32 {
  let h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

fn sdSphere(p : vec3<f32>, r : f32) -> f32 {
  return length(p) - r;
}

// Cheap approximate ellipsoid distance.
fn sdEllipsoid(p : vec3<f32>, r : vec3<f32>) -> f32 {
  let k0 = length(p / r);
  let k1 = length(p / (r * r));
  return k0 * (k0 - 1.0) / k1;
}

fn rot2(p : vec2<f32>, a : f32) -> vec2<f32> {
  let c = cos(a);
  let s = sin(a);
  return vec2<f32>(p.x * c - p.y * s, p.x * s + p.y * c);
}

// Capsule (line segment a->b, radius r).
fn sdCapsule(p : vec3<f32>, a : vec3<f32>, b : vec3<f32>, r : f32) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - r;
}

// Cheap 2D value hash in [0,1).
fn hash21(p : vec2<f32>) -> f32 {
  var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, vec3<f32>(p3.y, p3.z, p3.x) + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// 2D value noise (smooth-interpolated hash lattice).
fn vnoise(p : vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = hash21(i);
  let b = hash21(i + vec2<f32>(1.0, 0.0));
  let c = hash21(i + vec2<f32>(0.0, 1.0));
  let d = hash21(i + vec2<f32>(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Shared rolling-ground height field (used by the ground surface AND to plant
// scattered props so they sit exactly on the terrain).
fn groundHeight(xz : vec2<f32>) -> f32 {
  return -0.04 * (sin(xz.x * 1.7) + sin(xz.y * 1.7));
}

// A field of little mushrooms via domain repetition on a grid. Each cell hashes
// to decide presence + jitter + scale; props near the origin are skipped so the
// creature has room. Returns vec2(distance, materialId in {6 cap, 7 stem}).
fn mushroomField(pos : vec3<f32>, t : f32) -> vec2<f32> {
  let spacing = 1.6;
  let cell = round(pos.xz / spacing);
  let rnd = hash21(cell);
  // ~55% of cells are empty.
  if (rnd < 0.55) {
    return vec2<f32>(1e5, 7.0);
  }
  let jitter = (vec2<f32>(hash21(cell + 5.1), hash21(cell + 9.7)) - 0.5) * 0.6;
  let center = cell * spacing + jitter;
  // keep a clear ring around the creature.
  if (length(center) < 1.3) {
    return vec2<f32>(1e5, 7.0);
  }
  let gh = groundHeight(center);
  let scale = 0.6 + 0.6 * hash21(cell + 19.0);
  // gentle sway.
  let sway = 0.04 * scale * sin(t * 1.5 + rnd * 6.28);
  let lp = vec3<f32>(pos.x - center.x - sway, pos.y - gh, pos.z - center.y);
  let stem = sdCapsule(lp, vec3<f32>(0.0), vec3<f32>(0.0, 0.22 * scale, 0.0), 0.04 * scale);
  let cap = sdEllipsoid(
    lp - vec3<f32>(0.0, 0.24 * scale, 0.0),
    vec3<f32>(0.15, 0.10, 0.15) * scale,
  );
  if (cap < stem) {
    return vec2<f32>(cap, 6.0);
  }
  return vec2<f32>(stem, 7.0);
}

// Floating pastel orbs drifting in the air, domain-repeated in xz.
fn bubbleField(pos : vec3<f32>, t : f32) -> f32 {
  let spacing = 2.7;
  let cell = round(pos.xz / spacing);
  let rnd = hash21(cell + 41.0);
  if (rnd < 0.6) {
    return 1e5;
  }
  let jitter = (vec2<f32>(hash21(cell + 2.2), hash21(cell + 8.8)) - 0.5) * 1.4;
  let center = cell * spacing + jitter;
  let baseY = 1.2 + 1.4 * hash21(cell + 13.0);
  let bobY = baseY + 0.35 * sin(t * 0.7 + rnd * 6.28);
  let r = 0.12 + 0.16 * hash21(cell + 27.0);
  let lp = vec3<f32>(pos.x - center.x, pos.y - bobY, pos.z - center.y);
  return sdSphere(lp, r);
}

// Material id is carried alongside the distance in .y.
// Returns vec2(distance, materialId).
fn mapScene(pos : vec3<f32>, t : f32) -> vec2<f32> {
  // --- hop animation -------------------------------------------------------
  // bounce in [0,1) per hop; a parabola gives the vertical arc (0 on the
  // ground, 1 at the apex).
  let bounce = fract(t * 0.75);
  let arc = 4.0 * bounce * (1.0 - bounce);          // 0 (land) .. 1 (apex) .. 0
  let hopH = 0.75 * arc;

  // squash & stretch. `landing` is 1 right after touchdown, 0 mid-air; `apex`
  // is 1 at the top of the hop. Landing -> wide + short; apex -> slightly tall
  // + thin. sx/sy are horizontal/vertical scale factors centered on 1.0.
  let landing = 1.0 - smoothstep(0.0, 0.30, arc);
  let apex = smoothstep(0.75, 1.0, arc);
  let sx = 1.0 + 0.28 * landing - 0.10 * apex;       // fatter on landing
  let sy = 1.0 - 0.26 * landing + 0.12 * apex;       // shorter on landing

  // Body center. Drop the center as it squashes so the belly stays planted.
  let cen = vec3<f32>(0.0, 0.50 + hopH - 0.12 * landing, 0.0);
  var q = pos - cen;

  // head turn: glance left/right slowly.
  let turn = 0.5 * sin(t * 1.3);

  // --- body (round, slightly egg-shaped) -----------------------------------
  var d = sdEllipsoid(q, vec3<f32>(0.50 * sx, 0.46 * sy, 0.50 * sx));
  var mat = 1.0; // body

  // belly dimple wrinkle for a bit of life.
  let belly = q.y - 0.05 - 1.5 * q.x * q.x;
  d += 0.003 * sin(belly * 40.0) * (1.0 - smoothstep(0.0, 0.2, abs(belly)));

  // --- head (sits on top, fuses into the body via smin) --------------------
  var h = q - vec3<f32>(0.0, 0.34 * sy, 0.0);
  h = vec3<f32>(rot2(h.xz, turn), h.y).xzy; // yaw around Y (xz rotated)
  let hq = vec3<f32>(abs(h.x), h.y, h.z);   // mirror X for symmetric features
  let dHead = sdSphere(h, 0.30);
  d = smin(d, dHead, 0.16);

  // --- ears (two rounded ellipsoids, mirrored, gentle wag) -----------------
  let earWag = 0.06 * sin(t * 6.0);
  let ear = sdEllipsoid(
    hq - vec3<f32>(0.17, 0.26 + earWag, -0.02),
    vec3<f32>(0.08, 0.15, 0.07),
  );
  d = smin(d, ear, 0.06);

  // --- feet (little nubs that tuck up while airborne) ----------------------
  let foot = sdEllipsoid(
    vec3<f32>(abs(q.x) - 0.20, q.y + 0.40 * sy, q.z - 0.06),
    vec3<f32>(0.13, 0.10, 0.17),
  );
  d = smin(d, foot, 0.09);

  // --- eyes (whites + dark pupils), only override material near surface ----
  let blink = pow(0.5 + 0.5 * sin(t * 2.7), 24.0);
  let eyeWhite = sdSphere(hq - vec3<f32>(0.12, 0.06, 0.24), 0.072 - 0.05 * blink);
  if (eyeWhite < d) {
    d = eyeWhite;
    mat = 3.0; // eye white
  }
  let pupil = sdSphere(hq - vec3<f32>(0.13, 0.05, 0.275), 0.038);
  if (pupil < d) {
    d = pupil;
    mat = 4.0; // pupil
  }

  // --- ground (gentle rolling, shared height field) ------------------------
  let dGround = pos.y - groundHeight(pos.xz);
  if (dGround < d) {
    d = dGround;
    mat = 2.0; // ground
  }

  // --- scattered mushrooms -------------------------------------------------
  let shroom = mushroomField(pos, t);
  if (shroom.x < d) {
    d = shroom.x;
    mat = shroom.y; // 6 = cap, 7 = stem
  }

  // --- floating orbs -------------------------------------------------------
  let bub = bubbleField(pos, t);
  if (bub < d) {
    d = bub;
    mat = 5.0; // orb
  }

  return vec2<f32>(d, mat);
}

fn calcNormal(pos : vec3<f32>, t : f32) -> vec3<f32> {
  let e = vec2<f32>(1.0, -1.0) * 0.0008;
  return normalize(
    e.xyy * mapScene(pos + e.xyy, t).x +
    e.yyx * mapScene(pos + e.yyx, t).x +
    e.yxy * mapScene(pos + e.yxy, t).x +
    e.xxx * mapScene(pos + e.xxx, t).x,
  );
}

fn softShadow(ro : vec3<f32>, rd : vec3<f32>, t : f32) -> f32 {
  var res = 1.0;
  var dist = 0.05;
  for (var i = 0; i < 40; i = i + 1) {
    let h = mapScene(ro + rd * dist, t).x;
    res = min(res, 12.0 * h / dist);
    dist += clamp(h, 0.02, 0.25);
    if (res < 0.004 || dist > 8.0) {
      break;
    }
  }
  return clamp(res, 0.0, 1.0);
}

fn calcAO(pos : vec3<f32>, nor : vec3<f32>, t : f32) -> f32 {
  var occ = 0.0;
  var sca = 1.0;
  for (var i = 0; i < 5; i = i + 1) {
    let hr = 0.01 + 0.12 * f32(i) / 4.0;
    let d = mapScene(pos + nor * hr, t).x;
    occ += (hr - d) * sca;
    sca *= 0.95;
  }
  return clamp(1.0 - 1.5 * occ, 0.0, 1.0);
}

fn matColor(mat : f32, pos : vec3<f32>) -> vec3<f32> {
  if (mat > 6.5) {
    return vec3<f32>(0.92, 0.88, 0.78);          // mushroom stem (cream)
  }
  if (mat > 5.5) {
    // mushroom cap: per-cell hue + little pale spots.
    let cell = round(pos.xz / 1.6);
    let hue = hash21(cell + 3.0);
    let red = vec3<f32>(0.85, 0.18, 0.16);
    let orange = vec3<f32>(0.92, 0.52, 0.12);
    var capCol = mix(red, orange, hue);
    let spot = vnoise(pos.xz * 26.0);
    capCol = mix(capCol, vec3<f32>(0.96, 0.94, 0.88), smoothstep(0.72, 0.8, spot));
    return capCol;
  }
  if (mat > 4.5) {
    // floating orb: soft pastel, tinted by location.
    let cell = round(pos.xz / 2.7);
    let h = hash21(cell + 41.0);
    return mix(vec3<f32>(0.75, 0.85, 1.0), vec3<f32>(0.95, 0.8, 0.95), h);
  }
  if (mat > 3.5) {
    return vec3<f32>(0.02, 0.02, 0.03);          // pupil
  }
  if (mat > 2.5) {
    return vec3<f32>(0.95, 0.96, 0.98);          // eye white
  }
  if (mat > 1.5) {
    // ground: checker-ish green with a little noise mottle.
    let c = 0.5 + 0.5 * sign(sin(pos.x * 3.1416) * sin(pos.z * 3.1416));
    var g = mix(vec3<f32>(0.10, 0.22, 0.09), vec3<f32>(0.14, 0.30, 0.12), c);
    g += (vnoise(pos.xz * 5.0) - 0.5) * 0.04;
    return g;
  }
  return vec3<f32>(0.95, 0.55, 0.62);            // body: warm pink
}

fn render(ro : vec3<f32>, rd : vec3<f32>, t : f32) -> vec3<f32> {
  // sky gradient
  var col = vec3<f32>(0.55, 0.78, 0.92) - max(rd.y, 0.0) * 0.35;
  col = mix(col, vec3<f32>(0.85, 0.90, 0.95), exp(-9.0 * max(rd.y, 0.0)));

  // drifting clouds: project the ray onto a high plane and layer value noise.
  if (rd.y > 0.02) {
    let cp = rd.xz / rd.y * 1.6 + vec2<f32>(t * 0.05, 0.0);
    var cl = 0.55 * vnoise(cp);
    cl += 0.30 * vnoise(cp * 2.1 + 7.0);
    cl += 0.15 * vnoise(cp * 4.3 + 19.0);
    let cover = smoothstep(0.55, 0.85, cl) * smoothstep(0.02, 0.18, rd.y);
    col = mix(col, vec3<f32>(1.0, 1.0, 1.0), cover * 0.85);
  }
  // warm sun glow in the sky.
  let sunDirSky = normalize(vec3<f32>(0.6, 0.7, 0.4));
  col += vec3<f32>(1.0, 0.85, 0.6) * pow(max(dot(rd, sunDirSky), 0.0), 64.0) * 0.6;

  // sphere-trace
  var dist = 0.4;
  var hitMat = -1.0;
  var hitPos = vec3<f32>(0.0);
  for (var i = 0; i < 180; i = i + 1) {
    let p = ro + rd * dist;
    let s = mapScene(p, t);
    if (s.x < 0.0008 * dist) {
      hitMat = s.y;
      hitPos = p;
      break;
    }
    dist += s.x;
    if (dist > 30.0) {
      break;
    }
  }

  if (hitMat > -0.5) {
    let nor = calcNormal(hitPos, t);
    let baseCol = matColor(hitMat, hitPos);

    let sunDir = normalize(vec3<f32>(0.6, 0.7, 0.4));
    let sunDif = clamp(dot(nor, sunDir), 0.0, 1.0);
    let sunSha = softShadow(hitPos + nor * 0.01, sunDir, t);
    let skyDif = clamp(0.5 + 0.5 * nor.y, 0.0, 1.0);
    let bounce = clamp(0.3 - 0.7 * nor.y, 0.0, 1.0);
    let ao = calcAO(hitPos, nor, t);

    // specular (Blinn-Phong-ish)
    let hal = normalize(sunDir - rd);
    let spe = pow(clamp(dot(nor, hal), 0.0, 1.0), 32.0) * sunDif * sunSha;

    var lin = vec3<f32>(0.0);
    lin += sunDif * vec3<f32>(2.0, 1.75, 1.35) * sunSha;
    lin += skyDif * vec3<f32>(0.30, 0.40, 0.55) * ao;
    lin += bounce * vec3<f32>(0.20, 0.25, 0.12) * ao;
    col = baseCol * lin;
    col += spe * vec3<f32>(1.0, 0.95, 0.85);

    // a soft rim to pop the silhouette
    let fre = pow(clamp(1.0 + dot(nor, rd), 0.0, 1.0), 3.0);
    col += fre * 0.15 * vec3<f32>(0.9, 0.95, 1.0) * ao;

    // distance fog -- lighter touch + farther onset so the field keeps colour.
    col = mix(col, vec3<f32>(0.72, 0.83, 0.92), 1.0 - exp(-0.00025 * dist * dist));
  }

  return col;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
  // fragCoord with bottom-left origin (flip V from WebGPU top-left UV).
  let fragCoord = vec2<f32>(in.uv.x, 1.0 - in.uv.y) * material.iResolution;
  let p = (2.0 * fragCoord - material.iResolution) / material.iResolution.y;

  let t = material.iTime;

  // camera orbits slowly and looks at the creature.
  let an = 0.5 * sin(t * 0.25);
  let ta = vec3<f32>(0.0, 0.55, 0.0);
  let ro = ta + vec3<f32>(2.6 * sin(an), 0.5, 2.6 * cos(an));

  // camera basis
  let cw = normalize(ta - ro);
  let cu = normalize(cross(cw, vec3<f32>(0.0, 1.0, 0.0)));
  let cv = cross(cu, cw);
  let rd = normalize(p.x * cu + p.y * cv + 1.8 * cw);

  var col = render(ro, rd, t);

  // tonemap + gamma
  col = col / (1.0 + col);
  col = pow(col, vec3<f32>(0.4545));

  // colour grade: lift saturation + a little contrast so the storybook palette
  // pops instead of washing out.
  let luma = dot(col, vec3<f32>(0.299, 0.587, 0.114));
  col = mix(vec3<f32>(luma), col, 1.25);
  col = clamp((col - 0.5) * 1.08 + 0.5, vec3<f32>(0.0), vec3<f32>(1.0));

  // gentle vignette
  let q = fragCoord / material.iResolution;
  col *= 0.5 + 0.5 * pow(16.0 * q.x * q.y * (1.0 - q.x) * (1.0 - q.y), 0.2);

  return vec4<f32>(col, 1.0);
}
