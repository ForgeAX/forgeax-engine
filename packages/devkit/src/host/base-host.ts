import type { ProjectFacts } from '../types.js';

export type BootstrapRoot = 'project-bootstrap' | 'resource-bootstrap';

export interface BaseHostOptions {
  readonly root: BootstrapRoot;
  readonly projectRoot: string;
  readonly backend?: 'webgpu';
}

export interface BaseHost {
  readonly root: BootstrapRoot;
  readonly projectRoot: string;
  readonly backend: 'webgpu';
  readonly trace: readonly string[];
}

/** Physical browser/evidence host facts shared by both bootstrap roots. */
export function createBaseHost(options: BaseHostOptions): BaseHost {
  return {
    root: options.root,
    projectRoot: options.projectRoot,
    backend: options.backend ?? 'webgpu',
    trace: ['base-host-created', 'browser-transport-ready', 'webgpu-backend-selected'],
  };
}

export function createBaseHostForProject(facts: ProjectFacts): BaseHost {
  return createBaseHost({ root: 'project-bootstrap', projectRoot: facts.root });
}

export function createBaseHostForResource(facts: ProjectFacts): BaseHost {
  return createBaseHost({ root: 'resource-bootstrap', projectRoot: facts.root });
}
