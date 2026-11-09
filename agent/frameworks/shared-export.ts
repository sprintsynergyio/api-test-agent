import { readFileSync } from 'node:fs';
import type { Config } from '../config';

// Pieces both exporters share.

// agent/model.ts has no imports, so it is copied as it is (src/model.ts).
export function modelSource(): string {
  const src = readFileSync('agent/model.ts', 'utf8');
  if (/^\s*import\s/m.test(src)) throw new Error('framework export: agent/model.ts must not import anything');
  return src;
}

// config/api.json for an exported framework: the validated config without the agent-only fields and
// never an auth value. With a profile, the resolved baseUrl and selection are left out so the one
// export serves every environment, brand and region (AGENT_SELECT picks one at run time).
// The safety flags are always written, so a team can see and change them.
export function exportedConfig(name: string, config: Config): Record<string, unknown> {
  const { name: _inputName, framework: _framework, allowProduction, allowWrites, selection: _selection, baseUrl, ...rest } = config;
  return {
    name,
    ...(config.profile ? {} : { baseUrl }),
    ...rest,
    allowProduction: allowProduction === true,
    allowWrites: allowWrites === true,
  };
}
