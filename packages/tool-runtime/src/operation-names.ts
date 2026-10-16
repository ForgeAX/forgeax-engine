/** Transport spellings of one public domain operation ID. */
export function operationCommandPath(id: string): readonly string[] {
  if (!/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/.test(id))
    throw new TypeError(`invalid public operation ID: ${id}`);
  return id.split('.');
}

export function operationMcpName(id: string): string {
  return `forgeax_${operationCommandPath(id).join('_').replaceAll('-', '_')}`;
}
