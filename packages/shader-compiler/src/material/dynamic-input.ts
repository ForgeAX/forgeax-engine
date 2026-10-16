import type { MaterialDynamicInputLayout } from '@forgeax/engine-types';

/** Stable module identity for a generated read-only Surface input page. */
export function materialDynamicInputModuleId(layout: MaterialDynamicInputLayout): string {
  return `forgeax_material::dynamic_input::${layout.name}`;
}

/**
 * Generate the shared storage record and accessor for a declared page.
 *
 * The resource remains renderer-owned and read-only. Surface code receives a
 * record value through the generated function; it never receives a buffer
 * handle or an instance address field owned by skinning.
 */
export function generateMaterialDynamicInputAccessor(layout: MaterialDynamicInputLayout): string {
  const recordName = `SurfaceDynamicInput_${layout.name}`;
  const pageName = `surfaceDynamicInput_${layout.name}`;
  const rawRecordName = `${recordName}_Raw`;
  const accessorName = `read_${layout.name}`;
  const wordCount = layout.stride / 4;
  const fields = layout.fields.map((field) => `  ${field.name} : ${field.type},`).join('\n');
  const values = layout.fields
    .map((field) => {
      const word = field.offset / 4;
      const read = (component: number) => `raw.words[${word + component}]`;
      switch (field.type) {
        case 'f32':
          return `bitcast<f32>(${read(0)})`;
        case 'u32':
          return read(0);
        case 'vec2<f32>':
          return `vec2<f32>(bitcast<f32>(${read(0)}), bitcast<f32>(${read(1)}))`;
        case 'vec3<f32>':
          return `vec3<f32>(bitcast<f32>(${read(0)}), bitcast<f32>(${read(1)}), bitcast<f32>(${read(2)}))`;
        case 'vec4<f32>':
          return `vec4<f32>(bitcast<f32>(${read(0)}), bitcast<f32>(${read(1)}), bitcast<f32>(${read(2)}), bitcast<f32>(${read(3)}))`;
        default: {
          const unreachable: never = field.type;
          return unreachable;
        }
      }
    })
    .join(',\n    ');
  return `// The raw word record makes the CPU-derived stride explicit. A WGSL
// struct containing only scalar fields has an implementation-dependent array
// stride on some translators, so every record is exactly ${layout.stride} bytes.
struct ${rawRecordName} {
  words : array<u32, ${wordCount}>,
};
struct ${recordName} {
${fields}
};

@group(3) @binding(3) var<storage, read> ${pageName} : array<${rawRecordName}>;

fn ${accessorName}(recordIndex : u32) -> ${recordName} {
  let raw = ${pageName}[recordIndex];
  return ${recordName}(
    ${values},
  );
}
`;
}
