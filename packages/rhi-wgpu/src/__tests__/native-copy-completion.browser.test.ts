import { expect, it } from 'vitest';
import {
  BOTTOM,
  nativeImageFixture,
  TOP,
} from '../../../wgpu-wasm/src/__tests__/native-image.fixture';
import { driveNativeCompletion } from '../internal/native-completion';

it.each([
  false,
  true,
])('native completion flushes copy-only work and observes its real HAL fence (flipY %s)', async (flipY) => {
  const fixture = await nativeImageFixture('html');
  const { queue, gl } = fixture;
  const fenceSync = gl.fenceSync;
  const getSyncParameter = gl.getSyncParameter;
  const fences: WebGLSync[] = [];
  const signaled = new Set<WebGLSync>();
  try {
    await queue.onSubmittedWorkDone(driveNativeCompletion);
    // Observe actual HAL synchronization without changing native return values.
    gl.fenceSync = (condition, flags) => {
      const sync = fenceSync.call(gl, condition, flags);
      if (sync !== null) fences.push(sync);
      return sync;
    };
    gl.getSyncParameter = (sync, parameter) => {
      const status = getSyncParameter.call(gl, sync, parameter);
      if (parameter === gl.SYNC_STATUS && status === gl.SIGNALED) signaled.add(sync);
      return status;
    };
    fixture.copy(flipY);
    // No ordinary submission or readback may flush this upload for completion.
    await queue.onSubmittedWorkDone(driveNativeCompletion);
    expect(fences.length).toBeGreaterThan(0);
    expect(signaled.has(fences[fences.length - 1] as WebGLSync)).toBe(true);
    gl.fenceSync = fenceSync;
    gl.getSyncParameter = getSyncParameter;
    expect(await fixture.read()).toEqual({
      top: flipY ? BOTTOM : TOP,
      bottom: flipY ? TOP : BOTTOM,
    });
    expect(gl.getError()).toBe(gl.NO_ERROR);
  } finally {
    gl.fenceSync = fenceSync;
    gl.getSyncParameter = getSyncParameter;
    fixture.dispose();
  }
});
