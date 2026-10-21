// @forgeax/engine-rhi-null/src/adapter - headless adapter.
//
// Descriptor support is structural only. Device requests enable the selected
// advertised features; unavailable features fail before minting a device.

import type {
  RequestDeviceOptions,
  Result,
  RhiAdapter,
  RhiDevice,
  RhiError as RhiErrorType,
} from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { err, ok } from '@forgeax/engine-types';
import { RhiNullCommandEncoder } from './command-encoder';
import { NULL_LIMITS, RhiNullDevice, type RhiNullDeviceOptions } from './device';
import { RhiNullQueue } from './queue';

/** Headless descriptor support, without hardware execution. */
export class RhiNullAdapter implements RhiAdapter {
  readonly features: ReadonlySet<GPUFeatureName> = new Set(['depth32float-stencil8']);
  readonly limits = NULL_LIMITS;

  /** `options` flows into every device; `{ rayQuery: limits }` simulates a Ray Query device. */
  constructor(private readonly deviceOptions: RhiNullDeviceOptions = {}) {}

  // forgeax-async-whitelist is not needed: this returns Promise<Result<...>>
  // per the spec contract; never rejects.
  requestDevice(opts?: RequestDeviceOptions | undefined): Promise<Result<RhiDevice, RhiErrorType>> {
    const features = new Set(opts?.requiredFeatures ?? []);
    for (const feature of features) {
      if (!this.features.has(feature))
        return Promise.resolve(
          err(
            new RhiError({
              code: 'feature-not-enabled',
              expected: `an advertised RhiNull structural feature; received ${feature}`,
              hint: 'use adapter.features to select supported descriptors; GPU validation requires a real backend',
            }),
          ),
        );
    }
    const queue = new RhiNullQueue();
    const device = new RhiNullDevice(
      queue,
      (bookkeeper, dev) => new RhiNullCommandEncoder(bookkeeper, dev),
      features,
      this.deviceOptions,
    );
    return Promise.resolve(ok(device));
  }
}
