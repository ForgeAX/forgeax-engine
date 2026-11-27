import type { Result, RhiError } from '@forgeax/engine-rhi';
import type { SubmissionPlan } from '../../gpu-driven/batch-topology';
import type { ShadowViewStatePool, ShadowViewUpdateInput } from '../../gpu-driven/shadow-views';
import type { GpuDrivenView } from '../../gpu-driven/view-gpu';
import type { GpuScene, GpuSceneResourceFrame } from '../../gpu-scene';
import type { GpuInputReadFrame } from '../../gpu-scene-inputs';

// Low-level selector fixtures own no Renderer submission transaction. Retain
// their exact numeric inputs and native table roots until the fixture observes
// completion of its submitted work or disposes. Shadow graph
// projection can declare a forced compute demand after update, so its low-level
// scope remains open through projection. ResourceFrame integration tests own
// and exercise the explicit pre-submit seal. Production uses
// GpuSceneResourceFrame and its submitted-completion lease instead.
const held = new WeakMap<GpuScene, Set<GpuSceneResourceFrame>>();
export function releaseGpuFixtureReads(scene: GpuScene): void {
  const frames = held.get(scene);
  if (frames === undefined) return;
  for (const frame of frames) frame.release();
  frames.clear();
}

function retain(scene: GpuScene, reads: GpuSceneResourceFrame): void {
  let frames = held.get(scene);
  if (frames === undefined) {
    frames = new Set();
    held.set(scene, frames);
    const dispose = scene.dispose.bind(scene);
    scene.dispose = () => {
      releaseGpuFixtureReads(scene);
      dispose();
    };
  }
  frames.add(reads);
}
function withReads<T>(
  scene: GpuScene,
  plan: SubmissionPlan,
  action: (reads: GpuInputReadFrame) => Result<T, RhiError>,
  seal = true,
): Result<T, RhiError> {
  if (plan.sourceGroups !== undefined) scene.inputs.adoptSources(plan.sourceGroups);
  const frame = scene.captureResources().unwrap();
  const reads = frame.inputReads();
  try {
    const result = action(reads);
    if (!result.ok) {
      frame.release();
      return result;
    }
    if (seal) {
      const sealed = frame.seal();
      if (!sealed.ok) {
        frame.release();
        return sealed;
      }
    }
    retain(scene, frame);
    return result;
  } catch (cause) {
    frame.release();
    throw cause;
  }
}
type ViewArguments =
  Parameters<GpuDrivenView['update']> extends [unknown, unknown, unknown, ...infer Rest]
    ? Rest
    : never;
export function updateGpuView(
  view: GpuDrivenView,
  plan: SubmissionPlan,
  scene: GpuScene,
  ...args: ViewArguments
): Result<void, RhiError> {
  return withReads(scene, plan, (reads) => view.update(plan, scene, reads, ...args));
}
export function updateShadowView(
  pool: ShadowViewStatePool,
  input: Omit<ShadowViewUpdateInput, 'inputReads'>,
  projectionSource?: SubmissionPlan,
): ReturnType<ShadowViewStatePool['update']> {
  const sourcePlan = input.sourcePlan;
  return withReads(
    input.scene,
    sourcePlan,
    (inputReads) => pool.update({ ...input, sourcePlan, inputReads }, projectionSource),
    false,
  );
}
