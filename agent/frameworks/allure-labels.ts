import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Extra Allure labels per test title, added to the raw results before the report is built: a sheet case
// that passed without asserting every clause of its expected result is tagged "partially covered" (and
// "needs review" when the probe disagreed with the sheet), so the report never shows it as a plain pass.
export type ExtraLabels = Record<string, { name: string; value: string }[]>;

export function addAllureLabels(resultsDir: string, extra: ExtraLabels | undefined): number {
  if (!extra || !Object.keys(extra).length || !existsSync(resultsDir)) return 0;
  let changed = 0;
  for (const file of readdirSync(resultsDir).filter((f) => f.endsWith('-result.json'))) {
    const path = join(resultsDir, file);
    let result: { name?: string; labels?: { name: string; value: string }[] };
    try {
      result = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      continue;
    }
    const add = result.name ? extra[result.name] : undefined;
    if (!add?.length) continue;
    const labels = result.labels ?? [];
    for (const l of add) if (!labels.some((x) => x.name === l.name && x.value === l.value)) labels.push(l);
    result.labels = labels;
    writeFileSync(path, JSON.stringify(result));
    changed++;
  }
  return changed;
}
