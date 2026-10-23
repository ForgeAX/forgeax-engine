import type {
  MaterialAsset,
  MaterialParameter,
  MaterialPass,
  MaterialProgramAbi,
  MaterialProgramAddress,
  MaterialStaticSwitches,
  MaterialSurfaceDeclaration,
  MaterialTextureValue,
  MaterialValue,
  Result,
} from '@forgeax/engine-types';
import {
  deriveStandardLayerPlan,
  err,
  isMaterialProgramAbi,
  isMaterialStaticSwitches,
  isMaterialSurfaceDeclaration,
  isMaterialTextureParameterType,
  isStandardRootModule,
  MATERIAL_TEXTURE_SLOTS,
  ok,
  standardMaterialParameterEnabled,
} from '@forgeax/engine-types';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { AssetGuid } from '../guid.js';

export interface MaterialCookRefs {
  readonly parent: readonly string[];
  readonly textures: readonly string[];
  readonly samplers: readonly string[];
  readonly modules: readonly string[];
}

export interface MaterialCookArtifact {
  readonly mediaType: string;
  readonly path: string;
  readonly digest: string;
  readonly bytes: Uint8Array;
}

/** Domain-owned inputs used to compile and select a material program. */
export interface MaterialCookRasterContext {
  readonly backend: 'webgpu' | 'webgl2' | 'wgpu-native';
  readonly capability:
    | 'storage-buffer-minimum'
    | 'storage-buffer-projector'
    | 'storage-buffer'
    | 'storage-buffer-atmosphere'
    | 'uniform-fallback';
  readonly pipeline: 'forward' | 'deferred';
  /** Absent is the ordinary material ABI; enabled by the receiving renderer. */
  readonly visibleSurface?: true;
  readonly geometry: 'mesh' | 'skinned' | 'sprite' | 'sprite-instances' | 'terrain';
  readonly pass: 'forward' | 'shadow' | 'depth';
  readonly profile: 'forgeax-material-wgsl-v1';
  readonly toolchain: 'naga-oil';
  readonly instrumentation: 'none' | 'validation';
}

/** The same authored Surface evaluated at a ray hit or Card capture, without a submission address ABI. */
export interface MaterialCookRayContext {
  readonly backend: 'webgpu' | 'wgpu-native';
  readonly capability: 'storage-buffer';
  readonly pipeline: 'ray';
  readonly geometry: 'mesh';
  readonly pass: 'ray-hit' | 'card-capture';
  readonly profile: 'forgeax-material-ray-v1';
  readonly toolchain: 'naga-oil';
  readonly instrumentation: 'none';
}

export type MaterialCookProgramContext = MaterialCookRasterContext | MaterialCookRayContext;

/** Programs are derived artifacts, never independently authored assets. */
export interface MaterialCookProgram {
  readonly specializationKey: string;
  readonly artifact: MaterialCookArtifact;
  readonly selections: readonly {
    readonly pass: string;
    readonly context: MaterialCookProgramContext;
    /** Renderer submission address selected by this publication. */
    readonly address?: MaterialProgramAddress;
    /** Actual entry point paired with the selected address. */
    readonly entry?: string;
    /** Producer-reflected ABI facts for the selected artifact/entry. */
    readonly abi?: MaterialProgramAbi;
  }[];
}

export interface MaterialCookWasmProvenance {
  readonly sourceContentKey: string;
  readonly artifactSha256: string;
  readonly glueSha256: string;
}

export interface MaterialCookIdentity {
  readonly materialContractDigest: string;
  readonly sourceRevision: string;
  readonly sourceClosureDigest: string;
  readonly layoutIdentity: string;
  readonly programIdentity: string;
  readonly pipelineIdentity: string;
  readonly materialPublicationIdentity: string;
  readonly cookIdentity: string;
  readonly compilerFingerprint: string;
  readonly wasm: MaterialCookWasmProvenance;
  readonly artifactDigest: string;
  readonly valueGeneration: number;
  readonly dependencyGeneration: number;
  readonly cookGeneration: number;
}

export type MaterialCookIdentityInput = Omit<MaterialCookIdentity, 'cookIdentity'>;

export interface MaterialCookReceipt {
  readonly schemaVersion: 'material-cook/4';
  readonly sourceClosure: readonly string[];
  readonly profile: string;
  readonly compilerVersion: string;
  readonly identity: MaterialCookIdentity;
  readonly derivedInterface: {
    readonly layoutIdentity: string;
    /** Build-time Standard physical lowering identity, when the root is Standard. */
    readonly layerPlanIdentity?: string;
  };
}

export interface MaterialParameterContract {
  readonly parameters: readonly MaterialParameter[];
  readonly values: Readonly<Record<string, MaterialValue | null>>;
}

export interface CookedMaterialRecord {
  readonly schemaVersion: 'material-cook/4';
  readonly guid: string;
  readonly authored?: MaterialAsset;
  readonly materialGuid?: string;
  readonly publicationGeneration?: number;
  readonly specializationKey?: string;
  readonly programs: readonly MaterialCookProgram[];
  /** Digest of the complete program/Pass/context manifest. */
  readonly artifactDigest?: string;
  readonly sourceClosure?: readonly string[];
  readonly parameterContract?: MaterialParameterContract;
  readonly resolved: {
    readonly passes: readonly MaterialPass[];
    readonly parameters: readonly MaterialParameter[];
    readonly values: Readonly<Record<string, MaterialValue | null>>;
    readonly surface?: MaterialSurfaceDeclaration;
    readonly staticSwitches?: MaterialStaticSwitches;
  };
  readonly refs: MaterialCookRefs;
  readonly receipt: MaterialCookReceipt;
}

export interface MaterialCookRecordError {
  readonly code: 'material-cook-record-invalid';
  readonly expected: string;
  readonly hint: string;
  readonly detail: {
    readonly field: string;
    readonly actual?: unknown;
    readonly action: string;
  };
}

export interface MaterialCookIdentityExpectation {
  readonly layoutIdentity?: string;
  readonly artifactDigest?: string;
  readonly inputDigest?: string;
}

export { isStandardRootModule } from '@forgeax/engine-types';

export function isStandardMaterialRecord(record: Pick<CookedMaterialRecord, 'resolved'>): boolean {
  return record.resolved.passes.some((pass) => isStandardRootModule(pass.program.module));
}

/**
 * Recompute the Standard layer identity from the admitted resolved root.
 * Material admission and runtime loading share this owner so a stale receipt
 * cannot select a different physical layer plan after cooking.
 */
export function materialLayerPlanIdentity(
  record: Pick<CookedMaterialRecord, 'resolved'>,
): string | undefined {
  if (!isStandardMaterialRecord(record)) {
    return undefined;
  }
  return deriveStandardLayerPlan(
    record.resolved.parameters,
    record.resolved.passes,
    record.resolved.staticSwitches,
  ).identity;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function guidText(value: string | Uint8Array): string {
  return typeof value === 'string' ? value : AssetGuid.format(value as AssetGuid);
}

function cookGuidText(
  value: MaterialTextureValue['texture'] | MaterialTextureValue['sampler'],
): string | undefined {
  return typeof value === 'string' || value instanceof Uint8Array ? guidText(value) : undefined;
}

function textureValues(
  values: Readonly<Record<string, MaterialValue | null>> | undefined,
  textureFields: ReadonlySet<string>,
): readonly MaterialTextureValue[] {
  return Object.entries(values ?? {}).flatMap(([name, value]) => {
    if (value === null) return [];
    if (typeof value === 'string') {
      return textureFields.has(name) ? [{ texture: value }] : [];
    }
    return value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      'texture' in value
      ? [value as MaterialTextureValue]
      : [];
  });
}

export function collectMaterialCookRefs(material: Partial<MaterialAsset>): MaterialCookRefs {
  const textureFields =
    material.parameters === undefined
      ? new Set<string>(MATERIAL_TEXTURE_SLOTS)
      : new Set(
          material.parameters
            .filter((parameter) => isMaterialTextureParameterType(parameter.type))
            .map((parameter) => parameter.name),
        );
  const textures = textureValues(material.values, textureFields);
  return {
    parent: material.parent ? [guidText(material.parent)] : [],
    textures: unique(
      textures.flatMap((value) => {
        const guid = cookGuidText(value.texture);
        return guid === undefined ? [] : [guid];
      }),
    ),
    samplers: unique(
      textures.flatMap((value) => {
        if (value.sampler === undefined) return [];
        const guid = cookGuidText(value.sampler);
        return guid === undefined ? [] : [guid];
      }),
    ),
    modules: unique([
      ...(material.passes ?? []).map((pass) => pass.program.module),
      ...(material.surface === undefined ? [] : [material.surface.module]),
    ]),
  };
}

export function createMaterialArtifactDigest(bytes: Uint8Array): string {
  return `sha256:${bytesToHex(sha256(bytes))}`;
}

// Publication identity crosses runtimes without a shared locale or ICU version.
function compareCanonicalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function jsonValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return [...value];
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => compareCanonicalStrings(a, b))
        .map(([key, entry]) => [key, jsonValue(entry)]),
    );
  }
  return value;
}

// Deep-frozen data objects cannot change, so their canonical text is computed once.
const canonicalTexts = new WeakMap<object, string>();
// Set by canonicalText: whether its last result may be cached by identity.
let canonicalStable = true;
// Set when an input would make the legacy serializer call toJSON; it then stays authoritative.
let canonicalLegacy = false;
const ARRAY_INDEX = /^\d+$/;

function frozenData(value: object): boolean {
  if (!Object.isFrozen(value)) return false;
  for (const key of Object.getOwnPropertyNames(value))
    if (!('value' in (Object.getOwnPropertyDescriptor(value, key) as PropertyDescriptor)))
      return false;
  return true;
}

/** `JSON.stringify(jsonValue(value))` with identity reuse for deep-frozen data. */
function canonicalText(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') {
    canonicalStable = true;
    return JSON.stringify(value);
  }
  const cached = canonicalTexts.get(value);
  if (cached !== undefined) {
    canonicalStable = true;
    return cached;
  }
  let text: string;
  let stable: boolean;
  if (value instanceof Uint8Array) {
    stable = false;
    text = `[${value.join(',')}]`;
  } else if (Array.isArray(value)) {
    stable = frozenData(value);
    const parts: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      parts.push(canonicalText(value[index]) ?? 'null');
      stable &&= canonicalStable;
    }
    text = `[${parts.join(',')}]`;
  } else {
    stable = frozenData(value);
    let entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => compareCanonicalStrings(a, b));
    // Object.fromEntries orders array-index keys numerically before the sorted names.
    if (entries.some(([key]) => ARRAY_INDEX.test(key))) {
      const values = new Map(entries);
      entries = Object.keys(Object.fromEntries(entries)).map((key) => [key, values.get(key)]);
    }
    const parts: string[] = [];
    for (const [key, entry] of entries) {
      if (key === 'toJSON' && typeof entry === 'function') {
        canonicalLegacy = true;
        stable = false;
      }
      const child = canonicalText(entry);
      stable &&= canonicalStable;
      if (child !== undefined) parts.push(`${JSON.stringify(key)}:${child}`);
    }
    text = `{${parts.join(',')}}`;
  }
  if (stable) canonicalTexts.set(value, text);
  canonicalStable = stable;
  return text;
}

export function createMaterialCookIdentity(input: MaterialCookIdentityInput): MaterialCookIdentity {
  const cookIdentity = createMaterialArtifactDigest(
    new TextEncoder().encode(
      JSON.stringify(
        jsonValue({
          materialContractDigest: input.materialContractDigest,
          sourceRevision: input.sourceRevision,
          sourceClosureDigest: input.sourceClosureDigest,
          layoutIdentity: input.layoutIdentity,
          programIdentity: input.programIdentity,
          pipelineIdentity: input.pipelineIdentity,
          compilerFingerprint: input.compilerFingerprint,
          wasm: input.wasm,
          artifactDigest: input.artifactDigest,
        }),
      ),
    ),
  );
  return { ...input, cookIdentity };
}

export function serializeCookedMaterialRecord(record: CookedMaterialRecord): string {
  return JSON.stringify(jsonValue(record));
}

export function serializeMaterialCookReceipt(receipt: MaterialCookReceipt): string {
  return JSON.stringify(jsonValue({ ...receipt, sourceClosure: unique(receipt.sourceClosure) }));
}

function invalid(field: string, actual?: unknown): Result<never, MaterialCookRecordError> {
  return err({
    code: 'material-cook-record-invalid',
    expected: 'a complete material-cook/4 record with layered identity and provenance',
    hint: 're-cook the material and publish its record, artifact, references, and receipt together',
    detail: {
      field,
      ...(actual === undefined ? {} : { actual }),
      action: 'inspect the named field and recook the material generation',
    },
  });
}

function normalizeArtifactBytes(value: unknown): Uint8Array | undefined {
  if (Array.isArray(value)) {
    return value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
      ? Uint8Array.from(value)
      : undefined;
  }
  if (!ArrayBuffer.isView(value)) return undefined;
  const view = value as ArrayBufferView;
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
}

const IDENTITY_FIELDS = [
  'materialContractDigest',
  'sourceRevision',
  'sourceClosureDigest',
  'layoutIdentity',
  'programIdentity',
  'pipelineIdentity',
  'materialPublicationIdentity',
  'cookIdentity',
  'compilerFingerprint',
  'artifactDigest',
] as const;

function isGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function validateIdentity(value: unknown): Result<MaterialCookIdentity, MaterialCookRecordError> {
  if (value === null || typeof value !== 'object') return invalid('receipt.identity', value);
  const candidate = value as Record<string, unknown>;
  for (const field of IDENTITY_FIELDS) {
    if (typeof candidate[field] !== 'string' || candidate[field].length === 0) {
      return invalid(`receipt.identity.${field}`, candidate[field]);
    }
  }
  if (candidate.wasm === null || typeof candidate.wasm !== 'object') {
    return invalid('receipt.identity.wasm', candidate.wasm);
  }
  const wasm = candidate.wasm as Record<string, unknown>;
  for (const field of ['sourceContentKey', 'artifactSha256', 'glueSha256']) {
    if (typeof wasm[field] !== 'string' || wasm[field].length === 0) {
      return invalid(`receipt.identity.wasm.${field}`, wasm[field]);
    }
  }
  for (const field of ['valueGeneration', 'dependencyGeneration', 'cookGeneration']) {
    if (!isGeneration(candidate[field]))
      return invalid(`receipt.identity.${field}`, candidate[field]);
  }
  return ok({
    ...candidate,
    wasm: wasm as unknown as MaterialCookWasmProvenance,
  } as MaterialCookIdentity);
}

export function validateMaterialCookReceipt(
  value: unknown,
  expected: MaterialCookIdentityExpectation = {},
): Result<MaterialCookReceipt, MaterialCookRecordError> {
  if (value === null || typeof value !== 'object') return invalid('receipt');
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== 'material-cook/4')
    return invalid('receipt.schemaVersion', candidate.schemaVersion);
  const identityResult = validateIdentity(candidate.identity);
  if (!identityResult.ok) return identityResult;
  const identity = identityResult.value;
  if (candidate.derivedInterface === null || typeof candidate.derivedInterface !== 'object') {
    return invalid('receipt.derivedInterface', candidate.derivedInterface);
  }
  const derivedInterface = candidate.derivedInterface as Record<string, unknown>;
  if (derivedInterface.layoutIdentity !== identity.layoutIdentity) {
    return invalid('receipt.derivedInterface.layoutIdentity', derivedInterface.layoutIdentity);
  }
  if (
    derivedInterface.layerPlanIdentity !== undefined &&
    (typeof derivedInterface.layerPlanIdentity !== 'string' ||
      derivedInterface.layerPlanIdentity.length === 0)
  ) {
    return invalid(
      'receipt.derivedInterface.layerPlanIdentity',
      derivedInterface.layerPlanIdentity,
    );
  }
  for (const field of ['sourceClosure', 'profile', 'compilerVersion']) {
    const fieldValue = candidate[field];
    if (
      (field === 'sourceClosure' && !Array.isArray(fieldValue)) ||
      (field !== 'sourceClosure' && typeof fieldValue !== 'string')
    ) {
      return invalid(`receipt.${field}`, fieldValue);
    }
  }
  const sourceClosure = candidate.sourceClosure;
  if (Array.isArray(sourceClosure) && sourceClosure.some((path) => typeof path !== 'string')) {
    return invalid('receipt.sourceClosure', sourceClosure);
  }
  if (
    expected.layoutIdentity !== undefined &&
    identity.layoutIdentity !== expected.layoutIdentity
  ) {
    return invalid('receipt.identity.layoutIdentity', identity.layoutIdentity);
  }
  if (
    expected.artifactDigest !== undefined &&
    identity.artifactDigest !== expected.artifactDigest
  ) {
    return invalid('receipt.identity.artifactDigest', identity.artifactDigest);
  }
  if (expected.inputDigest !== undefined && identity.cookIdentity !== expected.inputDigest) {
    return invalid('receipt.identity.cookIdentity', identity.cookIdentity);
  }
  return ok({
    schemaVersion: 'material-cook/4',
    sourceClosure: candidate.sourceClosure as string[],
    profile: candidate.profile as string,
    compilerVersion: candidate.compilerVersion as string,
    identity,
    derivedInterface: {
      layoutIdentity: derivedInterface.layoutIdentity as string,
      ...(derivedInterface.layerPlanIdentity === undefined
        ? {}
        : { layerPlanIdentity: derivedInterface.layerPlanIdentity as string }),
    },
  });
}

function validateRecordHeader(
  candidate: Record<string, unknown>,
): Result<void, MaterialCookRecordError> {
  if (candidate.schemaVersion !== 'material-cook/4')
    return invalid('schemaVersion', candidate.schemaVersion);
  if (typeof candidate.guid !== 'string' || !candidate.guid) return invalid('guid');
  if (candidate.materialGuid !== undefined && typeof candidate.materialGuid !== 'string')
    return invalid('materialGuid');
  if (
    candidate.publicationGeneration !== undefined &&
    !isGeneration(candidate.publicationGeneration)
  )
    return invalid('publicationGeneration', candidate.publicationGeneration);
  if (candidate.specializationKey !== undefined && typeof candidate.specializationKey !== 'string')
    return invalid('specializationKey');
  if ('artifact' in candidate || 'variants' in candidate || 'variantContext' in candidate)
    return invalid('programs', 'legacy single-artifact publication');
  if (candidate.artifactDigest !== undefined && typeof candidate.artifactDigest !== 'string')
    return invalid('artifactDigest');
  if (
    candidate.sourceClosure !== undefined &&
    (!Array.isArray(candidate.sourceClosure) ||
      candidate.sourceClosure.some((path) => typeof path !== 'string'))
  )
    return invalid('sourceClosure');
  return validateParameterContract(candidate.parameterContract);
}

function validateParameterContract(value: unknown): Result<void, MaterialCookRecordError> {
  if (value === undefined) return ok(undefined);
  if (value === null || typeof value !== 'object') return invalid('parameterContract');
  const parameterContract = value as Record<string, unknown>;
  if (!Array.isArray(parameterContract.parameters)) return invalid('parameterContract.parameters');
  if (
    parameterContract.values === null ||
    typeof parameterContract.values !== 'object' ||
    Array.isArray(parameterContract.values)
  )
    return invalid('parameterContract.values');
  return ok(undefined);
}

/** Validate the resolved material contract and return its unique Pass names. */
function validateResolvedMaterial(
  resolved: Record<string, unknown>,
): Result<Set<string>, MaterialCookRecordError> {
  if (!Array.isArray(resolved.passes)) return invalid('resolved.passes', resolved.passes);
  if (!Array.isArray(resolved.parameters))
    return invalid('resolved.parameters', resolved.parameters);
  if (
    resolved.values === null ||
    typeof resolved.values !== 'object' ||
    Array.isArray(resolved.values)
  )
    return invalid('resolved.values', resolved.values);
  if (resolved.surface !== undefined && !isMaterialSurfaceDeclaration(resolved.surface))
    return invalid('resolved.surface', resolved.surface);
  if (resolved.staticSwitches !== undefined && !isMaterialStaticSwitches(resolved.staticSwitches))
    return invalid('resolved.staticSwitches', resolved.staticSwitches);
  if (
    resolved.staticSwitches !== undefined &&
    (resolved.parameters as MaterialParameter[]).some(
      (parameter) =>
        !standardMaterialParameterEnabled(
          parameter,
          resolved.staticSwitches as MaterialStaticSwitches,
        ),
    )
  )
    return invalid(
      'resolved.parameters',
      'inactive static parameters must be removed before publication',
    );
  return collectResolvedPassNames(resolved.passes as MaterialPass[]);
}

function collectResolvedPassNames(
  passes: readonly MaterialPass[],
): Result<Set<string>, MaterialCookRecordError> {
  const passNames = new Set<string>();
  for (const [index, pass] of passes.entries()) {
    if (
      pass === null ||
      typeof pass !== 'object' ||
      typeof pass.name !== 'string' ||
      !pass.name ||
      passNames.has(pass.name) ||
      pass.program === null ||
      typeof pass.program !== 'object' ||
      typeof pass.program.module !== 'string'
    )
      return invalid(`resolved.passes[${index}]`);
    passNames.add(pass.name);
  }
  return ok(passNames);
}

type MaterialCookSelection = MaterialCookProgram['selections'][number];

/** Cross-program facts a program set must keep consistent while its selections are read. */
interface ProgramSetScan {
  readonly passNames: ReadonlySet<string>;
  readonly programKeys: Set<string>;
  readonly selections: Set<string>;
  readonly submissionSelections: Map<string, Set<MaterialProgramAddress>>;
  readonly selectedPasses: Set<string>;
  modernPublication: boolean;
  legacySelectionField: string | undefined;
}

function validateProgramSet(
  value: unknown,
  passNames: ReadonlySet<string>,
): Result<MaterialCookProgram[], MaterialCookRecordError> {
  if (!Array.isArray(value) || value.length === 0) return invalid('programs');
  const scan: ProgramSetScan = {
    passNames,
    programKeys: new Set<string>(),
    selections: new Set<string>(),
    submissionSelections: new Map<string, Set<MaterialProgramAddress>>(),
    selectedPasses: new Set<string>(),
    modernPublication: false,
    legacySelectionField: undefined,
  };
  const programs: MaterialCookProgram[] = [];
  for (const [index, entry] of value.entries()) {
    const program = validateProgram(entry, `programs[${index}]`, scan);
    if (!program.ok) return program;
    programs.push(program.value);
  }
  const complete = validateProgramSetCompleteness(scan);
  if (!complete.ok) return complete;
  return ok(programs);
}

function validateProgramSetCompleteness(
  scan: ProgramSetScan,
): Result<void, MaterialCookRecordError> {
  if (scan.modernPublication && scan.legacySelectionField !== undefined) {
    return invalid(
      scan.legacySelectionField,
      'modern material publications require address, entry, and ABI facts on every selection',
    );
  }
  for (const [selectionKey, addresses] of scan.submissionSelections) {
    if (addresses.size !== 2) {
      return invalid('programs.selections', `incomplete submission address pair: ${selectionKey}`);
    }
  }
  if ([...scan.passNames].some((pass) => !scan.selectedPasses.has(pass)))
    return invalid('programs.selections', 'unpublished Pass');
  return ok(undefined);
}

function validateProgram(
  entry: unknown,
  field: string,
  scan: ProgramSetScan,
): Result<MaterialCookProgram, MaterialCookRecordError> {
  if (entry === null || typeof entry !== 'object') return invalid(field);
  const program = entry as Record<string, unknown>;
  if (
    typeof program.specializationKey !== 'string' ||
    !program.specializationKey ||
    scan.programKeys.has(program.specializationKey)
  )
    return invalid(`${field}.specializationKey`);
  scan.programKeys.add(program.specializationKey);
  const artifact = validateProgramArtifact(program.artifact, field);
  if (!artifact.ok) return artifact;
  if (!Array.isArray(program.selections) || program.selections.length === 0)
    return invalid(`${field}.selections`);
  const programSelections: MaterialCookSelection[] = [];
  for (const [selectionIndex, rawSelection] of program.selections.entries()) {
    const selection = validateProgramSelection(
      rawSelection,
      `${field}.selections[${selectionIndex}]`,
      scan,
    );
    if (!selection.ok) return selection;
    programSelections.push(selection.value);
  }
  return ok({
    specializationKey: program.specializationKey,
    artifact: artifact.value,
    selections: programSelections,
  });
}

function validateProgramArtifact(
  value: unknown,
  field: string,
): Result<MaterialCookArtifact, MaterialCookRecordError> {
  if (value === null || typeof value !== 'object') return invalid(`${field}.artifact`);
  const artifact = value as Record<string, unknown>;
  const bytes = normalizeArtifactBytes(artifact.bytes);
  if (
    artifact.mediaType !== 'text/wgsl' ||
    typeof artifact.path !== 'string' ||
    !artifact.path ||
    typeof artifact.digest !== 'string' ||
    !artifact.digest ||
    bytes === undefined
  )
    return invalid(`${field}.artifact`);
  return ok({ mediaType: 'text/wgsl', path: artifact.path, digest: artifact.digest, bytes });
}

function validateProgramSelection(
  rawSelection: unknown,
  selectionField: string,
  scan: ProgramSetScan,
): Result<MaterialCookSelection, MaterialCookRecordError> {
  if (rawSelection === null || typeof rawSelection !== 'object') return invalid(selectionField);
  const selection = rawSelection as Record<string, unknown>;
  if (typeof selection.pass !== 'string' || !scan.passNames.has(selection.pass))
    return invalid(selectionField);
  const context = validateMaterialCookProgramContext(selection.context);
  if (!context.ok)
    return invalid(`${selectionField}.${context.error.detail.field}`, context.error.detail.actual);
  if (context.value.pipeline === 'ray')
    return validateRaySelection(selection, selection.pass, context.value, selectionField, scan);
  return validateRasterSelection(selection, selection.pass, context.value, selectionField, scan);
}

function validateRaySelection(
  selection: Record<string, unknown>,
  pass: string,
  context: MaterialCookProgramContext,
  selectionField: string,
  scan: ProgramSetScan,
): Result<MaterialCookSelection, MaterialCookRecordError> {
  if (selection.address !== undefined || selection.abi !== undefined)
    return invalid(selectionField, 'Surface derivatives have no raster submission address or ABI');
  const entry = context.pass === 'ray-hit' ? 'cs_surface' : 'vs_card';
  if (selection.entry !== entry)
    return invalid(`${selectionField}.entry`, `${context.pass} Surface entry must be ${entry}`);
  const key = JSON.stringify([pass, materialProgramContextKey(context)]);
  if (scan.selections.has(key)) return invalid(selectionField, 'ambiguous Pass/context selection');
  scan.selections.add(key);
  return ok({ pass, context, entry });
}

function hasColorVertexInput(abi: MaterialProgramAbi): boolean {
  return abi.vertexInputs.some((input) => input.semantic === 'color');
}

function validateRasterSelection(
  selection: Record<string, unknown>,
  pass: string,
  context: MaterialCookProgramContext,
  selectionField: string,
  scan: ProgramSetScan,
): Result<MaterialCookSelection, MaterialCookRecordError> {
  const address = selection.address === undefined ? 'direct' : selection.address;
  if (address !== 'direct' && address !== 'scene-index')
    return invalid(`${selectionField}.address`, selection.address);
  const hasAddressFacts =
    selection.address !== undefined || selection.entry !== undefined || selection.abi !== undefined;
  scan.modernPublication ||= hasAddressFacts;
  if (!hasAddressFacts) scan.legacySelectionField ??= selectionField;
  const rawEntry = selection.entry;
  const entry = typeof rawEntry === 'string' ? rawEntry : undefined;
  let abi: MaterialProgramAbi | undefined;
  if (hasAddressFacts) {
    const addressed = validateAddressedSelection(
      selection,
      pass,
      context,
      address,
      selectionField,
      scan,
    );
    if (!addressed.ok) return addressed;
    abi = addressed.value;
  }
  const key = JSON.stringify([
    pass,
    materialProgramContextKey(context),
    address,
    abi !== undefined && hasColorVertexInput(abi),
  ]);
  if (scan.selections.has(key)) return invalid(selectionField, 'ambiguous Pass/context selection');
  scan.selections.add(key);
  scan.selectedPasses.add(pass);
  return ok({
    pass,
    context,
    ...(selection.address === undefined ? {} : { address }),
    ...(entry === undefined ? {} : { entry }),
    ...(selection.abi === undefined ? {} : { abi: selection.abi as MaterialProgramAbi }),
  });
}

// A deep-frozen ABI cannot change, so one admission covers every selection that shares it.
const admittedFrozenAbis = new WeakSet<object>();
function isAdmittedMaterialProgramAbi(value: unknown): value is MaterialProgramAbi {
  if (value !== null && typeof value === 'object' && admittedFrozenAbis.has(value)) return true;
  if (!isMaterialProgramAbi(value)) return false;
  try {
    // Canonical text is cached only for deep-frozen data; the digest reuses it.
    canonicalText(value);
    if (canonicalTexts.has(value)) admittedFrozenAbis.add(value);
  } catch {
    // Serialization failures stay with the digest that reports them today.
  }
  return true;
}

/** Validate a modern selection's address/entry/ABI facts and record its submission address. */
function validateAddressedSelection(
  selection: Record<string, unknown>,
  pass: string,
  context: MaterialCookProgramContext,
  address: MaterialProgramAddress,
  selectionField: string,
  scan: ProgramSetScan,
): Result<MaterialProgramAbi, MaterialCookRecordError> {
  const rawEntry = selection.entry;
  const entry = typeof rawEntry === 'string' ? rawEntry : undefined;
  if (selection.address === undefined)
    return invalid(
      `${selectionField}.address`,
      'modern ABI selections require an explicit address',
    );
  if (entry === undefined || entry.length === 0)
    return invalid(`${selectionField}.entry`, rawEntry);
  if (!isAdmittedMaterialProgramAbi(selection.abi))
    return invalid(`${selectionField}.abi`, selection.abi);
  const abi = selection.abi;
  const expectedEntry = address === 'direct' ? abi.directEntry : abi.sceneIndexEntry;
  if (entry !== expectedEntry)
    return invalid(`${selectionField}.entry`, 'entry does not match published ABI');
  if (abi.sceneIndexEntry !== undefined) {
    const submissionKey = JSON.stringify([
      pass,
      materialProgramContextKey(context),
      hasColorVertexInput(abi),
    ]);
    const addresses =
      scan.submissionSelections.get(submissionKey) ?? new Set<MaterialProgramAddress>();
    addresses.add(address);
    scan.submissionSelections.set(submissionKey, addresses);
  }
  return ok(abi);
}

/** Validate the receipt against the program-set digest, layer plan, and record generation. */
function validateRecordReceipt(
  candidate: Record<string, unknown>,
  resolved: Record<string, unknown>,
  manifestDigest: string,
): Result<MaterialCookReceipt, MaterialCookRecordError> {
  const receiptResult = validateMaterialCookReceipt(candidate.receipt, {
    artifactDigest: manifestDigest,
  });
  if (!receiptResult.ok) return receiptResult;
  let expectedLayerPlanIdentity: string | undefined;
  try {
    expectedLayerPlanIdentity = materialLayerPlanIdentity({
      resolved: resolved as unknown as CookedMaterialRecord['resolved'],
    });
  } catch (error) {
    return invalid('resolved.layerPlanIdentity', error instanceof Error ? error.message : error);
  }
  if (
    expectedLayerPlanIdentity !== undefined &&
    receiptResult.value.derivedInterface.layerPlanIdentity !== expectedLayerPlanIdentity
  ) {
    return invalid(
      'receipt.derivedInterface.layerPlanIdentity',
      receiptResult.value.derivedInterface.layerPlanIdentity,
    );
  }
  if (candidate.artifactDigest !== undefined && candidate.artifactDigest !== manifestDigest)
    return invalid('artifactDigest', candidate.artifactDigest);
  if (
    candidate.publicationGeneration !== undefined &&
    receiptResult.value.identity.cookGeneration !== candidate.publicationGeneration
  )
    return invalid('receipt.identity.cookGeneration', receiptResult.value.identity.cookGeneration);
  return receiptResult;
}

export function validateCookedMaterialRecord(
  value: unknown,
): Result<CookedMaterialRecord, MaterialCookRecordError> {
  if (value === null || typeof value !== 'object') return invalid('record');
  const candidate = value as Record<string, unknown>;
  const header = validateRecordHeader(candidate);
  if (!header.ok) return header;
  if (candidate.resolved === null || typeof candidate.resolved !== 'object')
    return invalid('resolved');
  if (candidate.refs === null || typeof candidate.refs !== 'object') return invalid('refs');
  if (candidate.receipt === null || typeof candidate.receipt !== 'object')
    return invalid('receipt');
  const resolved = candidate.resolved as Record<string, unknown>;
  const passNames = validateResolvedMaterial(resolved);
  if (!passNames.ok) return passNames;
  const programs = validateProgramSet(candidate.programs, passNames.value);
  if (!programs.ok) return programs;
  const manifestDigest = createMaterialProgramSetDigest(
    programs.value,
    resolved.passes as MaterialPass[],
  );
  const receipt = validateRecordReceipt(candidate, resolved, manifestDigest);
  if (!receipt.ok) return receipt;
  return ok({
    ...candidate,
    programs: programs.value,
    receipt: receipt.value,
  } as unknown as CookedMaterialRecord);
}

/** Bind an immutable cooked record to an accepted publication without recooking programs. */
export function withMaterialPublicationGeneration(
  value: unknown,
  generation: number,
): Result<CookedMaterialRecord, MaterialCookRecordError> {
  if (!isGeneration(generation)) return invalid('publicationGeneration', generation);
  const checked = validateCookedMaterialRecord(value);
  if (!checked.ok) return checked;
  const record = checked.value;
  return ok({
    ...record,
    publicationGeneration: generation,
    receipt: {
      ...record.receipt,
      identity: { ...record.receipt.identity, cookGeneration: generation },
    },
  });
}

export function projectCookedMaterialRecord(
  record: CookedMaterialRecord,
): Omit<CookedMaterialRecord, 'guid' | 'authored'> {
  return {
    resolved: record.resolved,
    refs: record.refs,
    programs: record.programs,
    receipt: record.receipt,
    schemaVersion: record.schemaVersion,
  };
}

/** Canonical context key shared by publication validation and runtime selection. */
export function materialProgramContextKey(context: MaterialCookProgramContext): string {
  return JSON.stringify(jsonValue(context));
}

/** One pass-domain projection for both the cooker and runtime selector. */
export function materialProgramContextForPass(
  context: MaterialCookRasterContext,
  lightMode: string,
): MaterialCookRasterContext {
  const pass = /shadow/i.test(lightMode)
    ? 'shadow'
    : /depth/i.test(lightMode)
      ? 'depth'
      : 'forward';
  const { visibleSurface, ...base } = context;
  return {
    ...base,
    pipeline: /deferred|gbuffer/i.test(lightMode) ? 'deferred' : context.pipeline,
    pass,
    ...(pass === 'forward' && visibleSurface === true ? { visibleSurface: true } : {}),
  };
}

export function validateMaterialCookProgramContext(
  value: unknown,
): Result<MaterialCookProgramContext, MaterialCookRecordError> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return invalid('context', value);
  const context = value as Record<string, unknown>;
  if (context.pipeline === 'ray') {
    const fields = {
      backend: ['webgpu', 'wgpu-native'],
      capability: ['storage-buffer'],
      pipeline: ['ray'],
      geometry: ['mesh'],
      pass: ['ray-hit', 'card-capture'],
      profile: ['forgeax-material-ray-v1'],
      toolchain: ['naga-oil'],
      instrumentation: ['none'],
    };
    for (const field of Object.keys(context))
      if (!(field in fields)) return invalid(`context.${field}`, context[field]);
    for (const [field, allowed] of Object.entries(fields))
      if (!allowed.includes(context[field] as string))
        return invalid(`context.${field}`, context[field]);
    return ok({ ...context } as unknown as MaterialCookRayContext);
  }
  const fields = {
    backend: ['webgpu', 'webgl2', 'wgpu-native'],
    capability: [
      'storage-buffer-minimum',
      'storage-buffer-projector',
      'storage-buffer',
      'storage-buffer-atmosphere',
      'uniform-fallback',
    ],
    pipeline: ['forward', 'deferred'],
    geometry: ['mesh', 'skinned', 'sprite', 'sprite-instances', 'terrain'],
    pass: ['forward', 'shadow', 'depth'],
    profile: ['forgeax-material-wgsl-v1'],
    toolchain: ['naga-oil'],
    instrumentation: ['none', 'validation'],
  };
  for (const field of Object.keys(context)) {
    if (field === 'visibleSurface') {
      if (context[field] !== true) return invalid(`context.${field}`, context[field]);
    } else if (!(field in fields)) return invalid(`context.${field}`, context[field]);
  }
  for (const [field, allowed] of Object.entries(fields)) {
    if (!allowed.includes(context[field] as string))
      return invalid(`context.${field}`, context[field]);
  }
  return ok({ ...context } as unknown as MaterialCookProgramContext);
}

// Materials sharing one program set produce one large manifest; hash each distinct text once.
const MANIFEST_DIGEST_ENTRIES = 64;
const MANIFEST_DIGEST_CHARACTERS = 32 * 1024 * 1024;
const manifestDigests = new Map<string, string>();
let manifestDigestCharacters = 0;

function manifestDigest(text: string): string {
  const cached = manifestDigests.get(text);
  if (cached !== undefined) {
    manifestDigests.delete(text);
    manifestDigests.set(text, cached);
    return cached;
  }
  const digest = createMaterialArtifactDigest(new TextEncoder().encode(text));
  if (text.length > MANIFEST_DIGEST_CHARACTERS) return digest;
  manifestDigests.set(text, digest);
  manifestDigestCharacters += text.length;
  for (const oldest of manifestDigests.keys()) {
    if (
      manifestDigests.size <= MANIFEST_DIGEST_ENTRIES &&
      manifestDigestCharacters <= MANIFEST_DIGEST_CHARACTERS
    )
      break;
    manifestDigests.delete(oldest);
    manifestDigestCharacters -= oldest.length;
  }
  return digest;
}

/** The exact legacy manifest text, for inputs outside the canonical fast path. */
function legacyMaterialProgramSetManifest(
  programs: readonly MaterialCookProgram[],
  passes: readonly MaterialPass[],
): string {
  const manifest = {
    // Keep these known manifest fields in canonical order. Nested author data
    // is normalized once before sorting and serialization.
    passes: jsonValue(passes),
    programs: programs
      .map((program) => ({
        artifact: {
          digest: program.artifact.digest,
          mediaType: program.artifact.mediaType,
          path: program.artifact.path,
        },
        selections: program.selections
          .map(jsonValue)
          .sort((a, b) => compareCanonicalStrings(JSON.stringify(a), JSON.stringify(b))),
        specializationKey: program.specializationKey,
      }))
      .sort((a, b) => compareCanonicalStrings(a.specializationKey, b.specializationKey)),
  };
  return JSON.stringify(manifest);
}

function materialProgramSetManifest(
  programs: readonly MaterialCookProgram[],
  passes: readonly MaterialPass[],
): string {
  canonicalLegacy = false;
  const passText = canonicalText(passes);
  const entries: { readonly key: string; readonly text: string }[] = [];
  for (const program of programs) {
    if (typeof program.specializationKey !== 'string') canonicalLegacy = true;
    const selections: string[] = [];
    for (const selection of program.selections) {
      const text = canonicalText(selection);
      if (text === undefined) canonicalLegacy = true;
      else selections.push(text);
    }
    if (canonicalLegacy) break;
    selections.sort(compareCanonicalStrings);
    const artifact = JSON.stringify({
      digest: program.artifact.digest,
      mediaType: program.artifact.mediaType,
      path: program.artifact.path,
    });
    entries.push({
      key: program.specializationKey,
      text: `{"artifact":${artifact},"selections":[${selections.join(',')}],"specializationKey":${JSON.stringify(program.specializationKey)}}`,
    });
  }
  if (canonicalLegacy) return legacyMaterialProgramSetManifest(programs, passes);
  entries.sort((a, b) => compareCanonicalStrings(a.key, b.key));
  return `{${passText === undefined ? '' : `"passes":${passText},`}"programs":[${entries
    .map((entry) => entry.text)
    .join(',')}]}`;
}

/** Covers every selection and artifact while excluding transport copies of the bytes. */
export function createMaterialProgramSetDigest(
  programs: readonly MaterialCookProgram[],
  passes: readonly MaterialPass[],
): string {
  return manifestDigest(materialProgramSetManifest(programs, passes));
}
