// A fake Atlassian site for offline tests and demos: Jira Cloud search (two pages), Confluence Cloud
// pages, Xray Cloud (sign-in and GraphQL) and Zephyr Scale Cloud, all on one local port. Nothing real is
// called. The data mirrors input/local-shop-test-cases.csv.
//
//   node scripts/mock-atlassian.mjs [port]     prints the .env lines to point the agent or the UI at it
//
// Used by npm run test:ui-atlassian, npm run test:e2e and the UI screenshots.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MOCK_EMAIL = "qa.lead@example.com";
export const MOCK_TOKEN = "mock-atlassian-token-0123456789";
export const MOCK_XRAY = { id: "mock-xray-client", secret: "mock-xray-secret-0123456789" };
export const MOCK_ZEPHYR_TOKEN = "mock-zephyr-token-0123456789";
export const CONFLUENCE_PAGE_ID = "4242";

const p = (text) => ({ type: "paragraph", content: [{ type: "text", text }] });
const doc = (...content) => ({ type: "doc", version: 1, content });

// Jira issues. customfield_10050 is "Endpoint", customfield_10051 "Expected Result".
export const JIRA_ISSUES = [
  { key: "SHOP-101", type: "Story", summary: "List all products", endpoint: "list-products", description: doc(p("Send GET /products"), p("Expected result: 200 with an array; each product has id, name, price, category, inStock and createdAt")), priority: "High" },
  { key: "SHOP-102", type: "Test", summary: "Create product rejects a text price", endpoint: "create-product", description: doc(p("Price validation on create.")), priority: "High" },
  { key: "SHOP-103", type: "Story", summary: "Create product without a token is rejected", description: doc(p("POST /products without the Authorization header")), expected: "401 Unauthorized", priority: "High" },
  { key: "SHOP-104", type: "Story", summary: "Get a product that does not exist", description: doc({ type: "orderedList", content: [{ type: "listItem", content: [p("Send GET /products/999999")] }] }, { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Expected result" }] }, p("404 Not Found")), priority: "Medium" },
  { key: "SHOP-105", type: "Story", summary: "Delete a product without a token", endpoint: "delete-product", description: doc(p("DELETE /products/{id} without the Authorization header"), p("Expected result: 401 Unauthorized")), priority: "High" },
  { key: "SHOP-106", type: "Story", summary: "Export the monthly sales report", description: doc(p("Download the monthly sales report as a PDF file"), p("Expected result: The file downloads")), priority: "Low" },
];
const XRAY_STEPS = { "SHOP-102": [{ action: 'POST /products with price "abc" instead of a number', data: '{"name":"Pen","price":"abc","category":"office","inStock":true}', result: "400 Bad Request" }] };
export const ZEPHYR_CASES = [
  { key: "SHOP-T1", name: "View one product", objective: "<p>GET /products/{id} for a product created first</p>", precondition: "<p>A product exists</p>", steps: [{ description: "<p>GET /products/{id}</p>", testData: "", expectedResult: "<p>200 with the product fields and their types</p>" }] },
  { key: "SHOP-T2", name: "Update a product's price", objective: "", precondition: "", steps: [{ description: "<p>PUT /products/{id} with a new price</p>", testData: "<p>price = 9.99</p>", expectedResult: "<p>200 with the updated product</p>" }] },
];

function csvRows(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') q = false; else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// The sample sheet as a Confluence storage-format page: an intro, an info macro, then the table.
export function confluenceStorage() {
  const rows = csvRows(fs.readFileSync(path.join(ROOT, "input", "local-shop-test-cases.csv"), "utf8")).filter((r) => r.some((c) => c.trim()));
  const head = `<tr>${rows[0].map((h) => `<th><p><strong>${esc(h)}</strong></p></th>`).join("")}</tr>`;
  const body = rows.slice(1).map((r) => `<tr>${r.map((c) => `<td><p>${esc(c)}</p></td>`).join("")}</tr>`).join("");
  return `<h2>Local shop API</h2><p>Manual test cases owned by the QA team.</p><ac:structured-macro ac:name="info"><ac:rich-text-body><p>Run before every release.</p></ac:rich-text-body></ac:structured-macro><table data-layout="wide"><colgroup><col /></colgroup><tbody>${head}${body}</tbody></table><p>Last reviewed by the QA lead.</p>`;
}

function jiraIssue(i) {
  return {
    id: String(10000 + Number(i.key.split("-")[1])),
    key: i.key,
    fields: {
      summary: i.summary,
      issuetype: { name: i.type },
      priority: { name: i.priority },
      description: i.description,
      customfield_10050: i.endpoint ?? null,
      customfield_10051: i.expected ? doc(p(i.expected)) : null,
      customfield_10099: { value: "Regression" },
    },
  };
}
const NAMES = { summary: "Summary", description: "Description", issuetype: "Issue Type", priority: "Priority", customfield_10050: "Endpoint", customfield_10051: "Expected Result", customfield_10099: "Test Suite" };

// The .env values that point the agent at a mock on url (demo values, nothing real).
export function mockEnv(url) {
  return { ATLASSIAN_BASE_URL: url, ATLASSIAN_DEPLOYMENT: "cloud", ATLASSIAN_EMAIL: MOCK_EMAIL, ATLASSIAN_API_TOKEN: MOCK_TOKEN, XRAY_CLIENT_ID: MOCK_XRAY.id, XRAY_CLIENT_SECRET: MOCK_XRAY.secret, XRAY_BASE_URL: `${url}/xray`, ZEPHYR_API_TOKEN: MOCK_ZEPHYR_TOKEN, ZEPHYR_BASE_URL: `${url}/zephyr/v2` };
}

export function startMockAtlassian({ port = 0, host = "127.0.0.1", rateLimitOnce = false } = {}) {
  const seen = [];
  let limited = !rateLimitOnce;
  const basic = `Basic ${Buffer.from(`${MOCK_EMAIL}:${MOCK_TOKEN}`).toString("base64")}`;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://mock");
      seen.push({ method: req.method, path: url.pathname, search: url.search, auth: req.headers.authorization ? req.headers.authorization.split(" ")[0] : null });
      const reply = (status, obj, headers = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(obj));
      };
      const p = url.pathname;
      // For tests that run the mock in another process: what was requested so far (no secrets).
      if (p === "/__seen") return reply(200, seen.slice(0, -1));
      // Xray Cloud
      if (p === "/xray/api/v2/authenticate" && req.method === "POST") {
        const b = JSON.parse(raw || "{}");
        if (b.client_id !== MOCK_XRAY.id || b.client_secret !== MOCK_XRAY.secret) return reply(401, { error: "Authentication failed: invalid client credentials" });
        return reply(200, "mock-xray-jwt-token-abcdefghijkl");
      }
      if (p === "/xray/api/v2/graphql" && req.method === "POST") {
        if (req.headers.authorization !== "Bearer mock-xray-jwt-token-abcdefghijkl") return reply(401, { error: "unauthorized" });
        const b = JSON.parse(raw || "{}");
        const keys = (/key in \(([^)]*)\)/.exec(b.variables?.jql || "")?.[1] || "").split(",").map((k) => k.trim());
        const results = keys.filter((k) => XRAY_STEPS[k]).map((k) => ({ issueId: k, testType: { name: "Manual", kind: "Steps" }, steps: XRAY_STEPS[k], gherkin: null, unstructured: null, jira: { key: k } }));
        return reply(200, { data: { getTests: { total: results.length, start: 0, limit: 100, results } } });
      }
      // Zephyr Scale Cloud
      if (p.startsWith("/zephyr/v2/")) {
        if (req.headers.authorization !== `Bearer ${MOCK_ZEPHYR_TOKEN}`) return reply(401, { message: "invalid token" });
        let m;
        if (p === "/zephyr/v2/testcases") {
          const start = Number(url.searchParams.get("startAt") || 0);
          return reply(200, { values: ZEPHYR_CASES.slice(start).map(({ steps, ...c }) => ({ ...c, priority: { id: 1 } })), startAt: start, maxResults: 100, isLast: true });
        }
        if ((m = /^\/zephyr\/v2\/testcases\/([^/]+)\/teststeps$/.exec(p))) {
          const c = ZEPHYR_CASES.find((x) => x.key === decodeURIComponent(m[1]));
          if (!c) return reply(404, { message: "not found" });
          return reply(200, { values: c.steps.map((s) => ({ inline: s })), isLast: true });
        }
        if ((m = /^\/zephyr\/v2\/testcases\/([^/]+)$/.exec(p))) {
          const c = ZEPHYR_CASES.find((x) => x.key === decodeURIComponent(m[1]));
          if (!c) return reply(404, { message: `Test case ${m[1]} was not found` });
          const { steps, ...rest } = c;
          return reply(200, rest);
        }
        return reply(404, { message: "not found" });
      }
      if (req.headers.authorization !== basic) return reply(401, { errorMessages: ["Client must be authenticated to access this resource."] });
      if (!limited && p.startsWith("/rest/api/3/search/jql")) {
        limited = true;
        return reply(429, { errorMessages: ["Rate limit exceeded."] }, { "retry-after": "0" });
      }
      if (p === "/rest/api/3/myself") return reply(200, { displayName: "QA Lead", emailAddress: MOCK_EMAIL });
      if (p === "/rest/api/3/search/jql") {
        const jql = url.searchParams.get("jql") || "";
        let issues = JIRA_ISSUES;
        const key = /key\s*=\s*([A-Z]+-\d+)/i.exec(jql);
        if (key) issues = JIRA_ISSUES.filter((i) => i.key === key[1].toUpperCase());
        else if (/filter\s*=\s*10001/.test(jql) || /project\s*=\s*SHOP/i.test(jql)) issues = JIRA_ISSUES;
        else if (/project\s*=/i.test(jql)) return reply(400, { errorMessages: [`The value '${(/project\s*=\s*(\S+)/i.exec(jql) || [])[1]}' does not exist for the field 'project'.`] });
        const page = url.searchParams.get("nextPageToken") === "page-2" ? 1 : 0;
        const size = 4;
        const slice = issues.slice(page * size, page * size + size);
        const last = page * size + size >= issues.length;
        return reply(200, { issues: slice.map(jiraIssue), names: NAMES, ...(last ? { isLast: true } : { nextPageToken: "page-2", isLast: false }) });
      }
      const page = /^\/wiki\/api\/v2\/pages\/(\d+)$/.exec(p);
      if (page) {
        if (page[1] !== CONFLUENCE_PAGE_ID) return reply(404, { errors: [{ status: 404, title: "Not Found" }] });
        return reply(200, { id: CONFLUENCE_PAGE_ID, title: "Local shop API test cases", body: { storage: { value: confluenceStorage(), representation: "storage" } } });
      }
      return reply(404, { errorMessages: ["Not found"] });
    });
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const actual = server.address().port;
      const url = `http://${host}:${actual}`;
      resolve({
        server,
        port: actual,
        url,
        seen,
        env: mockEnv(url),
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const m = await startMockAtlassian({ port: Number(process.argv[2] ?? 4600) });
  console.log(`Mock Atlassian site on ${m.url}. Put these in .env (demo values, nothing real):`);
  for (const [k, v] of Object.entries(m.env)) console.log(`${k}=${v}`);
  console.log(`Then paste: ${m.url}/issues/?jql=project%20%3D%20SHOP  or  ${m.url}/wiki/spaces/QA/pages/${CONFLUENCE_PAGE_ID}/Local+shop+API+test+cases  or  zephyr: project = SHOP`);
}
