import type { App } from '@modelcontextprotocol/ext-apps';
type ToolResult = Awaited<ReturnType<App['callServerTool']>>;
/** One 60 Hz event pump for every nested Host connection; missed ticks never accumulate. */
export function createHostPoll(call: (params: any) => Promise<any>, tool: string) {
  const waiting = new Map<string, { resolve(value: any): void; reject(error: unknown): void }[]>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let running = false;
  const schedule = (delay = 1000 / 60) => {
    if (closed || running || timer || waiting.size === 0) return;
    timer = setTimeout(pump, delay);
  };
  const pump = async () => {
    timer = undefined;
    running = true;
    const started = performance.now();
    const batch = new Map(waiting);
    waiting.clear();
    try {
      const result = await call({
        name: tool,
        arguments: { action: 'host-read', connectionIds: [...batch.keys()] },
      });
      if (result.isError) throw new Error(JSON.stringify(result.content));
      for (const { connectionId, response } of result.structuredContent.connections) {
        for (const request of batch.get(connectionId) ?? [])
          request.resolve({ ...result, structuredContent: response });
        batch.delete(connectionId);
      }
      if (batch.size) throw new Error('Host event batch omitted a connection');
    } catch (error) {
      for (const requests of batch.values()) for (const request of requests) request.reject(error);
    } finally {
      running = false;
      schedule(Math.max(0, 1000 / 60 - (performance.now() - started)));
    }
  };
  return {
    read(connectionId: string) {
      if (closed) return Promise.reject(new Error('MCP document retired'));
      return new Promise<ToolResult>((resolve, reject) => {
        const requests = waiting.get(connectionId) ?? [];
        requests.push({ resolve, reject });
        waiting.set(connectionId, requests);
        schedule();
      });
    },
    close() {
      closed = true;
      clearTimeout(timer);
      for (const requests of waiting.values())
        for (const request of requests) request.reject(new Error('MCP document retired'));
      waiting.clear();
    },
  };
}
