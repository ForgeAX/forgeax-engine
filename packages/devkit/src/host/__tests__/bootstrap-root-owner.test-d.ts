import { describe, expectTypeOf, it } from 'vitest';
import type { BootstrapRoot } from '../../index.js';

describe('DevKit bootstrap root owner', () => {
  it('keeps the exact public root vocabulary', () => {
    expectTypeOf<BootstrapRoot>().toEqualTypeOf<'project-bootstrap' | 'resource-bootstrap'>();

    const acceptsRoot = (root: BootstrapRoot): BootstrapRoot => root;
    acceptsRoot('project-bootstrap');
    acceptsRoot('resource-bootstrap');
    // @ts-expect-error Unknown roots remain outside the closed bootstrap vocabulary.
    acceptsRoot('preview-bootstrap');
  });
});
