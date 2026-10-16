import type {
  ToolCapability,
  ToolCapabilityResolver,
  ToolRealm,
  ToolRuntimeError,
} from './types.js';
import { TOOL_REALMS } from './types.js';

const capabilityIdPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

/** A static service identity. The value and its lifecycle remain Fiber-local. */
export function defineToolCapability<T>(id: string): ToolCapability<T> {
  if (!capabilityIdPattern.test(id)) {
    throw new TypeError(`Tool capability id must use a stable lower-case path: ${id}`);
  }
  return Object.freeze({ id }) as ToolCapability<T>;
}

export function createCapabilityResolver(
  resolve: <T>(capability: ToolCapability<T>) => T | undefined,
): ToolCapabilityResolver {
  return <T>(capability: ToolCapability<T>) => {
    const value = resolve(capability);
    return value === undefined ? undefined : { ok: true as const, value };
  };
}

export interface ServiceAdmissionRef {
  readonly schema: 'forgeax.tool-service-admission-ref.v1';
  readonly reportDigest: string;
  readonly toolId: string;
  readonly descriptorDigest: string;
  readonly recipeDigest: string;
  readonly workloadClass: string;
  readonly codeDigest: string;
  readonly browserVersion: string;
  readonly backend: 'webgpu';
  readonly frameCount: number;
  readonly samples: {
    readonly privateCold: number;
    readonly privateWarm: number;
    readonly serviceCold: number;
    readonly serviceWarm: number;
  };
  readonly correctness: {
    readonly terminalEquivalent: boolean;
    readonly artifactIntegrity: boolean;
    readonly freshReplay: boolean;
    readonly hiddenParity: boolean;
    readonly drawCalls: number;
    readonly nonBlackPixels: number;
  };
  readonly performance: {
    readonly privateMedianMs: number;
    readonly privateP95Ms: number;
    readonly privateMaxMs: number;
    readonly privateRssBytes: number;
    readonly serviceMedianMs: number;
    readonly serviceP95Ms: number;
    readonly serviceMaxMs: number;
    readonly serviceRssBytes: number;
  };
  readonly cleanupPassed: boolean;
  readonly evictionPassed: boolean;
}

export interface ServiceAdmissionExpectation {
  readonly toolId: string;
  readonly descriptorDigest: string;
  readonly recipeDigest: string;
  readonly workloadClass: string;
  readonly codeDigest: string;
  readonly browserVersion: string;
  readonly backend: 'webgpu';
}

export type ServiceCapability =
  | { readonly available: true; readonly reportDigest?: string }
  | {
      readonly available: false;
      readonly code: 'tool-service-capability-absent';
      readonly expected: 'an admitted acceleration service';
      readonly hint: 'Use the private executor and rerun benchmark admission before enabling service.';
      readonly detail: { readonly reason: string };
    };

function admissionFailure(
  admission: ServiceAdmissionRef | undefined,
  expected: ServiceAdmissionExpectation,
): string | undefined {
  if (admission === undefined) return 'no workload-scoped admission report was supplied';
  if (
    admission.schema !== 'forgeax.tool-service-admission-ref.v1' ||
    !/^sha256:[0-9a-f]{64}$/.test(admission.reportDigest)
  ) {
    return 'admission report identity is invalid';
  }
  for (const key of [
    'toolId',
    'descriptorDigest',
    'recipeDigest',
    'workloadClass',
    'codeDigest',
    'browserVersion',
    'backend',
  ] as const) {
    if (admission[key] !== expected[key]) return `admission ${key} does not match this run`;
  }
  if (admission.frameCount < 300) return 'admission workload ran fewer than 300 frames';
  if (Object.values(admission.samples).some((count) => count < 30)) {
    return 'admission sample set is incomplete';
  }
  if (
    !admission.correctness.terminalEquivalent ||
    !admission.correctness.artifactIntegrity ||
    !admission.correctness.freshReplay ||
    !admission.correctness.hiddenParity ||
    admission.correctness.drawCalls <= 0 ||
    admission.correctness.nonBlackPixels <= 0
  ) {
    return 'admission correctness gate failed';
  }
  const performance = admission.performance;
  if (
    Object.values(performance).some((value) => !Number.isFinite(value) || value <= 0) ||
    performance.serviceMedianMs > performance.privateMedianMs * 0.8 ||
    performance.serviceP95Ms > performance.privateP95Ms * 0.9 ||
    performance.serviceMaxMs > performance.privateMaxMs * 1.1 ||
    performance.serviceRssBytes > performance.privateRssBytes * 1.25
  ) {
    return 'admission performance threshold failed';
  }
  if (!admission.cleanupPassed) return 'admission cleanup gate failed';
  if (!admission.evictionPassed) return 'admission eviction gate failed';
  return undefined;
}

export function createServiceCapability(
  admission: ServiceAdmissionRef | undefined,
  expected: ServiceAdmissionExpectation,
): ServiceCapability {
  const reason = admissionFailure(admission, expected);
  if (reason === undefined && admission !== undefined) {
    return { available: true, reportDigest: admission.reportDigest };
  }
  return {
    available: false,
    code: 'tool-service-capability-absent',
    expected: 'an admitted acceleration service',
    hint: 'Use the private executor and rerun benchmark admission before enabling service.',
    detail: { reason: reason ?? 'benchmark admission did not pass' },
  };
}

export interface RealmCapability {
  readonly realm: ToolRealm;
  readonly supported: boolean;
  readonly reason?: 'realm-capability-unavailable';
}

export interface RealmCapabilityMatrix {
  readonly catalogDigest: string;
  readonly realms: Readonly<Record<ToolRealm, RealmCapability>>;
}

export interface RealmCapabilityInput {
  readonly catalogDigest: string;
  readonly supported: Readonly<Record<ToolRealm, boolean>>;
}

export function createRealmCapabilityMatrix(input: RealmCapabilityInput): RealmCapabilityMatrix {
  const realms = TOOL_REALMS.reduce(
    (result, realm) => {
      const supported = input.supported[realm];
      result[realm] = supported
        ? { realm, supported: true }
        : { realm, supported: false, reason: 'realm-capability-unavailable' };
      return result;
    },
    {} as Record<ToolRealm, RealmCapability>,
  );
  return { catalogDigest: input.catalogDigest, realms };
}

export type RealmBootstrapValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: ToolRuntimeError };

function bootstrapNotCloneSafeError(detail: { readonly message: string }): ToolRuntimeError {
  return {
    code: 'tool-bootstrap-not-clone-safe',
    expected: 'bootstrap input to contain structured-clone-safe data',
    hint: 'Remove live handles, functions, ports, and realm-owned objects from bootstrap input.',
    detail,
  };
}

export function validateRealmBootstrapPayload(value: unknown): RealmBootstrapValidation {
  try {
    structuredClone(value);
    return { ok: true };
  } catch (cause) {
    return {
      ok: false,
      error: bootstrapNotCloneSafeError({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
    };
  }
}
