import type { MeshBinHeader } from '@forgeax/engine-pack';
import {
  AssetError,
  type AssetErrorDetail,
  type AssetMeshBinContractFacts,
  type AssetMeshBinContractViolationReason,
} from '@forgeax/engine-types';

export class MeshBinAssetError extends AssetError {
  readonly subject = 'mesh-bin' as const;
  readonly sourceKey: string;
  readonly actual: string;
  readonly recovery = 're-cook the source with its Meta sidecar through the build-time importer';

  constructor(args: {
    readonly sourceKey: string;
    readonly expected: string;
    readonly actual: string;
    readonly header?: Partial<MeshBinHeader> & { readonly byteLength?: number };
    readonly reason?: AssetMeshBinContractViolationReason;
    readonly expectedFacts?: AssetMeshBinContractFacts;
    readonly actualFacts?: AssetMeshBinContractFacts;
  }) {
    const expectedFacts: AssetMeshBinContractFacts = args.expectedFacts ?? {
      version: args.header?.version ?? 5,
      projectionVersion: 1,
    };
    const actualFacts: AssetMeshBinContractFacts = {
      ...(args.header ?? {}),
      ...(args.actualFacts ?? {}),
    };
    const detail: AssetErrorDetail = {
      code: 'mesh-bin-contract-violation',
      sourceKey: args.sourceKey,
      reason: args.reason ?? 'header-invalid',
      expected: expectedFacts,
      actual: actualFacts,
    };
    super({
      code: 'mesh-bin-contract-violation',
      expected: args.expected,
      hint: 're-cook the source with its Meta sidecar through the build-time importer',
      detail,
    });
    this.sourceKey = args.sourceKey;
    this.actual = args.actual;
  }
}
