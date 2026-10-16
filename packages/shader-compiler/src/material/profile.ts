import { err, ok, type Result } from '@forgeax/engine-types';

export const MATERIAL_WGSL_PROFILE = {
  id: 'forgeax-material-wgsl-v1',
  language: 'wgsl' as const,
  profileVersion: '1.0.0',
  adapterVersion: '1.0.0',
  compilerVersion: '0.22.0',
  nagaVersion: '29.0.3',
} as const;

export const MATERIAL_WGSL_PROFILE_CAPABILITIES = [
  { feature: 'bool-define', supported: true, evidence: 'naga_oil 0.22 boolean defines' },
  { feature: 'int-define', supported: true, evidence: 'typed material definition projection' },
  { feature: 'uint-define', supported: true, evidence: 'typed material definition projection' },
  { feature: 'undefined-define', supported: true, evidence: 'omitted definition sentinel' },
  { feature: 'conditional', supported: true, evidence: 'naga_oil 0.22 conditional composition' },
  { feature: 'alias-import', supported: true, evidence: 'WGSL import path alias' },
  { feature: 'selective-import', supported: true, evidence: 'WGSL selective import' },
  { feature: 'nested-import', supported: true, evidence: 'transitive catalog closure' },
  { feature: 'virtual-module', supported: true, evidence: 'provider-owned virtual source' },
  { feature: 'override-module', supported: true, evidence: 'profile-scoped override source' },
  { feature: 'span-diagnostic', supported: true, evidence: 'source line, column, and context' },
] as const satisfies readonly {
  readonly feature: string;
  readonly supported: boolean;
  readonly evidence: string;
}[];

export type MaterialWgslProfileFeature =
  (typeof MATERIAL_WGSL_PROFILE_CAPABILITIES)[number]['feature'];

export interface MaterialWgslProfileCapability {
  readonly feature: MaterialWgslProfileFeature;
  readonly supported: boolean;
  readonly evidence: string;
}

export function characterizeMaterialWgslProfile(): readonly MaterialWgslProfileCapability[] {
  return MATERIAL_WGSL_PROFILE_CAPABILITIES;
}

export type MaterialProfileErrorCode = 'material-profile-unsupported';

export interface MaterialProfileError {
  readonly code: MaterialProfileErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly message: string;
  readonly detail: {
    readonly code: MaterialProfileErrorCode;
    readonly feature: string;
    readonly line: number;
    readonly column: number;
    readonly context: string;
  };
}

const DEFINE_WITH_VALUE = /^\s*#define\s+\w+\s+\S/;

export function validateMaterialWgslSource(source: string): Result<true, MaterialProfileError> {
  const lines = source.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    let feature: string | undefined;
    if (trimmed.startsWith('#version')) feature = 'glsl';
    if (trimmed.startsWith('#override unrestricted')) feature = 'unrestricted-override';
    if (DEFINE_WITH_VALUE.test(line)) feature = 'numeric-preprocessor-define';
    if (feature === undefined) continue;
    return err({
      code: 'material-profile-unsupported',
      expected: 'WGSL source uses the closed forgeax-material-wgsl-v1 profile',
      hint: 'use WGSL and typed material definitions; keep override policy inside the profile',
      message: `unsupported material WGSL profile feature: ${feature}`,
      detail: {
        code: 'material-profile-unsupported',
        feature,
        line: index + 1,
        column: Math.max(1, line.search(/\S/) + 1),
        context: line,
      },
    });
  }
  return ok(true);
}
