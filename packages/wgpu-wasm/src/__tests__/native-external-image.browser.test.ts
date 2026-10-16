import { expect, it } from 'vitest';
import { BOTTOM, nativeImageFixture, TOP } from './native-image.fixture';

it.each([
  { sourceKind: 'html', flipY: false },
  { sourceKind: 'html', flipY: true },
] as const)('native binding copies a real $sourceKind canvas (flipY $flipY)', async ({
  sourceKind,
  flipY,
}) => {
  const fixture = await nativeImageFixture(sourceKind);
  try {
    fixture.copy(flipY);
    expect(await fixture.read()).toEqual({
      top: flipY ? BOTTOM : TOP,
      bottom: flipY ? TOP : BOTTOM,
    });
    expect(fixture.gl.getError()).toBe(fixture.gl.NO_ERROR);
  } finally {
    fixture.dispose();
  }
});

it('preserves the WebGL downlevel rejection of OffscreenCanvas copies', async () => {
  const fixture = await nativeImageFixture('offscreen');
  try {
    fixture.copy(false);
    await expect(fixture.read()).rejects.toMatch(/UNRESTRICTED_EXTERNAL_TEXTURE_COPIES/);
  } finally {
    fixture.dispose();
  }
});
