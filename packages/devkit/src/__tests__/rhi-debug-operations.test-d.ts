import { expectTypeOf, it } from 'vitest';
import {
  type ArtifactRef,
  RHI_DEBUG_OPERATION_MANIFEST,
  type RhiDebugOperationName,
  type RhiDebugOperationOutput,
} from '../rhi-debug/operations';
import type { CommandResult } from '../types';

it('exposes one schema authority for the four operation names', () => {
  expectTypeOf<RhiDebugOperationName>().toEqualTypeOf<
    'rhi.capture' | 'rhi.summary' | 'rhi.inspect' | 'rhi.read' | 'rhi.timing'
  >();
  expectTypeOf(RHI_DEBUG_OPERATION_MANIFEST).toMatchTypeOf<{
    readonly operations: readonly { readonly name: RhiDebugOperationName }[];
  }>();
});

it('keeps ArtifactRef closed and directly composable', () => {
  const artifact: ArtifactRef = {
    kind: 'rhi-tape',
    digest: 'sha256:test',
    source: 'rhi.capture',
  };
  expectTypeOf(artifact.kind).toEqualTypeOf<'rhi-tape'>();
  expectTypeOf(artifact.digest).toBeString();
  expectTypeOf(artifact.source).toBeString();
  expectTypeOf<CommandResult<RhiDebugOperationOutput>>().toHaveProperty('ok');
});
