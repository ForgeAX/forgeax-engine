import { Transform } from '@forgeax/engine/scene';
import { lookRotation } from '../../lab/stage';
import { check, vfxProbe } from './support/probe';
import { LAB_EYE, LAB_TARGET } from './support/vfx-stage';

export default vfxProbe(
  {
    title: 'VFX fixed-bounds culling',
    catalog: 'VFX fixed-bounds culling',
    summary:
      'Each emitter declares fixed sphere/AABB bounds in source; the renderer frustum-tests those bounds (never live particles) and applies simulationWhenCulled.',
    expect:
      'Facing the effect every emitter is cameraVisible; turning the camera 180 degrees makes all of them culled and removes their draws; turning back restores visibility.',
  },
  async (vfx, { frames }) => {
    const emitters = () => vfx.host.inspect(vfx.world)?.players[0]?.emitters ?? [];
    const visibleBefore = emitters().map((emitter) => emitter.cameraVisible);
    const behind: [number, number, number] = [LAB_EYE[0], LAB_EYE[1], LAB_EYE[2] + 10];
    const transform = vfx.world.get(vfx.camera, Transform);
    if (!transform.ok) return [check('camera transform readable', false)];
    vfx.world
      .set(vfx.camera, Transform, { ...transform.value, quat: lookRotation(LAB_EYE, behind) })
      .unwrap();
    await frames(8);
    const culled = emitters().map((emitter) => emitter.cameraVisible);
    const culledDraws = vfx.host.feature.inspect().subjectOutputs;
    vfx.world
      .set(vfx.camera, Transform, { ...transform.value, quat: lookRotation(LAB_EYE, LAB_TARGET) })
      .unwrap();
    await frames(8);
    const restored = emitters().map((emitter) => emitter.cameraVisible);
    return [
      check(
        'all emitters visible facing the effect',
        visibleBefore.length === 5 && visibleBefore.every(Boolean),
        visibleBefore,
      ),
      check(
        'all emitters culled facing away',
        culled.length === 5 && culled.every((visible) => !visible),
        culled,
      ),
      check('no VFX draws while culled', culledDraws === 0, { culledDraws }),
      check('visibility restored facing back', restored.every(Boolean), restored),
      check(
        'bounds are the authored fixed spheres',
        emitters().every((emitter) => emitter.bounds.kind === 'sphere'),
      ),
    ];
  },
);
