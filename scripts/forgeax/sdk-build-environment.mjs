import { runnerResources, shaderProducerHeapSize } from '../lib/runner-resources.mjs';

/** Keep the SDK's cold declaration and profile children inside one runner budget. */
export function sdkBuildEnvironment(environment = process.env, resources = runnerResources()) {
  return {
    ...environment,
    NODE_OPTIONS: [
      environment.NODE_OPTIONS,
      `--max-old-space-size=${shaderProducerHeapSize(resources)}`,
    ]
      .filter(Boolean)
      .join(' '),
    FORGEAX_SHADER_COMPILE_WORKERS: '1',
  };
}
