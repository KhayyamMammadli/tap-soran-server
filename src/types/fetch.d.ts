// Node 18+ provides global `fetch`, but TypeScript doesn't know about it unless
// DOM libs are enabled. We declare a minimal signature here to keep server
// TypeScript build strict without pulling DOM types.

declare function fetch(
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: any;
  }
): Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<any>;
}>;
