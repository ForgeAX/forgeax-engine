import {
  ACESFilmicToneMapping,
  BoxGeometry,
  Color,
  DirectionalLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PointLight,
  Scene,
  SRGBColorSpace,
  SpotLight,
} from 'three';
import { WebGPURenderer } from 'three/webgpu';
import {
  PERF_WORKLOAD_SEED,
  DIRECTIONAL_LIGHT_CAST_SHADOW,
  DIRECTIONAL_LIGHT_COLOR,
  DIRECTIONAL_LIGHT_DIRECTION,
  DIRECTIONAL_LIGHT_INTENSITY,
  PUNCTUAL_DECAY_EXPONENT,
  type WorkloadOptions,
  cubePositions,
  mulberry32,
  parseWorkloadOptions,
  workloadFingerprint,
  yawQuaternion,
} from './workload';

const CUBE_SCALE = 0.32;
const FIXED_DELTA_SECONDS = 1 / 60;
const MAX_FRAMES = 600;

export interface ThreePerfEvidence {
  readonly implementation: 'three';
  readonly version: '0.184.0';
  readonly backend: 'webgpu';
  readonly workloadFingerprint: string;
  readonly seed: number;
  readonly requestedCounts: WorkloadOptions;
  readonly postSpawn: {
    readonly cubeCount: number;
    readonly pointLightCount: number;
    readonly spotLightCount: number;
    readonly directionalBaseline: {
      readonly count: number;
      readonly direction: readonly [number, number, number];
      readonly color: readonly [number, number, number];
      readonly intensity: number;
      readonly shadowCasterCount: number;
    };
    readonly positionChecksum: string;
  };
  frameProgress: number;
  processedCubeCount: number;
  cameraRotationRadians: number;
  frameIntervalsMs: number[];
  cubeUpdateSamplesMs: number[];
  renderSamplesMs: number[];
  frameErrors: string[];
  bootstrapMs: number;
  rendererInfo: unknown;
}

declare global {
  interface Window {
    __threePerf?: ThreePerfEvidence;
  }
}

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) throw new Error('[three-10k-cubes-lights] missing <canvas id="app">');

const params = new URLSearchParams(window.location.search);
const parsed = parseWorkloadOptions(params);
if (!parsed.ok) {
  console.error(`[three-10k-cubes-lights] ${parsed.error.code}: ${parsed.error.hint}`);
} else {
  void bootstrap(canvas, parsed.value);
}

async function bootstrap(target: HTMLCanvasElement, options: WorkloadOptions): Promise<void> {
  const bootstrapStart = performance.now();
  const scene = new Scene();
  const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 80);
  camera.position.set(0, 0, 0);

  const renderer = new WebGPURenderer({ canvas: target, antialias: false, forceWebGL: false });
  await renderer.init();
  renderer.setPixelRatio(1);
  renderer.setSize(target.width, target.height, false);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.setClearColor(new Color(0.005, 0.008, 0.02), 1);

  const geometry = new BoxGeometry(1, 1, 1);
  const material = new MeshStandardMaterial({
    // ForgeaX's built-in `color` material parameters are authored in sRGB and
    // extracted to linear RGB. Three's numeric Color constructor is already
    // linear, so name the authored color space here to compare the same
    // material instead of giving Three a substantially brighter albedo.
    color: new Color().setRGB(0.34, 0.48, 0.72, SRGBColorSpace),
    metalness: 0.05,
    roughness: 0.58,
  });
  const positions = cubePositions(options);
  const cubes: Mesh[] = [];
  for (let index = 0; index < options.cubeCount; index += 1) {
    const base = index * 3;
    const cube = new Mesh(geometry, material);
    cube.position.set(positions[base] ?? 0, positions[base + 1] ?? 0, positions[base + 2] ?? 0);
    cube.scale.setScalar(CUBE_SCALE);
    scene.add(cube);
    cubes.push(cube);
  }

  const directional = new DirectionalLight(
    new Color(...DIRECTIONAL_LIGHT_COLOR),
    DIRECTIONAL_LIGHT_INTENSITY,
  );
  directional.position.set(
    -DIRECTIONAL_LIGHT_DIRECTION[0],
    -DIRECTIONAL_LIGHT_DIRECTION[1],
    -DIRECTIONAL_LIGHT_DIRECTION[2],
  );
  directional.target.position.set(0, 0, 0);
  directional.castShadow = DIRECTIONAL_LIGHT_CAST_SHADOW;
  scene.add(directional, directional.target);

  const lightRandom = mulberry32(PERF_WORKLOAD_SEED ^ 0x9e3779b9);
  for (let index = 0; index < options.pointLightCount; index += 1) {
    const x = -18 + lightRandom() * 36;
    const y = -10 + lightRandom() * 20;
    const z = -18 + lightRandom() * 36;
    const light = new PointLight(
      new Color(0.55 + lightRandom() * 0.45, 0.55 + lightRandom() * 0.45, 0.55 + lightRandom() * 0.45),
      1.5 + lightRandom() * 1.5,
      12,
      PUNCTUAL_DECAY_EXPONENT,
    );
    light.position.set(x, y, z);
    scene.add(light);
  }
  for (let index = 0; index < options.spotLightCount; index += 1) {
    const x = -18 + lightRandom() * 36;
    const y = -10 + lightRandom() * 20;
    const z = -18 + lightRandom() * 36;
    const light = new SpotLight(
      new Color(0.65 + lightRandom() * 0.35, 0.65 + lightRandom() * 0.35, 0.65 + lightRandom() * 0.35),
      2 + lightRandom() * 2,
      16,
      (40 * Math.PI) / 180,
      0.5,
      PUNCTUAL_DECAY_EXPONENT,
    );
    light.position.set(x, y, z);
    light.target.position.set(0, 0, 0);
    // Three's SpotLight target is a scene object and must be attached for the
    // target transform to participate in the render traversal.
    scene.add(light, light.target);
  }

  const evidence: ThreePerfEvidence = {
    implementation: 'three',
    version: '0.184.0',
    backend: 'webgpu',
    workloadFingerprint: workloadFingerprint(options),
    seed: PERF_WORKLOAD_SEED,
    requestedCounts: options,
    postSpawn: {
      cubeCount: cubes.length,
      pointLightCount: options.pointLightCount,
      spotLightCount: options.spotLightCount,
      directionalBaseline: {
        count: 1,
        direction: [...DIRECTIONAL_LIGHT_DIRECTION],
        color: [...DIRECTIONAL_LIGHT_COLOR],
        intensity: DIRECTIONAL_LIGHT_INTENSITY,
        shadowCasterCount: directional.castShadow ? 1 : 0,
      },
      positionChecksum: checksumPositions(positions),
    },
    frameProgress: 0,
    processedCubeCount: 0,
    cameraRotationRadians: 0,
    frameIntervalsMs: [],
    cubeUpdateSamplesMs: [],
    renderSamplesMs: [],
    frameErrors: [],
    bootstrapMs: performance.now() - bootstrapStart,
    rendererInfo: null,
  };
  window.__threePerf = evidence;

  let elapsed = 0;
  let lastFrameAt: number | undefined;
  const animate = async (): Promise<void> => {
    try {
      const frameAt = performance.now();
      if (lastFrameAt !== undefined) evidence.frameIntervalsMs.push(frameAt - lastFrameAt);
      lastFrameAt = frameAt;
      elapsed += FIXED_DELTA_SECONDS;
      const updateStart = performance.now();
      const quaternion = yawQuaternion(elapsed * 0.18);
      camera.quaternion.set(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
      let processed = 0;
      for (const cube of cubes) {
        cube.rotation.y = elapsed * (0.35 + (processed % 17) * 0.013) + processed * 0.0007;
        processed += 1;
      }
      evidence.cubeUpdateSamplesMs.push(performance.now() - updateStart);
      evidence.processedCubeCount = processed;
      evidence.cameraRotationRadians = elapsed * 0.18;

      const renderStart = performance.now();
      renderer.render(scene, camera);
      evidence.renderSamplesMs.push(performance.now() - renderStart);
      evidence.frameProgress += 1;
      evidence.processedCubeCount = processed;
      evidence.rendererInfo = renderer.info;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      evidence.frameErrors.push(message);
      console.error(`[three-10k-cubes-lights] frame error: ${message}`);
    }
    if (evidence.frameProgress < MAX_FRAMES) requestAnimationFrame(() => void animate());
  };
  requestAnimationFrame(() => void animate());
}

function checksumPositions(positions: ArrayLike<number>): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < positions.length; index += 1) {
    const value = Math.round((positions[index] ?? 0) * 100_000);
    hash ^= value;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
