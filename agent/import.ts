import { readFileSync } from 'node:fs';
import { ImportError, type ImportResult } from './importers/core';
import { importCurl } from './importers/curl';
import { importHar } from './importers/har';
import { importOpenApi } from './importers/openapi';
import { importPostman } from './importers/postman';
import { importText } from './importers/text';

// Usage: npm run -s import <type> < source-file
// Reads the source from stdin and prints one JSON object on stdout: { input, skipped, warnings }.
// Errors go to stderr with exit code 1. Never prints the source or any credential found in it,
// and writes nothing to disk.

const IMPORTERS: Record<string, (content: string) => ImportResult | Promise<ImportResult>> = {
  postman: importPostman,
  openapi: importOpenApi,
  curl: importCurl,
  har: importHar,
  text: importText,
};

async function main() {
  const type = process.argv[2] ?? '';
  if (!IMPORTERS[type]) throw new ImportError(`usage: npm run -s import <type> < file, where type is one of: ${Object.keys(IMPORTERS).join(', ')}`);
  const content = readFileSync(0, 'utf8');
  if (!content.trim()) throw new ImportError('Nothing to import: stdin is empty.');
  // Anything an importer logs goes to stderr, so stdout stays one JSON object.
  console.log = (...args: unknown[]) => console.error(...args);
  const result = await IMPORTERS[type](content);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

main().catch((err) => {
  // ImportError messages are written to be safe to show. Anything else is a bug: show its first line only.
  const message = err instanceof ImportError ? err.message : `unexpected error: ${String((err as Error)?.message ?? err).split('\n')[0]}`;
  console.error(`import FAILED ${message}`);
  process.exit(1);
});
