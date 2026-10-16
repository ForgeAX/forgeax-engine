import { expectTypeOf } from 'vitest';
import type { BrowserCarrierRequest } from '../tools/display-carrier.js';

expectTypeOf<BrowserCarrierRequest>().toEqualTypeOf<{
  readonly run: { readonly serviceId: string; readonly runId: string };
  readonly generation: number;
  readonly headless: boolean;
  readonly gpu: 'auto' | 'hardware' | 'software';
  readonly width: number;
  readonly height: number;
  readonly url: string;
}>();
expectTypeOf<BrowserCarrierRequest>().not.toHaveProperty('leaseId');
expectTypeOf<BrowserCarrierRequest>().not.toHaveProperty('surfaceId');

import type { SoftwareBrowserOpenOptions } from '../software-capture.js';
import type { BrowserHostOptions } from '../tools/browser-host.js';
import type { BrowserCarrierAdapter } from '../tools/display-carrier.js';

type HostInput = {
  readonly backend?: 'auto' | 'hardware' | 'software';
  readonly headless?: boolean;
  readonly carrier?: BrowserCarrierAdapter;
  readonly carrierRun?: { readonly serviceId: string; readonly runId: string };
  readonly carrierGeneration?: number;
};
expectTypeOf<BrowserHostOptions>().toEqualTypeOf<{
  readonly publish?: boolean;
  readonly backend?: 'auto' | 'hardware' | 'software';
  readonly headless?: boolean;
  readonly carrier?: BrowserCarrierAdapter;
  readonly carrierRun?: { readonly serviceId: string; readonly runId: string };
  readonly carrierGeneration?: number;
}>();
expectTypeOf<Pick<SoftwareBrowserOpenOptions, keyof HostInput>>().toEqualTypeOf<HostInput>();
expectTypeOf<SoftwareBrowserOpenOptions['width']>().toEqualTypeOf<number | undefined>();
expectTypeOf<SoftwareBrowserOpenOptions['software']>().toEqualTypeOf<boolean | undefined>();
expectTypeOf<BrowserHostOptions>().not.toHaveProperty('width');
expectTypeOf<BrowserHostOptions>().not.toHaveProperty('timeoutMs');
