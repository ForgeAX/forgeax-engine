import { type RhiDevice, RhiError } from '@forgeax/engine-rhi';
import type { CapsuleShadowSnapshot } from '../capsule-shadow/world-capsules';
import type { RenderableSnapshot } from '../render-system-extract';
import type { SkinSceneFrame } from '../scene/skin-scene-inputs';
import { type SkinTaskBinding, SkinTasks } from './skin-tasks';

const CAPSULE_NOT_SKINNED = Object.freeze({ status: 'not-skinned' as const });
const POSE_UNAVAILABLE = Object.freeze({ status: 'pose-unavailable' as const });

/** Scene-owned fixed Skin root pair; this owner only pairs it with one recording. */
export interface SkinRootOwner {
  skinRecordingFrame(): SkinSceneFrame | undefined;
  trackSkinSubmittedWork(completed: Promise<void>): Promise<void> | undefined;
  submitSkinFrame(completed: Promise<void>, accepted: boolean): Promise<void> | undefined;
  discardSkinFrame(): void;
}

export interface RecordingSkinTaskHost {
  device(): RhiDevice;
  readonly roots: SkinRootOwner;
  reportError(error: RhiError): void;
}

/**
 * Renderer-scoped recording Skin lifecycle. One fixed Skin frame binds lazily at
 * the first actual CPU draw demand and stays fixed until the recording
 * completes. Physical task buffers belong to one device; task buffers and both
 * Scene roots retire after the accepted submission's GPU completion.
 */
export class RecordingSkinTasks {
  private tasks: SkinTasks | undefined;
  private device: RhiDevice | undefined;
  private frame: SkinSceneFrame | undefined;
  private submitted: Promise<void> | undefined;
  private rootCompletion: Promise<void> | undefined;

  constructor(private readonly host: RecordingSkinTaskHost) {}

  get paletteUploadBytes(): number {
    return this.tasks?.paletteUploadBytes ?? 0;
  }

  /** A recording without Skin demand reports zero upload bytes and owns no stale roots. */
  beginRecording(): void {
    if (this.tasks !== undefined) this.tasks.paletteUploadBytes = 0;
    this.submitted = undefined;
    this.rootCompletion = undefined;
    this.host.roots.discardSkinFrame();
  }

  demand(source: Pick<RenderableSnapshot, 'worldId' | 'entityKey'>): SkinTaskBinding | undefined {
    const tasks = this.actual();
    const slot = this.frame?.slots.lookup(source.worldId, source.entityKey);
    return slot === undefined ? undefined : tasks.demand(slot);
  }

  capsules(source: RenderableSnapshot): CapsuleShadowSnapshot | undefined {
    if (source.capsuleShadowRequested !== true) return;
    if (source.skinBinding === undefined) return CAPSULE_NOT_SKINNED;
    const tasks = this.actual();
    const slot = this.frame?.slots.lookup(source.worldId, source.entityKey);
    return slot === undefined ? POSE_UNAVAILABLE : tasks.capsules(slot);
  }

  /** Physical queue acceptance pins this recording's task buffers and both roots. */
  trackSubmittedWork(completed: Promise<void>): void {
    this.submitted = completed;
    if (this.frame !== undefined) this.tasks?.trackSubmittedWork(completed);
    this.rootCompletion = this.host.roots.trackSkinSubmittedWork(completed);
  }

  /**
   * Retires task buffers and advances (or discards) Scene roots independently.
   * Only an accepted Scene picture advances history. Returns every cause.
   */
  complete(sceneAccepted: boolean): unknown[] {
    const failures: unknown[] = [];
    const submitted = this.submitted,
      rootCompletion = this.rootCompletion;
    this.submitted = undefined;
    this.rootCompletion = undefined;
    try {
      this.observe(this.tasks?.complete());
    } catch (cause) {
      failures.push(cause);
    } finally {
      this.frame = undefined;
    }
    try {
      if (submitted === undefined) this.host.roots.discardSkinFrame();
      else
        this.observe(
          this.host.roots.submitSkinFrame(submitted, sceneAccepted) ?? rootCompletion,
          'submitted Skin input roots retire after GPU completion',
        );
    } catch (cause) {
      failures.push(cause);
    }
    return failures;
  }

  dispose(): void {
    this.observe(this.tasks?.dispose());
  }

  private actual(): SkinTasks {
    const frame = this.host.roots.skinRecordingFrame();
    if (frame === undefined)
      throw new RhiError({
        code: 'rhi-not-available',
        expected: 'a fixed Skin frame for the actual CPU draw',
        hint: 'prepare the accepted Scene before recording Skin consumers',
      });
    const device = this.host.device();
    let tasks = this.tasks;
    if (tasks === undefined || this.device !== device) {
      // The open recording's owner must still complete and retire its buffers.
      if (this.frame !== undefined)
        throw new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'one device throughout a CPU Skin recording',
          hint: 'finish the current recording before replacing the device',
        });
      this.observe(tasks?.dispose());
      tasks = new SkinTasks(device, device.caps.storageBuffer);
      this.tasks = tasks;
      this.device = device;
    }
    if (this.frame === undefined) {
      tasks.begin(frame);
      this.frame = frame;
    } else if (this.frame !== frame)
      throw new RhiError({
        code: 'rhi-descriptor-invalid',
        expected: 'one fixed Skin root pair throughout CPU recording',
        hint: 'finish the current recording before preparing another Scene frame',
      });
    return tasks;
  }

  private observe(
    completion: Promise<void> | undefined,
    expected = 'Skin task buffers retire after physical GPU completion',
  ): void {
    void completion?.catch((cause) =>
      this.host.reportError(
        new RhiError({
          code: 'internal-error',
          expected,
          hint: 'inspect the retained completion failure before reusing renderer inputs',
          detail: { error: cause },
        }),
      ),
    );
  }
}
