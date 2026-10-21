import { expect, it } from 'vitest';
import { AssetRegistry } from '../asset-registry';

it.each([
  '',
  'javascript:invalid',
  '//invalid.example/video.mp4',
  'clip file.mp4',
])('validates runtime video creation and updates through the video owner (%s)', (url) => {
  const assets = new AssetRegistry();
  expect(assets.create({ kind: 'video', url })).toMatchObject({
    ok: false,
    error: { code: 'asset-invalid-value' },
  });
  const handle = assets.create({ kind: 'video', url: 'clips/intro.mp4' }).unwrap();
  const before = assets.snapshot(handle).unwrap();
  const changes = assets.observe().unwrap();
  expect(assets.update(handle, { url })).toMatchObject({
    ok: false,
    error: { code: 'asset-invalid-value' },
  });
  expect(assets.read(handle).unwrap().url).toBe('clips/intro.mp4');
  expect(before.matchesCurrent()).toBe(true);
  expect(changes.read().unwrap().changes).toEqual([]);
  before.dispose();
  changes.dispose();
  assets.dispose();
});
