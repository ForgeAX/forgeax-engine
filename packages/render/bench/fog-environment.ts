import { Time, World } from '@forgeax/engine-ecs';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import { Atmosphere } from '../src/components/atmosphere';
import { Camera } from '../src/components/camera';
import { CloudLayer } from '../src/components/cloud-layer';
import { DirectionalLight } from '../src/components/directional-light';
import { Fog } from '../src/components/fog';
import { extractWorldEnvironment } from '../src/extract/world-environment';
import {
  createWorldInternalView,
  prepareExtractContext,
  selectFogFrame,
} from '../src/render-system-extract';

export const modes = [
  'fog-empty',
  'fog-value',
  'environment-empty',
  'environment-fog',
  'environment-cloud-time',
  'environment-moving-pose',
];

/** Real Fog producer, or Fog followed by the complete World environment producer. */
export function createCase(mode: string) {
  if (!modes.includes(mode)) throw new Error(`Unknown Fog environment case: ${mode}`);
  const world = new World();
  const environment = mode.startsWith('environment-');
  if (mode !== 'fog-empty' && mode !== 'environment-empty')
    world.spawn({ component: Fog, data: { density: 0.03, color: [0.2, 0.3, 0.4] } }).unwrap();
  // Every full case includes an ordinary camera, atmosphere and shadowed sun.
  // Those real producer costs stay in the measured call, rather than being
  // replaced by prebuilt environment candidates.
  const cameraEntity = environment
    ? world.spawn({ component: Camera, data: {} }, { component: Transform, data: {} }).unwrap()
    : undefined;
  if (environment) {
    world.spawn({ component: Atmosphere, data: {} }).unwrap();
    world
      .spawn({ component: DirectionalLight, data: { direction: [0.2, -1, 0.1], castShadow: true } })
      .unwrap();
  }
  if (mode === 'environment-cloud-time')
    world.spawn({ component: CloudLayer, data: { coverage: 0.3 } }).unwrap();
  const context = prepareExtractContext(world);
  const internal = createWorldInternalView(world);
  const matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const ring: unknown[] = new Array(32);
  let checksum = 0;
  let calls = 0;
  return {
    run: function projectionTarget(index: number): number {
      if (mode === 'environment-cloud-time') world.update(1 / 60).unwrap();
      if (mode === 'environment-moving-pose' && cameraEntity !== undefined) {
        matrix[12] = index & 1;
        world.set(cameraEntity, GlobalTransform, { world: matrix }).unwrap();
      }
      const fog = selectFogFrame(world);
      checksum = fog === undefined ? 0 : Math.round(fog.density * 100000);
      if (environment) {
        const value = extractWorldEnvironment(world, context, internal, fog);
        ring[index & 31] = value;
        checksum += value.cameras.length + value.environment.signature.length;
        const camera = value.cameras[0];
        if (camera === undefined) throw new Error('Environment producer lost its display camera');
        checksum += Math.round(camera.position[0] as number);
        checksum += Number(value.cloudLayer !== undefined);
      } else ring[index & 31] = fog;
      calls++;
      return checksum;
    },
    inspect() {
      return {
        checksum,
        calls,
        hasEnvironment: environment,
        elapsed: world.getResource(Time).elapsed,
      };
    },
  };
}
