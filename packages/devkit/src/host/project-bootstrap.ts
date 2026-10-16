import type { ProjectFacts } from '../types.js';
import { type BaseHost, type BootstrapRoot, createBaseHostForProject } from './base-host.js';

type ProjectBootstrapRoot = Extract<BootstrapRoot, 'project-bootstrap'>;

export interface ProjectBootstrapPlan {
  readonly root: ProjectBootstrapRoot;
  readonly projectRoot: string;
  readonly roots: ProjectFacts['roots'];
  readonly host: BaseHost;
}

export function createProjectBootstrapPlan(facts: ProjectFacts): ProjectBootstrapPlan {
  return {
    root: 'project-bootstrap',
    projectRoot: facts.root,
    roots: facts.roots,
    host: createBaseHostForProject(facts),
  };
}
