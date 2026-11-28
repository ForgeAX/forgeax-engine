import { rng } from '@forgeax/engine/math';
import { noiseTables, type CloudBake } from './gpu-bake.ts';
import { ALPINE_LAYOUT_METERS, ALPINE_SEED, SIZE, type AlpineTextureRole } from './alpine-textures.ts';

export function alpineGpuRecipe(role: AlpineTextureRole, size: number = SIZE[role]): CloudBake {
  const noise = noiseTables(true);
  const volume = role === 'body-noise';
  const mask = role === 'layout-mask';
  let shader: string;
  if (volume) {
    const seeds = rng.create(ALPINE_SEED).fork('volume');
    const grad = (name: string, period: number) => noise.gradient(seeds.fork(name).seed, period)('p');
    const cell = (name: string, period: number) => noise.cells(seeds.fork(name).seed, period)('p');
    shader = /* wgsl */ `
fn field(p: vec3f) -> vec4f {
  let broad = ${grad('mass', 5)};
  let medium = ${grad('folds', 10)};
  let fine = ${grad('wisps', 20)};
  let grain = ${grad('grain', 40)};
  let lobes = ${cell('lobes', 6)};
  let fold = ${cell('folds', 12)};
  let detail = ${cell('detail', 24)};
  let pore = ${cell('pores', 36)};
  return vec4f(0.62+0.40*${grad('warp', 6)}+0.17*${grad('warp-detail', 12)}+0.045*grain,
    0.48+0.36*broad+0.14*medium+0.068*fine+0.027*grain+0.74*(lobes-0.43)+0.29*(fold-0.43),
    0.47+0.34*fine+0.13*grain+0.73*(detail-0.43)+0.18*(pore-0.43),
    0.48+0.9*(pore-0.43)+0.1*grain);
}`;
  } else if (role === 'height-profile') {
    shader = /* wgsl */ `
fn lobe(height: f32, center: f32, below: f32, above: f32, peak: f32) -> f32 {
  let distance = (height-center)/select(above,below,height<center);
  return clamp(peak-0.27*(length(vec2f(distance,0.12))-0.12),0.0,1.0);
}
fn field(p: vec3f) -> vec4f {
  let weight = smoothstep(0.018,0.31,p.y)*(1.0-smoothstep(0.955,0.995,p.y));
  let growth = clamp(p.y/0.91,0.0,1.0);
  let lift = sqrt(growth);
  let taper = weight*smoothstep(0.013,0.051,p.x)*(1.0-smoothstep(0.84,0.955,p.x));
  return taper*vec4f(
    lobe(p.x,mix(0.067,0.119,growth),0.081,mix(0.055,0.118,growth),0.46+0.143*lift),
    lobe(p.x,mix(0.117,0.318,growth),mix(0.14,0.30,growth),mix(0.11,0.275,growth),0.425+0.219*lift),
    lobe(p.x,mix(0.190,0.448,growth),mix(0.155,0.375,growth),mix(0.155,0.305,growth),0.418+0.256*lift),0);
}`;
  } else {
    const seeds = rng.create(ALPINE_SEED).fork('weather');
    const grad = (name: string, period: number) => noise.gradient(seeds.fork(name).seed, period);
    const octave = (label: string, period: number) => {
      const seed = seeds.fork(label).seed;
      const terms = [0.6, 0.25, 0.11, 0.04].map((weight, index) =>
        `${weight}*${noise.gradient(seed + index, period * 2 ** index)('vec3f(p,0)')}`);
      return `fn ${label}(p: vec2f) -> f32 { return ${terms.join(' + ')}; }`;
    };
    shader = /* wgsl */ `
${octave('cumulus', 12)}
${octave('crests', 15)}
${octave('banks', 7)}
fn field(uv: vec3f) -> vec4f {
  let p = uv.xy ${mask ? '-0.5' : ''};
  let broad = p+0.042*vec2f(${grad('warp-u', 8)('vec3f(p,0)')},${grad('warp-v', 8)('vec3f(p,0)')});
  let q = broad+0.009*vec2f(${grad('fold-u', 37)('vec3f(broad,0)')},${grad('fold-v', 37)('vec3f(broad,0)')});
  let climate = ${grad('climate', 4)('vec3f(q,0)')};
  let rangeKm = ${ALPINE_LAYOUT_METERS / 1000}.0*length(centered(q))+7.0*climate;
  let clearing = smoothstep(0.8,4.1,rangeKm);
  let far = smoothstep(20.0,56.0,rangeKm);
  let cell = cumulus(q+vec2f(0.132,-0.069));
  let crest = crests(q+vec2f(-0.084,0.156));
  let mass = 0.5+0.77*cell+0.14*climate;
  let puffs = smoothstep(mix(0.408,0.506,far),mix(0.704,0.781,far),mass);
  let middle = clearing*mix(0.94,0.67,far)*puffs;
  let tower = clearing*(1.0-0.65*far)*0.94*smoothstep(0.487,0.768,mass+0.17*crest)*smoothstep(0.16,0.61,puffs);
  ${mask ? `let grain = ${grad('mask-grain', 23)('vec3f(q,0)')};
    let mask = smoothstep(0.28,0.78,max(middle,tower))*mix(0.22,0.82,smoothstep(-0.4,0.4,climate+0.25*grain));
    return mask*vec4f(0.85,1,0.91,0);`
    : `let bank = 0.51+0.71*banks(vec2f(q.x+0.35,q.x+3.0*q.y-0.21))+0.12*climate;
    let distanceBand = smoothstep(8.0,19.0,rangeKm)*(1.0-0.58*smoothstep(43.0,76.0,rangeKm));
    return vec4f(0.92*smoothstep(0.519,0.748,bank)*distanceBand,middle,tower,0);`}
}`;
  }
  return { size, volume, format: mask ? 'rgba8unorm' : 'rgba16float', clampHalf: !volume, shader, seeds: noise.data() };
}
