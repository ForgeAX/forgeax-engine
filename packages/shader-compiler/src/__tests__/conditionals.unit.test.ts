import { describe, expect, it } from 'vitest';
import { projectShaderConditionals } from '../conditionals';

describe('shader conditional projection', () => {
  const source = '#ifdef A\nactive\n#else\ninactive\n#endif';

  it('retains enabled backend directives unless their axis is explicitly flattened', () => {
    expect(projectShaderConditionals(source, { A: true })).toBe('#ifdef A\nactive\n#else\n#endif');
    expect(projectShaderConditionals(source, { A: true }, ['A'])).toBe('active');
    expect(projectShaderConditionals(source, { A: false })).toBe('inactive');
    expect(projectShaderConditionals(source)).toBe(source);
  });

  it('specializes every boolean form for entries and imported modules', () => {
    const source =
      '#if A\nyes\n#endif\n#if !A\nno\n#endif\n#if A == false\nno\n#else\nyes\n#endif\n#ifndef ABSENT\nyes\n#endif';
    expect(projectShaderConditionals(source, { A: true }, 'all')).toBe('yes\nyes\nyes');
    expect(projectShaderConditionals('#ifdef ABSENT\nno\n#else\nyes\n#endif', {}, 'all')).toBe(
      'yes',
    );
  });

  it('preserves opaque conditional nesting without reopening a disabled parent', () => {
    const nested = '#ifdef A\n#if COUNT > 2\nfirst\n#else\nsecond\n#endif\nthird\n#endif\nlive';
    expect(projectShaderConditionals(nested, { A: false }, 'all')).toBe('live');
    expect(projectShaderConditionals(nested, { A: true }, 'all')).toBe(
      '#if COUNT > 2\nfirst\n#else\nsecond\n#endif\nthird\nlive',
    );
  });

  it('leaves unknown comparisons to the backend during partial projection', () => {
    const opaque = '#if COUNT == true\nfirst\n#else\nsecond\n#endif';
    expect(projectShaderConditionals(opaque, { A: true })).toBe(opaque);
    expect(projectShaderConditionals(opaque, {}, 'all')).toBe('second');
  });

  it('normalizes CRLF and does not flip a branch twice on a duplicate else', () => {
    expect(
      projectShaderConditionals(
        '#ifdef A\r\nfirst\r\n#else\r\nsecond\r\n#else\r\nthird\r\n#endif',
        { A: false },
        'all',
      ),
    ).toBe('second\nthird');
  });
});
