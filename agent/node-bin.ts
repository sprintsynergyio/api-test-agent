import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Runs a dev dependency's command line through the current Node binary instead of node_modules/.bin.
// On Windows node_modules/.bin holds .cmd shims that spawn() cannot start without a shell; running the
// package's own JS entry with process.execPath works the same on macOS, Linux and Windows, needs no
// shell, and keeps arguments (globs, paths with spaces) exactly as given.

// The repo root: this file is agent/node-bin.ts.
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export type NodeBin = 'tsx' | 'tsc' | 'playwright' | 'mocha' | 'allure';
const PACKAGE_OF: Record<NodeBin, string> = { tsx: 'tsx', tsc: 'typescript', playwright: '@playwright/test', mocha: 'mocha', allure: 'allure' };

// The absolute path of the JS file behind `bin`, read from the package's package.json "bin" field.
export function binEntry(bin: NodeBin, root = REPO_ROOT): string {
  const pkgDir = join(root, 'node_modules', ...PACKAGE_OF[bin].split('/'));
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { bin?: string | Record<string, string> };
  const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[bin];
  if (!rel) throw new Error(`${PACKAGE_OF[bin]} has no "${bin}" command in its package.json`);
  return join(pkgDir, rel);
}

// [command, args] for spawn/spawnSync: process.execPath, the entry file, then the arguments.
export function nodeBin(bin: NodeBin, args: string[], root = REPO_ROOT): [string, string[]] {
  return [process.execPath, [binEntry(bin, root), ...args]];
}
