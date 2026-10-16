import { expect, it } from 'vitest';
import { digestMaterialSourceClosure } from '../compose.js';

it('preserves published closure digests, ordering and UTF-8 replacement bytes', () => {
  // Values were recorded from the original portable SHA-256 implementation.
  expect(digestMaterialSourceClosure({})).toBe(
    'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  const a = '// accented \u00e9 and unpaired \ud800\nfn a() {}';
  const z = '// emoji \ud83d\ude00\nfn z() {}';
  const expected = 'sha256:673ff555e10e412d082c5a8f5683355b36ec3408b12139c757eecae9ea319339';
  expect(digestMaterialSourceClosure({ 'game::z': z, 'game::a': a })).toBe(expected);
  expect(digestMaterialSourceClosure({ 'game::a': a, 'game::z': z })).toBe(expected);
  expect(digestMaterialSourceClosure({ 'game::a': `${a}\n`, 'game::z': z })).not.toBe(expected);
  expect(digestMaterialSourceClosure({ 'game::large': '// repeated source\n'.repeat(65536) })).toBe(
    'sha256:f2ea57681975694352d90101227df8ebf600f7c79c8d3b98e6a7aa9763926ed0',
  );
});
