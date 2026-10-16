import { rendererCrashProbe } from './render-worker-recovery-fixture';
import { HANDLE_CUBE, resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import { packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import {
  Camera,
  DirectionalLight,
  Instances,
  Lines,
  Materials,
  MeshFilter,
  MeshRenderer,
  Points,
  perspective,
  type RenderFeature,
} from '@forgeax/engine-render';
import { MorphWeights, Transform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import { ok, type MeshAsset, type MaterialAsset } from '@forgeax/engine-types';
import type { ExecutionBootstrapEntry } from '../src/execution/bootstrap-entry';

/** Identical authoring for co-located and published rendering; updates are explicit. */
const entry: ExecutionBootstrapEntry = (data) => {
  const mode = String(data);
  const crashRenderer = rendererCrashProbe();
  let revision = 0;
  let acknowledgments = 0;
  const renderErrors: string[] = [];
  let submittedErrors: readonly string[] = [];
  const feature: RenderFeature<{ revision: number }> = {
    identity: 'publication.geometry-proof',
    extract: ({ worlds }) => {
      if (worlds.length !== 1) throw new Error('Feature extraction lost the source World');
      return ok({ revision });
    },
    plan: (frame) =>
      ok({
        work: [{ scope: 'frame', resources: [], passes: [] }],
        sourceFeedback: { revision: frame.revision, errors: renderErrors },
      }),
    onSourceFrameSubmitted(frame, feedback) {
      const result = feedback as { revision: number; errors: string[] };
      if (result.revision !== frame.revision)
        throw new Error('Feature feedback does not match its source frame');
      submittedErrors = result.errors;
      acknowledgments++;
    },
  };
  return {
    features: [feature],
    configureRenderer(renderer) {
      renderer.subscribe((event) => {
        if (event.kind === 'error' && renderErrors.length < 10)
          renderErrors.push(JSON.stringify(event.error));
      });
    },
    plugins: [
      {
        name: 'publication-geometry-fixture',
        inject: ['world', 'executionBootstrapHost'],
        apply(ctx) {
          const world = ctx.world;
          world
            .spawn(
              { component: Transform, data: { pos: [0, 0, 6] } },
              {
                component: Camera,
                data: {
                  ...perspective({ fov: Math.PI / 3, aspect: 1, near: 0.1, far: 100 }),
                  tonemap: 0,
                  antialias: 0,
                },
              },
            )
            .unwrap();
          world
            .spawn({
              component: DirectionalLight,
              data: { intensity: 3, direction: [-0.5, -1, -0.3], color: [1, 1, 1] },
            })
            .unwrap();
          let mesh = resolveAssetHandle<MeshAsset>(world, HANDLE_CUBE).unwrap();
          const skinned = mode === 'skin';
          if (skinned) {
            const count = (mesh.attributes.position as Float32Array).length / 3;
            const weights = new Float32Array(count * 4);
            for (let i = 0; i < count; i++) weights[i * 4] = 1;
            const attributes = {
              ...mesh.attributes,
              skinIndex: new Uint16Array(count * 4),
              skinWeight: weights,
            };
            mesh = {
              ...mesh,
              attributes,
              vertices: packInterleavedVertexAttributes(attributes, count).unwrap().vertices,
            };
          } else if (mode === 'morph') {
            const delta = new Float32Array((mesh.attributes.position as Float32Array).length);
            for (let i = 0; i < delta.length; i += 3) delta[i] = 1.2;
            mesh = { ...mesh, morphTargets: [{ position: delta }] };
          } else if (mode === 'points' || mode === 'lines') {
            mesh = {
              ...mesh,
              submeshes: mesh.submeshes.map((row) => ({
                ...row,
                topology: mode === 'points' ? 'point-list' : 'line-list',
              })),
            };
          }
          const meshHandle = world.allocSharedRef('MeshAsset', mesh);
          const material: MaterialAsset = {
            kind: 'material',
            passes: [
              {
                name: 'Forward',
                program: {
                  module: skinned
                    ? 'forgeax::pbr-skin'
                    : mode === 'points' || mode === 'lines'
                      ? 'forgeax::default-unlit'
                      : 'forgeax::default-standard-pbr',
                },
                renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
              },
            ],
            values: { baseColor: [0.8, 0.3, 0.1, 1], metallic: 0, roughness: 0.8 },
          };
          const materialHandle = world.allocSharedRef(
            'MaterialAsset',
            mode === 'points' || mode === 'lines'
              ? Materials.unlit([0.8, 0.3, 0.1, 1])
              : material,
          );
          const entity = world
            .spawn(
              { component: Transform, data: {} },
              { component: MeshFilter, data: { assetHandle: meshHandle } },
              { component: MeshRenderer, data: { materials: [materialHandle] } },
            )
            .unwrap();
          const matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
          const joint = world.spawn({ component: Transform, data: {} }).unwrap();
          if (skinned) {
            const skeleton = world.allocSharedRef('SkeletonAsset', {
              kind: 'skeleton',
              jointCount: 1,
              inverseBindMatrices: matrix,
            });
            world
              .addComponent(entity, {
                component: Skin,
                data: { skeleton, joints: new Uint32Array([joint]) },
              })
              .unwrap();
          }
          if (mode === 'morph')
            world
              .addComponent(entity, {
                component: MorphWeights,
                data: { weights: new Float32Array([0.1]) },
              })
              .unwrap();
          if (mode === 'instances')
            world
              .addComponent(entity, { component: Instances, data: { transforms: matrix } })
              .unwrap();
          if (mode === 'points')
            world.addComponent(entity, { component: Points, data: { sizePx: 8 } }).unwrap();
          if (mode === 'lines')
            world.addComponent(entity, { component: Lines, data: { width: 5 } }).unwrap();
          const port = ctx.executionBootstrapHost.port;
          if (port !== undefined) {
            port.onmessage = (event) => {
              if (event.data === 'recover') crashRenderer();
              if (event.data === 'update') {
                revision++;
                if (skinned) world.set(joint, Transform, { pos: [1, 0, 0] }).unwrap();
                else if (mode === 'morph')
                  world.set(entity, MorphWeights, { weights: new Float32Array([0.9]) }).unwrap();
                else if (mode === 'instances') {
                  const moved = matrix.slice();
                  moved[12] = 1;
                  world.set(entity, Instances, { transforms: moved }).unwrap();
                } else world.set(entity, Transform, { pos: [1, 0, 0] }).unwrap();
              }
              port.postMessage({ revision, acknowledgments, errors: submittedErrors });
            };
            port.start();
          }
        },
      },
    ],
  };
};
export default entry;
