import type { PreparedGpuDrivenDraw } from '../gpu-driven/prepared-draw';
import type { SkinTaskBinding } from '../record/skin-tasks';
import type { SkinBindingInput } from '../scene/skin-scene-inputs';

declare const draw: PreparedGpuDrivenDraw;
declare const binding: SkinBindingInput;
declare const task: SkinTaskBinding;
// Source membership and physical task output have separate owners.
const joints: readonly number[] = binding.joints;
const offsets: readonly number[] = [task.dataOffset, task.auxiliaryOffset];
void draw.vertexInputs;
void joints;
void offsets;
