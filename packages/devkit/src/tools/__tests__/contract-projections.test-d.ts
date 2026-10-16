import type { ToolCommandDeclaration } from '@forgeax/engine-tool-runtime';
import { expectTypeOf } from 'vitest';
import type { ToolCatalogEntry } from '../catalog.js';

type Identity = {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly realm: 'build' | 'host' | 'engine' | 'frontend';
};

type Declaration = Identity & {
  readonly path?: readonly string[];
  readonly argsSchema?: string;
  readonly resultSchema?: string;
  readonly evidence?: readonly ('rhi-tape' | 'profile-capture' | 'png')[];
  readonly executor?: string;
  readonly exportName?: string;
};
type CatalogEntry = Identity & {
  readonly path: readonly string[];
  readonly evidence: readonly ('rhi-tape' | 'profile-capture' | 'png')[];
  readonly argsSchema?: string;
  readonly resultSchema?: string;
};

expectTypeOf<ToolCommandDeclaration>().toExtend<Declaration>();
expectTypeOf<Declaration>().toExtend<ToolCommandDeclaration>();
expectTypeOf<keyof ToolCommandDeclaration>().toEqualTypeOf<keyof Declaration>();
expectTypeOf<ToolCatalogEntry>().toExtend<CatalogEntry>();
expectTypeOf<CatalogEntry>().toExtend<ToolCatalogEntry>();
expectTypeOf<keyof ToolCatalogEntry>().toEqualTypeOf<keyof CatalogEntry>();

declare const declaration: ToolCommandDeclaration;
declare const entry: ToolCatalogEntry;
declare const acceptSchema: (value: ToolCommandDeclaration['argsSchema']) => void;
// @ts-expect-error Shared descriptor identity stays readonly.
declaration.id = 'changed';
// @ts-expect-error Catalog identity stays readonly across the projection.
entry.title = 'Changed';
// @ts-expect-error Serialized schema strings cannot carry a runtime parser.
acceptSchema({ parse: (value: unknown) => ({ ok: true, value }) });
// @ts-expect-error A projected catalog always contains a normalized path.
const missingPath: ToolCatalogEntry = {
  id: 'tool',
  title: 'Tool',
  summary: '',
  realm: 'build',
  evidence: [],
};
void missingPath;
