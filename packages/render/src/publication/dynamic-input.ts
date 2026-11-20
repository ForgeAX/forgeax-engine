import { err, ok } from '@forgeax/engine-types';
import {
  DynamicInputError,
  type DynamicInputResult,
  ReadonlyDynamicInputPage,
  type SurfaceDynamicInputFrame,
} from '../surface/dynamic-input';
import {
  type PublishedSurfaceDynamicInput,
  validatePublishedSurfaceDynamicInput,
} from '../surface/frame-source';

function rejected(
  code: 'invalid-record' | 'stale-generation' | 'released',
  expected: string,
): DynamicInputError {
  return new DynamicInputError(code, { operation: 'restore', expected });
}
function addresses(input: PublishedSurfaceDynamicInput): string {
  return JSON.stringify(
    input.ranges
      ?.map((range) => [
        range.domain,
        range.recordStart,
        range.recordCount,
        range.instanceIndex,
        range.member.worldIdentity,
        range.member.entityKey,
        range.member.drawItemIndex,
        range.member.instanceOrdinal,
      ])
      .map((row) => JSON.stringify(row))
      .sort(),
  );
}

function receiverRangeAddresses(
  ranges: PublishedSurfaceDynamicInput['ranges'],
  sceneIdentity: string | undefined,
): PublishedSurfaceDynamicInput['ranges'] {
  return sceneIdentity === undefined
    ? ranges
    : ranges?.map((range) => ({
        ...range,
        member: { ...range.member, worldIdentity: sceneIdentity },
      }));
}

/** One receiver owns the current source page and its renderer-local physical addresses. */
export class SurfaceDynamicInputReceiver {
  private current:
    | { frame: SurfaceDynamicInputFrame; addresses: string; sceneIdentity: string | undefined }
    | undefined;
  private disposed = false;
  get active(): boolean {
    return this.current !== undefined;
  }

  restore(
    input: PublishedSurfaceDynamicInput | undefined,
    generation: number,
    sceneIdentity?: string,
  ): DynamicInputResult<SurfaceDynamicInputFrame | undefined> {
    if (this.disposed) return err(rejected('released', 'a live Surface publication receiver'));
    if (input === undefined) {
      this.clear();
      return ok(undefined);
    }
    const valid = validatePublishedSurfaceDynamicInput(input);
    if (!valid.ok) return valid;
    const candidate = ReadonlyDynamicInputPage.fromSnapshot(input.page);
    if (!candidate.ok) return candidate;
    let adopted = false;
    try {
      const configured = candidate.value.reconfigureDevice(generation);
      if (!configured.ok) return configured;
      const previous = this.current;
      const samePage =
        previous !== undefined &&
        previous.sceneIdentity === sceneIdentity &&
        previous.frame.page.sourceId === input.page.sourceId &&
        previous.frame.page.pageId === input.page.pageId;
      const validatePreviousRevision = () => {
        if (samePage && input.page.contentRevision < previous.frame.page.contentRevision)
          return err(rejected('stale-generation', 'a current source page content revision'));
        if (samePage && input.page.contentRevision === previous.frame.page.contentRevision) {
          const unchanged = previous.frame.page.applySnapshot(input.page);
          if (!unchanged.ok) return unchanged;
        }

        return undefined;
      };
      const revisionFailure = validatePreviousRevision();
      if (revisionFailure !== undefined) return revisionFailure;
      const nextAddresses = addresses(input);
      const retain = samePage && previous.frame.projectionRevision === input.projectionRevision;
      if (retain && previous.addresses !== nextAddresses)
        return err(
          rejected(
            'invalid-record',
            'advance projectionRevision when range membership or addresses change',
          ),
        );
      let page = candidate.value;
      // Published rows use the receiver's scene identity at draw time.
      const snapshots = receiverRangeAddresses(input.ranges, sceneIdentity);
      let ranges: SurfaceDynamicInputFrame['ranges'] = snapshots?.map((range) =>
        page.reserveRange(range).unwrap(),
      );
      if (retain) {
        page = previous.frame.page;
        const applied = page.applySnapshot(input.page);
        if (!applied.ok) return applied;
        const changedDevice = page.deviceGeneration !== generation;
        if (changedDevice) page.reconfigureDevice(generation).unwrap();
        ranges = changedDevice
          ? snapshots?.map((range) => page.reserveRange(range).unwrap())
          : previous.frame.ranges;
      } else adopted = true;
      const frame: SurfaceDynamicInputFrame = {
        page,
        ...(ranges === undefined ? {} : { ranges }),
        projectionRevision: input.projectionRevision,
        frameTime: input.frameTime,
      };
      if (!retain) previous?.frame.page.release().unwrap();
      this.current = { frame, addresses: nextAddresses, sceneIdentity };
      return ok(frame);
    } finally {
      if (!adopted) candidate.value.release().unwrap();
    }
  }
  private clear(): void {
    this.current?.frame.page.release().unwrap();
    this.current = undefined;
  }
  dispose(): void {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
  }
}
