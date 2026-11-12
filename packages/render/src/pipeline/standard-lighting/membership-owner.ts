import { type ClusterBinScratch, createClusterBinScratch } from '../../cluster-binner';
import type { StandardClusterLayout } from './layout';
import type { StandardLightFrame, StandardLocalLightInput } from './light-frame';
import { deriveStandardMembership } from './membership';

const NO_LIGHT_VALUES = new Float64Array(0);

/**
 * One stock view's immutable Cluster membership and its admitted numeric inputs.
 * Color/shadow payloads stay current; only the binning product survives a frame.
 * Borrowed/custom pipeline inputs retain ordinary independent preparation.
 */
export class StandardClusterMembershipOwner {
  private readonly matrices = new Float32Array(32);
  private lights = NO_LIGHT_VALUES;
  private defaultScratch: ClusterBinScratch | undefined;
  private clusterCount = 0;
  private gridLength = 0;
  private capacity = 0;
  private x = 0;
  private y = 0;
  private z = 0;
  private near = 0;
  private far = 0;
  private count = -1;
  private result: ReturnType<typeof deriveStandardMembership> | undefined;

  derive(frame: StandardLightFrame, layout: StandardClusterLayout, scratch?: ClusterBinScratch) {
    if (scratch === undefined) {
      this.defaultScratch ??= createClusterBinScratch();
      scratch = this.defaultScratch;
    }
    if (this.matches(frame, layout, scratch))
      return this.result as ReturnType<typeof deriveStandardMembership>;
    const result = deriveStandardMembership(frame, layout, scratch);
    if (!result.ok) return result;
    if (this.lights.length < frame.local.length * 4)
      this.lights = new Float64Array(Math.max(4, frame.local.length * 4));
    this.matrices.set(frame.view, 0);
    this.matrices.set(frame.projection, 16);
    for (let index = 0; index < frame.local.length; index++) {
      const light = frame.local[index] as StandardLocalLightInput;
      const at = index * 4;
      this.lights[at] = light.position[0] as number;
      this.lights[at + 1] = light.position[1] as number;
      this.lights[at + 2] = light.position[2] as number;
      this.lights[at + 3] = light.range;
    }
    this.x = layout.grid.x;
    this.y = layout.grid.y;
    this.z = layout.grid.z;
    this.clusterCount = layout.clusterCount;
    this.gridLength = layout.clusterGridU32Length;
    this.capacity = layout.lightIndexListCapacity;
    this.near = frame.near;
    this.far = frame.far;
    this.count = frame.local.length;
    this.result = result;
    return result;
  }

  private matches(
    frame: StandardLightFrame,
    layout: StandardClusterLayout,
    scratch: ClusterBinScratch,
  ): boolean {
    if (
      !this.result?.ok ||
      this.result.value.scratch !== scratch ||
      this.count !== frame.local.length ||
      this.x !== layout.grid.x ||
      this.y !== layout.grid.y ||
      this.z !== layout.grid.z ||
      this.clusterCount !== layout.clusterCount ||
      this.gridLength !== layout.clusterGridU32Length ||
      this.capacity !== layout.lightIndexListCapacity ||
      !Object.is(this.near, frame.near) ||
      !Object.is(this.far, frame.far)
    )
      return false;
    return this.sameCamera(frame) && this.sameLights(frame);
  }

  private sameCamera(frame: StandardLightFrame): boolean {
    for (let index = 15; index >= 0; index--) {
      if (
        !Object.is(this.matrices[index], frame.view[index]) ||
        !Object.is(this.matrices[index + 16], frame.projection[index])
      )
        return false;
    }
    return true;
  }

  private sameLights(frame: StandardLightFrame): boolean {
    for (let index = 0; index < frame.local.length; index++) {
      const light = frame.local[index] as StandardLocalLightInput;
      const at = index * 4;
      if (
        !Object.is(this.lights[at], light.position[0]) ||
        !Object.is(this.lights[at + 1], light.position[1]) ||
        !Object.is(this.lights[at + 2], light.position[2]) ||
        !Object.is(this.lights[at + 3], light.range)
      )
        return false;
    }
    return true;
  }

  clear(): void {
    this.result = undefined;
    this.defaultScratch = undefined;
    this.lights = NO_LIGHT_VALUES;
    this.count = -1;
  }
}
