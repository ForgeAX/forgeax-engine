import type {
  LodProducerIdentity,
  LodProducerRoles,
  verifyLodProducerManifestBytes,
} from './lod-acceptance-evidence.mjs';

export function loadLodProducerInputs(
  directory: string,
  options?: { readonly producerHead?: string; readonly shaderManifest?: string },
): Promise<{
  readonly verified: Awaited<ReturnType<typeof verifyLodProducerManifestBytes>>;
  readonly identity: LodProducerIdentity;
  readonly roles: LodProducerRoles;
  readonly inputRoot: string;
  readonly shaderBytes: Uint8Array;
}>;
