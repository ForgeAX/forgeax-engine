#!/usr/bin/env node
import { existsSync, readdirSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function resolveLavapipeIcd(env = process.env, directory = '/usr/share/vulkan/icd.d') {
  const current = env.VK_DRIVER_FILES;
  const legacy = env.VK_ICD_FILENAMES;
  if (current && legacy && current !== legacy)
    throw new Error('graphics-configuration: conflicting VK_DRIVER_FILES and VK_ICD_FILENAMES');
  const explicit = current || legacy;
  if (explicit) {
    if (explicit.split(delimiter).some((path) => !path || !existsSync(path)))
      throw new Error('graphics-configuration: an explicit Vulkan ICD file is missing');
    return explicit;
  }
  const name = existsSync(directory)
    ? readdirSync(directory)
        .sort()
        .find((entry) => /^lvp_icd.*\.json$/.test(entry))
    : undefined;
  if (!name)
    throw new Error('graphics-unavailable: install Lavapipe or set both Vulkan ICD selectors');
  return join(directory, name);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(resolveLavapipeIcd());
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
