/** Source fragments emitted into generated DevKit host entries for optional viewport debug views. */
export function viewportDebugViewSourceFragments(devMode: boolean, viewportDebugView: boolean) {
  if (!devMode && !viewportDebugView) {
    return { setup: '', appOption: '', globalSetup: '', previewOption: '' };
  }
  return {
    setup: `const viewportDebugViewRequested = !workerExecution && (${viewportDebugView ? 'true' : "workspaceTarget || query.get('forgeax-debug-view') === '1'"});
    const createViewportOutput = viewportDebugViewRequested
      ? (await import('@forgeax/engine/render/debug-view')).createViewportOutputExtension
      : undefined;
    const viewportOutput = createViewportOutput?.();`,
    appOption: "...(typeof viewportOutput === 'undefined' ? {} : { viewportOutput }),",
    globalSetup: `if (!workerExecution && viewportOutput !== undefined) {
      const vpControl = {
        get: () => app.renderer.getViewportOutput(),
        set: (mode) => app.renderer.setViewportOutput(mode),
      };
      globalThis.__forgeaxViewportOutput = vpControl;
      ctx.effect(() => () => {
        if (globalThis.__forgeaxViewportOutput === vpControl) delete globalThis.__forgeaxViewportOutput;
      }, 'devkit/viewport-output-debug');
    }`,
    previewOption:
      "...(typeof createViewportOutput === 'undefined' ? {} : { viewportOutput: createViewportOutput() }),",
  };
}
