import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { win32 } from 'node:path';

// How to start the Claude Code CLI on this machine, without a shell (the system prompt is passed as an
// argument and must reach the CLI exactly as written).
//   macOS and Linux: "claude" from PATH.
//   Windows: the native installer gives claude.exe, which spawn() starts directly. An npm global install
//   gives a claude.cmd shim, which spawn() cannot start without a shell; the shim only runs Node on the
//   package's cli.js, so that file is run with the current Node binary instead.

export type ClaudeCommand = { command: string; prefixArgs: string[] };

// whereOutput: the lines `where claude` prints on Windows. exists/readText are injectable for the tests.
export function claudeCommandFrom(
  platform: NodeJS.Platform,
  whereOutput: string,
  exists: (p: string) => boolean = existsSync,
  readText: (p: string) => string = (p) => readFileSync(p, 'utf8'),
): ClaudeCommand {
  if (platform !== 'win32') return { command: 'claude', prefixArgs: [] };
  const found = whereOutput.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const exe = found.find((f) => /\.exe$/i.test(f));
  if (exe) return { command: exe, prefixArgs: [] };
  for (const shim of found.filter((f) => /\.cmd$/i.test(f))) {
    const pkgDir = win32.join(win32.dirname(shim), 'node_modules', '@anthropic-ai', 'claude-code');
    const pkgFile = win32.join(pkgDir, 'package.json');
    if (!exists(pkgFile)) continue;
    try {
      const pkg = JSON.parse(readText(pkgFile)) as { bin?: string | Record<string, string> };
      const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.claude;
      if (!rel) continue;
      const entry = win32.join(pkgDir, rel);
      if (/\.(c|m)?js$/i.test(entry) && exists(entry)) return { command: process.execPath, prefixArgs: [entry] };
      if (/\.exe$/i.test(entry) && exists(entry)) return { command: entry, prefixArgs: [] };
    } catch {
      // try the next shim
    }
  }
  // Nothing usable found: "claude" lets spawn() report ENOENT, which the agent turns into one clear message.
  return { command: 'claude', prefixArgs: [] };
}

let cached: ClaudeCommand | null = null;
export function claudeCommand(): ClaudeCommand {
  if (cached) return cached;
  let where = '';
  if (process.platform === 'win32') {
    const r = spawnSync('where', ['claude'], { encoding: 'utf8', windowsHide: true });
    where = r.status === 0 ? r.stdout : '';
  }
  cached = claudeCommandFrom(process.platform, where);
  return cached;
}
