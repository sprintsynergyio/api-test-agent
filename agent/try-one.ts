import { loadConfig } from './config';
import { claudeBudget, claudeCallsUsed } from './claude';
import { frameworkFor } from './frameworks';
import { generateEndpoint } from './generate';
import { planEndpoint } from './plan';
import { readProbe } from './probe';

// Usage: tsx agent/try-one.ts <inputFile> <endpointId>
// Plans and generates one endpoint from its existing probe file (run npm run probe first).
async function main() {
  const [inputFile, endpointId] = process.argv.slice(2);
  if (!inputFile || !endpointId) throw new Error('usage: tsx agent/try-one.ts <inputFile> <endpointId>');
  const config = loadConfig(inputFile);
  const endpoint = config.endpoints.find((e) => e.id === endpointId);
  if (!endpoint) throw new Error(`unknown endpoint "${endpointId}" in ${inputFile}`);
  const probe = readProbe(endpointId);

  console.log('=== PLANNING ===');
  const planned = await planEndpoint(endpoint, probe);
  if (!planned.ok) {
    console.log(`${endpointId} FAILED ${planned.reason}`);
    process.exitCode = 1;
    return;
  }
  console.log(`${endpointId} OK ${planned.plan.cases.length} cases`);

  console.log('=== GENERATING ===');
  const generated = await generateEndpoint(frameworkFor(config), endpoint, planned.plan, probe);
  if (generated.ok) console.log(`${endpointId} OK written ${generated.specFile}`);
  else {
    console.log(`${endpointId} FAILED static gate: ${generated.reasons.join(' | ').replace(/\s*\n\s*/g, ' ')}`);
    process.exitCode = 1;
  }
  console.log(`claude calls used: ${claudeCallsUsed()}/${claudeBudget()}`);
}

main().catch((err) => {
  console.error(`try-one FAILED ${(err as Error).message}`);
  process.exit(1);
});
