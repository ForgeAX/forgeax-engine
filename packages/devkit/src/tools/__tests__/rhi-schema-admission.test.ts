import { expect, it } from 'vitest';
import { createUnifiedCommandContributions } from '../unified-contributions.js';

it('admits RHI read arguments with the advertised batch and image range bounds', () => {
  const read = createUnifiedCommandContributions(process.cwd()).find(
    (item) => item.descriptor.id === 'rhi.read',
  );
  if (!read) throw new Error('RHI read command is missing');
  const parse = read.descriptor.argsSchema.parse;
  const request = { resourceId: 'texture:1' };
  expect(
    parse({ artifact: 'frame.rhitape', reads: Array.from({ length: 64 }, () => request) }).ok,
  ).toBe(true);
  expect(
    parse({ artifact: 'frame.rhitape', reads: Array.from({ length: 65 }, () => request) }).ok,
  ).toBe(false);
  expect(
    parse({ artifact: 'frame.rhitape', reads: [{ ...request, image: { range: [0, 1] } }] }).ok,
  ).toBe(true);
  expect(
    parse({ artifact: 'frame.rhitape', reads: [{ ...request, image: { range: [0, 1, 2] } }] }).ok,
  ).toBe(false);
});
