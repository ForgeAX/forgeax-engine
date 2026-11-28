import { rng } from '@forgeax/engine/math';
import { DAWN_LAYOUT_METERS, DAWN_SEED, DAWN_SIZE, PROFILE_LAYOUT_MAX, stageUvU, stageUvV, type DawnTextureRole } from './dawn-textures.ts';
import { noiseTables, wgslFloat as f, wgslVec as v, type CloudBake } from './gpu-bake.ts';

const ridgeSource = /* wgsl */ `
fn ridge(value: f32, sharpness: f32, epsilon: f32) -> f32 {
  return clamp(1.0-sqrt(value*value*sharpness*sharpness+epsilon)+0.5*sqrt(epsilon), 0.0, 1.0);
}`;

function weatherShader(noise: ReturnType<typeof noiseTables>, mask: boolean) {
  const stream = rng.create(DAWN_SEED);
  const perlin = (label: string, x: number, y: number) => noise.gradient2d(stream.fork(label).seed, x, y);
  const fbm = (name: string, label: string, x: number, y: number, weights: readonly number[]) => {
    const seed = stream.fork(label).seed;
    const terms = [0, 11, 23, 37].map((offset, octave) =>
      `${f(weights[octave]!)}*${noise.gradient2d(seed + offset, x * 2 ** octave, y * 2 ** octave)('p')}`);
    return `fn ${name}(p: vec2f) -> f32 { return ${terms.join(' + ')}; }`;
  };
  const filigree = (name: string, label: string, x: number, y: number) => {
    const seed = stream.fork(label).seed;
    const samples = [0, 17, 31].map((offset, octave) =>
      `let r${octave} = ridge(${noise.gradient2d(seed + offset, x * 2 ** octave, y * 2 ** octave)('p')}, ${[1.35, 1.45, 1.55][octave]}, 0.06);`);
    return `fn ${name}(p: vec2f) -> f32 { ${samples.join(' ')} return 0.50*r0*r0 + 0.32*r1*r1 + 0.18*r2*r2; }`;
  };
  const fineV = perlin('warp-fine-v', 20, 20);
  return /* wgsl */ `
${ridgeSource}
${fbm('climate', 'climate', 3, 3, [0.62, 0.24, 0.10, 0.04])}
${fbm('mainStreak', 'main-streak', 2, 11, [0.48, 0.27, 0.16, 0.09])}
${filigree('mainTendril', 'main-tendril', 4, 20)}
${fbm('midStreak', 'mid-streak', 2, 10, [0.46, 0.28, 0.16, 0.10])}
${filigree('midFiligree', 'mid-filigree', 4, 18)}
${fbm('highStreak', 'high-streak', 1, 8, [0.48, 0.28, 0.16, 0.08])}
${filigree('highFiligree', 'high-filigree', 3, 16)}
${mask ? fbm('maskGrain', 'mask-grain', 5, 5, [0.60, 0.25, 0.11, 0.04]) : ''}
fn warp(p: vec2f) -> vec4f {
  let phase = p + vec2f(0.21, -0.17);
  let broad = phase + 0.020*vec2f(${perlin('warp-broad-u',3,3)('phase')}, ${perlin('warp-broad-v',3,3)('phase')});
  let middle = broad + 0.0040*vec2f(${perlin('warp-mid-u',7,7)('broad')}, ${perlin('warp-mid-v',7,7)('broad')});
  let fine = middle + 0.0014*vec2f(${perlin('warp-fine-u',20,20)('middle')}, ${fineV('middle')});
  return vec4f(broad, fine);
}
fn cleanLane(raw: f32) -> f32 {
  return smoothstep(0.10, 0.19, raw)*clamp(raw, 0.0, 1.0)*${f(PROFILE_LAYOUT_MAX)};
}
fn pattern(p: vec2f, broad: vec2f, fine: vec2f) -> vec4f {
  let regionalClimate = climate(broad + vec2f(0.14, -0.09));
  let distanceKm = ${f(DAWN_LAYOUT_METERS / 1_000)}*length(centered(p - ${v([stageUvU, stageUvV])}));
  let clump = ${perlin('climate-detail',6,6)('broad')};
  let far = smoothstep(24.0,62.0,distanceKm+7.0*clump);
  let farScale = mix(1.0, mix(0.42,0.80,smoothstep(-0.35,0.35,clump)),far);
  let skyOpen = smoothstep(-0.28,0.28,regionalClimate);

  // Different periodic integer shears represent the three wind directions.
  let s1 = fine.x + 2.0*fine.y + 0.12;
  let t1 = -2.0*fine.x + fine.y - 0.08;
  let comb1 = t1 + 0.024*${perlin('main-cross-comb',12,20)('vec2f(s1,t1)')};
  let mField = mainStreak(vec2f(s1,comb1));
  let mLen = ${perlin('main-len-mod',2,3)('vec2f(s1,broad.x-broad.y)')};
  let mFil = mainTendril(vec2f(s1+0.19,comb1-0.13));
  let rSignal = 0.51 + 0.68*mField + 0.16*mLen + 0.26*(mFil-0.30) + 0.12*regionalClimate;
  let rCore = smoothstep(0.52,0.86,rSignal);
  let rFeather = 0.54*smoothstep(0.44,0.72,rSignal+0.24*(mFil-0.28))*smoothstep(0.28,0.72,mFil);
  let laneR = cleanLane(max(rCore,rFeather)*mix(0.15,1.0,skyOpen)*farScale);

  let s2 = fine.x + 3.0*fine.y + 0.31;
  let t2 = -3.0*fine.x + fine.y - 0.22;
  let comb2 = t2 + 0.020*${fineV('fine+vec2f(-0.19,0.43)')};
  let gField = midStreak(vec2f(s2,comb2));
  let gFil = midFiligree(vec2f(s2-0.11,comb2+0.22));
  let gCluster = ${perlin('mid-cluster',3,4)('broad+vec2f(-0.27,0.23)')};
  let gSignal = 0.48 + 0.74*gField + 0.29*(gFil-0.29) + 0.05*gCluster + 0.04*regionalClimate;
  let gCore = smoothstep(0.52,0.85,gSignal);
  let gFeather = 0.54*smoothstep(0.44,0.72,gSignal+0.22*(gFil-0.26))*smoothstep(0.28,0.74,gFil);
  let laneG = cleanLane(max(gCore,gFeather)*mix(0.16,1.0,smoothstep(-0.30,0.32,gCluster+0.14*regionalClimate))*farScale);

  let s3 = 2.0*fine.x + 3.0*fine.y - 0.37;
  let t3 = -3.0*fine.x + 2.0*fine.y + 0.24;
  let bField = highStreak(vec2f(s3,t3));
  let bFil = highFiligree(vec2f(s3+0.17,t3-0.29));
  let bPatch = ${perlin('high-gate',3,3)('broad+vec2f(0.41,0.33)')};
  let bSignal = 0.50 + 0.64*bField + 0.36*(bFil-0.28) + 0.15*bPatch;
  let bCore = smoothstep(0.54,0.85,bSignal);
  let bTrail = 0.56*smoothstep(0.46,0.72,bSignal+0.22*(bFil-0.26))*smoothstep(0.26,0.70,bFil);
  let laneB = cleanLane(0.94*max(bCore,bTrail)*mix(0.15,1.0,smoothstep(-0.30,0.34,bPatch-0.25*regionalClimate))*farScale);
  return vec4f(laneR,laneG,laneB,0);
}
fn field(uvw: vec3f) -> vec4f {
  let p = uvw.xy${mask ? ' - 0.5' : ''};
  let warped = warp(p);
  let lanes = pattern(p, warped.xy, warped.zw);
  ${mask ? `let support = smoothstep(0.22,0.70,max(lanes.r,max(lanes.g,lanes.b)));
  if (support == 0.0) { return vec4f(0); }
  let grain = vec3f(maskGrain(warped.xy), maskGrain(warped.xy+vec2f(0.06,-0.04)), maskGrain(warped.xy+vec2f(-0.05,0.07)));
  return vec4f(0.18*support*smoothstep(vec3f(-0.35),vec3f(0.45),grain),0);` : 'return lanes;'}
}`;
}

const profileShader = /* wgsl */ `
fn deck(height: f32, p: f32, curve: f32, base: f32, lift: f32, peakMax: f32, below: f32, above: f32, radius: f32) -> f32 {
  let d = height-(base+lift*p);
  let slope = select(above,below,d<0.0);
  let peak = mix(0.18,peakMax,curve);
  return clamp(peak-slope*(sqrt(d*d+radius*radius)-radius),0.0,1.0);
}
fn field(uv: vec3f) -> vec4f {
  let h = uv.x;
  let p = clamp(uv.y/${f(PROFILE_LAYOUT_MAX)},0.0,1.0);
  let activation = smoothstep(0.003,0.035,p)*(1.0-smoothstep(${f(PROFILE_LAYOUT_MAX)}, ${f(1 - 1 / DAWN_SIZE['height-profile'])}, uv.y));
  let curve = pow(p,0.30)*smoothstep(0.015,0.14,p);
  return activation*vec4f(deck(h,p,curve,0.25,0.040,0.568,1.32,1.08,0.032),
    deck(h,p,curve,0.39,0.036,0.562,1.26,1.04,0.030),
    deck(h,p,curve,0.54,0.032,0.556,1.20,1.00,0.030),0);
}`;

function bodyRecipe(size: number): CloudBake {
  const noise = noiseTables(true);
  const stream = rng.create(DAWN_SEED).fork('body');
  const maxBand = size >= 128 ? 32 : Math.max(2, Math.floor(size / 6));
  const band = (period: number) => Math.min(maxBand, period);
  const grad = (label: string, x: number, y: number, z: number, coordinate = 'p') =>
    noise.dawnGradient(stream.fork(label).seed, band(x), band(y), band(z))(coordinate);
  const cell = (label: string, x: number, y: number, z: number) =>
    noise.dawnCells(stream.fork(label).seed, band(x), band(y), band(z))('p');
  const cellFields = [cell('r-cell',8,8,6), cell('g-cavity',4,8,6), cell('g-wisp-cell',10,14,10),
    cell('b-cell',12,12,10), cell('a-cell',20,20,20)];
  const shader = /* wgsl */ `
${ridgeSource}
fn field(p: vec3f) -> vec4f {
  let rc = ${grad('r-coarse',4,4,3)};
  let rm = ${grad('r-mid',8,8,6)};
  let rf = ${grad('r-fine',16,16,10)};
  let rcell = sampleVolumeGrid(p,0u)-0.45;
  let warp = 0.52+0.30*rc+0.24*rm+0.24*rcell+0.16*rf;
  let curl = p + vec3f(0.058*${grad('g-curl-u',4,4,4)}, 0.058*${grad('g-curl-v',4,4,4)}, 0.020*${grad('g-curl-w',4,4,3)});
  let windswept = vec3f(curl.x+curl.y,curl.y-curl.x,curl.z);
  let p0 = ${grad('g-broad',3,6,5,'windswept')};
  let p1 = ${grad('g-med',6,12,9,'windswept')};
  let p2 = ${grad('g-fine',12,18,13,'windswept')};
  let p3 = ${grad('g-micro',24,24,16)};
  let cav0 = sampleVolumeGrid(windswept,1u)-0.45;
  let cav1 = sampleVolumeGrid(windswept,2u)-0.45;
  let filament = ridge(p1,1.20,0.09)-0.50;
  let fbmBody = 0.44*p0+0.25*p1+0.14*p2+0.055*p3;
  let cellBody = 0.44*cav0+0.28*cav1;
  let body = 0.455+0.88*fbmBody+0.56*cellBody+0.13*filament;
  let bp = ${grad('b-perlin',9,11,8)};
  let bf = ${grad('b-fine',18,18,14)};
  let bc = sampleVolumeGrid(p,3u)-0.45;
  let erosion = 0.49+0.34*bp+0.18*bf+0.94*bc;
  let pores = 0.45+0.92*(sampleVolumeGrid(p,4u)-0.45)+0.08*p3;
  return vec4f(warp,body,erosion,pores);
}`;
  return { size, volume: true, format: 'bgra8unorm', volumeGrid: { size: Math.min(size, 64), fields: cellFields },
    shader, seeds: noise.data() };
}

/** All four sunrise texture roles are evaluated by the Pack's hardware GPU baker. */
export function dawnGpuRecipe(role: DawnTextureRole, size: number = DAWN_SIZE[role]): CloudBake {
  if (role === 'body-noise') return bodyRecipe(size);
  const noise = noiseTables(true);
  const mask = role === 'layout-mask';
  const profile = role === 'height-profile';
  const shader = profile ? profileShader : weatherShader(noise, mask);
  return { size, format: mask ? 'bgra8unorm' : 'rgba16float', shader, seeds: noise.data(),
    ...(!profile && size > 512 ? { weatherGrid: 512 } : {}) };
}
