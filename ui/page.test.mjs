// npm run test:ui-page: clicks through the page in headless Chromium, the way a tester does, for the
// defects the team's test sheet found on 24 Nov 2026 (API-Test-Agent-Test-Scenarios.xlsx). Offline: no
// agent run, no model call; a dummy model key only lifts the "set up your model" card.
//   TC-028  Build tab: the first click on an endpoint's trash icon right after typing its path removes it
//   TC-023  Saved tab: Run is disabled, with the reason, while the JSON does not parse or the input is invalid
//   TC-050  Test case sheet: an upload that is not a sheet is refused by its file type
//   TC-070  AGENT_FORCE_PRODUCTION=1: the page asks for the production tick, like the server
// Needs Chromium for Playwright (npx playwright install chromium), or CHROME_PATH pointing to a Chrome.
import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.UI_PAGE_PORT || 3885);

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok    ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}\n      ${String(err && err.message ? err.message : err).split("\n").join("\n      ")}`);
  }
}

function startUi(port, extra = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, UI_PORT: String(port), SKIP_CLI_DETECT: "1", ENV_FILE: path.join(ROOT, "ui", "ui.test.env.none"), LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant-dummy-page-test", ...extra };
    for (const k of ["HOSTED", "UI_USERS", ...(extra.AGENT_FORCE_PRODUCTION ? [] : ["AGENT_FORCE_PRODUCTION"])]) delete env[k];
    const child = spawn(process.execPath, [path.join(ROOT, "ui", "server.mjs")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    const timer = setTimeout(() => reject(new Error(`UI did not start: ${out}`)), 15000);
    child.stdout.on("data", (d) => {
      out += d;
      if (out.includes("running on")) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`UI exited with ${code}: ${out}`));
    });
  });
}

function stop(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
}

async function openPage(browser, port) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}`);
  await page.waitForFunction(() => document.querySelectorAll("#epList li").length > 0);
  return { page, errors };
}

async function selectSaved(page, name) {
  await page.click("#tabSaved");
  await page.selectOption("#inputSel", name);
  await page.waitForFunction((n) => document.getElementById("jsonBox").value.includes('"endpoints"') && document.getElementById("inputSel").value === n, name);
  await page.waitForTimeout(400); // the input is validated by the server 250 ms after a change
}

const runState = (page) => page.evaluate(() => ({ disabled: document.getElementById("runBtn").disabled, hint: document.getElementById("runHint").classList.contains("hidden") ? "" : document.getElementById("runHintText").textContent }));

async function main() {
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  let ui = await startUi(PORT);
  try {
    const { page, errors } = await openPage(browser, PORT);

    await check("TC-028: one click on the trash icon right after typing a path removes the endpoint", async () => {
      await page.click("#tabCustom");
      await page.waitForSelector("#cEps .ep-edit");
      await page.click("#cAdd");
      await page.click("#cAdd");
      const before = await page.locator("#cEps .ep-edit").count();
      assert.ok(before >= 3, `rows before: ${before}`);
      const paths = page.locator('#cEps input[data-k="path"]');
      // Type a path and go straight to that row's trash icon: the path field still has the cursor, so the
      // press on the icon is what ends the edit. A human press, not an instant one.
      await paths.nth(1).fill("/orders/{id}");
      await page.locator('#cEps .ep-edit[data-i="1"] [data-act="del"]').click({ delay: 100 });
      assert.equal(await page.locator("#cEps .ep-edit").count(), before - 1, "the first click removed the row");
      assert.equal(await page.evaluate(() => [...document.querySelectorAll('#cEps input[data-k="path"]')].some((i) => i.value === "/orders/{id}")), false, "the removed row is the one that was edited");
    });

    await check("TC-028: changing a method or path still renames ids and refreshes the setup lists", async () => {
      const paths = page.locator('#cEps input[data-k="path"]');
      await paths.nth(0).fill("/orders");
      await paths.nth(1).fill("/orders");
      await page.locator('#cEps .ep-edit[data-i="1"] select[data-k="method"]').selectOption("POST");
      await paths.nth(0).click();
      assert.deepEqual((await page.locator("#cEps .ep-id").allTextContents()).slice(0, 2), ["id: get-orders", "id: post-orders"]);
      const options = await page.locator('#cEps .ep-edit[data-i="0"] select[data-k="setupFrom"] option').allTextContents();
      assert.deepEqual(options, ["None", "post-orders"], "the POST of row 2 is offered as setup for row 1");
    });

    await check("TC-023: Run is disabled with the reason while the JSON does not parse, and comes back when it is fixed", async () => {
      await selectSaved(page, "local-shop.json");
      assert.deepEqual(await runState(page), { disabled: false, hint: "" }, "a valid saved input can run");
      const good = await page.inputValue("#jsonBox");
      await page.click("#toggleJson");
      await page.fill("#jsonBox", good.slice(0, -3));
      await page.waitForTimeout(400);
      assert.deepEqual(await runState(page), { disabled: true, hint: "Fix the JSON error above before running." });
      const broken = JSON.parse(good);
      delete broken.defaultHeaders;
      await page.fill("#jsonBox", JSON.stringify(broken, null, 2));
      await page.waitForFunction(() => !document.getElementById("jsonErr").classList.contains("hidden") && /defaultHeaders/.test(document.getElementById("jsonErr").textContent));
      assert.deepEqual(await runState(page), { disabled: true, hint: "Fix the input problems shown above before running." });
      assert.match(await page.textContent("#jsonErr"), /defaultHeaders/);
      await page.fill("#jsonBox", good);
      await page.waitForFunction(() => !document.getElementById("runBtn").disabled);
      assert.deepEqual(await runState(page), { disabled: false, hint: "" });
    });

    await check("TC-050: a .pdf uploaded as the test case sheet is refused by its file type", async () => {
      await page.setInputFiles("#tcFile", { name: "report.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 fake pdf bytes") });
      await page.waitForFunction(() => !document.getElementById("tcErr").classList.contains("hidden"));
      assert.match(await page.textContent("#tcErr"), /report\.pdf is not a test case sheet: upload a \.csv, \.tsv, \.txt, \.xlsx file/);
    });

    await check("the page threw no script errors", async () => {
      assert.deepEqual(errors, []);
    });
    await page.close();

    await stop(ui);
    ui = await startUi(PORT, { AGENT_FORCE_PRODUCTION: "1" });
    await check("TC-070: with AGENT_FORCE_PRODUCTION=1 a local input asks for the production tick, like the server", async () => {
      const { page: p2, errors: e2 } = await openPage(browser, PORT);
      await selectSaved(p2, "local-shop.json");
      assert.equal(await p2.isVisible("#prodBox"), true, "the production box is shown");
      assert.deepEqual(await runState(p2), { disabled: true, hint: 'Production host: tick "I understand this is a production host" to run.' });
      assert.equal((await (await p2.request.get(`http://127.0.0.1:${PORT}/api/session`)).json()).forceProduction, true);
      assert.deepEqual(e2, []);
      await p2.close();
    });
  } finally {
    await browser.close();
    await stop(ui);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
