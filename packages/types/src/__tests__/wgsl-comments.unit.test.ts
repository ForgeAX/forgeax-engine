import { describe, expect, it } from 'vitest';
import { stripWgslComments } from '../wgsl-comments';

describe('WGSL comment elision', () => {
  it('retains every UTF-16 source offset and CR/LF line boundary', () => {
    const source = 'let/* 😀 outer\r\n /* inner */ \n */value = 1; // tail\rnext';
    const output = stripWgslComments(source);
    expect(output.length).toBe(source.length);
    expect(output.indexOf('value')).toBe(source.indexOf('value'));
    expect(output.indexOf('next')).toBe(source.indexOf('next'));
    expect([...output.matchAll(/[\r\n]/g)].map((match) => match.index)).toEqual(
      [...source.matchAll(/[\r\n]/g)].map((match) => match.index),
    );
    expect(output.replace(/\s+/g, ' ')).toBe('let value = 1; next');
  });

  it('preserves quoted import paths and escaped quotes before real comments', () => {
    const imports = String.raw`#import "https://host/shaders/*literal*/path\"//tail.wgsl"`;
    const source = `${imports} /* outer /* nested */ end */\nvisible // tail`;
    const output = stripWgslComments(source);
    expect(output.slice(0, imports.length)).toBe(imports);
    expect(output.indexOf('visible')).toBe(source.indexOf('visible'));
    expect(output.slice(imports.length).trim()).toBe('visible');
  });

  it.each(['\n', '\r\n', '\r'])('ends an unterminated quoted path at %j', (newline) => {
    const quoted = '"unterminated // literal';
    const source = `${quoted}${newline}visible /* comment */`;
    const output = stripWgslComments(source);
    expect(output.startsWith(quoted + newline)).toBe(true);
    expect(output.indexOf('visible')).toBe(source.indexOf('visible'));
    expect(output.slice(quoted.length).trim()).toBe('visible');
  });

  it('handles line/block precedence, unterminated blocks and deeply nested comments', () => {
    expect(stripWgslComments('// /*\nvisible').trim()).toBe('visible');
    expect(stripWgslComments('/* // */visible').trim()).toBe('visible');
    expect(stripWgslComments('before/* /* */ after').trim()).toBe('before');
    const nested = `${'/*'.repeat(2048)}hidden${'*/'.repeat(2048)}`;
    expect(stripWgslComments(`${nested}visible`).trim()).toBe('visible');
    expect(stripWgslComments('plain_code')).toBe('plain_code');
  });
});
