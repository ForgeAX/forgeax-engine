// extract-record-no-hardcoded-texture-fields.test.ts
//
// feat-20260621-learn-render-5-5-parallax-mapping-demo-aligned-wit M2 / w4
//
// Grep gate (AC-06 (1)): after the M2 SSOT refactor, the extract + record
// stages must NOT resolve / validate / bind the user-region material textures
// one field at a time. The user-region texture set is the single source of
// truth `derive(paramSchema).textureFieldNames`; extract iterates it (w7) and
// record assembles the user-region bind group from it (w8). A residual
// per-field hardcoded read (`pv.baseColorTexture`, a fixed `binding: 2` slot
// keyed to `submeshMaterial.normalTexture`, ...) means the SSOT collapse did
// not actually happen — the 4th texture (heightTexture) would silently fall
// through.
//
// Scope of the gate — the three user-authored base texture fields:
//   baseColorTexture / metallicRoughnessTexture / normalTexture
// These are the fields `derive(default-standard-pbr).textureFieldNames`
// produces and that w7/w8 route through iteration.
//
// Deliberately NOT gated (legitimate residual naming):
//   - emissiveTexture / occlusionTexture: legacy engine-owned snapshot fields
//     still have named reads, while the production Standard BGL no longer adds
//     a duplicate engine injection region.
//   - USER_REGION_TEXTURE_FIELDS in derive-paramschema.ts: the 3-field
//     register-time under-declaration validator (charter P3 safety net from
//     the 4.3 blending regression). Orthogonal to binding; lives in a
//     different file and is explicitly exempt (requirements-decisions F-1).
//
// RED before w7/w8 (extract resolves pv.baseColorTexture one-by-one; record
// binds binding 2/4/6 keyed to submeshMaterial.<field>); GREEN after.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const EXTRACT_SRC = fileURLToPath(
  new URL('../../../render/src/render-system-extract.ts', import.meta.url),
);
const RECORD_SRC = fileURLToPath(
  new URL('../../../render/src/record/main-pass-material.ts', import.meta.url),
);

const USER_REGION_FIELDS = [
  'baseColorTexture',
  'metallicRoughnessTexture',
  'normalTexture',
] as const;

/** Strip `//` line comments and block comments so commented prose never trips the gate. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('extract/record have no per-field hardcoding of the user-region textures (M2 w4)', () => {
  it('extract does not resolve user-region textures via per-field `pv.<field>` reads', () => {
    const src = stripComments(readFileSync(EXTRACT_SRC, 'utf8'));
    for (const field of USER_REGION_FIELDS) {
      // `pv.baseColorTexture` / `pv["baseColorTexture"]` member reads off the
      // values object are the hardcoded per-field resolve pattern w7
      // replaces with a loop over derive().textureFieldNames.
      const dotForm = new RegExp(`pv\\.${field}\\b`);
      const bracketForm = new RegExp(`pv\\[['"]${field}['"]\\]`);
      expect(dotForm.test(src), `extract still reads pv.${field} (per-field hardcode)`).toBe(false);
      expect(bracketForm.test(src), `extract still reads pv["${field}"] (per-field hardcode)`).toBe(
        false,
      );
    }
  });

  it('record does not bind user-region textures via per-field `submeshMaterial.<field>` reads', () => {
    const src = stripComments(readFileSync(RECORD_SRC, 'utf8'));
    for (const field of USER_REGION_FIELDS) {
      const memberForm = new RegExp(`submeshMaterial\\.${field}\\b`);
      expect(
        memberForm.test(src),
        `record still reads submeshMaterial.${field} (per-field hardcode)`,
      ).toBe(false);
    }
  });
});
