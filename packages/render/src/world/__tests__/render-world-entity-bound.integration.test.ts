import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { rhi } from '@forgeax/engine-rhi-null';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { expect, it, vi } from 'vitest';
import { renderLifecycleManifestUrl } from '../../__tests__/shader-manifest-fixture';
import { createRenderer, exposeRenderer } from '../../assembly/factory';
import { Camera, MeshFilter, MeshRenderer, PointLight, PointLightShadow } from '../../components';
import { ANTIALIAS_NONE, BLOOM_DISABLED } from '../../components/camera';
import { CameraView } from '../../components/camera-view';
import { ReflectionProbe } from '../../components/reflection-probe';
import { SceneRows } from '../../scene/scene-rows';
import { ShadowView } from '../render-lights';
import { RenderReflectionProbe } from '../render-probes';
import { RenderView } from '../render-views';
import * as renderWorlds from '../render-world';

vi.mock('../render-world', async (actual) => {
  const module = await actual<typeof import('../render-world')>();
  return { ...module, createRenderWorld: vi.fn(module.createRenderWorld) };
});

const ROWS = 10_000;
const VIEWS = 2;
const LIGHTS = 3;
const PROBES = 2;
/** A point light casts through six face views. */
const POINT_FACES = 6;

/**
 * Renderable rows live in SceneSlots columns, never as Render World entities
 * (design: render-world-row-entities, R1 4/5 retracted by 3e4348b124). Only
 * objects with a lifecycle and low cardinality are entities: views, lights,
 * their shadow views and probes. Reintroducing one entity per row makes the
 * count scale with ROWS and fails this gate.
 */
it('keeps the Render World entity count independent of the staged renderable rows', async () => {
  const host = await createRenderer(
    { width: 64, height: 64, getContext: () => null } as unknown as HTMLCanvasElement,
    { rhi },
    { shaderManifestUrl: renderLifecycleManifestUrl() },
  );
  const initialized = await host.initialization;
  if (!initialized.ok) throw initialized.error;
  const renderer = exposeRenderer(host);
  const created = vi.mocked(renderWorlds.createRenderWorld).mock.results.at(-1);
  if (created?.type !== 'return') throw new Error('the Renderer creates its Render World');
  const renderWorld = created.value;
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  for (let index = 0; index < VIEWS; index++) {
    const camera = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 8] } },
        {
          component: Camera,
          data: { fov: Math.PI / 3, aspect: 1, antialias: ANTIALIAS_NONE, bloom: BLOOM_DISABLED },
        },
      )
      .unwrap();
    world.addComponent(camera, { component: CameraView, data: {} }).unwrap();
  }
  for (let index = 0; index < LIGHTS; index++)
    world
      .spawn(
        { component: Transform, data: { pos: [index, 4, 0] } },
        { component: PointLight, data: {} },
        { component: PointLightShadow, data: {} },
      )
      .unwrap();
  for (let index = 0; index < PROBES; index++)
    world
      .spawn(
        { component: Transform, data: { pos: [index * 4, 1, 0] } },
        { component: ReflectionProbe, data: {} },
      )
      .unwrap();
  const mesh = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  for (let index = 0; index < ROWS; index++)
    world
      .spawn(
        { component: Transform, data: { pos: [index % 100, 0, Math.floor(index / 100)] } },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: {} },
      )
      .unwrap();
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  const lease = attached.value;
  const apply = vi.spyOn(SceneRows.prototype, 'apply');
  try {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    const frame = renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } });
    if (!frame.ok) throw frame.error;
    expect((await frame.value.completed).ok).toBe(true);

    // The rows were staged: the store received every renderable.
    const staged = apply.mock.calls.reduce((sum, [operations]) => sum + operations.length, 0);
    expect(staged).toBeGreaterThanOrEqual(ROWS);

    const shadowViews = [...renderWorld.query({ read: [ShadowView] }).unwrap()].length;
    expect(shadowViews).toBe(LIGHTS * POINT_FACES);
    const probeRows = [...renderWorld.query({ read: [RenderReflectionProbe] }).unwrap()].length;
    expect(probeRows).toBe(PROBES);
    const views = [...renderWorld.query({ read: [RenderView] }).unwrap()].length;
    const entities = renderWorld.inspect().entityCount;
    expect(entities).toBeGreaterThan(0);
    expect(entities).toBe(views + LIGHTS + PROBES + shadowViews);
    expect(entities).toBeLessThan(ROWS / 100);
  } finally {
    apply.mockRestore();
    lease.dispose();
    expect((await renderer.dispose()).ok).toBe(true);
  }
}, 120_000);
