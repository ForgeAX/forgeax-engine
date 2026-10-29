// @ts-nocheck -- node:fs / node:path / node:url imports outside @types/node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Regression guard for the hot extract path: joint/instance array fields must
// stay on the zero-copy column route instead of whole-row world.get calls.

const extractPaths = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, '..', '..', '..', 'render', 'src');
  return [join(root, 'render-system-extract.ts'), join(root, 'render-system-extract-tail.ts')];
})();

describe('_getArrayView count (AC-03 gate)', () => {
  it('keeps skin and instance hot fields on column views', () => {
    const src = extractPaths.map((path) => readFileSync(path, 'utf8')).join('\n');
    // Extraction admits static Skin membership only. Joint presentation
    // matrices are read once per known joint change by their shared owners.
    expect(src).not.toContain('readPresentationWorldMatrix(world, joint');
    const renderSource = dirname(extractPaths[0]);
    expect(readFileSync(join(renderSource, 'publication', 'publisher.ts'), 'utf8')).toContain(
      'readPresentationWorldMatrix(world, joint as EntityHandle)',
    );
    expect(readFileSync(join(renderSource, 'scene', 'composition-skin.ts'), 'utf8')).toContain(
      'readPresentationWorldMatrix(world, entity as EntityHandle)',
    );
    const presentation = readFileSync(
      join(dirname(extractPaths[0]), '..', '..', 'scene', 'src', 'presentation.ts'),
      'utf8',
    );
    expect(presentation).toContain('return readRenderArrayView(');
    expect(presentation).toContain("state.active.has(entity) ? 'presentation' : 'world'");
    expect(src).toContain("_getArrayView(entity, Instances, 'transforms')");
    expect(src).toContain("_getArrayView(entity, SpriteInstances, 'transforms')");
    expect(src).toContain("_getArrayView(entity, SpriteInstances, 'regions')");
    expect(src).not.toMatch(/^\s*const\s+\w+\s*=\s*world\.get\(jointEntity, Transform\)/m);
    expect(src).not.toMatch(/^\s*const\s+\w+\s*=\s*world\.get\(entity, Instances\)/m);
  });
});
