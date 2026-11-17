import { defineResource, type World } from '@forgeax/engine-ecs';
import { err, ok } from '@forgeax/engine-types';
import {
  DynamicInputError,
  type DynamicInputPageSnapshot,
  type DynamicInputRangeSnapshot,
  type DynamicInputResult,
  ReadonlyDynamicInputPage,
  type SurfaceDynamicInputFrame,
} from './dynamic-input';

/** The source and Render Worlds use the same native input vocabulary. */
export const RenderSurfaceDynamicInput = defineResource<SurfaceDynamicInputFrame>(
  'RenderSurfaceDynamicInput',
);

/** Publish a native page for the source's next frame; undefined withdraws it. */
export function publishSurfaceDynamicInput(
  world: World,
  frame: SurfaceDynamicInputFrame | undefined,
): void {
  if (frame === undefined) world.removeResource(RenderSurfaceDynamicInput);
  else world.insertResource<SurfaceDynamicInputFrame>(RenderSurfaceDynamicInput, frame);
}
export function surfaceDynamicInputOf(world: World): SurfaceDynamicInputFrame | undefined {
  return world.hasResource(RenderSurfaceDynamicInput)
    ? world.getResource<SurfaceDynamicInputFrame>(RenderSurfaceDynamicInput)
    : undefined;
}

/** Cloneable frame facts; native pages and GPU proofs remain with their own realm. */
export interface PublishedSurfaceDynamicInput {
  readonly page: DynamicInputPageSnapshot;
  readonly ranges?: readonly DynamicInputRangeSnapshot[];
  readonly projectionRevision: number;
  readonly frameTime: number;
}

function invalidFrame(field: string): DynamicInputError {
  return new DynamicInputError('invalid-record', {
    operation: 'capture',
    field,
    expected: 'a finite frame time, non-negative projection revision and owned bounded ranges',
  });
}

export function captureSurfaceDynamicInput(
  frame: SurfaceDynamicInputFrame,
  sourceWorldIdentity?: string,
): DynamicInputResult<PublishedSurfaceDynamicInput> {
  if (
    !Number.isFinite(frame.frameTime) ||
    !Number.isSafeInteger(frame.projectionRevision) ||
    frame.projectionRevision < 0
  )
    return err(invalidFrame('frame'));
  const page = frame.page.capture();
  if (!page.ok) return page;
  const ranges: DynamicInputRangeSnapshot[] = [];
  for (const range of frame.ranges ?? []) {
    const captured = frame.page.captureRange(range);
    if (!captured.ok) return captured;
    if (
      sourceWorldIdentity !== undefined &&
      captured.value.member.worldIdentity !== sourceWorldIdentity
    )
      return err(invalidFrame('member.worldIdentity'));
    ranges.push(captured.value);
  }
  return ok({
    page: page.value,
    ...(frame.ranges === undefined ? {} : { ranges }),
    projectionRevision: frame.projectionRevision,
    frameTime: frame.frameTime,
  });
}

/** Validate every row before scene adoption; the temporary CPU page owns no GPU allocation. */
export function validatePublishedSurfaceDynamicInput(
  input: PublishedSurfaceDynamicInput,
): DynamicInputResult<true> {
  if (
    !input ||
    typeof input !== 'object' ||
    !input.page ||
    typeof input.page.sourceId !== 'string' ||
    !Number.isFinite(input.frameTime) ||
    !Number.isSafeInteger(input.projectionRevision) ||
    input.projectionRevision < 0 ||
    (input.ranges !== undefined && !Array.isArray(input.ranges))
  )
    return err(invalidFrame('frame'));
  const page = ReadonlyDynamicInputPage.fromSnapshot(input.page);
  if (!page.ok) return page;
  try {
    for (const range of input.ranges ?? []) {
      if (
        !range ||
        typeof range.domain !== 'string' ||
        !range.member ||
        typeof range.member.worldIdentity !== 'string'
      )
        return err(invalidFrame('range'));
      const reserved = page.value.reserveRange(range);
      if (!reserved.ok) return reserved;
    }
    return ok(true);
  } finally {
    page.value.release();
  }
}
