export class InstanceTransformsStrideMismatchError extends Error {
  override readonly name = 'InstanceTransformsStrideMismatchError';
  readonly code = 'instance-transforms-stride-mismatch' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: { readonly actualLength: number; readonly expectedStride: 16 };

  constructor(actualLength: number) {
    const hint = `Instances.transforms length ${actualLength} violates stride 16 (mat4); ensure transforms.length % 16 === 0 before render frame; verify world.set / world.push call sites`;
    const expectedStr = 'actualLength % 16 === 0';
    super(
      `Instances.transforms: stride mismatch.\n` +
        `  code: instance-transforms-stride-mismatch\n` +
        `  actualLength: ${actualLength}\n` +
        `  expectedStride: 16\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expectedStr;
    this.detail = { actualLength, expectedStride: 16 };
  }
}

const SPAWN_LIGHT_INVALID_BOUNDS_POLICY = {
  intensity: {
    expected: 'intensity is finite and >= 0',
    hint: (componentName: string, got: number | readonly number[]) =>
      `${componentName}.intensity must be a finite non-negative number (got ${got})`,
  },
  color: {
    expected: 'color is a finite non-negative [r, g, b] vector',
    hint: (componentName: string, got: number | readonly number[]) =>
      `${componentName}.color must contain three finite non-negative channels (got ${JSON.stringify(got)})`,
  },
  width: {
    expected: 'width is finite and > 0',
    hint: (componentName: string, got: number | readonly number[]) =>
      `${componentName}.width must be a finite positive meter value (got ${got})`,
  },
  height: {
    expected: 'height is finite and > 0',
    hint: (componentName: string, got: number | readonly number[]) =>
      `${componentName}.height must be a finite positive meter value (got ${got})`,
  },
  irradiance: {
    expected: 'irradiance is a finite 27-value SH vector',
    hint: (componentName: string, got: number | readonly number[]) =>
      `${componentName}.irradiance must contain 27 finite SH values (got ${JSON.stringify(got)})`,
  },
  radius: {
    expected: 'radius is finite and >= R_MIN',
    hint: (componentName: string, got: number | readonly number[]) =>
      `${componentName}.radius must be a finite value >= R_MIN (got ${got})`,
  },
  range: {
    expected: 'range >= 0 or Number.POSITIVE_INFINITY',
    hint: (componentName: string, got: number | readonly number[]) =>
      `${componentName}.range = ${got} is invalid; use Number.POSITIVE_INFINITY for unlimited range, or a non-negative meter value`,
  },
  innerOuter: {
    expected: 'finite 0 <= innerConeDeg <= outerConeDeg',
    hint: (componentName: string, got: number | readonly number[]) =>
      `${componentName}.cone bounds are invalid (got ${got}); inner cone is the saturated bright region, outer cone is the falloff edge; finite 0 <= innerConeDeg <= outerConeDeg required; equality gives a hard cone`,
  },
  outerNinety: {
    expected: 'finite 0 < outerConeDeg <= 90 (cone half-angle)',
    hint: (componentName: string, got: number | readonly number[]) =>
      `${componentName}.outerConeDeg = ${got} is invalid; use a finite half-angle in (0, 90], or PointLight for a full sphere`,
  },
  direction: {
    expected: 'direction is a non-zero [x, y, z] vector',
    hint: (componentName: string, got: number | readonly number[]) =>
      `${componentName}.direction is missing or a zero vector (got ${JSON.stringify(got)}); direction has no default, provide a non-zero direction, e.g. [-0.5, -1, -0.3]`,
  },
} satisfies Record<
  string,
  {
    readonly expected: string;
    readonly hint: (componentName: string, got: number | readonly number[]) => string;
  }
>;

export class SpawnLightInvalidBoundsError extends Error {
  override readonly name = 'SpawnLightInvalidBoundsError';
  readonly code = 'spawn-light-invalid-bounds' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: {
    readonly field: keyof typeof SPAWN_LIGHT_INVALID_BOUNDS_POLICY;
    readonly got: number | readonly number[];
  };

  constructor(
    componentName: string,
    field: keyof typeof SPAWN_LIGHT_INVALID_BOUNDS_POLICY,
    got: number | readonly number[],
  ) {
    const policy = SPAWN_LIGHT_INVALID_BOUNDS_POLICY[field];
    const hint = policy.hint(componentName, got);
    const expectedStr = policy.expected;
    super(
      `${componentName}: spawn payload bound violation.\n` +
        `  code: spawn-light-invalid-bounds\n` +
        `  component: ${componentName}\n` +
        `  field: ${field}\n` +
        `  got: ${got}\n` +
        `  expected: ${expectedStr}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expectedStr;
    this.detail = { field, got };
  }
}

export class ResourceInvalidValueError extends Error {
  override readonly name = 'ResourceInvalidValueError';
  readonly code = 'resource-invalid-value' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: { readonly receivedMode: number; readonly receivedKey?: string };

  constructor(
    expected: string,
    hint: string,
    detail: { readonly receivedMode: number; readonly receivedKey?: string },
  ) {
    const keyClause = detail.receivedKey === undefined ? '' : `  key: ${detail.receivedKey}\n`;
    super(
      `resource: invalid value.\n` +
        `  code: resource-invalid-value\n` +
        keyClause +
        `  receivedMode: ${detail.receivedMode}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
    this.detail = detail;
  }
}

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
