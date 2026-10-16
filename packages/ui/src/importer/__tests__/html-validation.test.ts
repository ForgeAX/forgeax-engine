import { describe, expect, it } from 'vitest';
import { validateHtmlSource } from '../html.js';

describe('ui html author source validation', () => {
  it('accepts semantic, aria and data-ui-part markup', () => {
    const result = validateHtmlSource(
      '<button aria-label="Save" data-ui-part="save">Save</button>',
    );
    expect(result.ok).toBe(true);
  });
  it('accepts explicitly named templates for runtime cloning', () => {
    const result = validateHtmlSource(
      '<template data-ui-template="score-popup"><span></span></template>',
    );
    expect(result.ok).toBe(true);
  });
  it.each([
    '<script>alert(1)</script>',
    '<button onclick="go()">x</button>',
    '<div style="color:red">x</div>',
    '<template><button>x</button></template>',
    '<a href="https://example.com">x</a>',
    '<img src="//cdn.example/x.png">',
  ])('rejects unsafe source %s with a source location', (source) => {
    const result = validateHtmlSource(source);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.location).toBeDefined();
  });
});
