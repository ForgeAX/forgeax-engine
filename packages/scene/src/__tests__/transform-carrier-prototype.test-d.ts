import type { QueryRow, QuerySpan, SchemaOf } from '@forgeax/engine-ecs';
import { defineComponent } from '@forgeax/engine-ecs';
import type { SceneError, SceneErrorCode } from '../index';

const LocalLane = defineComponent('PrototypeLocalLane', { value: 'f32' });
const WorldLane = defineComponent('PrototypeWorldLane', { value: 'f32' });

type LocalShape = { value: number };
type WorldShape = { readonly value: number };
type LocalSchema = SchemaOf<typeof LocalLane>;
type WorldSchema = SchemaOf<typeof WorldLane>;

declare const localAuthor: LocalShape;
declare const worldOutput: WorldShape;
declare const localSchema: LocalSchema;
declare const worldSchema: WorldSchema;
void localSchema;
void worldSchema;

localAuthor.value = 1;
// @ts-expect-error authoring only exposes the local lane, not derived world output.
worldOutput.value = 1;

declare const authoredRow: QueryRow<readonly [typeof LocalLane], readonly []>;
declare const propagatedRow: QueryRow<readonly [typeof LocalLane], readonly [typeof WorldLane]>;
declare const worldReadRow: QueryRow<readonly [typeof WorldLane], readonly []>;
declare const worldReadSpan: QuerySpan<readonly [typeof WorldLane], readonly []>;

propagatedRow.get(LocalLane).value;
propagatedRow.mut(WorldLane).value = propagatedRow.get(LocalLane).value;
worldReadRow.get(WorldLane).value;
worldReadSpan.get(WorldLane).value[0];
void authoredRow;

// @ts-expect-error local-only authoring cannot write the derived world lane.
authoredRow.mut(WorldLane);
// @ts-expect-error a readonly Query row cannot write world output.
worldReadRow.mut(WorldLane);
// @ts-expect-error a readonly QuerySpan cannot write world output.
worldReadSpan.mut(WorldLane);

function rendererSync(row: QueryRow<readonly [typeof WorldLane], readonly []>): number {
  return row.get(WorldLane).value;
}
void rendererSync(worldReadRow);

// @ts-expect-error the renderer sync contract cannot accept a propagation writer row.
rendererSync(propagatedRow);

declare const parsedField: string;
// @ts-expect-error carrier consumers cannot parse arbitrary string field names.
const localField: keyof LocalShape = parsedField;
void localField;

type MissingPairHasWorldLane = typeof WorldLane extends typeof LocalLane ? true : false;
const missingPairHasWorldLane: MissingPairHasWorldLane = false;
void missingPairHasWorldLane;

// @ts-expect-error unsafe casts cannot turn a local shape into a world writer.
const unsafeWorldWriter: never = localAuthor as unknown as { value: number };
void unsafeWorldWriter;

declare const sceneError: SceneError;
const stableCode: SceneErrorCode = sceneError.code;
const stableExpected: string = sceneError.expected;
const stableHint: string = sceneError.hint;
const stableDetail = sceneError.detail;
void stableCode;
void stableExpected;
void stableHint;
void stableDetail;
