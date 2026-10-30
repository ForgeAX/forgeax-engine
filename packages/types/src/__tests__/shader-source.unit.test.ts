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

it('matches exact borrowed text across fragments without expanding its body', () => {
  const text = 'a\ud83d\ude00b';
  const source = new ShaderSource(['', 'a\ud83d', '\ude00b', '']);
  const read = vi.spyOn(ShaderSource.prototype, 'read');
  try {
    expect(source.matches(text)).toBe(true);
    expect(source.matches('a\ud83d\ude00c')).toBe(false);
    expect(source.matches(`${text}x`)).toBe(false);
    expect(source.matches(text.slice(0, -1))).toBe(false);
    expect(read).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
  }
  expect(new ShaderSource([]).matches('')).toBe(true);
});

it('borrows raw text without runtime fragmentation and hashes only on first identity demand', () => {
  const read = vi.spyOn(ShaderSource.prototype, 'read');
  const copy = vi.spyOn(String, 'fromCharCode');
  try {
    const text = 'fn source() {}\n\n'.repeat(2_000);
    const source = new ShaderSource([text]);
    expect(source.read()).toBe(text);
    expect(source.descriptor().code).toBe(text);
    expect(copy).not.toHaveBeenCalled();
    // Only the two explicit text reads above have expanded the owner.
    expect(read).toHaveBeenCalledTimes(2);
    read.mockClear();
    const identity = source.identity;
    expect(read).toHaveBeenCalledTimes(1);
    expect(source.identity).toBe(identity);
    expect(read).toHaveBeenCalledTimes(1);
  } finally {
    copy.mockRestore();
    read.mockRestore();
  }
});
