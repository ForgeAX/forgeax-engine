import type { RhiInstance } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import type { RhiBackendInstrumentation, RhiBackendPack } from '../assembly/backend-contract';

declare const instrumentation: RhiBackendInstrumentation;

const pack: RhiBackendPack = {
  rhi: rhi as RhiBackendPack['rhi'],
  instrumentation,
};

const preserved = pack.instrumentation;
const instance: RhiInstance = pack.rhi;
void preserved;
void instance;

// The instrumentation seam is the only capture hook exposed by the pack.
// @ts-expect-error pseudo-private raw-device escape hatches are not part of the pack.
pack._realDevice;
// @ts-expect-error capture capabilities are attached by App, not backend selection.
pack.rhiCapture;
