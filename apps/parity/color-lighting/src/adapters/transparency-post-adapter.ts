import { World } from '@forgeax/engine-ecs';
import { createPlaneGeometry } from '@forgeax/engine-geometry';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  perspective,
  TONEMAP_REINHARD,
  type Renderer,
} from '@forgeax/engine-render';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
import type {
  BundlerOptions,
  RendererLegacyHostAdapter,
} from '@forgeax/engine-render/internal/construct-renderer';
import { Transform } from '@forgeax/engine-scene';
import type { SceneCase } from '../contracts/types';
import { readCanvasPixels } from '../capture/canvas-readback';
import { projectForgeaxSurfaceEvidence, type ForgeaxCaptureOutput } from './forgeax-adapter';
import { threeToneMappingId, type ThreeCaptureOutput } from './three-adapter';
import { WebGPURenderer } from 'three/webgpu';
import {
  Color,
  DirectionalLight as ThreeDirectionalLight,
  DoubleSide,
  LinearSRGBColorSpace,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from 'three';

const blend = {
  color: { srcFactor: 'src-alpha' as const, dstFactor: 'one-minus-src-alpha' as const, operation: 'add' as const },
  alpha: { srcFactor: 'one' as const, dstFactor: 'one-minus-src-alpha' as const, operation: 'add' as const },
};

function makeMaterial(world: World): void {
  const plane = createPlaneGeometry(2.8, 2.8);
  if (!plane.ok) throw new Error(`transparent plane creation failed: ${plane.error.code}`);
  const meshHandle = world.allocSharedRef('MeshAsset', plane.value);
  const materialHandle = world.allocSharedRef('MaterialAsset', Materials.standard({
    baseColor: [0.8, 0.28, 0.12, 0.5],
    metallic: 0,
    roughness: 1,
    queue: 3000,
    renderState: { cullMode: 'none', depthWriteEnabled: false, blend },
  }));
  world.spawn(
    { component: Transform, data: {} },
    { component: MeshFilter, data: { assetHandle: meshHandle } },
    { component: MeshRenderer, data: { materials: [materialHandle] } },
  ).unwrap();
}

export function makeTransparencyWorld(sceneCase: SceneCase): World {
  const world = new World();
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 3], quat: [0, 0, 0, 1] } },
    {
      component: Camera,
      data: {
        ...perspective({ fov: Math.PI / 4, aspect: sceneCase.scene.width / sceneCase.scene.height }),
        clearColor: sceneCase.scene.background,
        ...(sceneCase.colorDomain === 'linearHdr' ? { tonemap: TONEMAP_REINHARD } : {}),
      },
    },
  ).unwrap();
  makeMaterial(world);
  world.spawn({
    component: DirectionalLight,
    data: { direction: [0, 0, -1], color: [1, 1, 1], intensity: 1, castShadow: false },
  }).unwrap();
  return world;
}

function configFor(sceneCase: SceneCase) {
  return {
    width: sceneCase.scene.width,
    height: sceneCase.scene.height,
    colorDomain: sceneCase.colorDomain,
    background: sceneCase.scene.background,
    ...(sceneCase.pipeline === undefined ? {} : { pipeline: sceneCase.pipeline.identity }),
  } as const;
}

async function waitForAnimationFrameOrTimeout(): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timeout = setTimeout(finish, 250);
    requestAnimationFrame(() => {
      clearTimeout(timeout);
      finish();
    });
  });
}

async function settleWebglRenderer(renderer: Renderer): Promise<void> {
  await waitForAnimationFrameOrTimeout();
  await waitForAnimationFrameOrTimeout();
  renderer.dispose();
}

export async function captureTransparencyForgeaxBrowser(
  sceneCase: SceneCase,
  rendererKind: 'webgpu' | 'webgl' = 'webgpu',
  fallbackBackendId?: 'webkit-webgl2' | 'chromium-webgl2',
  bundler: BundlerOptions = {},
): Promise<ForgeaxCaptureOutput> {
  const canvas = document.createElement('canvas');
  canvas.width = sceneCase.scene.width;
  canvas.height = sceneCase.scene.height;
  const created = await constructRuntimeRendererHost(canvas, {}, bundler);
  if (!created.ok) throw created.error;
  const { renderer, debugDrawHost } = created.value;
  const legacyHost = debugDrawHost as unknown as RendererLegacyHostAdapter;
  // Three's WebGPU renderer does not apply an equivalent final dither in this
  // strict fixture. Disable the engine's pipeline-asset output policy so the
  // parity comparison isolates lighting/blending/colour-space behavior. The
  // production default remains outputDither=true when no override is installed.
  legacyHost.configureStandard({ outputDither: false });
  try {
    const renderErrors: string[] = [];
    const removeRenderErrorListener = renderer.subscribe((event) => {
      if (event.kind !== 'error') return;
      const error = event.error;
      renderErrors.push(`${error.code}: ${error.hint}`);
    });
    const world = makeTransparencyWorld(sceneCase);
    const worldAttachment1 = renderer.attach(world);
    if (!worldAttachment1.ok) throw worldAttachment1.error;
    const lease = worldAttachment1.value;
    const drawFrame = (): ReturnType<typeof renderer.draw> => renderer.draw({
      leases: [lease],
      camera: { lease },
      environment: { lease },
    });
    world.update().unwrap();
    const drawn = drawFrame();
    if (!drawn.ok) throw new Error(`transparent ForgeaX draw failed: ${drawn.error.code}`);
    const observed = await renderer.observe(drawn.value, { include: ['draws'] });
    if (!observed.ok) throw new Error(`transparent ForgeaX observation failed: ${observed.error.code}`);
    if (rendererKind === 'webgl') await waitForAnimationFrameOrTimeout();
    else await renderer.observe(drawn.value, { include: ['timings'] });
    world.update().unwrap();
    const warmed = drawFrame();
    if (!warmed.ok) throw new Error(`transparent ForgeaX warmed draw failed: ${warmed.error.code}`);
    const warmedObservation = await renderer.observe(warmed.value, { include: ['draws'] });
    if (!warmedObservation.ok) throw new Error(`transparent ForgeaX warmed observation failed: ${warmedObservation.error.code}`);
    if (rendererKind === 'webgl') await waitForAnimationFrameOrTimeout();
    else await renderer.observe(warmed.value, { include: ['timings'] });
    removeRenderErrorListener();
    if (renderErrors.length > 0) throw new Error(`transparent ForgeaX render errors: ${renderErrors.join(' | ')}`);
    const pixels = await readCanvasPixels(canvas);
    const surfaceEvidence = rendererKind === 'webgl' && fallbackBackendId !== undefined
      ? await projectForgeaxSurfaceEvidence({
          inspection: renderer.inspect(),
          backendId: fallbackBackendId,
          caseId: sceneCase.caseId,
          pixels,
          width: sceneCase.scene.width,
          height: sceneCase.scene.height,
        })
      : undefined;
    return {
      linear: [],
      final: Array.from(pixels),
      config: configFor(sceneCase),
      ...(surfaceEvidence === undefined ? {} : { surfaceEvidence }),
    };
  } finally {
    if (rendererKind === 'webgpu') renderer.dispose();
    else await settleWebglRenderer(renderer);
  }
}

export async function captureTransparencyThreeBrowser(
  sceneCase: SceneCase,
  rendererKind: 'webgpu' | 'webgl' = 'webgpu',
): Promise<ThreeCaptureOutput> {
  const canvas = document.createElement('canvas');
  canvas.width = sceneCase.scene.width;
  canvas.height = sceneCase.scene.height;
  const renderer = rendererKind === 'webgpu'
    ? new WebGPURenderer({ canvas, antialias: false, forceWebGL: false })
    : new WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
  if (rendererKind === 'webgpu') {
    await renderer.init();
    if (renderer.backend?.isWebGPUBackend !== true) throw new Error('Three WebGPU primary unavailable');
  } else {
    renderer.setSize(sceneCase.scene.width, sceneCase.scene.height, false);
  }
  renderer.toneMapping = sceneCase.colorDomain === 'linearHdr'
    ? threeToneMappingId('reinhard')
    : threeToneMappingId('linear');
  renderer.toneMappingExposure = 1;
  renderer.setClearColor(
    new Color().setRGB(
      sceneCase.scene.background[0],
      sceneCase.scene.background[1],
      sceneCase.scene.background[2],
      LinearSRGBColorSpace,
    ),
    sceneCase.scene.background[3],
  );
  const scene = new Scene();
  const camera = new PerspectiveCamera(45, sceneCase.scene.width / sceneCase.scene.height, 0.1, 10);
  camera.position.z = 3;
  const material = new MeshStandardMaterial({
    color: new Color().setRGB(0.8, 0.28, 0.12, LinearSRGBColorSpace),
    opacity: 0.5,
    transparent: true,
    depthWrite: false,
    toneMapped: sceneCase.colorDomain === 'linearHdr',
    side: DoubleSide,
    roughness: 1,
    metalness: 0,
  });
  scene.add(new Mesh(new PlaneGeometry(2.8, 2.8), material));
  const light = new ThreeDirectionalLight(0xffffff, 1);
  light.position.set(0, 0, 3);
  light.target.position.set(0, 0, 0);
  scene.add(light, light.target);
  // WebGPU was explicitly initialized above. Avoid Three r184's deprecated
  // renderAsync() wrapper, which repeats the init path for every capture.
  renderer.render(scene, camera);
  if (rendererKind === 'webgl') await waitForAnimationFrameOrTimeout();
  const pixels = await readCanvasPixels(canvas);
  renderer.dispose();
  return { linear: [], final: Array.from(pixels), config: configFor(sceneCase) };
}
