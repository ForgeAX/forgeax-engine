import { expect, it, vi } from 'vitest';
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

it('borrows raw text without runtime fragmentation and hashes only on first identity demand', () => {
  const encode = vi.spyOn(TextEncoder.prototype, 'encode');
  const copy = vi.spyOn(String, 'fromCharCode');
  try {
    const text = 'fn source() {}\n\n'.repeat(2_000);
    const source = new ShaderSource([text]);
    expect(source.read()).toBe(text);
    expect(source.descriptor().code).toBe(text);
    expect(copy).not.toHaveBeenCalled();
    expect(encode).not.toHaveBeenCalled();
    const identity = source.identity;
    expect(encode).toHaveBeenCalledTimes(1);
    expect(source.identity).toBe(identity);
    expect(encode).toHaveBeenCalledTimes(1);
  } finally {
    copy.mockRestore();
    encode.mockRestore();
  }
});
