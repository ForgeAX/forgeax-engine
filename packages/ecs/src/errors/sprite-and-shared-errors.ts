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
 * `.hint` distinguishes non-asset `world.allocSharedRef` values from
 * `asset<kind>` fields bound directly to `assets.load` or `assets.create` handles.
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
      `Allocate non-asset resources with world.allocSharedRef(target, value). ` +
      `Managed assets use asset<kind> fields and assets.load(guid, kind) or assets.create(value).`;
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
