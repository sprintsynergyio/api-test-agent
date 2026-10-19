import { buildInput, type Credential, type ImportResult, type RawBody, type RawRequest, type Skipped } from './core';

// One or more curl commands pasted together (bash syntax): line continuations, quotes, $'...',
// comments, ; && || | between commands. Each curl command becomes an endpoint or a skipped item.

type Word = { text: string; vars: string[]; line: number };
type Command = { words: Word[]; line: number };

// $NAME or ${NAME}: expanded by the shell when unquoted or inside double quotes.
function readVar(src: string, i: number): { name: string; raw: string } | null {
  const m = src.slice(i).match(/^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/);
  return m ? { name: `$${m[1] ?? m[2]}`, raw: m[0] } : null;
}

const ANSI_ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', a: '\x07', b: '\b', e: '\x1b', f: '\f', v: '\v', '?': '?' };

function ansiEscape(src: string, i: number): { ch: string; len: number } {
  const next = src[i + 1] ?? '';
  if (next in ANSI_ESCAPES) return { ch: ANSI_ESCAPES[next], len: 2 };
  const hex = next === 'x' ? src.slice(i + 2).match(/^[0-9a-fA-F]{1,2}/) : next === 'u' ? src.slice(i + 2).match(/^[0-9a-fA-F]{1,4}/) : null;
  if (hex) return { ch: String.fromCharCode(parseInt(hex[0], 16)), len: 2 + hex[0].length };
  return { ch: `\\${next}`, len: 2 };
}

function splitCommands(text: string): Command[] {
  const src = text.replace(/\r\n?/g, '\n');
  const commands: Command[] = [];
  const state = { words: [] as Word[], word: null as Word | null, line: 1 };
  const word = (): Word => (state.word ??= { text: '', vars: [], line: state.line });
  const endWord = () => {
    if (state.word) state.words.push(state.word);
    state.word = null;
  };
  const endCommand = () => {
    endWord();
    if (state.words.length) commands.push({ words: state.words, line: state.words[0].line });
    state.words = [];
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\' && src[i + 1] === '\n') {
      state.line++;
      i += 2;
    } else if (c === '\n') {
      endCommand();
      state.line++;
      i++;
    } else if (c === ' ' || c === '\t') {
      endWord();
      i++;
    } else if (c === '#' && !state.word) {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === ';' || c === '|' || c === '&') {
      endCommand();
      i += src[i + 1] === c && c !== ';' ? 2 : 1;
    } else if (c === "'") {
      const w = word();
      for (i++; i < src.length && src[i] !== "'"; i++) {
        if (src[i] === '\n') state.line++;
        w.text += src[i];
      }
      i++;
    } else if (c === '$' && src[i + 1] === "'") {
      const w = word();
      for (i += 2; i < src.length && src[i] !== "'"; ) {
        if (src[i] === '\\') {
          const e = ansiEscape(src, i);
          w.text += e.ch;
          i += e.len;
        } else {
          if (src[i] === '\n') state.line++;
          w.text += src[i++];
        }
      }
      i++;
    } else if (c === '"') {
      const w = word();
      for (i++; i < src.length && src[i] !== '"'; ) {
        const v = src[i] === '$' ? readVar(src, i) : null;
        if (src[i] === '\\' && src[i + 1] === '\n') {
          state.line++;
          i += 2;
        } else if (src[i] === '\\' && '"\\$`'.includes(src[i + 1] ?? '')) {
          w.text += src[i + 1];
          i += 2;
        } else if (v) {
          w.vars.push(v.name);
          w.text += v.raw;
          i += v.raw.length;
        } else {
          if (src[i] === '\n') state.line++;
          w.text += src[i++];
        }
      }
      i++;
    } else if (c === '\\') {
      word().text += src[i + 1] ?? '';
      i += 2;
    } else {
      const v = c === '$' ? readVar(src, i) : null;
      const w = word();
      if (v) {
        w.vars.push(v.name);
        w.text += v.raw;
        i += v.raw.length;
      } else {
        w.text += c;
        i++;
      }
    }
  }
  endCommand();
  return commands;
}

const SHORT: Record<string, string> = {
  X: 'request', H: 'header', d: 'data', u: 'user', b: 'cookie', A: 'user-agent', e: 'referer', F: 'form', G: 'get',
  I: 'head', o: 'output', m: 'max-time', x: 'proxy', U: 'proxy-user', w: 'write-out', E: 'cert', K: 'config', r: 'range',
  T: 'upload-file', s: 'silent', S: 'show-error', k: 'insecure', L: 'location', v: 'verbose', i: 'include', f: 'fail',
  g: 'globoff', N: 'no-buffer', '#': 'progress-bar', '0': 'http1.0', '4': 'ipv4', '6': 'ipv6', z: 'time-cond',
  C: 'continue-at', c: 'cookie-jar', D: 'dump-header', t: 'telnet-option', Y: 'speed-limit', y: 'speed-time',
  P: 'ftp-port', Q: 'quote', j: 'junk-session-cookies', l: 'list-only', n: 'netrc', O: 'remote-name', p: 'proxytunnel',
  q: 'disable', R: 'remote-time', Z: 'parallel', '1': 'tlsv1', '2': 'sslv2', '3': 'sslv3',
};

// Options that take an argument. The rest of the known ones are flags.
const WITH_ARG = new Set([
  'request', 'header', 'data', 'data-raw', 'data-binary', 'data-ascii', 'data-urlencode', 'json', 'user', 'cookie',
  'user-agent', 'referer', 'form', 'form-string', 'output', 'max-time', 'connect-timeout', 'proxy', 'proxy-user',
  'write-out', 'cert', 'key', 'cacert', 'capath', 'config', 'range', 'upload-file', 'url', 'url-query',
  'oauth2-bearer', 'aws-sigv4', 'resolve', 'retry', 'retry-delay', 'retry-max-time', 'limit-rate', 'cookie-jar',
  'dump-header', 'interface', 'pass', 'max-redirs', 'proxy-header', 'connect-to', 'unix-socket', 'cert-type',
  'key-type', 'ciphers', 'tls-max', 'noproxy', 'time-cond', 'continue-at', 'telnet-option', 'speed-limit',
  'speed-time', 'ftp-port', 'quote', 'expect100-timeout', 'keepalive-time', 'variable', 'trace', 'trace-ascii',
  'socks5', 'socks5-hostname', 'dns-servers', 'doh-url', 'proto', 'proto-redir', 'netrc-file', 'login-options',
]);

const FLAGS = new Set([
  'get', 'head', 'silent', 'show-error', 'insecure', 'location', 'location-trusted', 'compressed', 'verbose',
  'include', 'fail', 'fail-with-body', 'globoff', 'no-buffer', 'progress-bar', 'http1.0', 'http1.1', 'http2',
  'http2-prior-knowledge', 'http3', 'ipv4', 'ipv6', 'no-keepalive', 'path-as-is', 'raw', 'tr-encoding', 'ssl',
  'ssl-reqd', 'tlsv1', 'tlsv1.2', 'tlsv1.3', 'sslv2', 'sslv3', 'digest', 'basic', 'ntlm', 'negotiate', 'anyauth',
  'remote-name', 'remote-name-all', 'remote-time', 'create-dirs', 'disable', 'list-only', 'junk-session-cookies',
  'no-progress-meter', 'styled-output', 'netrc', 'netrc-optional', 'proxytunnel', 'parallel', 'tcp-nodelay',
  'no-sessionid', 'no-alpn', 'no-npn', 'post301', 'post302', 'post303',
]);

type Data = { text: string; kind: 'data' | 'urlencode' | 'json'; vars: string[] };

function urlencodeData(text: string): string {
  const eq = text.indexOf('=');
  return eq >= 0 ? `${text.slice(0, eq)}=${encodeURIComponent(text.slice(eq + 1))}` : encodeURIComponent(text);
}

function parseCommand(cmd: Command, n: number, ignored: Set<string>, warnings: string[]): RawRequest[] | Skipped {
  const words = cmd.words.slice(1);
  const item = `curl #${n} (line ${cmd.line})`;
  let method: string | undefined;
  let head = false;
  let get = false;
  let form = false;
  let fileBody: string | undefined;
  const headers: { name: string; value: string }[] = [];
  const credentials: Credential[] = [];
  const data: Data[] = [];
  const urls: Word[] = [];
  const urlQuery: string[] = [];

  const apply = (name: string, arg: Word | undefined) => {
    const text = arg?.text ?? '';
    switch (name) {
      case 'request': method = text; break;
      case 'header': {
        const i = text.indexOf(':');
        if (i > 0) headers.push({ name: text.slice(0, i).trim(), value: text.slice(i + 1).trim() });
        break;
      }
      case 'data': case 'data-ascii': case 'data-binary': case 'data-raw': case 'data-urlencode': case 'json':
        if (name !== 'data-raw' && text.startsWith('@')) fileBody = text;
        else data.push({ text, kind: name === 'json' ? 'json' : name === 'data-urlencode' ? 'urlencode' : 'data', vars: arg?.vars ?? [] });
        break;
      case 'form': case 'form-string': form = true; break;
      case 'user': credentials.push({ name: 'Authorization', where: 'header', value: text }); break;
      case 'cookie': credentials.push({ name: 'Cookie', where: 'header', value: text }); break;
      case 'oauth2-bearer': credentials.push({ name: 'Authorization', where: 'header', value: text }); break;
      case 'aws-sigv4': credentials.push({ name: 'Authorization', where: 'header' }); break;
      case 'get': get = true; break;
      case 'head': head = true; break;
      case 'url': if (arg) urls.push(arg); break;
      case 'url-query': urlQuery.push(text); break;
      default: if (!WITH_ARG.has(name) && !FLAGS.has(name)) ignored.add(`--${name}`);
    }
  };

  let endOfOptions = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const t = w.text;
    if (endOfOptions || !t.startsWith('-') || t === '-') urls.push(w);
    else if (t === '--') endOfOptions = true;
    else if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      const name = eq > 0 ? t.slice(2, eq) : t.slice(2);
      if (WITH_ARG.has(name)) apply(name, eq > 0 ? { ...w, text: t.slice(eq + 1) } : words[++i]);
      else apply(name, undefined);
    } else {
      // A cluster of short options: -sSL, -XPOST, -sXDELETE
      for (let j = 1; j < t.length; j++) {
        const name = SHORT[t[j]];
        if (!name) {
          ignored.add(`-${t[j]}`);
          continue;
        }
        if (WITH_ARG.has(name)) {
          const rest = t.slice(j + 1);
          apply(name, rest ? { ...w, text: rest } : words[++i]);
          break;
        }
        apply(name, undefined);
      }
    }
  }

  if (!urls.length) return { item, reason: 'no URL in the command' };
  const jsonUsed = data.some((d) => d.kind === 'json');
  if (jsonUsed) {
    for (const [name, value] of [['Content-Type', 'application/json'], ['Accept', 'application/json']]) {
      if (!headers.some((h) => h.name.toLowerCase() === name.toLowerCase())) headers.push({ name, value });
    }
  }
  const dataVars = [...new Set(data.flatMap((d) => d.vars))];
  if (dataVars.length) warnings.push(`${item}: the body uses shell variables (${dataVars.join(', ')}) that have no value here; replace them in the sample body.`);

  return urls.map((u, k) => {
    let url = u.text;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !url.startsWith('/') && !url.startsWith('{{') && !url.startsWith('$')) url = `http://${url}`;
    let body: RawBody | undefined;
    const query = [...urlQuery];
    if (get) query.push(...data.map((d) => (d.kind === 'urlencode' ? urlencodeData(d.text) : d.text)));
    else if (fileBody) body = { unsupported: `body read from the file ${fileBody}` };
    else if (form) body = { unsupported: 'multipart form, -F' };
    else if (data.some((d) => d.kind === 'urlencode')) body = { unsupported: 'form-urlencoded, --data-urlencode' };
    else if (data.length) {
      const text = jsonUsed ? data.map((d) => d.text).join('') : data.map((d) => d.text).join('&');
      const headerType = headers.find((h) => h.name.toLowerCase() === 'content-type')?.value;
      body = { text, contentType: headerType ?? (jsonUsed ? 'application/json' : 'application/x-www-form-urlencoded') };
    }
    if (query.length) url += `${url.includes('?') ? '&' : '?'}${query.join('&')}`;
    const m = method ?? (head ? 'HEAD' : get ? 'GET' : data.length || form || fileBody ? 'POST' : 'GET');
    return {
      item: urls.length > 1 ? `${item}, URL ${k + 1}` : item,
      method: m,
      url,
      headers,
      body,
      credentials: [...credentials],
      unresolved: u.vars[0],
    };
  });
}

export function importCurl(content: string): ImportResult {
  const requests: RawRequest[] = [];
  const skipped: Skipped[] = [];
  const warnings: string[] = [];
  const ignored = new Set<string>();
  let n = 0;
  for (const cmd of splitCommands(content)) {
    // A pasted shell prompt ($ curl ...) or sudo in front is fine.
    while (cmd.words.length && (cmd.words[0].text === '$' || cmd.words[0].text === 'sudo')) cmd.words.shift();
    if (!cmd.words.length) continue;
    if (!/(^|\/)curl(\.exe)?$/i.test(cmd.words[0].text)) {
      skipped.push({ item: `line ${cmd.line}`, reason: 'not a curl command' });
      continue;
    }
    const parsed = parseCommand(cmd, ++n, ignored, warnings);
    if (Array.isArray(parsed)) requests.push(...parsed);
    else skipped.push(parsed);
  }
  if (ignored.size) warnings.push(`curl options ignored: ${[...ignored].join(', ')}.`);
  return buildInput(requests, { skipped, warnings, noEndpointsMessage: n ? 'No endpoints imported' : 'No curl commands found' });
}
