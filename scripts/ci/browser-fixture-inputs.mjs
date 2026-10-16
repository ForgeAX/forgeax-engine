import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function browserFixtureInputs(root, inputs, sourcePaths = []) {
  const workspace = resolve(root);
  const owner = (source) => {
    if (/[*?[\]{}!]/.test(source)) return undefined;
    let directory = resolve(workspace, source);
    if (!existsSync(directory)) return undefined;
    while (directory !== workspace && directory !== dirname(directory)) {
      if (existsSync(resolve(directory, 'package.json'))) return directory;
      directory = dirname(directory);
    }
    return undefined;
  };
  const owners = new Set(sourcePaths.map(owner));
  // Broad discovery or an unknown source boundary keeps the full publication.
  if (owners.size === 0 || owners.has(undefined)) return inputs;
  // Each explicit Browser group prepares only its workspace's authored inputs.
  // Shared source roots (for example Preview's Capability Lab assets) join the
  // same owner set; they do not need another material inventory.
  return inputs.filter((file) => {
    const inputOwner = owner(file);
    return inputOwner === undefined || owners.has(inputOwner);
  });
}
