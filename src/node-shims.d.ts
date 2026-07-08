declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exitCode?: number;
  cwd(): string;
};

declare module "node:crypto" {
  export function randomUUID(): string;
}

declare module "node:fs/promises" {
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  export function readFile(path: string, options: "utf8"): Promise<string>;
  export function rm(path: string, options?: { force?: boolean }): Promise<void>;
  export function writeFile(path: string, data: string, options: "utf8"): Promise<void>;
}

declare module "node:path" {
  export function join(...segments: string[]): string;
}
