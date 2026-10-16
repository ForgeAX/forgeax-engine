/** The response operations consumed by Catalog, Pack and binary asset readers. */
export interface PackageResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly bodyUsed?: boolean;
  readonly body?: { cancel(): Promise<void> } | null;
  arrayBuffer(): Promise<ArrayBuffer>;
  json(): Promise<unknown>;
  text(): Promise<string>;
  readonly headers: { get(name: string): string | null };
}

/** Resource options shared by DOM and native hosts. */
export interface PackageRequest {
  readonly method?: string;
  readonly signal?: AbortSignal | null;
  readonly cache?: 'default' | 'reload' | 'no-store';
}

/** Browser fetch satisfies this contract; native hosts need no DOM Request/Response objects. */
export type PackageFetcher = (url: string, init?: PackageRequest) => Promise<PackageResponse>;
