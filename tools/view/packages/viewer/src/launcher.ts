/** View-specific hosting capability, borrowed by the retained Shell. */
export type ViewLauncher = {
  start(project?: string): Promise<void>;
};

export function createServiceViewLauncher(fetcher: typeof fetch): ViewLauncher {
  return {
    async start(project) {
      const response = await fetcher('/__forgeax/view/launch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(project?.trim() ? { project: project.trim() } : {}),
      });
      const result = await response.json();
      if (!response.ok || result.ok !== true) {
        throw new Error([result.error?.code, result.error?.hint ?? 'View backend startup failed'].filter(Boolean).join(': '));
      }
    },
  };
}
