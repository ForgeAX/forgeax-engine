export const MATERIAL_ERROR_CODES = [
  'material-output-contract-invalid',
  'material-parent-not-found',
  'material-circular-inheritance',
  'material-child-contract-invalid',
  'material-no-effective-pass',
  'material-value-unknown',
  'material-value-type-mismatch',
  'material-parameter-type-unsupported',
  'material-contract-program-mismatch',
  'shader-module-id-missing',
  'shader-module-id-duplicate',
  'shader-module-not-found',
  'shader-module-namespace-reserved',
  'material-reflection-binding-mismatch',
  'material-specialization-not-cooked',
  'material-specialization-stale-generation',
  'gltf-material-uv-set-missing',
  'material-derived-interface-mismatch',
  'material-texture-coordinate-invalid',
  'material-payload-bounds',
  'material-transmission-contract-invalid',
  'material-physical-contract-invalid',
  'material-tangent-required',
  'material-surface-slot-missing',
  'material-surface-abi-mismatch',
  'material-surface-forbidden-interface',
] as const;

export type MaterialErrorCode = (typeof MATERIAL_ERROR_CODES)[number];

export interface MaterialGenerationVector {
  readonly dependencies: Readonly<Record<string, number>>;
}

export interface MaterialParentNotFoundDetail {
  readonly code: 'material-parent-not-found';
  readonly leaf: string;
  readonly missingParent: string;
  readonly chain: readonly string[];
}

export interface MaterialCircularInheritanceDetail {
  readonly code: 'material-circular-inheritance';
  readonly leaf: string;
  readonly chain: readonly string[];
}

export interface MaterialChildContractInvalidDetail {
  readonly code: 'material-child-contract-invalid';
  readonly material: string;
  readonly parent: string;
  readonly forbidden: readonly ('colorSpace' | 'passes' | 'parameters' | 'surface')[];
  readonly action: 'remove-forbidden-fields';
}

export interface MaterialNoEffectivePassDetail {
  readonly code: 'material-no-effective-pass';
  readonly material: string;
}

export interface MaterialValueUnknownDetail {
  readonly code: 'material-value-unknown';
  readonly material: string;
  readonly parameter: string;
}

export interface MaterialValueTypeMismatchDetail {
  readonly code: 'material-value-type-mismatch';
  readonly material: string;
  readonly parameter: string;
  readonly expectedType: string;
  readonly actualType: string;
}

export interface MaterialParameterTypeUnsupportedDetail {
  readonly code: 'material-parameter-type-unsupported';
  readonly stage: 'cook' | 'runtime';
  readonly material: string;
  readonly parameter: string;
  readonly type: string;
  readonly action: 'use-supported-type';
}

export interface MaterialContractProgramMismatchDetail {
  readonly code: 'material-contract-program-mismatch';
  readonly material: string;
  readonly pass: string;
  readonly program: string;
  readonly expectedProgram: string;
}

export interface ShaderModuleIdMissingDetail {
  readonly code: 'shader-module-id-missing';
  readonly source: string;
}

export interface ShaderModuleIdDuplicateDetail {
  readonly code: 'shader-module-id-duplicate';
  readonly module: string;
  readonly sources: readonly string[];
}

export interface ShaderModuleNotFoundDetail {
  readonly code: 'shader-module-not-found';
  readonly module: string;
  readonly source: string;
}

export interface ShaderModuleNamespaceReservedDetail {
  readonly code: 'shader-module-namespace-reserved';
  readonly module: string;
  readonly namespace: string;
}

export interface MaterialReflectionBindingMismatchDetail {
  readonly code: 'material-reflection-binding-mismatch';
  readonly material: string;
  readonly pass: string;
  readonly parameter: string;
  readonly expected: string;
  readonly actual: string;
}

export interface MaterialSpecializationNotCookedDetail {
  readonly code: 'material-specialization-not-cooked';
  readonly material: string;
  readonly staticSelection: readonly string[];
}

export interface MaterialSpecializationStaleGenerationDetail {
  readonly code: 'material-specialization-stale-generation';
  readonly material: string;
  readonly dependencies: readonly string[];
  readonly observed: MaterialGenerationVector;
  readonly current: MaterialGenerationVector;
}

export interface GltfMaterialUvSetMissingDetail {
  readonly material: string;
  readonly primitive: string;
  readonly slot: string;
  readonly requestedSet: number;
  readonly availableSets: readonly number[];
}

export interface MaterialInterfaceFacts {
  readonly group?: number;
  readonly binding?: number;
  readonly resourceKind?: string;
  readonly member?: string;
  readonly type?: string;
  readonly offset?: number;
  readonly size?: number;
  readonly alignment?: number;
  readonly span?: number;
}

export interface MaterialDerivedInterfaceMismatchDetail {
  readonly code: 'material-derived-interface-mismatch';
  readonly stage: 'compile' | 'cook' | 'extract' | 'record';
  readonly material: string;
  readonly layoutIdentity: string;
  readonly expectedIdentity?: string;
  readonly actualIdentity?: string;
  readonly parameter?: string;
  readonly action: 'recook';
  readonly pass?: string;
  readonly module?: string;
  readonly source?: string;
  readonly context?: Readonly<Record<string, string>>;
  readonly expected?: MaterialInterfaceFacts;
  readonly actual?: MaterialInterfaceFacts;
}

export interface MaterialTextureCoordinateInvalidDetail {
  readonly code: 'material-texture-coordinate-invalid';
  readonly stage: 'compile' | 'cook' | 'extract' | 'record';
  readonly material: string;
  readonly layoutIdentity: string;
  readonly parameter: string;
  readonly slot: string;
  readonly reason: 'missing' | 'non-finite' | 'shape';
  readonly action: 'recook';
}

export interface MaterialPayloadBoundsDetail {
  readonly code: 'material-payload-bounds';
  readonly stage: 'compile' | 'cook' | 'extract' | 'record';
  readonly material: string;
  readonly layoutIdentity: string;
  readonly slot: string;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly payloadBytes: number;
  readonly action: 'stop-draw';
}

export interface MaterialTransmissionContractInvalidDetail {
  readonly code: 'material-transmission-contract-invalid';
  readonly material: string;
  readonly parameter:
    | 'transmission'
    | 'ior'
    | 'thickness'
    | 'attenuationColor'
    | 'attenuationDistance'
    | 'transmissionTexture'
    | 'thicknessTexture';
  readonly reason: 'non-finite' | 'range' | 'shape' | 'blend' | 'depth-write';
  readonly actual?: unknown;
}

export type MaterialPhysicalLayer =
  | 'clearcoat'
  | 'anisotropy'
  | 'sheen'
  | 'iridescence'
  | 'specular'
  | 'diffuseTransmission'
  | 'root';

export interface MaterialPhysicalContractInvalidDetail {
  readonly code: 'material-physical-contract-invalid';
  readonly material: string;
  readonly layer: MaterialPhysicalLayer;
  readonly missing?: readonly string[];
  readonly conflicting?: readonly string[];
  readonly pass?: string;
  readonly reason: 'incomplete-layer' | 'child-parameter' | 'deferred-pass';
}

export interface MaterialTangentRequiredDetail {
  readonly code: 'material-tangent-required';
  readonly material: string;
  readonly mesh: string;
  readonly layer: string;
  readonly uv: string;
  readonly attributes: readonly string[];
  readonly reason: string;
}

export interface MaterialSurfaceSlotMissingDetail {
  readonly code: 'material-surface-slot-missing';
  readonly material: string;
  readonly pass: string;
  readonly source: string;
  readonly slot: 'surface';
  readonly action: 'add-surface-slot';
}

export interface MaterialSurfaceAbiMismatchDetail {
  readonly code: 'material-surface-abi-mismatch';
  readonly material: string;
  readonly pass: string;
  readonly source: string;
  readonly slot: 'surface';
  readonly expected: string;
  readonly actual: string;
  readonly action: 'repair-surface-export';
}

export interface MaterialSurfaceForbiddenInterfaceDetail {
  readonly code: 'material-surface-forbidden-interface';
  readonly material: string;
  readonly pass: string;
  readonly source: string;
  readonly slot: 'surface';
  readonly interface:
    | 'fragment-entry'
    | 'vertex-entry'
    | 'compute-entry'
    | 'resource-binding'
    | 'engine-entry'
    | 'vertex-position-mutation';
  readonly action: 'remove-forbidden-interface';
}

export interface MaterialOutputContractInvalidDetail {
  readonly code: 'material-output-contract-invalid';
  readonly material: string;
  readonly pass: string;
  readonly location: number;
  readonly reason: string;
}

interface MaterialErrorDetailByCode {
  readonly 'material-output-contract-invalid': MaterialOutputContractInvalidDetail;
  readonly 'material-parent-not-found': MaterialParentNotFoundDetail;
  readonly 'material-circular-inheritance': MaterialCircularInheritanceDetail;
  readonly 'material-child-contract-invalid': MaterialChildContractInvalidDetail;
  readonly 'material-no-effective-pass': MaterialNoEffectivePassDetail;
  readonly 'material-value-unknown': MaterialValueUnknownDetail;
  readonly 'material-value-type-mismatch': MaterialValueTypeMismatchDetail;
  readonly 'material-parameter-type-unsupported': MaterialParameterTypeUnsupportedDetail;
  readonly 'material-contract-program-mismatch': MaterialContractProgramMismatchDetail;
  readonly 'shader-module-id-missing': ShaderModuleIdMissingDetail;
  readonly 'shader-module-id-duplicate': ShaderModuleIdDuplicateDetail;
  readonly 'shader-module-not-found': ShaderModuleNotFoundDetail;
  readonly 'shader-module-namespace-reserved': ShaderModuleNamespaceReservedDetail;
  readonly 'material-reflection-binding-mismatch': MaterialReflectionBindingMismatchDetail;
  readonly 'material-specialization-not-cooked': MaterialSpecializationNotCookedDetail;
  readonly 'material-specialization-stale-generation': MaterialSpecializationStaleGenerationDetail;
  readonly 'gltf-material-uv-set-missing': GltfMaterialUvSetMissingDetail;
  readonly 'material-derived-interface-mismatch': MaterialDerivedInterfaceMismatchDetail;
  readonly 'material-texture-coordinate-invalid': MaterialTextureCoordinateInvalidDetail;
  readonly 'material-payload-bounds': MaterialPayloadBoundsDetail;
  readonly 'material-transmission-contract-invalid': MaterialTransmissionContractInvalidDetail;
  readonly 'material-physical-contract-invalid': MaterialPhysicalContractInvalidDetail;
  readonly 'material-tangent-required': MaterialTangentRequiredDetail;
  readonly 'material-surface-slot-missing': MaterialSurfaceSlotMissingDetail;
  readonly 'material-surface-abi-mismatch': MaterialSurfaceAbiMismatchDetail;
  readonly 'material-surface-forbidden-interface': MaterialSurfaceForbiddenInterfaceDetail;
}

export type MaterialErrorDetail = MaterialErrorDetailByCode[MaterialErrorCode];

export type MaterialErrorFor<C extends MaterialErrorCode> = {
  readonly code: C;
  readonly expected: string;
  readonly hint: string;
  readonly detail: MaterialErrorDetailByCode[C];
  readonly message: string;
};

export type MaterialError = {
  [C in MaterialErrorCode]: MaterialErrorFor<C>;
}[MaterialErrorCode];

const MATERIAL_ERROR_POLICY = {
  'material-parent-not-found': {
    expected: 'every parent GUID resolves to a MaterialAsset',
    hint: 'fix the parent GUID and resolve the material again',
  },
  'material-circular-inheritance': {
    expected: 'the parent chain is acyclic',
    hint: 'remove the repeated GUID from the parent chain',
  },
  'material-output-contract-invalid': {
    expected: 'ordered named color outputs with valid formats and independent blend/write states',
    hint: 'repair the material output declaration and bind matching RenderGraph attachments',
  },
  'material-child-contract-invalid': {
    expected: 'a parent-bearing material child contains only parent and authored values',
    hint: 'remove colorSpace, passes, parameters, and surface from the child; let the MaterialTable root provide the effective contract',
  },
  'material-no-effective-pass': {
    expected: 'the resolved material has at least one pass',
    hint: 'add a pass to the root material or an inherited parent',
  },
  'material-value-unknown': {
    expected: 'every value name is declared by the effective contract',
    hint: 'remove the value or declare the parameter in the root contract',
  },
  'material-value-type-mismatch': {
    expected: 'each value matches its declared parameter type',
    hint: 'change the value to the declared parameter type',
  },
  'material-parameter-type-unsupported': {
    expected: 'each material parameter uses a producer-supported ABI type',
    hint: 'replace the boolean parameter with a supported numeric, vector, color, or texture type and recook the material',
  },
  'material-contract-program-mismatch': {
    expected: 'the program satisfies the material contract',
    hint: 'align the program entries with the root contract',
  },
  'shader-module-id-missing': {
    expected: 'each WGSL source declares a module ID',
    hint: 'add a compiler-native module ID declaration to the WGSL source',
  },
  'shader-module-id-duplicate': {
    expected: 'each module ID has one source provenance',
    hint: 'rename one module or remove the duplicate source',
  },
  'shader-module-not-found': {
    expected: 'every referenced module exists in the source catalog',
    hint: 'add the module to the source catalog or fix the reference',
  },
  'shader-module-namespace-reserved': {
    expected: 'user modules use a non-reserved namespace',
    hint: 'choose a module ID outside the reserved namespace',
  },
  'material-reflection-binding-mismatch': {
    expected: 'reflection matches the material contract bindings',
    hint: 'update the contract or WGSL binding and cook again',
  },
  'material-specialization-not-cooked': {
    expected: 'the requested specialization has a cooked artifact',
    hint: 'run the build or development cook path for this selection',
  },
  'material-specialization-stale-generation': {
    expected: 'all specialization dependencies share one generation',
    hint: 'retry after dependent assets and sources settle',
  },
  'gltf-material-uv-set-missing': {
    expected: 'each texture slot references an available primitive UV set',
    hint: 'add the requested UV set to the primitive and re-import it',
  },
  'material-derived-interface-mismatch': {
    expected: 'the generated material interface matches the derived schema interface',
    hint: 'repair the schema or WGSL producer and recook the material',
  },
  'material-texture-coordinate-invalid': {
    expected: 'every texture coordinate record is finite and complete',
    hint: 'repair the texture metadata or coordinates and recook the material',
  },
  'material-payload-bounds': {
    expected: 'every material payload write stays within the derived payload',
    hint: 'repair the derived payload owner before submitting the draw',
  },
  'material-transmission-contract-invalid': {
    expected: 'transmission material values satisfy finite ranges and Forward depth rules',
    hint: 'repair the named transmission value or pass state before publishing the material',
  },
  'material-physical-contract-invalid': {
    expected: 'the Standard physical contract contains complete declared layers and valid passes',
    hint: 'repair the root parameters or pass policy and derive the material again',
  },
  'material-tangent-required': {
    expected: 'the physical material tangent input is complete and valid before draw admission',
    hint: 'provide a finite tangent: vec4 or repair the named normal, UV, and triangle topology inputs',
  },
  'material-surface-slot-missing': {
    expected: 'the Standard material pass has one surface module slot',
    hint: 'add moduleSlots.surface to the Standard pass and recook the material',
  },
  'material-surface-abi-mismatch': {
    expected:
      'the Surface module exports evaluate_surface with the input and output types required by its selected material model',
    hint: 'repair the authored Surface export to the producer-reported ABI and recook the material',
  },
  'material-surface-forbidden-interface': {
    expected: 'the Surface module declares no stage entry, resource binding, or vertex mutation',
    hint: 'remove the forbidden interface from the Surface source and recook the material',
  },
} satisfies {
  readonly [C in MaterialErrorCode]: {
    readonly expected: string;
    readonly hint: string;
  };
};

export const MATERIAL_ERROR_EXPECTED: Readonly<Record<MaterialErrorCode, string>> =
  Object.fromEntries(
    MATERIAL_ERROR_CODES.map((code) => [code, MATERIAL_ERROR_POLICY[code].expected]),
  ) as Readonly<Record<MaterialErrorCode, string>>;

export const MATERIAL_ERROR_HINTS: Readonly<Record<MaterialErrorCode, string>> = Object.fromEntries(
  MATERIAL_ERROR_CODES.map((code) => [code, MATERIAL_ERROR_POLICY[code].hint]),
) as Readonly<Record<MaterialErrorCode, string>>;

export function createMaterialError<C extends MaterialErrorCode>(
  code: C,
  detail: MaterialErrorDetailByCode[C],
  message = `${code}: ${MATERIAL_ERROR_EXPECTED[code]}`,
): MaterialErrorFor<C> {
  return {
    code,
    expected: MATERIAL_ERROR_EXPECTED[code],
    hint: MATERIAL_ERROR_HINTS[code],
    detail,
    message,
  };
}
