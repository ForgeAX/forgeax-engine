/** Authored module paths include the Engine's dotted VFX identifiers. */
export const SHADER_MODULE_PATH = '[A-Za-z0-9_.-]+(?:::[A-Za-z0-9_.-]+)*';

const HEADER = new RegExp(`^\\s*#define_import_path\\s+(${SHADER_MODULE_PATH})\\s*$`, 'm');

export function shaderModuleId(source: string): string | undefined {
  return HEADER.exec(source)?.[1];
}
