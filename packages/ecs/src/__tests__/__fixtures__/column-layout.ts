import {
  componentDefinition,
  defineComponent,
  type FieldPlan,
  type ScalarFieldType,
} from '../../component';

/** Exercise physical columns with the same compiled layouts used by World. */
export function columnLayout(storage: ScalarFieldType, arity = 1): FieldPlan {
  const type = arity === 1 ? storage : (`array<${storage}, ${arity}>` as const);
  const component = defineComponent('ColumnLayoutFixture', { value: type });
  const layout = componentDefinition(component).plan.fields.value;
  if (layout === undefined) throw new Error('Column fixture field is missing');
  return layout;
}
