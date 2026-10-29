import { expect, it } from 'vitest';
import { ShaderSource, shaderSourceForDescriptor } from '../shader-source';

it('shares full-text identity across exact fragment partitions, including split surrogate pairs', () => {
  const literal = new ShaderSource(['a😀b']);
  const split = new ShaderSource(['a\ud83d', '\ude00b']);
  expect(split.identity).toBe(literal.identity);
  expect(split.read()).toBe(literal.read());
  expect(split.length).toBe(literal.length);
  const descriptor = split.descriptor('diagnostic');
  expect(shaderSourceForDescriptor(descriptor)).toBe(split);
  expect(descriptor.code).toBe(literal.read());
  expect(shaderSourceForDescriptor({ code: 'a😀b' })).toBeUndefined();
  expect(Object.isFrozen(split)).toBe(true);
});
