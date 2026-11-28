import { noiseTables, wgslFloat as f, wgslVec as v, type CloudBake } from './gpu-bake.ts';
import { LOOKS, SIZE, PROFILE_LAYOUT_MAX, stageUv, sunSegment } from './textures.ts';
import { NUBIS_BOSS_SUN, NUBIS_LAYOUT_METERS, NUBIS_SUNLIT_SUN, type NubisMode } from './presets.ts';
import { dawnGpuRecipe } from './dawn-gpu.ts';
import type { NubisRole } from './textures.ts';

export function nubisGpuRecipe(mode: NubisMode, role: NubisRole, size: number = SIZE[role]): CloudBake {
  if (mode === 'nubis-dawn') return dawnGpuRecipe(role, size);
  const look = LOOKS[mode];
  const boss = mode === 'nubis-boss';
  const noise = noiseTables(true);
  const volume = role === 'body-noise';
  const mask = role === 'layout-mask';
  let shader: string;
  if (volume) {
    const period = (multiplier: number) => Math.min(Math.max(2, Math.floor(size / 2)), look.period * multiplier);
    const grad = (seed: number, count: number) => noise.gradient(look.seed + seed, count);
    const cell = (seed: number, multiplier: number) => noise.cells(look.seed + seed, period(multiplier));
    shader = /* wgsl */ `
fn field(p: vec3f) -> vec4f {
  let q = p + vec3f(0.028*${grad(74, Math.min(5, period(1)))('p')}, 0, 0);
  let large = ${grad(17, period(1))('q')};
  let fine = ${grad(38, period(2))('q')};
  let micro = ${grad(43, period(5))('p')};
  let billow = ${cell(59, 1)('q')} - 0.51;
  let eroder = ${cell(67, 3)('p')};
  let microStructure = ${cell(79, 5)('p')};
  let erosion = smoothstep(0.21, 0.70, 0.74*eroder + 0.26*microStructure + 0.21*micro);
  let body = mix(0.62*large, 1.3*billow + 0.26*large, ${f(look.cells)});
  let density = 0.54 + body + ${f(look.detail)}*(0.30*fine + 0.13*micro - 0.48*erosion);
  let warp = ${grad(74, Math.min(5, period(1)))('p + vec3f(0.3, 0, 0)')};
  return vec4f(0.68 + 0.8*(0.50*warp + 0.19*fine),
    ${f(look.densityTarget)} + ${f(look.densityGain)}*(density - ${f(look.densityCenter)}),
    0.16 + 0.78*erosion + 0.18*micro, 0.48 + 0.98*(microStructure-0.46) + 0.15*micro);
}`;
  } else if (role === 'height-profile') {
    shader = /* wgsl */ `
fn profile(shape: vec4f, height: f32, weak: f32, peak: f32) -> f32 {
  let foot = shape.x + 0.07*weak + shape.z*0.5;
  let crown = shape.y - 0.18*weak - shape.w*0.5;
  let lowerWidth = max(0.112, shape.z*1.65);
  let upperWidth = max(0.135, shape.w*1.5);
  let core = smoothstep(foot-lowerWidth*0.5, foot+lowerWidth*0.5, height) *
    (1.0-smoothstep(crown-upperWidth*0.5, crown+upperWidth*0.5, height));
  let shoulder = smoothstep(foot-lowerWidth, foot-lowerWidth*0.22, height) *
    (1.0-smoothstep(crown+upperWidth*0.22, crown+upperWidth, height));
  return 0.37*shoulder + (peak-0.37)*core;
}
fn field(p: vec3f) -> vec4f {
  let coverage = clamp(p.y/${f(PROFILE_LAYOUT_MAX)}, 0.0, 1.0);
  let activation = smoothstep(0.0, 0.14, coverage) * (1.0-smoothstep(${f(PROFILE_LAYOUT_MAX)}, ${f(1 - 1 / SIZE['height-profile'])}, p.y));
  let weak = pow(1.0-coverage, 1.5);
  let peak = mix(${look.profileGain.join(', ')}, sqrt(coverage));
  return activation*vec4f(${look.profiles.map(shape => shape ? `profile(${v(shape)}, p.x, weak, peak)` : '0.0').join(', ')}, 0);
}`;
  } else {
    const seed = look.seed;
    const frequency = look.weatherFrequency;
    const grad = (offset: number, period: number) => noise.gradient(seed + offset, period);
    const octave = (name: string, offset: number, period: number) => {
      const terms = [0.64, 0.21, 0.10, 0.05].map((weight, index) =>
        `${f(weight)}*${grad(offset + index, period * 2 ** index)('p')}`);
      return `fn ${name}(p: vec3f) -> f32 { return ${terms.join(' + ')}; }`;
    };
    const warpU = grad(1, Math.round(frequency / 2));
    const warpV = grad(2, Math.round(frequency / 2));
    const fineU = grad(3, frequency * 4);
    const fineV = grad(4, frequency * 4);
    const rifts = grad(53, frequency * 6);
    const [start, end] = sunSegment(boss ? NUBIS_BOSS_SUN : NUBIS_SUNLIT_SUN);
    shader = /* wgsl */ `
${octave('lowWeather', 17, frequency)}
${octave('midWeather', 29, frequency + 2)}
${octave('tallWeather', 41, frequency + 4)}
${octave('maskWeather', 67, 4)}
${octave('distantWeather', 83, 7)}
fn aperture(p: vec2f) -> f32 {
  let start = ${v(start)};
  let end = ${v(end)};
  let span = end-start;
  let d = centered(p-(start+end)*0.5) + span*0.5;
  let t = clamp(dot(d, span)/dot(span, span), 0.0, 1.0);
  let distanceKm = length(d-t*span)*${f(NUBIS_LAYOUT_METERS / 1000)};
  ${boss ? `let lateral = d.x*span.y - d.y*span.x;
    let rim = ${fineU('vec3f(p,0.43)')} + 0.35*${rifts('vec3f(p,0.25)')};
    let radius = mix(0.54, select(3.0, 4.0, lateral < 0.0), t)*(1.0+0.36*rim);
    return smoothstep(radius, radius+mix(0.35,0.85,t), distanceKm);`
    : `let edge = ${fineV('vec3f(p,0.47)')};
    let width = mix(0.38, 1.6, t)*(1.0+0.56*edge);
    return mix(0.13, 1.0, smoothstep(width, width+mix(0.64,1.7,t), distanceKm));`}
}
fn coordinates(p: vec2f) -> vec2f {
  let strength = ${f(look.turbulence / frequency)};
  let coarse = p + strength*vec2f(${warpU('vec3f(p,0.29)')}, ${warpV('vec3f(p,0.71)')});
  return coarse + strength*0.23*vec2f(${fineU('vec3f(coarse,0.18)')}, ${fineV('vec3f(coarse,0.67)')});
}
fn regional(p: vec2f, q: vec2f) -> f32 {
  let distanceKm = ${f(NUBIS_LAYOUT_METERS / 1000)}*length(centered(p-${v(stageUv)}));
  let group = distantWeather(vec3f(q,0.36));
  let far = smoothstep(10.0,31.0,distanceKm+5.0*group);
  let sparse = mix(${boss ? '0.16, 0.73' : '0.11, 0.67'}, smoothstep(-0.12,0.30,group));
  return mix(1.0,sparse,far);
}
fn pattern(p: vec2f, q: vec2f, regionalDensity: f32) -> vec4f {
  let opening = aperture(p);
  if (opening == 0.0) { return vec4f(0); }
  let density = ${f(PROFILE_LAYOUT_MAX)}*opening*regionalDensity;
  let bands = q.y;
  let low = lowWeather(vec3f(q.x,bands,0.41));
  let middle = midWeather(vec3f(q,0.69));
  let top = tallWeather(vec3f(q,0.25));
  let cut = max(0.0,-${rifts('vec3f(q.x,bands,0.34)')});
  let threshold = ${f(0.70 - 0.48 * look.coverage)};
  let weather = ${boss ? '0.52' : '0.56'}+0.42*low+0.57*middle-0.12*cut;
    let body = smoothstep(threshold-0.018,threshold+0.29,weather);
    let lower = 0.59*smoothstep(0.48,0.78,0.47+0.74*low+0.07*middle-0.12*cut);
    let crest = smoothstep(${boss ? '0.50' : '0.56'},0.82,weather+0.34*top-0.10*cut);
    return density*vec4f(lower,body,${boss ? '0.96' : '0.83'}*crest,0);
}
fn maskLane(q: vec2f, offset: f32) -> f32 {
  return smoothstep(0.34,0.76,0.46+0.57*maskWeather(vec3f(q.x+offset,q.y,0.42)));
}
fn field(uv: vec3f) -> vec4f {
  let p = uv.xy ${mask ? '- 0.5' : ''};
  let q = coordinates(p);
  let density = regional(p,q);
  let weather = pattern(p,q,density);
  ${mask ? `let support = smoothstep(0.0,0.16,max(weather.r,max(weather.g,weather.b)));
    return (0.18*density*support)*vec4f(maskLane(q,0.0),maskLane(q,0.07),maskLane(q,-0.08),0);`
    : 'return weather;'}
}`;
  }
  return { size, volume, format: volume || mask ? 'bgra8unorm' : 'rgba16float', shader, seeds: noise.data(),
    ...(volume ? { densityFilter: [0, 1, 2, 2] } : {}) };
}
