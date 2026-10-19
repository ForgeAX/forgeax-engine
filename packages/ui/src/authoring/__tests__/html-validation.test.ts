import { describe, expect, it } from 'vitest';
import { parseHtmlAuthoring } from '../index.js';

describe('ui html author source validation', () => {
  it('accepts semantic, aria and data-ui-part markup', () => {
    const result = parseHtmlAuthoring(
      '<button aria-label="Save" data-ui-part="save">Save</button>',
      'fixture.ui.html',
    );
    expect(result.diagnostics.filter((entry) => entry.severity === 'error')).toEqual([]);
  });
  it('accepts explicitly named templates for runtime cloning', () => {
    const result = parseHtmlAuthoring(
      '<template data-ui-template="score-popup"><span></span></template>',
      'fixture.ui.html',
    );
    expect(result.diagnostics.filter((entry) => entry.severity === 'error')).toEqual([]);
  });
  it.each([
    '<script>alert(1)</script>',
    '<button onclick="go()">x</button>',
    '<div style="color:red">x</div>',
    '<template><button>x</button></template>',
    '<a href="https://example.com">x</a>',
    '<img src="//cdn.example/x.png">',
  ])('rejects unsafe source %s with a source location', (source) => {
    const result = parseHtmlAuthoring(source, 'fixture.ui.html');
    const blocking = result.diagnostics.find((entry) => entry.severity === 'error');
    expect(blocking).toMatchObject({
      sourcePath: 'fixture.ui.html',
      sourceRange: expect.any(Object),
    });
  });
});
