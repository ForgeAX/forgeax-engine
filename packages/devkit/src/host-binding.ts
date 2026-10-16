import type { BackendHost } from '@forgeax/engine-host/backend';
import {
  createHostAssembly,
  type HostAssembly,
  HostAssemblyError,
  validateHostAssembly,
} from '@forgeax/engine-host/protocol';

/** A project server borrows transport and authority; it never disposes the owner. */
export interface DevKitHostBinding {
  readonly backend: BackendHost;
  /** Optional connection projection; does not mutate the borrowed Host's assembly. */
  readonly frontendAssembly?: HostAssembly | undefined;
  /** Trusted immutable module supplied by the frontend owner, separate from wire program identity. */
  readonly frontendModule?:
    | {
        readonly specifier: string;
        readonly export?: string;
        /** Native plugin export activated in the frontend Context before connecting the Host. */
        readonly prepare?: string;
      }
    | undefined;
  readonly workspace?: {
    /** Game projections borrow the backend without contributing to its default frontend. */
    readonly execution?: 'preview' | 'game';
    readonly sessionId: string;
    readonly targetId: string;
    readonly admissionToken: string;
  };
}
declare module '@forgeax/engine-plugin' {
  interface EngineContextServices {
    devkitHostBinding: DevKitHostBinding;
  }
}
export function hostBindingError(reason: string): never {
  throw new HostAssemblyError(
    'host-assembly-invalid',
    'one unambiguous project host binding',
    'bind one project session to the host',
    { reason },
  );
}
export function validateHostBinding(binding: DevKitHostBinding): void {
  if (binding.frontendAssembly) {
    const checked = validateHostAssembly(binding.frontendAssembly);
    if (!checked.ok) throw checked.error;
  }
  const externalRoot = (binding.frontendAssembly ?? binding.backend.assembly.current).root;
  if (binding.workspace?.execution !== 'game' && externalRoot && !binding.frontendModule)
    hostBindingError('an external frontend root requires an explicit immutable frontendModule');
  if (
    binding.frontendModule &&
    (!binding.frontendModule.specifier ||
      binding.frontendModule.export === '' ||
      binding.frontendModule.prepare === '')
  )
    hostBindingError('frontendModule requires nonempty specifier, export and prepare names');
  if (
    binding.workspace &&
    Object.values(binding.workspace).some((value) => typeof value !== 'string' || !value)
  ) {
    hostBindingError('workspace identity and admission token must be nonempty');
  }
  if (
    binding.frontendAssembly === undefined &&
    binding.workspace?.execution !== 'game' &&
    binding.backend.context.get('devkitHostBinding') !== undefined
  )
    hostBindingError('backend already serves a project');
}
export function composeBoundHostAssembly(
  binding: DevKitHostBinding,
  project: HostAssembly,
): HostAssembly {
  const current = binding.frontendAssembly ?? binding.backend.assembly.current;
  if (project.root && current.root)
    hostBindingError('compose roots through a native root plugin before binding');
  const root = project.root ?? current.root;
  return createHostAssembly({
    sessionGeneration: current.sessionGeneration + 1,
    ...(root ? { root } : {}),
    ...(current.config === undefined ? {} : { config: current.config }),
  });
}
