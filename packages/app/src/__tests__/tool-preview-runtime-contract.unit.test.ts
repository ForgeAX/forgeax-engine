import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const bootstrapSource = readFileSync(
  new URL('../tool-preview/bootstrap.ts', import.meta.url),
  'utf8',
);
const runtimeSource = readFileSync(
  new URL('../internal/browser-rhi-debug-runtime.ts', import.meta.url),
  'utf8',
);

describe('tool preview runtime contract', () => {
  it('captures one rendered frame after warmup and the live-resource snapshot', () => {
    const finalFrame = bootstrapSource.indexOf('if (frame === recipe.frames - 1)');
    const armed = bootstrapSource.indexOf(
      'encodedCapture = runtime.attachment.captureFrame()',
      finalFrame,
    );
    const snapshot = bootstrapSource.indexOf('runtime.attachment.frameBoundary()', armed);
    const rendered = bootstrapSource.indexOf(
      'stepToolPreviewFrame(app, recipe.deltaSeconds)',
      snapshot,
    );
    const finalized = bootstrapSource.indexOf(
      'const finalized = await runtime.attachment.frameBoundary()',
      rendered,
    );

    expect(finalFrame).toBeGreaterThan(-1);
    expect(armed).toBeGreaterThan(finalFrame);
    expect(snapshot).toBeGreaterThan(armed);
    expect(rendered).toBeGreaterThan(snapshot);
    expect(finalized).toBeGreaterThan(rendered);
  });

  it('requests replay features and limits from the recorded tape', () => {
    expect(bootstrapSource).toContain('runtime.createReplayDevice(parsed.value)');
    expect(runtimeSource).toContain('createReplayDevice: async (tape)');
    expect(runtimeSource).toContain(
      'replayDeviceRequest(tape, adapter.value.features, adapter.value.limits)',
    );
  });

  it('publishes owner identity only after the recorded tape proves a subject draw', () => {
    expect(bootstrapSource).toContain('toolPreviewSubjectDrawn(resource.kind, drawCalls)');
    expect(bootstrapSource).toContain('material: 2');
    expect(bootstrapSource).toContain('mesh: 0');
    expect(bootstrapSource).toContain('observation: capture.resource.ownerFacts');
  });
});
