import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { measure } from '../../src/brep/measure.ts';
import { deserializeShape, serializeShape } from '../../src/brep/serialize.ts';
import { tessellate } from '../../src/brep/tessellate.ts';
import type { Shape } from '../../src/brep/types.ts';
import { filletedBox, pipeElbowShape } from '../brep-continuity/cases.ts';
import { buildBracket } from '../brep-edit/bracket.ts';
import { must } from '../brep-heal/damage.ts';
import { buildHousing } from '../brep-heal/parts.ts';
import { contactSheet, featureLines, type Image, renderScene, toPng } from '../brep-kit/index.ts';
import { meshSurface } from '../brep-kit/mesh-scene.ts';

export const SERIALIZE_PARTS: Readonly<Record<string, () => Shape>> = {
  bracket: () => buildBracket().simplified,
  housing: () => buildHousing(),
  'filleted box': () => filletedBox(),
  'pipe elbow': () => pipeElbowShape(),
};

const draw = (shape: Shape, size: number): Image =>
  renderScene(
    {
      tris: meshSurface(must(tessellate(shape, { angle: Math.PI / 32 })), { dim: 0.38 }),
      lines: featureLines(shape),
      markers: [],
    },
    'iso',
    { size },
  );

export interface SerializeRow {
  readonly name: string;
  readonly bytes: number;
  readonly digest: string;
  readonly faces: number;
  readonly volume: number;
  /** Bytes of the PNG of the original that differ from the PNG of the decoded Shape. */
  readonly pixelDifferences: number;
  readonly sheet: Image;
}

/** Each part: original render | render of the Shape decoded from its JSON; the two must be identical. */
export function renderSerialize(outDir: string, size = 360): SerializeRow[] {
  mkdirSync(outDir, { recursive: true });
  const rows: SerializeRow[] = [];
  const cells: { image: Image; caption: string }[] = [];
  for (const [name, make] of Object.entries(SERIALIZE_PARTS)) {
    const shape = make();
    const text = must(serializeShape(shape));
    const back = must(deserializeShape(text));
    const a = draw(shape, size);
    const b = draw(back, size);
    let pixelDifferences = 0;
    for (let i = 0; i < a.rgba.length; i++) if (a.rgba[i] !== b.rgba[i]) pixelDifferences++;
    const digest = createHash('sha256').update(text).digest('hex').slice(0, 16);
    const volume = must(measure(back)).volume;
    cells.push({
      image: a,
      caption: `${name}: original, ${shape.faces.length} faces, volume ${volume.toFixed(3)}`,
    });
    cells.push({
      image: b,
      caption: `decoded from ${text.length} B json ${digest}, ${pixelDifferences} differing bytes`,
    });
    rows.push({
      name,
      bytes: text.length,
      digest,
      faces: back.faces.length,
      volume,
      pixelDifferences,
      sheet: a,
    });
  }
  const sheet = contactSheet(cells, {
    columns: 2,
    cell: size,
    title: 'forgeax-brep json v1: render before and after a round trip',
  });
  writeFileSync(join(outDir, 'serialize-sheet.png'), toPng(sheet));
  return rows;
}
