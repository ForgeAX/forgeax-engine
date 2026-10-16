/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  BootstrapRoot,
  ProjectBootstrapPlan,
  ResourceBootstrapPlan,
  ResourceBootstrapTrace,
} from '../../index.js';

type ProjectRoot = ProjectBootstrapPlan['root'];
type ResourceRoot = ResourceBootstrapPlan['root'];
type TraceRoot = ResourceBootstrapTrace['root'];

const projectBootstrapSource = readFileSync(
  new URL('../project-bootstrap.ts', import.meta.url),
  'utf8',
);
const resourceBootstrapSource = readFileSync(
  new URL('../resource-bootstrap.ts', import.meta.url),
  'utf8',
);

describe('DevKit bootstrap root owner', () => {
  it('keeps the exact public root vocabulary and plan discriminants', () => {
    expectTypeOf<BootstrapRoot>().toEqualTypeOf<'project-bootstrap' | 'resource-bootstrap'>();
    expectTypeOf<ProjectRoot>().toEqualTypeOf<Extract<BootstrapRoot, 'project-bootstrap'>>();
    expectTypeOf<ResourceRoot>().toEqualTypeOf<Extract<BootstrapRoot, 'resource-bootstrap'>>();
    expectTypeOf<TraceRoot>().toEqualTypeOf<ResourceRoot>();

    const acceptsRoot = (root: BootstrapRoot): BootstrapRoot => root;
    acceptsRoot('project-bootstrap');
    acceptsRoot('resource-bootstrap');
    // @ts-expect-error Unknown roots remain outside the closed bootstrap vocabulary.
    acceptsRoot('preview-bootstrap');
  });

  it('keeps project and resource projections derived from BootstrapRoot', () => {
    expect(projectBootstrapSource).toContain(
      "type ProjectBootstrapRoot = Extract<BootstrapRoot, 'project-bootstrap'>;",
    );
    expect(projectBootstrapSource).toContain('readonly root: ProjectBootstrapRoot;');
    expect(projectBootstrapSource).not.toContain("readonly root: 'project-bootstrap';");

    expect(resourceBootstrapSource).toContain(
      "type ResourceBootstrapRoot = Extract<BootstrapRoot, 'resource-bootstrap'>;",
    );
    expect(resourceBootstrapSource).toContain('readonly root: ResourceBootstrapRoot;');
    expect(resourceBootstrapSource).not.toContain("readonly root: 'resource-bootstrap';");
  });
});
