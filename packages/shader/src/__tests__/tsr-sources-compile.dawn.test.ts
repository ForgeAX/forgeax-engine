import { expect, it } from 'vitest';
import * as shader from '../index';

// Every TSR stage source is a complete module on both lanes. A helper that reads a binding its
// stage never declares (for example TsrParams in the opaque-guide stage) fails here, not in a frame.
it('compiles every TSR WGSL source as a standalone module', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('TSR source compilation requires a Dawn adapter');
  const device = await adapter.requestDevice();
  const sources = Object.entries(shader).filter(
    (entry): entry is [string, string] =>
      /^TSR_.*_WGSL$/.test(entry[0]) && typeof entry[1] === 'string',
  );
  expect(sources.length).toBeGreaterThan(20);
  const failures: string[] = [];
  for (const [name, code] of sources) {
    const info = await device.createShaderModule({ label: name, code }).getCompilationInfo();
    for (const message of info.messages)
      if (message.type === 'error') failures.push(`${name}:${message.lineNum}: ${message.message}`);
  }
  expect(failures).toEqual([]);
});
