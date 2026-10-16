import { isStandardMaterialRecord, type MaterialCookProgram } from '@forgeax/engine-pack';
import type { MaterialSurfaceDeclaration, StandardLayerPlan } from '@forgeax/engine-types';
import { deriveStandardLayerPlan } from '@forgeax/engine-types';
import type { MaterialLoadError, MaterialReady } from './loader.js';

/** JSON-safe Standard projection carried by the runtime material inspection. */
export interface MaterialRuntimeStandardInfo {
  readonly mode: StandardLayerPlan['mode'];
  readonly layers: StandardLayerPlan['layers'];
  readonly passFamily: StandardLayerPlan['passFamily'];
  readonly layerPlanIdentity: string;
  readonly passNames: readonly string[];
}

/**
 * Read-only facts for one GUID after the MaterialReady gate succeeds.
 * `status` is retained for the existing runtime API; `readiness` is the
 * machine-readable first-level field for inspection consumers. This owner
 * does not invent transport provenance or compare transport URLs.
 */
export interface MaterialRuntimeInfo {
  readonly materialGuid: string;
  readonly readiness: 'ready';
  readonly publicationGeneration: number;
  readonly specializationKey: string;
  readonly artifactDigest: string;
  readonly layoutIdentity: string;
  /** Derived program identities and selection conditions; never shader source bytes. */
  readonly programs: readonly {
    readonly specializationKey: string;
    readonly artifactDigest: string;
    readonly byteLength: number;
    readonly selections: readonly Omit<MaterialCookProgram['selections'][number], 'abi'>[];
  }[];
  readonly dependencies: readonly string[];
  readonly profile: string;
  readonly sourceClosure: readonly string[];
  readonly parameterContract: MaterialReady['record']['parameterContract'];
  readonly refs: MaterialReady['record']['refs'];
  readonly receipt: MaterialReady['record']['receipt'];
  /** Present for the built-in Standard module; absent for custom materials. */
  readonly standard?: MaterialRuntimeStandardInfo;
  /** Root-published Surface model, when the material declares one. */
  readonly surface?: MaterialSurfaceDeclaration;
  readonly status: 'Ready';
}

export interface MaterialRuntimePendingInput {
  readonly status: 'Pending';
  readonly guid: string;
  readonly specializationKey: string;
  readonly reason?: string;
}

export interface MaterialRuntimeLastKnownGoodInput {
  readonly status: 'LastKnownGood';
  readonly ready: MaterialReady;
  readonly failure: MaterialLoadError;
}

export interface MaterialRuntimeFailureInfo {
  readonly materialGuid: string;
  readonly readiness: 'failed';
  readonly specializationKey: string;
  readonly publicationGeneration: number | undefined;
  readonly preparationFailure: MaterialLoadError['error'];
  readonly status: 'Error';
}

export interface MaterialRuntimePendingInfo {
  readonly materialGuid: string;
  readonly readiness: 'pending';
  readonly specializationKey: string;
  readonly reason: string | undefined;
  readonly status: 'Pending';
}

export interface MaterialRuntimeLastKnownGoodInfo {
  readonly materialGuid: string;
  readonly readiness: 'last-known-good';
  readonly specializationKey: string;
  readonly lastKnownGood: MaterialRuntimeInfo;
  readonly preparationFailure: MaterialLoadError['error'];
  readonly status: 'LastKnownGood';
}

export type MaterialRuntimeInput =
  | MaterialReady
  | MaterialLoadError
  | MaterialRuntimePendingInput
  | MaterialRuntimeLastKnownGoodInput;

export type MaterialRuntimeInspection =
  | MaterialRuntimeInfo
  | MaterialRuntimeFailureInfo
  | MaterialRuntimePendingInfo
  | MaterialRuntimeLastKnownGoodInfo;

export function inspectReady(ready: MaterialReady): MaterialRuntimeInfo {
  const standard = isStandardMaterialRecord(ready.record);
  const standardInfo = !standard
    ? undefined
    : (() => {
        const layerPlan = deriveStandardLayerPlan(
          ready.record.resolved.parameters,
          ready.record.resolved.passes,
          ready.record.resolved.staticSwitches,
        );
        return Object.freeze({
          mode: layerPlan.mode,
          layers: layerPlan.layers,
          passFamily: layerPlan.passFamily,
          layerPlanIdentity: layerPlan.identity,
          passNames: Object.freeze(ready.record.resolved.passes.map((pass) => pass.name)),
        });
      })();
  return {
    materialGuid: ready.record.materialGuid,
    readiness: 'ready',
    publicationGeneration: ready.record.publicationGeneration,
    specializationKey: ready.record.specializationKey,
    artifactDigest: ready.record.artifactDigest,
    layoutIdentity: ready.record.receipt.identity.layoutIdentity,
    programs: ready.record.programs.map(({ specializationKey, artifact, selections }) => ({
      specializationKey,
      artifactDigest: artifact.digest,
      byteLength: artifact.bytes.byteLength,
      selections: selections.map(({ pass, context, address, entry }) => ({
        pass,
        context: { ...context },
        ...(address === undefined ? {} : { address }),
        ...(entry === undefined ? {} : { entry }),
      })),
    })),
    dependencies: [
      ...ready.record.refs.parent,
      ...ready.record.refs.textures,
      ...ready.record.refs.samplers,
      ...ready.record.refs.modules,
    ],
    profile: ready.record.receipt.profile,
    sourceClosure: ready.record.sourceClosure,
    parameterContract: ready.record.parameterContract,
    refs: ready.record.refs,
    ...(ready.record.resolved.surface === undefined
      ? {}
      : { surface: ready.record.resolved.surface }),
    receipt: ready.record.receipt,
    ...(standardInfo === undefined ? {} : { standard: standardInfo }),
    status: 'Ready',
  };
}

/**
 * Project only the producer's material lifecycle result into a detached,
 * bounded inspection POD. Renderer code should consume resident bindings and
 * must not copy this producer state into a second readiness ledger.
 */
export function inspectMaterialRuntime(ready: MaterialReady): MaterialRuntimeInfo;
export function inspectMaterialRuntime(input: MaterialRuntimeInput): MaterialRuntimeInspection;
export function inspectMaterialRuntime(input: MaterialRuntimeInput): MaterialRuntimeInspection {
  if (input.status === 'Ready') return inspectReady(input);
  if (input.status === 'Error') {
    return {
      materialGuid: input.error.detail.guid,
      readiness: 'failed',
      specializationKey: input.error.detail.specializationKey,
      publicationGeneration: input.error.detail.publicationGeneration,
      preparationFailure: { ...input.error },
      status: 'Error',
    };
  }
  if (input.status === 'Pending') {
    return {
      materialGuid: input.guid,
      readiness: 'pending',
      specializationKey: input.specializationKey,
      reason: input.reason,
      status: 'Pending',
    };
  }
  const lastKnownGood = inspectReady(input.ready);
  return {
    materialGuid: input.ready.record.materialGuid,
    readiness: 'last-known-good',
    specializationKey: input.ready.record.specializationKey,
    lastKnownGood,
    preparationFailure: { ...input.failure.error },
    status: 'LastKnownGood',
  };
}
