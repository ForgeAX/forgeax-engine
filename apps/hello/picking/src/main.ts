// apps/hello/picking — screen-to-entity picking end-to-end demonstration
// (feat-20260529-picking-raycasting-screen-to-entity M4 / w16).
//
// Spawns a single cube at the origin in front of a perspective camera. A DOM
// click listener unprojects the viewport-relative pointer coordinate into a
// world-space ray via the runtime `pick` free function and, on a hit, swaps the
// cube's `MeshRenderer.material` from the default grey to a bright highlight
// material. Clicking empty space (a miss) leaves the cube unchanged.
//
// Four-step recipe (same as hello-cube / hello-culling):
//   (1) await host initialization
//   (2) register a custom box mesh (createBoxGeometry -> world.allocSharedRef(...)) so the
//       AABB the ray-AABB test needs is present, plus two unlit materials
//   (3) spawn the cube + a perspective camera entity
//   (4) rAF draw loop + a `click` listener that calls `pick(...)` and highlights
//
// The canvas is a fixed 800x600 (index.html). DOM coordinate conversion lives
// here in the demo (the Renderer does not expose the canvas; requirements
// OOS-13): `e.clientX - rect.left` / `e.clientY - rect.top` maps the page-space
// pointer to the viewport-relative coordinate `pick` expects.

import { World } from '@forgeax/engine-ecs';
import { type MeshAsset } from '@forgeax/engine-assets-runtime';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';

import { perspective } from '@forgeax/engine-render';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
import { EngineEnvironmentError, type MaterialAsset } from '@forgeax/engine-runtime';
import { Materials } from '@forgeax/engine-render';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';

import { pick, pickVertex, pickVertexOnEntity, type VertexHit } from '@forgeax/engine-picking';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const world = new World();

// DirectionalLight has no asset deps; safe to spawn before the renderer is ready.
world.spawn({
  component: DirectionalLight,
  data: {
    direction: [-0.5, -1, -0.3],
    color: [1, 1, 1], intensity: 1,
  },
});

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('hello-picking: missing <canvas id="app"> in index.html');
bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) console.error('[picking] no usable backend:', err);
  else console.error('[picking] bootstrap error:', err);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const constructed = await constructRuntimeRendererHost(target, {}, forgeaxBundlerAdapter());
  if (!constructed.ok) throw constructed.error;
  const renderer = constructed.value.renderer;
  const worldAttachment1 = renderer.attach(world);
  if (!worldAttachment1.ok) throw worldAttachment1.error;
  console.warn('[picking] Standard pipeline active');


  // Custom cube mesh ensures AABB computation (the built-in HANDLE_CUBE uses
  // engine-internal handle values); the ray-AABB pick test reads MeshAsset.aabb.
  const boxResult = createBoxGeometry(1, 1, 1, 1, 1, 1);
  if (!boxResult.ok) {
    console.error('[picking] createBoxGeometry failed:', boxResult.error.code);
    return;
  }
  const cubeHandle = world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', boxResult.value);

  // Two unlit materials: default grey + bright highlight (swapped on a pick hit).
  const defaultHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.unlit([0.55, 0.55, 0.6, 1]),
  );
  const highlightHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.unlit([1, 0.85, 0.1, 1]),
  );

  // Cube at the origin, bound to the default material.
  const cubeEntity = world.spawn(
    { component: Transform, data: {} },
    { component: MeshFilter, data: { assetHandle: cubeHandle } },
    { component: MeshRenderer, data: { materials: [defaultHandle] } },
  ).unwrap();

  // Perspective camera looking down -Z at the cube.
  const cameraEntity = world.spawn(
    {
      component: Transform,
      data: { pos: [0, 0, 4]},
    },
    {
      component: Camera,
      data: perspective({
        fov: Math.PI / 4,
        aspect: target.width / target.height,
        autoAspect: false,
      }),
    },
  ).unwrap();

  const probeButton = document.querySelector<HTMLButtonElement>('#probe-vertices');
  const mutateButton = document.querySelector<HTMLButtonElement>('#mutate-transform');
  const cameraButton = document.querySelector<HTMLButtonElement>('#update-camera');
  const status = document.querySelector<HTMLOutputElement>('#picking-status');
  if (!probeButton || !mutateButton || !cameraButton || !status) {
    throw new Error('hello-picking: missing vertex probe controls');
  }

  const center = (): [number, number] => [target.width / 2, target.height / 2];
  const summarizeHit = (hit: VertexHit): Record<string, unknown> => ({
    entity: hit.entity,
    vertexIndex: hit.vertexIndex,
    worldPos: [
      Number(hit.worldPos[0]),
      Number(hit.worldPos[1]),
      Number(hit.worldPos[2]),
    ],
    screenDist: Number(hit.screenDist.toFixed(4)),
    worldDist: Number(hit.worldDist.toFixed(4)),
    deformed: hit.deformed,
  });

  const probeVertices = (screenX: number, screenY: number, phase: string): VertexHit[] => {
    const propagation = propagateTransforms(world);
    if (!propagation.ok) {
      console.error(`[picking] vertex phase=${phase} propagation=${propagation.error.code}`);
      status.value = `propagation error: ${propagation.error.code}`;
      return [];
    }

    const sceneHits = pickVertex(world, cameraEntity, screenX, screenY, target.width, target.height, {
      limit: 3,
    });
    const entityHits = pickVertexOnEntity(
      world,
      cameraEntity,
      screenX,
      screenY,
      target.width,
      target.height,
      cubeEntity,
      { limit: 3 },
    );
    const sceneEvidence = sceneHits.map(summarizeHit);
    const entityEvidence = entityHits.map(summarizeHit);
    console.log(
      `[picking] vertex phase=${phase} scene=${JSON.stringify(sceneEvidence)} entity=${JSON.stringify(entityEvidence)}`,
    );
    status.value = `${phase}: ${sceneHits.length} scene vertices`;
    return sceneHits;
  };

  const updateTransform = (): void => {
    const result = world.set(cubeEntity, Transform, { pos: [0.25, 0, 0] });
    if (!result.ok) {
      console.error(`[picking] transform update failed: ${result.error.code}`);
      return;
    }
    const [x, y] = center();
    console.log('[picking] transform phase=updated posX=0.25');
    probeVertices(x, y, 'after-transform');
  };

  const updateCamera = (): void => {
    const result = world.set(cameraEntity, Camera, { aspect: 1.1, fov: Math.PI / 3 });
    if (!result.ok) {
      console.error(`[picking] camera update failed: ${result.error.code}`);
      return;
    }
    const [x, y] = center();
    console.log('[picking] camera phase=updated aspect=1.1 fov=1.0472');
    probeVertices(x, y, 'after-camera');
  };

  probeButton.addEventListener('click', () => {
    const [x, y] = center();
    probeVertices(x, y, 'button');
  });
  mutateButton.addEventListener('click', updateTransform);
  cameraButton.addEventListener('click', updateCamera);

  // Click -> pick -> highlight. DOM coordinate conversion (OOS-13) is done here.
  target.addEventListener('click', (e) => {
    const rect = target.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const propagation = propagateTransforms(world);
    if (!propagation.ok) {
      console.error(`[picking] propagation failed: ${propagation.error.code}`);
      return;
    }
    const hit = pick(
      world,
      cameraEntity,
      screenX,
      screenY,
      target.width,
      target.height,
    );
    probeVertices(screenX, screenY, 'pointer');
    if (hit) {
      world.set(hit.entity, MeshRenderer, { materials: [highlightHandle] });
      console.log(`[picking] hit entity=${hit.entity} distance=${hit.distance.toFixed(3)}`);
    } else {
      world.set(cubeEntity, MeshRenderer, { materials: [defaultHandle] });
      console.log('[picking] miss (no entity under pointer)');
    }
  });

  const frame = (): void => {
    world.update().unwrap();
    const r = renderer.draw({
      leases: [worldAttachment1.value],
      camera: { lease: worldAttachment1.value },
      environment: { lease: worldAttachment1.value },
    });
    if (!r.ok) console.error('[picking] draw error:', r.error);
    requestAnimationFrame(frame);
  };

  requestAnimationFrame(frame);
}
