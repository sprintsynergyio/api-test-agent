import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { EXIT_ERROR, EXIT_FINDINGS, EXIT_OK, runExitCode } from './exit-codes';
import { parseAgentFlags } from './flags';
import { crc32, zipFolder } from './zip';

// npm run test:exit: exit codes, --fail-on, and the in-process zip writer. Offline.

let failed = 0;
let passed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`ok    ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}\n      ${String((err as Error)?.message ?? err).split('\n').join('\n      ')}`);
  }
}

const base = { status: 'completed', findings: 0, untestedEndpoints: 0, exportFailed: false, failOn: 'finding' as const };
check('exit 0: completed, no findings', () => assert.equal(runExitCode(base), EXIT_OK));
check('exit 1: findings with --fail-on finding', () => assert.equal(runExitCode({ ...base, findings: 2 }), EXIT_FINDINGS));
check('exit 0: findings with --fail-on none', () => assert.equal(runExitCode({ ...base, findings: 2, failOn: 'none' }), EXIT_OK));
check('exit 2: refused, no-tests and stopped-budget', () => {
  for (const status of ['refused', 'no-tests', 'stopped-budget']) assert.equal(runExitCode({ ...base, status }), EXIT_ERROR, status);
});
check('exit 2: an endpoint could not be tested, even with findings or --fail-on none', () => {
  assert.equal(runExitCode({ ...base, untestedEndpoints: 1, findings: 3 }), EXIT_ERROR);
  assert.equal(runExitCode({ ...base, untestedEndpoints: 1, failOn: 'none' }), EXIT_ERROR);
});
check('exit 2: the framework export failed', () => assert.equal(runExitCode({ ...base, exportFailed: true }), EXIT_ERROR));

check('--fail-on: default finding, accepts none and finding, = form too, rejects anything else', () => {
  assert.equal(parseAgentFlags(['in.json']).failOn, 'finding');
  assert.equal(parseAgentFlags(['in.json', '--fail-on', 'none']).failOn, 'none');
  assert.equal(parseAgentFlags(['in.json', '--fail-on=finding']).failOn, 'finding');
  assert.throws(() => parseAgentFlags(['in.json', '--fail-on', 'error']), /--fail-on must be one of none, finding/);
});

// A minimal zip reader for the round trip: central directory, then each local entry.
function readZip(file: string): Map<string, Buffer> {
  const buf = readFileSync(file);
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, 'central header signature');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const lNameLen = buf.readUInt16LE(local + 26);
    const lExtra = buf.readUInt16LE(local + 28);
    const data = buf.subarray(local + 30 + lNameLen + lExtra, local + 30 + lNameLen + lExtra + size);
    const raw = method === 8 ? inflateRawSync(data) : Buffer.from(data);
    assert.equal(crc32(raw), crc, `crc of ${name}`);
    out.set(name, raw);
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return out;
}

check('crc32 matches the standard check value', () => assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926));
check('zipFolder writes every file and folder under the root name with "/" separators', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ata-zip-'));
  try {
    const dir = join(tmp, 'my-api');
    mkdirSync(join(dir, 'tests', 'fixtures'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{"name":"x"}\n');
    writeFileSync(join(dir, 'tests', 'fixtures', 'ctx.ts'), 'export const a = 1;\r\n'.repeat(200));
    writeFileSync(join(dir, '.env.example'), 'A=\n');
    const zip = join(tmp, 'out.zip');
    zipFolder(dir, 'my-api', zip);
    const entries = readZip(zip);
    assert.deepEqual([...entries.keys()].sort(), ['my-api/', 'my-api/.env.example', 'my-api/package.json', 'my-api/tests/', 'my-api/tests/fixtures/', 'my-api/tests/fixtures/ctx.ts']);
    assert.equal(entries.get('my-api/tests/fixtures/ctx.ts')!.toString('utf8'), 'export const a = 1;\r\n'.repeat(200), 'bytes kept exactly');
    // Cross-check with a real unzip tool when the machine has one (python3 zipfile, or tar on Windows).
    let tool = '';
    try {
      tool = execFileSync(process.platform === 'win32' ? 'tar' : 'python3', process.platform === 'win32' ? ['-tf', zip] : ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print("\\n".join(z.namelist()))', zip], { encoding: 'utf8' });
    } catch {
      tool = '';
    }
    if (tool) assert.match(tool, /my-api\/tests\/fixtures\/ctx\.ts/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
