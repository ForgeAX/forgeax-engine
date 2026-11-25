import * as THREE from '@forgeax/engine/three';
import { EffectComposer } from '@forgeax/engine/three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from '@forgeax/engine/three/addons/postprocessing/OutputPass.js';
import { RenderPass } from '@forgeax/engine/three/addons/postprocessing/RenderPass.js';
import type { Renderer } from '@forgeax/engine-render';
import { decodeImage, toRgba8 } from '@forgeax/engine-rhi-debug';
import { expect, it } from 'vitest';

const program = {
  identity: 'hdr-gain-test',
  uniformWords: 4,
  uniforms: [{ name: 'gain', offset: 0, width: 1 }],
  source: `
struct Vertex {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}
@group(1) @binding(0) var inputColor: texture_2d<f32>;
@group(1) @binding(1) var inputSampler: sampler;
@group(1) @binding(2) var<uniform> params: vec4f;
@vertex fn vs_main(@builtin(vertex_index) index: u32) -> Vertex {
  let p = array<vec2f, 3>(vec2f(-1., -1.), vec2f(3., -1.), vec2f(-1., 3.))[index];
  return Vertex(vec4f(p, 0., 1.), vec2f(p.x + 1., 1. - p.y) * 0.5);
}
@fragment fn fs_main(input: Vertex) -> @location(0) vec4f {
  let color = textureSample(inputColor, inputSampler, input.uv);
  return vec4f(color.rgb * params.x, color.a);
}`,
} as const;

it('projects live Three uniforms into HDR before OutputPass and removes disabled work', {
  timeout: 120000,
}, async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  document.body.append(canvas);
  const renderer = new THREE.WebGPURenderer({ canvas, forgeax: { fullscreenPrograms: [program] } });
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 2;
  const geometry = new THREE.PlaneGeometry(4, 4);
  const material = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.25, 0.125, 0.0625) });
  scene.add(new THREE.Mesh(geometry, material));
  const gain = { value: 1 };
  const effect = new THREE.ShaderMaterial({
    uniforms: { gain },
    depthTest: false,
    depthWrite: false,
  });
  const pass = new THREE.ThreeFullscreenPass(effect, program);
  const composer = new EffectComposer(renderer);
  const output = new OutputPass();
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(pass);
  composer.addPass(output);
  const draw = async () => {
    for (let attempt = 0; attempt < 16; attempt++) {
      composer.render();
      const receipt = renderer.inspect().receipt;
      if (receipt === undefined) throw new Error('missing composer receipt');
      (await receipt.completed).unwrap();
      if (receipt.presentation === 'ready') return;
      (await receipt.preparationCompleted)?.unwrap();
    }
    throw new Error('composer did not present');
  };
  const red = async () => {
    const native = (Reflect.get(renderer, 'runtime') as { readonly native: Renderer }).native;
    const requested = native.requestObservation?.(['final-display']);
    if (requested === undefined) throw new Error('missing native output observation');
    requested.unwrap();
    await draw();
    const frame = THREE.readThreeFrame(renderer);
    if (frame === undefined) throw new Error('missing composer frame');
    const capture = (await frame.observe({ include: ['final-display'] })).unwrap();
    const image = capture.observations?.find((entry) => entry.domain === 'final-display');
    if (image === undefined) throw new Error('missing display pixels');
    return toRgba8(decodeImage(image.bytes, image.metadata).unwrap())[(32 * 64 + 32) * 4];
  };
  try {
    await renderer.init();
    for (let frame = 0; frame < 60; frame++) await draw();
    expect(renderer.inspect().renderer.perFramePassNames).toContain('hdr-output-effect-0');
    expect(await red()).toBeGreaterThan(80);
    gain.value = 0;
    await draw();
    expect(renderer.inspect().renderer.perFramePassNames).toContain('hdr-output-effect-0');
    expect(await red()).toBe(0);
    pass.enabled = false;
    await draw();
    expect(renderer.inspect().renderer.perFramePassNames).not.toContain('hdr-output-effect-0');
    expect(await red()).toBeGreaterThan(80);
  } finally {
    composer.dispose();
    output.dispose();
    geometry.dispose();
    material.dispose();
    effect.dispose();
    await renderer.dispose();
    canvas.remove();
  }
});
