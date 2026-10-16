import {
  createProjectBootstrapPlan,
  type ProjectBootstrapPlan,
} from '../host/project-bootstrap.js';
import {
  createResourceBootstrapPlan,
  type ResourceBootstrapPlan,
} from '../host/resource-bootstrap.js';
import type { ProjectFacts } from '../types.js';

export interface PreviewBootstrapRoots {
  readonly project: ProjectBootstrapPlan;
  readonly resource: (guid: string) => ResourceBootstrapPlan;
}

/** Derives both physical roots without sharing project gameplay closure. */
export function createPreviewBootstrapRoots(facts: ProjectFacts): PreviewBootstrapRoots {
  return {
    project: createProjectBootstrapPlan(facts),
    resource: (guid) => createResourceBootstrapPlan(facts, guid),
  };
}
