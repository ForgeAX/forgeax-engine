/// <reference types="@webgpu/types" />

import { err, ok, type Result, RhiError } from '@forgeax/engine-rhi';

export function resolveTimestampQueries(args: {
  rawEncoder: GPUCommandEncoder;
  rawQuerySet: GPUQuerySet;
  firstQuery: number;
  queryCount: number;
  rawDestination: GPUBuffer;
  destinationOffset: number;
}): Result<void, RhiError> {
  try {
    args.rawEncoder.resolveQuerySet(
      args.rawQuerySet,
      args.firstQuery,
      args.queryCount,
      args.rawDestination,
      args.destinationOffset,
    );
    return ok(undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(
      new RhiError({
        code: 'webgpu-runtime-error',
        expected: 'underlying GPUCommandEncoder.resolveQuerySet to succeed',
        hint: `resolveQuerySet raised: ${message}`,
      }),
    );
  }
}
