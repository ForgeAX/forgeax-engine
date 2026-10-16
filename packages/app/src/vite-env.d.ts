/**
 * Vite replaces this one import-meta key in browser hosts. The app package
 * also ships to Dawn/Node, where the property is simply absent at runtime.
 */
interface ImportMeta {
  readonly env?: {
    readonly DEV?: boolean;
    readonly FORGEAX_ENGINE_RHI_DEBUG?: string;
  };
}
