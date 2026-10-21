import type { ExecutionBootstrapEntry } from '@forgeax/engine-app';
import { createPlaneGeometry, packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import { Camera, DirectionalLight, Materials, MeshFilter, MeshRenderer, type RenderFeature } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import { ok, type MaterialAsset, type TextureAsset } from '@forgeax/engine-types';
import testQuality from '../../../scripts/test/render-quality.json' with { type: 'json' };

/** Ordinary assets cross the source publication; the profile is configured in its actual realm. */
const entry: ExecutionBootstrapEntry = (mode) => {
  let revision = 0;
  let acknowledgments = 0;
  let submittedErrors: readonly string[] = [];
  const errors: string[] = [];
  const feature: RenderFeature<{ revision: number }> = {
    identity: 'publication.subsurface-proof',
    extract: () => ok({ revision }),
    plan: (frame) => ok({ work: [{ scope: 'frame', resources: [], passes: [] }],
      sourceFeedback: { revision: frame.revision, errors } }),
    onSourceFrameSubmitted(frame, feedback) {
      const result = feedback as { revision: number; errors: string[] };
      if (result.revision !== frame.revision) throw new Error('SSS publication acknowledgment changed revision');
      submittedErrors = result.errors;
      acknowledgments++;
    },
  };
  return {
    features: [feature],
    configureRenderer(renderer) {
      const result = renderer.setProfile({ ...renderer.inspect().profile, renderPath: 'deferred', subsurfaceQuality: testQuality.subsurfaceQuality as 'low' | 'high' });
      if (!result.ok) throw result.error;
      renderer.subscribe((event) => {
        if (event.kind === 'error' && errors.length < 10) errors.push(JSON.stringify(event.error));
      });
    },
    plugins: [{
      name: 'publication-subsurface-fixture',
      inject: ['world', 'assets', 'executionBootstrapHost'],
      apply(ctx) {
          const assets = ctx.assets;
          if (assets === undefined) throw new Error('Missing runtime asset owner');
        const world = ctx.world;
        const skinned = mode === 'skin';
        let mesh = createPlaneGeometry(2, 2, 8, 8).unwrap();
        if (skinned) {
          const position = mesh.attributes.position as Float32Array;
          const count = position.length / 3;
          const skinIndex = new Uint16Array(count * 4), skinWeight = new Float32Array(count * 4);
          for (let i = 0; i < count; i++) {
            const weight = ((position[i * 3 + 1] ?? 0) + 1) / 2;
            skinIndex.set([0, 1, 0, 0], i * 4);
            skinWeight.set([1 - weight, weight, 0, 0], i * 4);
          }
          const attributes = { ...mesh.attributes, skinIndex, skinWeight };
          mesh = { ...mesh, attributes, vertices: packInterleavedVertexAttributes(attributes, count).unwrap().vertices };
        }
        const data = new Uint8Array(128 * 128 * 4);
        for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++)
          data.set([x >= 64 ? 255 : 0, 0, 0, 255], (y * 128 + x) * 4);
        const texture: TextureAsset = { kind: 'texture', shape: { viewDimension: '2d', extent: { width: 128, height: 128 } },
          format: 'rgba8unorm', colorSpace: 'linear', mips: { kind: 'none' }, data };
        const textureHandle = assets.create(texture).unwrap();
        const material = (radius: number, weight: number): MaterialAsset => {
          const value = Materials.standard({ baseColor: [1, 1, 1, 1], baseColorTexture: { texture: textureHandle },
            roughness: 1, specular: 0, subsurfaceRadius: [radius, radius, radius], subsurfaceWeight: weight });
          if (!skinned) return value;
          if (!value.passes) throw new Error('Missing native Standard passes');
          const convert = (pass: typeof value.passes[number]) => ({ ...pass, program: { ...pass.program,
            module: pass.program.module === 'forgeax_material::standard' ? 'forgeax::pbr-skin' : pass.program.module } });
          return { ...value, passes: [convert(value.passes[0]), ...value.passes.slice(1).map(convert)] };
        };
        const entity = world.spawn({ component: Transform, data: {} },
          { component: MeshFilter, data: { assetHandle: assets.create(mesh).unwrap() } },
          { component: MeshRenderer, data: { materials: [assets.create(material(0, 1)).unwrap()] } }).unwrap();
        const joints = [world.spawn({ component: Transform, data: {} }).unwrap(), world.spawn({ component: Transform, data: {} }).unwrap()];
        if (skinned) {
          const inverseBindMatrices = new Float32Array(32);
          for (const joint of [0, 1]) for (const diagonal of [0, 5, 10, 15]) inverseBindMatrices[joint * 16 + diagonal] = 1;
          world.addComponent(entity, { component: Skin, data: { skeleton: assets.create({
            kind: 'skeleton', jointCount: 2, inverseBindMatrices, bounds: new Float32Array([-1, -1, -.01, 1, 1, .01]),
          }).unwrap(), joints: new Uint32Array(joints) } }).unwrap();
        }
        world.spawn({ component: Transform, data: { pos: [0, 0, 5] } }, { component: Camera, data: {
          projection: 1, left: -1, right: 1, top: 1, bottom: -1, near: .1, far: 30,
          aspect: 1, antialias: 0, bloom: 0, exposure: 1, tonemap: 0,
        } }).unwrap();
        world.spawn({ component: DirectionalLight, data: { intensity: 3, direction: [0, 0, -1], castShadow: false } }).unwrap();
        const port = ctx.executionBootstrapHost.port;
        if (port) {
          port.onmessage = (event) => {
            if (event.data === 'enable' || event.data === 'disable' || event.data === 'zero') {
              revision++;
              world.set(entity, MeshRenderer, { materials: [assets.create(material(event.data === 'zero' ? 0 : 6, event.data === 'disable' ? 0 : 1)).unwrap()] }).unwrap();
            }
            if (event.data === 'pose') {
              revision++;
              world.set(joints[1]!, Transform, { pos: [.1, 0, 0] }).unwrap();
            }
            port.postMessage({ revision, acknowledgments, errors: submittedErrors });
          };
          port.start();
        }
      },
    }],
  };
};
export default entry;
