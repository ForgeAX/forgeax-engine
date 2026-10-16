import type { RecorderAttachment } from '@forgeax/engine-rhi-debug';
import { createRhiCapture, type RhiCapture } from '../internal/rhi-capture';
import type { App } from '../types';

declare const attachment: RecorderAttachment;

const capture: RhiCapture = createRhiCapture(attachment);
const appCapture: NonNullable<App['rhiCapture']> = capture;
const result = await appCapture.captureFrame();

if (result.ok) {
  const kind: 'rhi-tape' = result.value.kind;
  const digest: string = result.value.digest;
  void kind;
  void digest;
}

// The App capability does not expose replay, cache, or the recorder internals.
// @ts-expect-error live replay is an offline operation.
capture.inspectWork;
// @ts-expect-error recorder device state is not an App capability.
capture.backend;
