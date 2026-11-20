import { isDeepStrictEqual } from 'node:util';
import type { CookedMaterialRecord, MaterialCookProgram } from '@forgeax/engine-pack/material-cook';
import type { NativeCookDraft } from '@forgeax/engine-pack/native-cooker';

type MaterialDraftPayload = {
  readonly kind: 'material';
  readonly cooked: CookedMaterialRecord;
};

function cookedMaterial(payload: unknown): payload is MaterialDraftPayload {
  if (payload === null || typeof payload !== 'object') return false;
  const { kind, cooked } = payload as Partial<MaterialDraftPayload>;
  return (
    kind === 'material' &&
    cooked?.schemaVersion === 'material-cook/5' &&
    Array.isArray(cooked.programs)
  );
}

/** Share immutable compiler output across cooks within one Pack build worklist. */
export function createMaterialDraftSharing() {
  const programs = new Map<string, MaterialCookProgram>();
  const shaderBytes = new Map<string, Uint8Array>();
  return <P>(draft: NativeCookDraft<P>): NativeCookDraft<P> => {
    const payload = draft.payload;
    if (!cookedMaterial(payload)) return draft;

    // Every cook crossing a process boundary arrives with a fresh graph.
    // Deduplicate before the worklist retains it and before DDC traverses it.
    const artifacts = { ...draft.artifacts };
    const sharedPrograms = payload.cooked.programs.map((program) => {
      const artifact = program?.artifact;
      if (
        typeof program?.specializationKey !== 'string' ||
        artifact?.mediaType !== 'text/wgsl' ||
        typeof artifact.path !== 'string' ||
        !(artifact.bytes instanceof Uint8Array)
      )
        return program;

      const previousBytes = shaderBytes.get(artifact.path);
      const bytes =
        previousBytes !== undefined && isDeepStrictEqual(previousBytes, artifact.bytes)
          ? previousBytes
          : artifact.bytes;
      if (previousBytes === undefined) shaderBytes.set(artifact.path, bytes);

      const external = Object.hasOwn(artifacts, artifact.path)
        ? artifacts[artifact.path]
        : undefined;
      if (external?.mediaType === artifact.mediaType && isDeepStrictEqual(external.bytes, bytes))
        artifacts[artifact.path] = { ...external, bytes };

      // Keys only select candidates. Conflicting metadata or bytes must
      // survive unchanged for the existing producer and publication checks.
      const candidate =
        bytes === artifact.bytes ? program : { ...program, artifact: { ...artifact, bytes } };
      const existing = programs.get(program.specializationKey);
      if (existing === undefined) programs.set(program.specializationKey, candidate);
      else if (isDeepStrictEqual(existing, candidate)) return existing;
      return candidate;
    });

    return {
      ...draft,
      artifacts,
      payload: { ...payload, cooked: { ...payload.cooked, programs: sharedPrograms } },
    };
  };
}
