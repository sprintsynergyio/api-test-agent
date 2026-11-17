import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { claudeCommandFrom } from './claude-bin';
import { redactHomeFolders } from './home-paths';
import { binEntry, nodeBin, REPO_ROOT, type NodeBin } from './node-bin';

// npm run test:platform: the parts that differ between macOS, Linux and Windows. Offline. CI runs it on
// all three, so the "really starts" checks below are proven on each OS.

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

const versionArgs: Record<NodeBin, string[]> = { tsx: ['--version'], tsc: ['--version'], playwright: ['--version'], mocha: ['--version'], allure: ['--version'] };
for (const bin of Object.keys(versionArgs) as NodeBin[]) {
  check(`nodeBin(${bin}) starts through the current Node, no node_modules/.bin shim`, () => {
    const [cmd, args] = nodeBin(bin, versionArgs[bin]);
    assert.equal(cmd, process.execPath);
    assert.ok(!args[0].includes(join('node_modules', '.bin')), args[0]);
    assert.equal(args[0], binEntry(bin));
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 60_000, windowsHide: true });
    assert.equal(r.error, undefined);
    assert.equal(r.status, 0, `${bin} --version exited ${r.status}: ${r.stderr}`);
    assert.match(r.stdout + r.stderr, /\d+\.\d+/);
  });
}

check('no agent or UI source spawns node_modules/.bin', () => {
  const files = ['agent/validate.ts', 'agent/frameworks/pactum.ts', 'agent/frameworks/playwright.ts', 'agent/eval/run.ts', 'ui/server.mjs', 'scripts/e2e-fake.mjs'];
  for (const f of files) {
    const text = readFileSync(join(REPO_ROOT, f), 'utf8');
    assert.ok(!/["']\.bin["']|node_modules\/\.bin/.test(text.replace(/\/\/.*$/gm, '')), `${f} still points at node_modules/.bin`);
  }
});

check('claude CLI: macOS and Linux use "claude" from PATH', () => {
  assert.deepEqual(claudeCommandFrom('darwin', ''), { command: 'claude', prefixArgs: [] });
  assert.deepEqual(claudeCommandFrom('linux', ''), { command: 'claude', prefixArgs: [] });
});
check('claude CLI on Windows: the native claude.exe is started directly', () => {
  const where = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\claude\r\nC:\\Users\\dev\\.local\\bin\\claude.exe\r\n';
  assert.deepEqual(claudeCommandFrom('win32', where, () => false), { command: 'C:\\Users\\dev\\.local\\bin\\claude.exe', prefixArgs: [] });
});
check('claude CLI on Windows: an npm claude.cmd shim runs the package cli.js with Node, no shell', () => {
  const shimDir = 'C:\\Users\\dev\\AppData\\Roaming\\npm';
  const pkgDir = win32.join(shimDir, 'node_modules', '@anthropic-ai', 'claude-code');
  const files: Record<string, string> = { [win32.join(pkgDir, 'package.json')]: JSON.stringify({ bin: { claude: 'cli.js' } }), [win32.join(pkgDir, 'cli.js')]: '' };
  const got = claudeCommandFrom('win32', `${shimDir}\\claude\r\n${shimDir}\\claude.cmd\r\n`, (p) => p in files, (p) => files[p]);
  assert.deepEqual(got, { command: process.execPath, prefixArgs: [win32.join(pkgDir, 'cli.js')] });
});
check('claude CLI on Windows: nothing usable found falls back to "claude" (ENOENT gives the clear message)', () => {
  assert.deepEqual(claudeCommandFrom('win32', '', () => false), { command: 'claude', prefixArgs: [] });
});

check('home folders are hidden in error text on all three OSes', () => {
  assert.equal(redactHomeFolders('at /Users/ana/proj/x.ts'), 'at ~/proj/x.ts');
  assert.equal(redactHomeFolders('at /private/Users/ana/x'), 'at ~/x');
  assert.equal(redactHomeFolders('at /home/runner/work/x'), 'at ~/work/x');
  assert.equal(redactHomeFolders('at C:\\Users\\Ana Dev\\proj\\x.ts'), 'at ~/proj\\x.ts');
  assert.equal(redactHomeFolders('at C:\\Users\\ana\\proj\\x.ts'), 'at ~/proj\\x.ts');
  assert.equal(redactHomeFolders('at d:/users/ana/proj'), 'at ~/proj');
});

check('.gitattributes keeps LF line endings (exports match source text with \\n)', () => {
  assert.match(readFileSync(join(REPO_ROOT, '.gitattributes'), 'utf8'), /^\* text=auto eol=lf$/m);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
