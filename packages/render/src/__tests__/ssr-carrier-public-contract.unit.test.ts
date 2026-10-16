import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const carrierScripts = [
  new URL('../../../../apps/hello/ssr/scripts/smoke-dawn.mjs', import.meta.url),
  new URL(
    '../../../../apps/learn-render/6.pbr/4.render-target-reflection/scripts/smoke-dawn.mjs',
    import.meta.url,
  ),
];

describe('SSR carrier public receipt contract', () => {
  it('uses public receipt completion instead of private inspection completion', () => {
    for (const scriptUrl of carrierScripts) {
      const source = readFileSync(scriptUrl, 'utf8');
      expect(source).not.toContain('reflectionFallbackCompletion');
      expect(source).toContain('.completed');
      expect(source).toContain('renderer.inspect()');
    }
  });
});
