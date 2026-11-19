import assert from 'node:assert/strict';
import { adfToText, atlassianSettings, atlassianStatus, htmlToText, isLinkSource, loadLinkCases, parseHtmlTables, parseLink, redactSecrets, splitExpected, verifyAtlassian, AtlassianError, type FetchLike } from './atlassian';
import { TestCasesConfigSchema } from './config';
import { parseAgentFlags } from './flags';
import { testEnv } from './frameworks/test-env';
import { previewSheet, SheetError } from './test-cases';

// npm run test:atlassian: live test case links (agent/atlassian.ts) against mocked HTTP: Jira Cloud and
// Data Center search, Xray Cloud and Data Center steps, Zephyr Scale Cloud and Data Center, Confluence
// Cloud v2 and Data Center pages, rate limits, error messages, caps and the host guard. Offline.

let failed = 0;
let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`ok    ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}\n      ${String((err as Error)?.message ?? err).split('\n').join('\n      ')}`);
  }
}
async function rejects(p: Promise<unknown>, re: RegExp) {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof AtlassianError && err instanceof SheetError, `not an AtlassianError: ${String(err)}`);
    assert.match((err as Error).message, re);
    return true;
  });
}

const TOKEN = 'atl-test-token-SECRET-0123456789';
const CLOUD = { ATLASSIAN_BASE_URL: 'https://acme.atlassian.net', ATLASSIAN_EMAIL: 'qa@acme.test', ATLASSIAN_API_TOKEN: TOKEN };
const DC = { ATLASSIAN_BASE_URL: 'https://jira.acme.test/jira', ATLASSIAN_API_TOKEN: TOKEN, CONFLUENCE_BASE_URL: 'https://wiki.acme.test' };
const BASIC = `Basic ${Buffer.from(`qa@acme.test:${TOKEN}`).toString('base64')}`;

type Call = { url: string; method: string; auth: string | null; body: unknown; redirect: string | undefined };
type Reply = { status?: number; body?: unknown; text?: string; headers?: Record<string, string> };
// A fake fetch: routes by URL, records every call.
function fake(route: (u: URL, c: Call) => Reply | undefined) {
  const calls: Call[] = [];
  const fn: FetchLike = async (url, init) => {
    const h = (init.headers ?? {}) as Record<string, string>;
    const c: Call = { url, method: String(init.method ?? 'GET'), auth: h.Authorization ?? null, body: init.body ? JSON.parse(String(init.body)) : undefined, redirect: init.redirect };
    calls.push(c);
    const r = route(new URL(url), c) ?? { status: 404, body: { errorMessages: ['no route'] } };
    const text = r.text ?? JSON.stringify(r.body ?? null);
    return new Response(text, { status: r.status ?? 200, headers: { 'content-type': r.text ? 'text/html' : 'application/json', ...(r.headers ?? {}) } });
  };
  return { fn, calls };
}
const noSleep = async () => {};
const ENDPOINTS = [
  { id: 'list-products', method: 'GET', path: '/products' },
  { id: 'create-product', method: 'POST', path: '/products' },
  { id: 'get-product', method: 'GET', path: '/products/{id}' },
];
const adf = (...texts: string[]) => ({ type: 'doc', version: 1, content: texts.map((t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })) });

// ---------- Settings and links ----------

await check('settings: Cloud uses Basic email:token, Data Center a bearer PAT, Confluence under /wiki on Cloud', () => {
  const c = atlassianSettings(CLOUD);
  assert.equal(c.deployment, 'cloud');
  assert.equal(c.authHeader, BASIC);
  assert.equal(c.confluenceBase, 'https://acme.atlassian.net/wiki');
  const d = atlassianSettings(DC);
  assert.equal(d.deployment, 'datacenter');
  assert.equal(d.authHeader, `Bearer ${TOKEN}`);
  assert.equal(d.jiraBase, 'https://jira.acme.test/jira');
  assert.equal(d.confluenceBase, 'https://wiki.acme.test');
});

await check('settings: clear errors for missing values, http hosts and vendor hosts; status never holds a token', () => {
  assert.throws(() => atlassianSettings({}), /not set up: add ATLASSIAN_BASE_URL/);
  assert.throws(() => atlassianSettings({ ...CLOUD, ATLASSIAN_EMAIL: '' }), /ATLASSIAN_EMAIL is empty/);
  assert.throws(() => atlassianSettings({ ...CLOUD, ATLASSIAN_API_TOKEN: '' }), /id\.atlassian\.com/);
  assert.throws(() => atlassianSettings({ ...CLOUD, ATLASSIAN_BASE_URL: 'http://acme.atlassian.net' }), /must use https/);
  assert.throws(() => atlassianSettings({ ...CLOUD, ATLASSIAN_BASE_URL: 'https://me:pw@acme.atlassian.net' }), /must not contain a user name/);
  assert.throws(() => atlassianSettings({ ...CLOUD, XRAY_CLIENT_ID: 'a', XRAY_CLIENT_SECRET: 'b', XRAY_BASE_URL: 'https://evil.test' }), /XRAY_BASE_URL must be on xray\.cloud\.getxray\.app/);
  assert.equal(atlassianSettings({ ...CLOUD, ATLASSIAN_BASE_URL: 'http://127.0.0.1:4600' }).jiraBase, 'http://127.0.0.1:4600');
  const st = atlassianStatus({ ...CLOUD, ZEPHYR_API_TOKEN: 'zephyr-secret-123456' });
  assert.equal(st.configured, true);
  assert.equal(st.zephyr, true);
  assert.doesNotMatch(JSON.stringify(st), /SECRET|zephyr-secret/);
});

await check('isLinkSource: links, jql: and plain JQL yes; a pasted sheet no', () => {
  for (const t of ['https://acme.atlassian.net/browse/QA-1', 'jql: project = QA', 'project = QA AND issuetype = Test', 'zephyr: QA-T1', 'filter = 10001', 'key in (QA-1, QA-2)']) assert.ok(isLinkSource(t), t);
  for (const t of ['ID,Title,Steps\nTC-1,a,b', 'ID\tTitle', 'Title,Steps', '', 'just words']) assert.ok(!isLinkSource(t), t);
});

await check('parseLink: Jira issue, filter, search, board selectedIssue, JQL and Zephyr links', () => {
  const s = atlassianSettings(CLOUD);
  assert.deepEqual(parseLink('https://acme.atlassian.net/browse/qa-12', s), { kind: 'jira', jql: 'key = QA-12', label: 'Jira issue QA-12' });
  assert.equal((parseLink('https://acme.atlassian.net/issues/?filter=10001', s) as { jql: string }).jql, 'filter = 10001');
  assert.equal((parseLink('https://acme.atlassian.net/issues/?jql=project%20%3D%20QA%20AND%20labels%20%3D%20api', s) as { jql: string }).jql, 'project = QA AND labels = api');
  assert.equal((parseLink('https://acme.atlassian.net/jira/software/projects/QA/boards/1?selectedIssue=QA-7', s) as { jql: string }).jql, 'key = QA-7');
  assert.equal((parseLink('jql: project = QA', s) as { jql: string }).jql, 'project = QA');
  assert.equal((parseLink('issuetype = Test AND project = QA', s) as { jql: string }).jql, 'issuetype = Test AND project = QA');
  assert.deepEqual(parseLink('https://acme.atlassian.net/projects/QA?selectedItem=com.atlassian.plugins.atlassian-connect-plugin:com.kanoah.test-manager__main-project-page#!/v2/testCase/QA-T5', s), { kind: 'zephyr', keys: ['QA-T5'], projectKey: null, label: 'Zephyr Scale QA-T5' });
  assert.deepEqual(parseLink('zephyr: project = qa', s), { kind: 'zephyr', keys: [], projectKey: 'QA', label: 'Zephyr Scale project QA' });
  assert.throws(() => parseLink('https://acme.atlassian.net/jira/your-work', s), /names no issue, filter or search/);
  assert.throws(() => parseLink('https://acme.atlassian.net/issues/?filter=mine', s), /must be a number/);
});

await check('parseLink: Confluence page links (Cloud and Data Center), short links refused', () => {
  const c = atlassianSettings(CLOUD);
  assert.deepEqual(parseLink('https://acme.atlassian.net/wiki/spaces/QA/pages/98765/API+test+cases', c), { kind: 'confluence', pageId: '98765', space: null, title: null, label: 'Confluence page 98765' });
  assert.equal((parseLink('https://acme.atlassian.net/wiki/spaces/QA/pages/edit-v2/555', c) as { pageId: string }).pageId, '555');
  assert.throws(() => parseLink('https://acme.atlassian.net/wiki/x/AbCd', c), /short Confluence links/);
  const d = atlassianSettings(DC);
  assert.equal((parseLink('https://wiki.acme.test/pages/viewpage.action?pageId=321', d) as { pageId: string }).pageId, '321');
  assert.deepEqual(parseLink('https://wiki.acme.test/display/QA/API+test+cases', d), { kind: 'confluence', pageId: null, space: 'QA', title: 'API test cases', label: 'Confluence page "API test cases"' });
  assert.equal(parseLink('https://jira.acme.test/jira/browse/QA-3', d).kind, 'jira');
});

await check('host guard: a link on another site is refused before any request', async () => {
  const f = fake(() => ({ body: {} }));
  await rejects(loadLinkCases('https://evil.example.com/browse/QA-1', { env: CLOUD, fetch: f.fn }), /the link is on evil\.example\.com, but the Atlassian site in \.env is acme\.atlassian\.net/);
  await rejects(loadLinkCases('https://acme.atlassian.net.evil.test/browse/QA-1', { env: CLOUD, fetch: f.fn }), /only the configured site is called|is on acme\.atlassian\.net\.evil\.test/i);
  await rejects(loadLinkCases('https://jira.acme.test/other/browse/QA-1', { env: DC, fetch: f.fn }), /is on jira\.acme\.test/);
  assert.equal(f.calls.length, 0);
});

// ---------- Text ----------

await check('ADF to text: paragraphs, lists, headings, hard breaks, mentions, code and tables', () => {
  const doc = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Steps' }] },
      { type: 'orderedList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'POST /orders' }] }] }, { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'as ' }, { type: 'mention', attrs: { text: '@Ana' } }] }] }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'line one' }, { type: 'hardBreak' }, { type: 'text', text: 'line two' }] },
      { type: 'codeBlock', content: [{ type: 'text', text: '{"sku":"A1"}' }] },
      { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] }, { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'b' }] }] }] }] },
    ],
  };
  assert.equal(adfToText(doc), 'Steps\n1. POST /orders\n2. as @Ana\nline one\nline two\n{"sku":"A1"}\na | b');
});

await check('splitExpected: "Expected result:" lines, h3. headings and none', () => {
  assert.deepEqual(splitExpected('Send GET /products\nExpected result: 200 with a list'), { steps: 'Send GET /products', expected: '200 with a list' });
  assert.deepEqual(splitExpected('h3. Steps\nPOST /orders\nh3. Expected Results\n201 Created'), { steps: 'POST /orders', expected: '201 Created' });
  assert.deepEqual(splitExpected('**Expected:** 404'), { steps: '', expected: '404' });
  assert.deepEqual(splitExpected('Just steps here'), { steps: 'Just steps here', expected: '' });
});

await check('HTML tables: storage format, entities, CDATA, colspan, a nested table becomes cell text', () => {
  const html = '<p>x</p><table><tbody><tr><th><p><strong>ID</strong></p></th><th>Title</th><th>Expected Result</th></tr><tr><td>TC-1</td><td>Fish &amp; chips&nbsp;&lt;ok&gt;</td><td><ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[{"a":1} <b>]]></ac:plain-text-body></ac:structured-macro></td></tr><tr><td colspan="2">TC-2</td><td><table><tr><td>200</td><td>OK</td></tr></table></td></tr></tbody></table><table><tr><td>other</td></tr></table>';
  const t = parseHtmlTables(html);
  assert.equal(t.length, 2, 'two top-level tables');
  assert.deepEqual(t[0][0], ['ID', 'Title', 'Expected Result']);
  assert.deepEqual(t[0][1], ['TC-1', 'Fish & chips <ok>', '{"a":1} <b>']);
  assert.deepEqual(t[0][2], ['TC-2', '', '200 | OK']);
  assert.equal(htmlToText('<ul><li>one</li><li>two</li></ul>'), '- one\n- two');
});

// ---------- Jira ----------

await check('Jira Cloud: /rest/api/3/search/jql with nextPageToken paging, Basic auth, custom fields by name, ADF', async () => {
  const issue = (n: number, extra: Record<string, unknown> = {}) => ({ key: `QA-${n}`, fields: { summary: `Case ${n}`, issuetype: { name: 'Story' }, priority: { name: 'High' }, description: adf(`GET /products/${n}`, 'Expected result: 200'), ...extra } });
  const f = fake((u) => {
    if (u.pathname !== '/rest/api/3/search/jql') return undefined;
    const tok = u.searchParams.get('nextPageToken');
    if (!tok) return { body: { issues: [issue(1), issue(2, { customfield_10050: 'list-products', customfield_10051: adf('200 with a list') })], names: { customfield_10050: 'Endpoint', customfield_10051: 'Expected Result', customfield_10060: 'Story Points' }, nextPageToken: 'p2', isLast: false } };
    return { body: { issues: [issue(3)], isLast: true } };
  });
  const sheet = await loadLinkCases('https://acme.atlassian.net/issues/?jql=project%20%3D%20QA', { env: CLOUD, fetch: f.fn });
  assert.equal(f.calls.length, 2);
  for (const c of f.calls) {
    assert.equal(c.auth, BASIC);
    assert.equal(c.redirect, 'manual');
    assert.equal(c.method, 'GET');
  }
  const u0 = new URL(f.calls[0].url);
  assert.equal(u0.searchParams.get('jql'), 'project = QA');
  assert.equal(u0.searchParams.get('maxResults'), '100');
  assert.equal(u0.searchParams.get('expand'), 'names');
  assert.equal(new URL(f.calls[1].url).searchParams.get('nextPageToken'), 'p2');
  assert.equal(sheet.format, 'jira');
  assert.equal(sheet.source?.kind, 'jira');
  assert.deepEqual(sheet.cases.map((c) => c.id), ['QA-1', 'QA-2', 'QA-3']);
  assert.equal(sheet.cases[0].steps, 'GET /products/1');
  assert.equal(sheet.cases[0].expected, '200');
  assert.equal(sheet.cases[1].endpoint, 'list-products');
  assert.equal(sheet.cases[1].expected, '200 with a list');
  assert.equal(sheet.cases[1].priority, 'High');
  // The traceability report's Jira column: each issue's browse link.
  assert.deepEqual(sheet.cases.map((c) => c.jira), ['https://acme.atlassian.net/browse/QA-1', 'https://acme.atlassian.net/browse/QA-2', 'https://acme.atlassian.net/browse/QA-3']);
  assert.equal(sheet.columns.jira, undefined, 'the link is derived, not a column of the source');
  assert.match(sheet.columns.expected ?? '', /Description.*Expected Result|Expected Result.*Description/);
  const pv = previewSheet(sheet, ENDPOINTS);
  assert.equal(pv.rows.find((r) => r.id === 'QA-2')?.endpoint, 'list-products');
  assert.equal(pv.rows.find((r) => r.id === 'QA-1')?.endpoint, 'get-product');
});

await check('Jira Data Center: /rest/api/2/search with startAt paging, bearer PAT, Xray DC steps', async () => {
  const f = fake((u) => {
    if (u.pathname === '/jira/rest/api/2/search') {
      const start = Number(u.searchParams.get('startAt'));
      const all = [1, 2, 3].map((n) => ({ key: `QA-${n}`, fields: { summary: `Case ${n}`, issuetype: { name: n === 3 ? 'Test' : 'Story' }, description: n === 3 ? 'Check create' : `h3. Steps\nGET /products\nh3. Expected result\n200` } }));
      return { body: { startAt: start, maxResults: 2, total: 3, issues: all.slice(start, start + 2) } };
    }
    if (u.pathname === '/jira/rest/raven/1.0/api/test') {
      assert.equal(u.searchParams.get('keys'), 'QA-3');
      return { body: [{ key: 'QA-3', steps: [{ index: 1, step: { raw: 'POST /products with a text price' }, data: { raw: 'price = "abc"' }, result: { raw: '400' } }, { index: 2, fields: { Action: 'GET /products', Data: '', 'Expected Result': 'no new product' } }] }] };
    }
    return undefined;
  });
  const sheet = await loadLinkCases('jql: project = QA', { env: DC, fetch: f.fn });
  assert.equal(f.calls.filter((c) => c.url.includes('/search')).length, 2);
  assert.ok(f.calls.every((c) => c.auth === `Bearer ${TOKEN}`));
  assert.equal(sheet.cases.length, 3);
  assert.equal(sheet.cases[0].steps, 'GET /products');
  assert.equal(sheet.cases[0].expected, '200');
  const t = sheet.cases[2];
  assert.equal(t.steps, '1. POST /products with a text price\n2. GET /products');
  assert.equal(t.expected, '1. 400\n2. no new product');
  assert.equal(t.testData, '1. price = "abc"');
  assert.equal(t.preconditions, 'Check create');
  assert.equal(sheet.source?.steps, 'Xray Data Center');
});

await check('Xray Data Center not installed (404): the description is used, no error', async () => {
  const f = fake((u) => {
    if (u.pathname === '/jira/rest/api/2/search') return { body: { total: 1, issues: [{ key: 'QA-9', fields: { summary: 'T', issuetype: { name: 'Test' }, description: 'GET /products\nExpected result: 200' } }] } };
    if (u.pathname.startsWith('/jira/rest/raven/')) return { status: 404, text: '<html>Not found</html>' };
    return undefined;
  });
  const sheet = await loadLinkCases('jql: key = QA-9', { env: DC, fetch: f.fn });
  assert.equal(sheet.cases[0].expected, '200');
  assert.equal(sheet.source?.steps, null);
});

await check('Xray Cloud: client id/secret sign-in, GraphQL getTests by key, steps and Gherkin', async () => {
  const env = { ...CLOUD, XRAY_CLIENT_ID: 'xid', XRAY_CLIENT_SECRET: 'xray-secret-0123456789' };
  const f = fake((u, c) => {
    if (u.pathname === '/rest/api/3/search/jql') return { body: { issues: [{ key: 'QA-1', fields: { summary: 'Create', issuetype: { name: 'Test' }, description: adf('Create a product') } }, { key: 'QA-2', fields: { summary: 'Login', issuetype: { name: 'Test' } } }, { key: 'QA-3', fields: { summary: 'Story', issuetype: { name: 'Story' }, description: adf('GET /products') } }], isLast: true } };
    if (u.host === 'xray.cloud.getxray.app' && u.pathname === '/api/v2/authenticate') {
      assert.deepEqual(c.body, { client_id: 'xid', client_secret: 'xray-secret-0123456789' });
      return { body: 'xray-jwt-0123456789abcdef' };
    }
    if (u.host === 'xray.cloud.getxray.app' && u.pathname === '/api/v2/graphql') {
      assert.equal(c.auth, 'Bearer xray-jwt-0123456789abcdef');
      const b = c.body as { query: string; variables: { jql: string; limit: number } };
      assert.match(b.query, /getTests\(jql: \$jql, limit: \$limit, start: \$start\)/);
      assert.equal(b.variables.jql, 'key in (QA-1,QA-2)');
      assert.equal(b.variables.limit, 100);
      return { body: { data: { getTests: { total: 2, results: [{ jira: { key: 'QA-1' }, steps: [{ action: 'POST /products', data: '{"name":"Pen"}', result: '201 Created' }] }, { jira: { key: 'QA-2' }, gherkin: 'Given a user\nWhen POST /login\nThen 200' }] } } } };
    }
    return undefined;
  });
  const sheet = await loadLinkCases('https://acme.atlassian.net/issues/?filter=10001', { env, fetch: f.fn });
  const [a, b, c] = sheet.cases;
  assert.equal(a.steps, '1. POST /products');
  assert.equal(a.expected, '201 Created');
  assert.equal(a.testData, '{"name":"Pen"}');
  assert.equal(a.preconditions, 'Create a product');
  assert.match(b.steps, /When POST \/login/);
  assert.equal(c.steps, 'GET /products');
  assert.equal(sheet.source?.steps, 'Xray Cloud');
});

await check('Xray Cloud not set up: Test issues use the description and a warning says why', async () => {
  const f = fake((u) => (u.pathname === '/rest/api/3/search/jql' ? { body: { issues: [{ key: 'QA-1', fields: { summary: 'Create', issuetype: { name: 'Test' }, description: adf('POST /products', 'Expected result: 201') } }], isLast: true } } : undefined));
  const sheet = await loadLinkCases('jql: key = QA-1', { env: CLOUD, fetch: f.fn });
  assert.equal(sheet.cases[0].expected, '201');
  assert.ok(sheet.warnings.some((w) => /XRAY_CLIENT_ID and XRAY_CLIENT_SECRET are not set/.test(w.message)));
});

await check('Xray Cloud errors: bad client secret is a clear 401, GraphQL errors are reported', async () => {
  const env = { ...CLOUD, XRAY_CLIENT_ID: 'xid', XRAY_CLIENT_SECRET: 'xray-secret-0123456789' };
  const search = { body: { issues: [{ key: 'QA-1', fields: { summary: 'T', issuetype: { name: 'Test' } } }], isLast: true } };
  const bad = fake((u) => (u.pathname === '/rest/api/3/search/jql' ? search : u.pathname === '/api/v2/authenticate' ? { status: 401, body: { error: 'bad secret xray-secret-0123456789' } } : undefined));
  await rejects(loadLinkCases('jql: key = QA-1', { env, fetch: bad.fn }), /Xray refused the credentials \(401\): check XRAY_CLIENT_ID and XRAY_CLIENT_SECRET.*<redacted>/);
  const gq = fake((u) => (u.pathname === '/rest/api/3/search/jql' ? search : u.pathname === '/api/v2/authenticate' ? { body: 'jwt-0123456789' } : { body: { errors: [{ message: 'jql is invalid' }] } }));
  await rejects(loadLinkCases('jql: key = QA-1', { env, fetch: gq.fn }), /Xray could not read the test steps: jql is invalid/);
});

// ---------- Zephyr Scale ----------

await check('Zephyr Scale Cloud: test cases by key and by project, step-by-step scripts, its own bearer token', async () => {
  const env = { ...CLOUD, ZEPHYR_API_TOKEN: 'zephyr-token-0123456789' };
  const f = fake((u, c) => {
    assert.equal(u.host, 'api.zephyrscale.smartbear.com');
    assert.equal(c.auth, 'Bearer zephyr-token-0123456789');
    if (u.pathname === '/v2/testcases') return { body: { values: [{ key: 'QA-T1', name: 'View', objective: '<p>GET /products/1</p>' }, { key: 'QA-T2', name: 'Create', precondition: '<p>Signed in</p>' }], isLast: true } };
    if (u.pathname === '/v2/testcases/QA-T1/teststeps') return { body: { values: [], isLast: true } };
    if (u.pathname === '/v2/testcases/QA-T2/teststeps') return { body: { values: [{ inline: { description: '<p>POST /products</p>', testData: '<p>name=Pen</p>', expectedResult: '<p>201</p>' } }, { testCase: { testCaseKey: 'QA-T9' } }], isLast: true } };
    if (u.pathname === '/v2/testcases/QA-T2') return { body: { key: 'QA-T2', name: 'Create' } };
    return undefined;
  });
  const sheet = await loadLinkCases('zephyr: project = QA', { env, fetch: f.fn });
  assert.equal(sheet.format, 'zephyr');
  assert.equal(sheet.cases[0].steps, 'GET /products/1');
  assert.equal(sheet.cases[1].steps, '1. POST /products\n2. Call test case QA-T9');
  assert.equal(sheet.cases[1].expected, '1. 201');
  assert.equal(sheet.cases[1].preconditions, 'Signed in');
  const one = await loadLinkCases('zephyr: QA-T2', { env, fetch: f.fn });
  assert.deepEqual(one.cases.map((c) => c.id), ['QA-T2']);
  await rejects(loadLinkCases('zephyr: QA-T2', { env: CLOUD, fetch: f.fn }), /Zephyr Scale needs its own API token: add ZEPHYR_API_TOKEN/);
});

await check('Zephyr Scale Data Center: /rest/atm/1.0 search with the Jira token', async () => {
  const f = fake((u, c) => {
    assert.equal(c.auth, `Bearer ${TOKEN}`);
    if (u.pathname === '/jira/rest/atm/1.0/testcase/search') {
      assert.equal(u.searchParams.get('query'), 'projectKey = "QA"');
      return { body: [{ key: 'QA-T1', name: 'View', priority: 'High', testScript: { type: 'STEP_BY_STEP', steps: [{ description: 'GET /products/1', testData: '', expectedResult: '200' }] } }, { key: 'QA-T2', name: 'Plain', testScript: { type: 'PLAIN_TEXT', text: '<p>GET /products</p>' } }] };
    }
    return undefined;
  });
  const sheet = await loadLinkCases('zephyr: QA', { env: DC, fetch: f.fn });
  assert.equal(sheet.cases[0].expected, '200');
  assert.equal(sheet.cases[0].priority, 'High');
  assert.equal(sheet.cases[1].steps, 'GET /products');
});

// ---------- Confluence ----------

const PAGE = '<p>Intro</p><table><tbody><tr><th>Test Case ID</th><th>Title</th><th>Steps / Request</th><th>Expected Result</th><th>Endpoint</th></tr><tr><td>TC-1</td><td>List</td><td>GET /products</td><td>200</td><td>list-products</td></tr><tr><td>TC-2</td><td>Create</td><td>POST /products</td><td>201</td><td></td></tr></tbody></table><table><tr><th>Owner</th><th>Date</th></tr><tr><td>QA</td><td>today</td></tr></table>';

await check('Confluence Cloud: /wiki/api/v2/pages/{id}?body-format=storage, the case table, the sheet column matching', async () => {
  const f = fake((u) => (u.pathname === '/wiki/api/v2/pages/98765' ? { body: { id: '98765', title: 'API test cases', body: { storage: { value: PAGE, representation: 'storage' } } } } : undefined));
  const sheet = await loadLinkCases('https://acme.atlassian.net/wiki/spaces/QA/pages/98765/API+test+cases', { env: CLOUD, fetch: f.fn });
  assert.equal(new URL(f.calls[0].url).searchParams.get('body-format'), 'storage');
  assert.equal(f.calls[0].auth, BASIC);
  assert.equal(sheet.format, 'confluence');
  assert.equal(sheet.source?.label, 'Confluence page "API test cases"');
  assert.equal(sheet.columns.id, 'Test Case ID');
  assert.deepEqual(sheet.cases.map((c) => [c.id, c.endpoint, c.expected]), [['TC-1', 'list-products', '200'], ['TC-2', '', '201']]);
  // The traceability report's Confluence column: the page the case was read from.
  assert.ok(sheet.cases.every((c) => c.confluence === 'https://acme.atlassian.net/wiki/spaces/QA/pages/98765/API+test+cases'));
  assert.ok(sheet.warnings.some((w) => /1 other table\(s\) on the page have no Title or Steps column/.test(w.message)));
  const pv = previewSheet(sheet, ENDPOINTS);
  assert.equal(pv.matched, 2);
});

await check('Confluence Data Center: /rest/api/content by id and by space and title; two case tables combine', async () => {
  const two = PAGE.replace('<table><tr><th>Owner', '<table><tr><th>ID</th><th>Summary</th><th>Expected</th></tr><tr><td>TC-3</td><td>Get one</td><td>404</td></tr></table><table><tr><th>Owner');
  const f = fake((u) => {
    if (u.host !== 'wiki.acme.test') return undefined;
    if (u.pathname === '/rest/api/content/321') return { body: { title: 'Cases', body: { storage: { value: PAGE } } } };
    if (u.pathname === '/rest/api/content') {
      assert.equal(u.searchParams.get('spaceKey'), 'QA');
      assert.equal(u.searchParams.get('title'), 'API test cases');
      return { body: { results: [{ title: 'API test cases', body: { storage: { value: two } } }] } };
    }
    return undefined;
  });
  const a = await loadLinkCases('https://wiki.acme.test/pages/viewpage.action?pageId=321', { env: DC, fetch: f.fn });
  assert.equal(a.cases.length, 2);
  const b = await loadLinkCases('https://wiki.acme.test/display/QA/API+test+cases', { env: DC, fetch: f.fn });
  assert.deepEqual(b.cases.map((c) => c.id), ['TC-1', 'TC-2', 'TC-3']);
  assert.ok(b.warnings.some((w) => /cases come from 2 tables/.test(w.message)));
});

await check('Confluence: a page without a usable table says what is needed', async () => {
  const f = fake(() => ({ body: { title: 'Notes', body: { storage: { value: '<p>No table</p>' } } } }));
  await rejects(loadLinkCases('https://acme.atlassian.net/wiki/spaces/QA/pages/1', { env: CLOUD, fetch: f.fn }), /has no table\. Put the test cases in a table with a header row/);
  const g = fake(() => ({ body: { title: 'Notes', body: { storage: { value: '<table><tr><th>Owner</th></tr><tr><td>x</td></tr></table>' } } } }));
  await rejects(loadLinkCases('https://acme.atlassian.net/wiki/spaces/QA/pages/1', { env: CLOUD, fetch: g.fn }), /none has a Title or Steps column\. Headers seen: Owner/);
});

// ---------- Limits, errors, secrets ----------

await check('429: waits Retry-After (seconds or a date) and retries, at most 3 times; 503 too', async () => {
  let n = 0;
  const waits: number[] = [];
  const f = fake((u) => {
    if (u.pathname !== '/rest/api/3/search/jql') return undefined;
    n++;
    if (n === 1) return { status: 429, body: {}, headers: { 'retry-after': '2' } };
    if (n === 2) return { status: 503, body: {} };
    return { body: { issues: [{ key: 'QA-1', fields: { summary: 'x', description: adf('GET /products', 'Expected result: 200') } }], isLast: true } };
  });
  const sheet = await loadLinkCases('jql: key = QA-1', { env: CLOUD, fetch: f.fn, sleep: async (ms) => void waits.push(ms) });
  assert.equal(sheet.cases.length, 1);
  assert.deepEqual(waits, [2000, 2000]);
  assert.ok(sheet.warnings.some((w) => /asked to slow down \(429\)/.test(w.message)));
  const always = fake(() => ({ status: 429, body: {}, headers: { 'retry-after': '120' } }));
  const w2: number[] = [];
  await rejects(loadLinkCases('jql: key = QA-1', { env: CLOUD, fetch: always.fn, sleep: async (ms) => void w2.push(ms) }), /rate limiting \(429\) and still was after 3 retries/);
  assert.equal(always.calls.length, 4);
  assert.deepEqual(w2, [60000, 60000, 60000], 'a long Retry-After is capped at 60 s');
});

await check('401, 403, 404 and 400 give plain-language messages; the token never appears', async () => {
  const echo = (status: number) => fake((u, c) => ({ status, body: { errorMessages: [`denied for ${c.auth} token ${TOKEN}`] } }));
  await rejects(loadLinkCases('jql: key = QA-1', { env: CLOUD, fetch: echo(401).fn, sleep: noSleep }), /401 \(not signed in\): check ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN; a new token can be made at https:\/\/id\.atlassian\.com/);
  await rejects(loadLinkCases('jql: key = QA-1', { env: CLOUD, fetch: echo(403).fn, sleep: noSleep }), /403 \(no permission\)/);
  await rejects(loadLinkCases('https://acme.atlassian.net/wiki/spaces/QA/pages/1', { env: CLOUD, fetch: echo(404).fn, sleep: noSleep }), /Confluence said 404 for page 1: it does not exist or the account in \.env cannot see it/);
  await rejects(loadLinkCases('jql: project = NOPE', { env: CLOUD, fetch: echo(400).fn, sleep: noSleep }), /Jira could not run the request for the search \(400\)\. Jira said: denied/);
  for (const s of [401, 403, 404, 400, 500]) {
    await assert.rejects(loadLinkCases('jql: key = QA-1', { env: CLOUD, fetch: echo(s).fn, sleep: noSleep }), (err: Error) => {
      assert.ok(!err.message.includes(TOKEN), `token in the ${s} message`);
      assert.ok(!err.message.includes(BASIC.split(' ')[1]), `basic auth in the ${s} message`);
      return true;
    });
  }
  assert.equal(redactSecrets(`x ${TOKEN} Bearer abcdefghijkl`, [TOKEN]), 'x <redacted> Bearer <redacted>');
});

await check('redirects are not followed; a login page (HTML) and network errors are explained', async () => {
  const r = fake(() => ({ status: 302, body: {}, headers: { location: 'https://evil.test/' } }));
  await rejects(loadLinkCases('jql: key = QA-1', { env: CLOUD, fetch: r.fn }), /redirected .* redirects are not followed/);
  assert.equal(r.calls.length, 1);
  const html = fake(() => ({ text: '<!doctype html><html>Log in</html>' }));
  await rejects(loadLinkCases('jql: key = QA-1', { env: CLOUD, fetch: html.fn }), /sent a web page instead of data .* login or SSO page/);
  const down: FetchLike = async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  };
  await rejects(loadLinkCases('jql: key = QA-1', { env: CLOUD, fetch: down }), /could not reach Jira at acme\.atlassian\.net: ENOTFOUND/);
});

await check('caps: more than 1000 issues, an oversized response and an empty search are refused', async () => {
  const many = fake(() => ({ body: { issues: Array.from({ length: 100 }, (_, i) => ({ key: `QA-${i + 1}`, fields: { summary: 's' } })), nextPageToken: 'more', isLast: false } }));
  await rejects(loadLinkCases('jql: project = QA', { env: CLOUD, fetch: many.fn }), /more than 1000 issues; narrow the JQL/);
  assert.ok(many.calls.length <= 11, `${many.calls.length} pages`);
  const dcMany = fake(() => ({ body: { total: 5000, issues: [{ key: 'QA-1', fields: {} }] } }));
  await rejects(loadLinkCases('jql: project = QA', { env: DC, fetch: dcMany.fn }), /finds 5000 issues, more than 1000/);
  const big = fake(() => ({ body: {}, headers: { 'content-length': String(11 * 1024 * 1024) } }));
  await rejects(loadLinkCases('jql: project = QA', { env: CLOUD, fetch: big.fn }), /more than 10 MB/);
  const none = fake(() => ({ body: { issues: [], isLast: true } }));
  await rejects(loadLinkCases('jql: project = QA', { env: CLOUD, fetch: none.fn }), /has no test cases \(the search found no issues\)/);
});

await check('verifyAtlassian: who-am-I on Jira (v3 Cloud, v2 Data Center); never throws', async () => {
  const f = fake((u) => (u.pathname === '/rest/api/3/myself' ? { body: { displayName: 'QA Lead' } } : u.pathname === '/jira/rest/api/2/myself' ? { body: { name: 'qa' } } : undefined));
  assert.deepEqual(await verifyAtlassian({ env: CLOUD, fetch: f.fn }), { ok: true, user: 'QA Lead', deployment: 'cloud' });
  assert.deepEqual(await verifyAtlassian({ env: DC, fetch: f.fn }), { ok: true, user: 'qa', deployment: 'datacenter' });
  const bad = await verifyAtlassian({ env: CLOUD, fetch: fake(() => ({ status: 401, body: {} })).fn });
  assert.equal(bad.ok, false);
  const none = await verifyAtlassian({ env: {} });
  assert.equal(none.ok, false);
});

// ---------- Wiring ----------

await check('input testCases takes a file or a link, not both; --test-cases takes a link', () => {
  assert.ok(TestCasesConfigSchema.safeParse({ link: 'https://acme.atlassian.net/browse/QA-1', mode: 'sheet-only' }).success);
  assert.ok(TestCasesConfigSchema.safeParse({ file: 'x.csv' }).success);
  assert.ok(!TestCasesConfigSchema.safeParse({ file: 'x.csv', link: 'jql: project = QA' }).success);
  assert.ok(!TestCasesConfigSchema.safeParse({}).success);
  const f = parseAgentFlags(['input/x.json', '--test-cases', 'https://acme.atlassian.net/issues/?jql=project%20%3D%20QA&x=1']);
  assert.equal(f.testCases, 'https://acme.atlassian.net/issues/?jql=project%20%3D%20QA&x=1');
});

await check('the generated tests never see the Atlassian, Xray or Zephyr tokens', () => {
  const keep = { ...process.env };
  try {
    Object.assign(process.env, { ATLASSIAN_API_TOKEN: TOKEN, XRAY_CLIENT_SECRET: 'x-secret-0123', XRAY_CLIENT_ID: 'xid', ZEPHYR_API_TOKEN: 'z-token-0123' });
    const env = testEnv('input/local-shop.json');
    for (const k of ['ATLASSIAN_API_TOKEN', 'XRAY_CLIENT_SECRET', 'XRAY_CLIENT_ID', 'ZEPHYR_API_TOKEN']) assert.equal(env[k], undefined, k);
  } finally {
    for (const k of ['ATLASSIAN_API_TOKEN', 'XRAY_CLIENT_SECRET', 'XRAY_CLIENT_ID', 'ZEPHYR_API_TOKEN']) if (keep[k] === undefined) delete process.env[k];
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
