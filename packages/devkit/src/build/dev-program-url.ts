/** Strip only Vite transport cache hints; semantic module queries stay intact. */
export function normalizeDevProgramUrl(url: string): string {
  const split = url.indexOf('?');
  if (split < 0) return url;
  const query = url
    .slice(split + 1)
    .split('&')
    .filter((part) => !/^t=\d+$/.test(part) && part !== 'import' && part !== 'import=');
  return url.slice(0, split) + (query.length ? `?${query.join('&')}` : '');
}

export const devProgramSessionQuery = 'forgeax-program-session';

export function devProgramSession(url: string): string | null {
  if (!url.includes('?')) return null;
  return new URLSearchParams(url.slice(url.indexOf('?') + 1)).get(devProgramSessionQuery);
}

/** Session locators belong to this Host, never to the portable program graph. */
export function withDevProgramSession(url: string, session: string | null): string {
  const split = url.indexOf('?');
  const pathname = split < 0 ? url : url.slice(0, split);
  const query = (split < 0 ? [] : url.slice(split + 1).split('&')).filter(
    (part) => !new URLSearchParams(part).has(devProgramSessionQuery),
  );
  if (session !== null) query.push(`${devProgramSessionQuery}=${encodeURIComponent(session)}`);
  return pathname + (query.length ? `?${query.join('&')}` : '');
}
