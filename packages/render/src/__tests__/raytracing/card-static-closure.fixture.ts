import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectMaterialSources } from '../../../../shader-compiler/src/material/pack-cooker';
import { cookRayMaterial } from '../../../../shader-compiler/src/material/ray-material';
import { buildMaterialSourceCatalog } from '../../../../shader-compiler/src/material/source-catalog';
import {
  customCardSource,
  numericCardCases,
  numericCardFixture,
  numericTransform,
} from './custom-surface-cards.fixture';

export const helperCardSource = `${customCardSource}
fn unusedViewAndTime(input: SurfaceInput) -> vec3f { return input.viewDirectionWS * input.frameTime; }
`;

/** Same MaterialAsset, geometry and analytic values; only an unreachable helper is added. */
export async function staticClosureFixture() {
  const base = await numericCardFixture();
  const section = base.source.sections[0];
  if (section === undefined) throw new Error('Numeric fixture has no authored section');
  const root = await mkdtemp(join(tmpdir(), 'card-static-closure-'));
  try {
    await writeFile(join(root, 'numeric.wgsl'), helperCardSource);
    const engine = fileURLToPath(new URL('../../../../shader/src/', import.meta.url));
    const sources = buildMaterialSourceCatalog(
      await collectMaterialSources([root, engine], [engine]),
    ).unwrap();
    const helper = (
      await cookRayMaterial({
        material: 'numeric',
        table: { numeric: section.material.asset },
        sources,
        context: 'card-capture',
      })
    ).unwrap();
    const c = numericCardCases[2];
    const baseline = {
      ...base.source,
      instance: { ...base.source.instance, transform: numericTransform(c) },
    };
    const candidate = {
      ...baseline,
      sections: [{ ...section, material: { id: section.material.id, ...helper } }],
    };
    return {
      baseline,
      candidate,
      context: c,
      baselineProgram: base.program,
      candidateProgram: helper.program,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
