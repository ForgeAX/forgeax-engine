import { expectTypeOf } from 'vitest';
import type { PreviewArtifactManifestEntry } from '../src/artifacts.js';

expectTypeOf<PreviewArtifactManifestEntry>().toEqualTypeOf<{
  readonly owner: string;
  readonly kind: 'report' | 'rhi-tape' | 'png' | 'profile-capture' | 'contact-sheet';
  readonly role: 'report' | 'rhi-tape' | 'capture' | 'fresh-replay' | 'profile-capture' | 'contact-sheet';
  readonly uri: string;
  readonly digest: string;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly derivedFrom: readonly string[];
}>();

import type { ToolCommandNode } from '../src/command-tree.js';
import type { JsonValue } from '../src/types.js';

// Compare the public shape while preserving every key and modifier.
type CommandLeaf = NonNullable<ToolCommandNode['leaf']>;
expectTypeOf<Pick<CommandLeaf, keyof CommandLeaf>>().toEqualTypeOf<{
  readonly title: string;
  readonly realm: 'host' | 'frontend' | 'engine' | 'build';
  readonly inputSchema?: JsonValue;
  readonly outputSchema?: JsonValue;
  readonly inputDescription?: string;
  readonly outputDescription?: string;
  readonly capabilities: readonly string[];
  readonly errors: readonly string[];
  readonly example?: JsonValue;
}>();

import type { ToolApiRunOptions } from '../src/api.js';

expectTypeOf<keyof ToolApiRunOptions>().toEqualTypeOf<
  | 'snapshot' | 'projectRoot' | 'signal' | 'deadlineMs' | 'evidence'
  | 'capabilityResolver' | 'providerId' | 'sourceId' | 'generation' | 'caller'
>();
expectTypeOf<ToolApiRunOptions>().not.toHaveProperty('owner');
expectTypeOf<Pick<ToolApiRunOptions, 'providerId' | 'sourceId' | 'generation'>>().toEqualTypeOf<{
  readonly providerId?: string;
  readonly sourceId?: string;
  readonly generation?: number;
}>();
