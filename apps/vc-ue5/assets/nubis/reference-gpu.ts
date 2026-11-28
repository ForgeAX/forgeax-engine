import { rng } from '@forgeax/engine/math';
import { referenceTextureRecipe, type CloudTextureRole, type CloudTextureValues } from '../../../../forgeax-engine-assets/demo-assets/volumetric-clouds/assets/reference-textures.ts';
import { noiseTables, wgslFloat as f, type CloudBake } from './gpu-bake.ts';

export function referenceGpuRecipe(role: CloudTextureRole, values: CloudTextureValues): CloudBake {
  const size = (values.resolution === 'preview' ? referenceTextureRecipe.previewDimensions : referenceTextureRecipe.dimensions)[role];
  const stream = rng.create(values.seed).fork(role);
  const noise = noiseTables(false);
  let shader: string;
  let weatherGrid: number | undefined;
  if (role === 'pattern' || role === 'mask') {
    const mask = role === 'mask';
    const frequency = mask ? values.maskFrequency : values.patternFrequency;
    const coarse = Math.max(2, Math.round(frequency / 2));
    const warpX = noise.gradient(stream.fork('warp-x').seed, coarse);
    const warpY = noise.gradient(stream.fork('warp-y').seed, coarse);
    const fineX = noise.gradient(stream.fork('fine-x').seed, frequency * 4);
    const fineY = noise.gradient(stream.fork('fine-y').seed, frequency * 4);
    const lines = [0.5, 1, 2, 0.5].map((scale, channel) => {
      const lane = stream.fork(String(channel));
      const period = mask ? frequency : Math.max(2, Math.round(frequency * scale));
      const terms = [0.64, 0.21, 0.10, 0.05].map((weight, index) =>
        `${f(weight)}*${noise.gradient(lane.fork(String(index)).seed, period * 2 ** index)('q')}`);
      if (mask && channel === 3) return 'let lane3 = 0.0;';
      const density = `let density${channel} = 0.5+0.95*(${terms.join(' + ')});`;
      if (mask) {
        const centerX = [0.46, 0.5, 0.54][channel]!;
        const centerY = [0.52, 0.46, 0.5][channel]!;
        return `${density}
  let envelope${channel} = 1.0-1.1*length(sin(3.14159265359*(q.xy-vec2f(${centerX},${centerY}))));
  let lane${channel} = clamp(0.5+${f(values.maskContrast)}*(smoothstep(0.0,0.9,envelope${channel}+0.35*(density${channel}-0.5))-0.5),0.0,1.0);`;
      }
      const threshold = 0.69 - values.patternCoverage * 0.48 + [0.015, -0.045, -0.025, -0.025][channel]!;
      return `${density}\n  let lane${channel} = smoothstep(${f(threshold)},${f(threshold + (channel === 2 ? 0.5 : 0.37))},density${channel});`;
    });
    weatherGrid = Math.min(size, Math.max(256, frequency * 32));
    shader = /* wgsl */ `
fn field(uv: vec3f) -> vec4f {
  let p = vec3f(uv.xy,0);
  let broad = p.xy+${f((mask ? 0.8 : 1.8) / frequency)}*vec2f(${warpX('p')},${warpY('p')});
  let r = vec3f(broad,0);
  let q = vec3f(broad+${f(0.3 / frequency)}*vec2f(${fineX('r')},${fineY('r')}),0);
  ${lines.join('\n  ')}
  return vec4f(lane0,lane1,lane2,lane3);
}`;
  } else if (role === 'profile') {
    shader = /* wgsl */ `
fn field(uv: vec3f) -> vec4f {
  let y = uv.y;
  let root = sqrt(y);
  let centers = vec4f(0.16+0.18*y,0.5+0.1*y,0.9,0.76-0.26*y);
  let peaks = vec4f(0.47+0.15*root,0.446+0.17*root,0.5+0.04*y,0.48+0.24*y);
  let slopes = vec4f(0.4,0.37+0.13*root,0.5,0.35);
  let distance = (vec4f(uv.x-${f(values.profileBaseOffset)})-centers)/${f(values.profileThickness)};
  return peaks-slopes*sqrt(distance*distance+vec4f(${f((values.profileSoftness * 0.2) ** 2)}));
}`;
  } else {
    const band = (multiple: number) => Math.min(size / 2, values.bodyFrequency * multiple);
    const grad = (label: string, multiple: number) => noise.gradient(stream.fork(label).seed, band(multiple))('p');
    const cell = (label: string, multiple: number) => noise.cells(stream.fork(label).seed, band(multiple), true)('p');
    shader = /* wgsl */ `
fn field(p: vec3f) -> vec4f {
  let broad = ${grad('perlin', 2)};
  let fine = ${grad('detail', 4)};
  let grain = ${grad('micro', 8)};
  let cellular = ${cell('cells', 2)};
  let small = ${cell('fine-cells', 4)};
  let tiny = ${cell('micro-cells', 8)};
  let body = mix(0.45+0.8*broad,0.45+1.1*(cellular-0.48)+0.3*broad,${f(values.bodyWorleyMix)});
  let detail = ${f(values.bodyDetail)};
  return vec4f(0.534+0.52*${grad('warp', 1)}+0.16*${grad('warp-detail', 2)}+0.06*grain,
    body+detail*(0.24*fine+0.12*grain+0.3*(small-0.48)),
    0.433+0.58*fine+0.22*grain+detail*0.8*(small-0.48),
    0.45+1.1*(tiny-0.48)+0.1*grain);
}`;
  }
  return { size, volume: role === 'body', format: role === 'mask' || role === 'body' ? 'bgra8unorm' : 'rgba16float',
    ...(weatherGrid === undefined ? {} : { weatherGrid }), shader, seeds: noise.data() };
}
