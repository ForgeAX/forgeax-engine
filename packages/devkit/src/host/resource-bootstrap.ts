import type { ProjectFacts } from '../types.js';
import { type BaseHost, type BootstrapRoot, createBaseHostForResource } from './base-host.js';

type ResourceBootstrapRoot = Extract<BootstrapRoot, 'resource-bootstrap'>;

export interface ResourceBootstrapPlan {
  readonly root: ResourceBootstrapRoot;
  readonly projectRoot: string;
  readonly guid: string;
  readonly host: BaseHost;
}

export function createResourceBootstrapPlan(
  facts: ProjectFacts,
  guid: string,
): ResourceBootstrapPlan {
  if (guid.trim().length === 0) throw new TypeError('resource preview requires a GUID');
  return {
    root: 'resource-bootstrap',
    projectRoot: facts.root,
    guid,
    host: createBaseHostForResource(facts),
  };
}

export interface ResourceBootstrapTraceInput {
  readonly guid: string;
  readonly projectRoot: string;
  readonly activation: readonly string[];
}

export interface ResourceBootstrapTrace {
  readonly root: ResourceBootstrapRoot;
  readonly guid: string;
  readonly projectRoot: string;
  readonly events: readonly string[];
}

export function createResourceBootstrapTrace(
  input: ResourceBootstrapTraceInput,
): ResourceBootstrapTrace {
  const eventFor = (value: string): string =>
    value === 'renderer' ? 'renderer-created' : `${value}-activated`;
  return {
    root: 'resource-bootstrap',
    guid: input.guid,
    projectRoot: input.projectRoot,
    events: ['resource-root-created', ...input.activation.map(eventFor)],
  };
}
