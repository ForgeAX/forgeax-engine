/**
 * feat-20260713-mount-override-component-add-and-shared-ref-round M2 / w9 —
 * `.code = 'shared-field-invalid-value'`.
 *
 * A `shared<T>` scalar / `array<shared<T>>` element must be a resolved numeric
 * Handle. A raw GUID string / `{ guid }` / `{ kind }` object (the
 * pre-resolution shape a sidecar hands an AI user) used to be silently coerced
 * to the all-zero sentinel by the column packer / scalar write path, so a
 * mis-bound reference read back as `0` / `[0,0,0,0]` and rendered blank with no
 * error. `validateComponentDataKeys` only checks key NAMES, not value types;
 * this error closes the value-type gap at all three write entries
 * (spawn / addComponent / set). `.detail.field` + `.detail.fieldType` name the
 * offending field; `.detail.index` locates the array element (undefined for the
 * scalar form).
 *
 * `.detail = { component, field, fieldType, actualValue, index? }`
 * `.hint` — names the field and points at `AssetRegistry.load + allocSharedRef`.
 */
export class SharedFieldInvalidValueError extends Error {
  override readonly name = 'SharedFieldInvalidValueError';
  readonly code = 'shared-field-invalid-value' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: {
    readonly component: string;
    readonly field: string;
    readonly fieldType: string;
    readonly actualValue: unknown;
    readonly index?: number;
  };

  constructor(
    componentName: string,
    fieldName: string,
    fieldType: string,
    actualValue: unknown,
    index?: number,
  ) {
    const at = index === undefined ? '' : `[${index}]`;
    const expected = `a resolved numeric Handle for shared field '${fieldName}${at}'`;
    const hint =
      `'${fieldName}${at}' on '${componentName}' is a ${fieldType} reference; ` +
      `got ${typeof actualValue} (${JSON.stringify(actualValue)}). ` +
      `Resolve the GUID to a handle first: AssetRegistry.load(guid, kind) then allocSharedRef(...), ` +
      `and bind the returned numeric handle — not the raw GUID / sidecar object.`;
    super(
      `${componentName}.${fieldName}${at}: shared field bound to a non-handle value.\n` +
        `  code: shared-field-invalid-value\n` +
        `  component: ${componentName}\n` +
        `  field: ${fieldName}${at}\n` +
        `  fieldType: ${fieldType}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
    this.detail =
      index === undefined
        ? { component: componentName, field: fieldName, fieldType, actualValue }
        : { component: componentName, field: fieldName, fieldType, actualValue, index };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// feat-20260625-sprite-instances-and-tilemap-terrain-static-batch M1 / w2 —
// closed-union evolution +3 for the SpriteInstances primitive + tilemap
// terrain static-batch path. AGENTS.md §Error model evolution contract: minor
// (add member only).
//
// All 3 codes are DECLARED here (M1) but FIRED at the render-system-extract
// QueryRow loop (M3 w13) — plan-strategy D-6 "fail-fast at the render
// domain entry, not at ECS spawn-time (avoids reverse dep ECS -> AssetRegistry
// to look up MaterialAsset.shadingModel)". M1 carries class declarations only;
// the `_routeError` call sites land in M3.
//
// Three codes, three failure shapes:
//   - 'sprite-instances-count-mismatch' — transforms.length / 16 !==
//     regions.length / 4 (stride contract; cf. instance-transforms-stride-
//     mismatch which guards Instances stride 16).
//   - 'sprite-instances-requires-sprite-shader' — the entity's MaterialAsset's
//     first pass shader is not 'forgeax::sprite' (extract-time check; AI users
//     using SpriteInstances must pick a sprite-shaded material).
//   - 'sprite-instances-mutually-exclusive-with-instances' — the same entity
//     carries both Instances + SpriteInstances (the two primitives are peers;
//     SpriteInstances supersedes Instances when per-instance UV region is
//     needed).
//
// .hint follows charter P3: each contains the literal repair step AI users
// can paste back into spawn code (transforms/regions stride math; shading
// model field write; component removal).
// ────────────────────────────────────────────────────────────────────────────

/**
 * Thrown / returned via Layer-3 error route when `SpriteInstances.transforms`
 * (stride 16 — column-major mat4 per instance) and `SpriteInstances.regions`
 * (stride 4 — per-instance UV vec4) instance counts disagree at render-system-
 * extract entry.
 *
 * `.code = 'sprite-instances-count-mismatch'`
 * `.detail = { transformsLength, regionsLength, expectedStride: { transforms: 16, regions: 4 } }`
 * `.hint` — instructs the AI user to enforce
 *   `transforms.length / 16 === regions.length / 4`.
 */
export class SpriteInstancesCountMismatchError extends Error {
  override readonly name = 'SpriteInstancesCountMismatchError';
  readonly code = 'sprite-instances-count-mismatch' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: {
    readonly code: 'sprite-instances-count-mismatch';
    readonly transformsLength: number;
    readonly regionsLength: number;
    readonly expectedStride: { readonly transforms: 16; readonly regions: 4 };
  };

  constructor(transformsLength: number, regionsLength: number) {
    const hint =
      'SpriteInstances.transforms (stride 16) and SpriteInstances.regions (stride 4) ' +
      'must describe the same instance count: ensure transforms.length / 16 === regions.length / 4 ' +
      'at the spawn / set site (resize both arrays together).';
    const expected = 'transforms.length / 16 === regions.length / 4';
    super(
      `SpriteInstances: per-instance count mismatch between transforms and regions.\n` +
        `  code: sprite-instances-count-mismatch\n` +
        `  transformsLength: ${transformsLength} (count = ${transformsLength / 16})\n` +
        `  regionsLength: ${regionsLength} (count = ${regionsLength / 4})\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
    this.detail = {
      code: 'sprite-instances-count-mismatch',
      transformsLength,
      regionsLength,
      expectedStride: { transforms: 16, regions: 4 },
    };
  }
}

/**
 * Thrown / returned via Layer-3 error route when an entity carrying
 * `SpriteInstances` references a MaterialAsset whose first pass shader is not
 * `'forgeax::sprite'`. Detected at render-system-extract entry (M3 w13).
 *
 * `.code = 'sprite-instances-requires-sprite-shader'`
 * `.detail = { entityId, observedMaterialShaderId }`
 * `.hint` — instructs the AI user to bind a MaterialAsset whose first pass
 *   `shader` is `'forgeax::sprite'` or `'forgeax::sprite-lit'`.
 *
 * feat-20260624-sprite-lit-shading-model-pure-2d-lighting M1' / t6:
 * sprite-lit walks the same per-instance UV region vertex path as sprite
 * (VsOut byte-identical, paramSchema mirror); both shader ids are accepted.
 */
export class SpriteInstancesRequiresSpriteShaderError extends Error {
  override readonly name = 'SpriteInstancesRequiresSpriteShaderError';
  readonly code = 'sprite-instances-requires-sprite-shader' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: {
    readonly code: 'sprite-instances-requires-sprite-shader';
    readonly entityId: number;
    readonly observedMaterialShaderId: string;
  };

  constructor(entityId: number, observedMaterialShaderId: string) {
    const hint =
      "bind a MaterialAsset whose first pass `shader` is 'forgeax::sprite' " +
      "or 'forgeax::sprite-lit' to this entity's MeshRenderer (SpriteInstances " +
      'requires a sprite-family shader so the per-instance UV region is consumed ' +
      'by the sprite vertex shader path).';
    const expected =
      "MaterialAsset.passes[0].shader === 'forgeax::sprite' || 'forgeax::sprite-lit'";
    super(
      `SpriteInstances: entity ${entityId} requires a sprite-shaded MaterialAsset.\n` +
        `  code: sprite-instances-requires-sprite-shader\n` +
        `  entityId: ${entityId}\n` +
        `  observedMaterialShaderId: ${observedMaterialShaderId}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
    this.detail = {
      code: 'sprite-instances-requires-sprite-shader',
      entityId,
      observedMaterialShaderId,
    };
  }
}

/**
 * Thrown / returned via Layer-3 error route when the same entity carries both
 * `Instances` (3D per-instance mat4) and `SpriteInstances` (2D per-instance
 * mat4 + UV region). The two primitives are peers — pick one. Detected at
 * render-system-extract entry (M3 w13).
 *
 * `.code = 'sprite-instances-mutually-exclusive-with-instances'`
 * `.detail = { entityId }`
 * `.hint` — instructs the AI user to remove one of the two components.
 */
export class SpriteInstancesMutuallyExclusiveWithInstancesError extends Error {
  override readonly name = 'SpriteInstancesMutuallyExclusiveWithInstancesError';
  readonly code = 'sprite-instances-mutually-exclusive-with-instances' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: {
    readonly code: 'sprite-instances-mutually-exclusive-with-instances';
    readonly entityId: number;
  };

  constructor(entityId: number) {
    const hint =
      'remove Instances or replace with SpriteInstances; SpriteInstances supersedes ' +
      'Instances when per-instance region is needed.';
    const expected = 'entity carries Instances XOR SpriteInstances (not both)';
    super(
      `SpriteInstances: entity ${entityId} carries both Instances and SpriteInstances.\n` +
        `  code: sprite-instances-mutually-exclusive-with-instances\n` +
        `  entityId: ${entityId}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
    this.detail = {
      code: 'sprite-instances-mutually-exclusive-with-instances',
      entityId,
    };
  }
}
