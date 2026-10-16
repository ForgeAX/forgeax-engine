import { createViteConfig, readProjectFacts } from '@forgeax/engine/devkit';
import { defineConfig } from 'vite';

export default defineConfig(async ({ command }) => {
  const facts = await readProjectFacts(import.meta.dirname);
  if (!facts.ok) throw new Error(JSON.stringify(facts.error));
  return createViteConfig(facts.value, command);
});
