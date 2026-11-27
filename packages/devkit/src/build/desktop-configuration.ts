import {
  EngineConfigurationError,
  type EngineStartupPlan,
  type HostDeviceFacts,
  resolveEngineStartup,
} from '@forgeax/engine-app/configuration';
import { err, ok } from '@forgeax/engine-types';

export function desktopDeviceFacts(platform: string): HostDeviceFacts {
  const platforms = { win32: 'windows', darwin: 'macos', linux: 'linux' } as const;
  return {
    platform: platforms[platform as keyof typeof platforms] ?? 'unknown',
    runtime: 'native',
  };
}

/** These domains require services that the native game host does not construct. */
export function validateDesktopStartup(plan: EngineStartupPlan) {
  const { execution, rendering } = plan.settings;
  const backend = rendering?.renderBackend;
  const path =
    execution?.taskWorkers !== undefined
      ? 'execution.taskWorkers'
      : Object.values(execution?.workers ?? {}).includes(true)
        ? 'execution.workers'
        : backend !== undefined && backend !== 'auto' && backend !== 'webgpu'
          ? 'rendering.renderBackend'
          : undefined;
  if (path === undefined) return ok(plan);
  return err(
    new EngineConfigurationError('configuration-domain-unavailable', {
      path,
      reason: `The native desktop Host does not construct this service or backend for ${plan.facts.platform}. Select compatible settings in the target device profile.`,
    }),
  );
}

export function preflightDesktopStartup(definition: unknown, platform: string) {
  const plan = resolveEngineStartup(definition, desktopDeviceFacts(platform));
  return plan.ok ? validateDesktopStartup(plan.value) : plan;
}
