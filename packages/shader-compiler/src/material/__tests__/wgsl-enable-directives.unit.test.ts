import { describe, expect, it } from 'vitest';
import { hoistWgslEnables } from '../compose.js';

describe('composed WGSL extension directives', () => {
  it('places active enables ahead of generated declarations and preserves imports', () => {
    const source =
      'struct Parameters { x: f32, };\n#import source::Value\nenable f16, primitive_index;\n@fragment fn main() {}';
    expect(hoistWgslEnables(source)).toBe(
      'enable f16, primitive_index;\nstruct Parameters { x: f32, };\n#import source::Value\n\n@fragment fn main() {}',
    );
  });

  it('ignores line and nested block comments without enabling their extensions', () => {
    const source =
      '/* outer /* nested */ enable f16; */\n// enable primitive_index;\nstruct Parameters { x: f32, };';
    expect(hoistWgslEnables(source)).toBe(source);
  });
});
