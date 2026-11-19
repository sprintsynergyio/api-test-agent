// npm run test:ui-layout: opens the UI in headless Chromium at several window widths and browser zoom levels
// and checks the layout: the input column and the pipeline/runs column never overlap, no element sticks out
// of its card, the page never scrolls sideways, and no placeholder, select option, label, tab or segmented
// button has its text cut off. The saved input is a stress fixture served through
// page.route (nothing is written to input/): a long input name, a long base URL, a long .env variable name
// that is not set, and a long endpoint path. Recent runs are faked the same way. Offline: no agent run, no
// model call. Needs Chromium for Playwright (npx playwright install chromium).
// Set LAYOUT_SCREENSHOTS=<folder> to also save a full-page screenshot per case.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UI_PORT = Number(process.env.UI_LAYOUT_PORT || 3880);
const BASE = `http://127.0.0.1:${UI_PORT}`;
const SHOTS = process.env.LAYOUT_SCREENSHOTS ? path.resolve(process.env.LAYOUT_SCREENSHOTS) : "";

const STRESS_NAME = "example-media-service-staging-environment-full-regression-suite-v2.json";
const STRESS = {
  name: "example-media-service-staging-environment-full-regression-suite-v2",
  baseUrl: "http://localhost:4000/organisations/example-organisation/media-service/api/v2/staging",
  defaultHeaders: { Accept: "application/json, image/*", "Content-Type": "application/json" },
  auth: { header: "Authorization", valueEnv: "EXAMPLE_MEDIA_SERVICE_STAGING_ENVIRONMENT_AUTH_HEADER_VALUE_NOT_SET" },
  endpoints: [
    { id: "list-photos", method: "GET", path: "/photos", requiresAuth: true, query: { page: 1, per_page: 3 } },
    { id: "get-rendition", method: "GET", path: "/organisations/{organisationId}/workspaces/{workspaceId}/media-libraries/{libraryId}/assets/{assetId}/renditions/thumbnail", requiresAuth: true },
    { id: "resize-photo", method: "POST", path: "/resize", requiresAuth: true, body: { photo_id: 101, width: 320, height: 240 } },
    { id: "delete-photo", method: "DELETE", path: "/photos/{id}", requiresAuth: true },
  ],
};
const RUNS = [
  { id: "a".repeat(24), name: STRESS.name, testFramework: "playwright", findings: 3, tests: 17, finishedAt: Date.now() - 60000, status: "completed", exitCode: 1 },
  { id: "b".repeat(24), name: "local-shop", testFramework: "pactum", findings: 0, tests: 12, finishedAt: Date.now() - 120000, status: "completed", exitCode: 0 },
];

// [label, window width, browser zoom]. Browser zoom is emulated the way the browser does it: the page sees a
// viewport of width / zoom CSS pixels drawn at zoom device pixels per CSS pixel.
const CASES = [
  ["1920", 1920, 1], ["1536", 1536, 1], ["1440", 1440, 1], ["1366", 1366, 1], ["1280", 1280, 1], ["1101", 1101, 1], ["1100", 1100, 1], ["1024", 1024, 1],
  ["900", 900, 1], ["768", 768, 1], ["390", 390, 1], ["1280-zoom125", 1280, 1.25], ["1280-zoom150", 1280, 1.5],
];

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

function startUi() {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, UI_PORT: String(UI_PORT), SKIP_CLI_DETECT: "1", ENV_FILE: path.join(ROOT, "ui", "ui.test.env.none") };
    for (const k of ["HOSTED", "UI_USERS", "AGENT_FORCE_PRODUCTION"]) delete env[k];
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

// Runs in the page. Returns the layout problems it finds, as strings.
function layoutProblems() {
  const problems = [];
  const r = (el) => el.getBoundingClientRect();
  const fmt = (b) => `${Math.round(b.left)}..${Math.round(b.right)} x ${Math.round(b.top)}..${Math.round(b.bottom)}`;
  const label = (el) => `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\s+/).join(".") : ""}`;
  const visible = (el) => {
    const b = r(el);
    if (!b.width || !b.height) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  };

  const docW = document.documentElement.scrollWidth;
  if (docW > window.innerWidth + 1) problems.push(`the page scrolls sideways: ${docW}px wide in a ${window.innerWidth}px viewport`);

  const grid = document.getElementById("mainGrid");
  const [left, right] = [...grid.children];
  const L = r(left);
  const R = r(right);
  const cols = getComputedStyle(grid).gridTemplateColumns.split(" ").length;
  const intersect = L.left < R.right - 1 && R.left < L.right - 1 && L.top < R.bottom - 1 && R.top < L.bottom - 1;
  if (intersect) problems.push(`the columns overlap: left ${fmt(L)}, right ${fmt(R)}`);
  if (cols === 2 && L.right > R.left + 0.5) problems.push(`the left column runs into the right one: left ends at ${L.right}, right starts at ${R.left}`);
  if (cols === 1 && L.bottom > R.top + 0.5) problems.push(`stacked columns overlap: left ends at ${L.bottom}, right starts at ${R.top}`);

  // Every card must fit its column, and everything in a card must fit the card, or the nearest box that
  // clips it.
  for (const [col, C] of [[left, L], [right, R]]) {
    for (const card of col.querySelectorAll(":scope > .card")) {
      if (!visible(card)) continue;
      const cb = r(card);
      if (cb.left < C.left - 1 || cb.right > C.right + 1) problems.push(`${label(card)} (${fmt(cb)}) is wider than its column (${fmt(C)})`);
    }
  }
  for (const card of document.querySelectorAll(".card")) {
    if (!visible(card)) continue;
    for (const el of card.querySelectorAll("*")) {
      if (!visible(el) || el.closest("option, svg")) continue;
      // Inside a box that scrolls sideways (the runs table, the log), content may be wider than the box: it
      // scrolls. That box itself is checked against the card. Inside a box that clips, content must fit it.
      let box = card;
      let scrolls = false;
      for (let a = el.parentElement; a && a !== card; a = a.parentElement) {
        const ox = getComputedStyle(a).overflowX;
        if (ox === "auto" || ox === "scroll") { scrolls = true; break; }
        if (ox !== "visible") { box = a; break; }
      }
      if (scrolls) continue;
      const b = r(el);
      const bb = r(box);
      if (b.left < bb.left - 1 || b.right > bb.right + 1) {
        problems.push(`${label(el)} (${fmt(b)}) sticks out of ${box === card ? "its card " + label(card) : label(box)} (${fmt(bb)})`);
        if (problems.length > 12) return problems;
      }
    }
  }
  return problems;
}

// Runs in the page. Returns text that does not fit its control, as strings: a placeholder or a selected
// value cut off inside its input or select, an option wider than its select (the native dropdown would
// spill out of the column), labels, tabs and segmented buttons whose text is clipped or ellipsed, and help
// text or labels cut off at the bottom.
function truncationProblems() {
  const problems = [];
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const label = (el) => `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${el.dataset && (el.dataset.fw || el.dataset.mode) ? "[" + (el.dataset.fw || el.dataset.mode) + "]" : ""}`;
  const visible = (el) => {
    const b = el.getBoundingClientRect();
    if (!b.width || !b.height) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  };
  const textWidth = (el, text) => {
    const cs = getComputedStyle(el);
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    return ctx.measureText(text).width;
  };
  const contentWidth = (el) => {
    const cs = getComputedStyle(el);
    return el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  };
  for (const el of document.querySelectorAll("input.txt, input.sm")) {
    if (!visible(el)) continue;
    const text = el.value || el.placeholder;
    if (!text || el.type === "password") continue;
    if (el.value && el === document.activeElement) continue;
    // A typed value may scroll (a long URL); a placeholder is the label of an empty field and must fit.
    if (!el.value) {
      const w = textWidth(el, text);
      if (w > contentWidth(el) + 1) problems.push(`${label(el)}: the placeholder "${text}" is cut off (${Math.round(w)}px of text in ${Math.round(contentWidth(el))}px)`);
    }
  }
  for (const el of document.querySelectorAll("select")) {
    // The saved-input list holds the user's own file names (the stress fixture's is 66 characters); its
    // closed value ellipses. Every other select has fixed option text, written to fit.
    if (!visible(el) || el.id === "inputSel") continue;
    const room = contentWidth(el) - 16; // the arrow
    for (const o of el.options) {
      const w = textWidth(el, o.text);
      if (w > room + 1) problems.push(`${label(el)}: option "${o.text}" is wider than its select (${Math.round(w)}px in ${Math.round(room)}px)`);
    }
  }
  for (const el of document.querySelectorAll(".seg button, .tab, label.lbl, .radio-card .t, .radio-card .d, .check, .btn, .pill, .tag")) {
    if (!visible(el)) continue;
    if (el.scrollWidth > el.clientWidth + 1) problems.push(`${label(el)}: "${el.textContent.trim().slice(0, 60)}" is clipped (${el.scrollWidth}px in ${el.clientWidth}px)`);
  }
  // Vertical clipping: help text, descriptions and labels must show every line. A text box that clips
  // (overflow hidden or clip, or a line clamp) must not have more text than it shows, and no ancestor up
  // to the card may clip it. Boxes that scroll (log, tables, code) are skipped: their content scrolls.
  for (const el of document.querySelectorAll(".hint, .help, .desc, .legend, label, .radio-card .t, .radio-card .d, .empty-state .sub, .empty-state .ttl, .step .t, .step .s, .card-h h2, .card-meta, p")) {
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    const clamp = cs.webkitLineClamp || cs.getPropertyValue("line-clamp");
    if (clamp && clamp !== "none") problems.push(`${label(el)}: "${el.textContent.trim().slice(0, 60)}" uses a line clamp (${clamp})`);
    if (/hidden|clip/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1) problems.push(`${label(el)}: "${el.textContent.trim().slice(0, 60)}" is cut off at the bottom (${el.scrollHeight}px in ${el.clientHeight}px)`);
    const b = el.getBoundingClientRect();
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const oy = getComputedStyle(a).overflowY;
      if (oy === "auto" || oy === "scroll") break;
      if (oy === "hidden" || oy === "clip") {
        const ab = a.getBoundingClientRect();
        if (b.bottom > ab.bottom + 1 || b.top < ab.top - 1) problems.push(`${label(el)}: "${el.textContent.trim().slice(0, 60)}" is clipped by ${label(a)} (text ${Math.round(b.top)}..${Math.round(b.bottom)}, box ${Math.round(ab.top)}..${Math.round(ab.bottom)})`);
        break;
      }
      if (a.classList.contains("card")) break;
    }
  }
  for (const el of document.querySelectorAll(".seg button")) {
    if (!visible(el)) continue;
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 20;
    if (el.getBoundingClientRect().height > Math.max(lh * 1.6, 36)) problems.push(`${label(el)}: segmented button text wraps`);
  }
  return problems;
}

async function main() {
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const ui = await startUi();
  const browser = await chromium.launch();
  try {
    for (const [name, width, zoom] of CASES) {
      const context = await browser.newContext({ viewport: { width: Math.round(width / zoom), height: Math.round(900 / zoom) }, deviceScaleFactor: zoom });
      const page = await context.newPage();
      await page.route("**/api/inputs", async (route) => {
        const res = await route.fetch();
        const files = await res.json();
        await route.fulfill({ json: [...files, STRESS_NAME] });
      });
      await page.route("**/api/input?*", async (route) => {
        if (new URL(route.request().url()).searchParams.get("name") === STRESS_NAME) return route.fulfill({ json: { name: STRESS_NAME, content: JSON.stringify(STRESS, null, 2) } });
        return route.continue();
      });
      await page.route("**/api/runs", (route) => route.fulfill({ json: RUNS }));
      try {
        await page.goto(BASE);
        await page.waitForFunction(() => document.querySelectorAll("#epList li").length > 0);

        await check(`${name}: the default saved input`, async () => {
          const p = await page.evaluate(layoutProblems);
          assert.deepEqual(p, []);
        });
        await check(`${name}: no cut-off placeholders, options, labels or buttons`, async () => {
          const p = await page.evaluate(truncationProblems);
          assert.deepEqual(p, []);
        });
        // Both extra-test options ticked: their endpoint-id fields show and must fit too.
        await page.evaluate(() => ["optInvalid", "optStable"].forEach((id) => document.getElementById(id).click()));
        await page.waitForTimeout(50);
        await check(`${name}: run options with every extra test ticked`, async () => {
          const p = [...(await page.evaluate(layoutProblems)), ...(await page.evaluate(truncationProblems))];
          assert.deepEqual(p, []);
        });
        await page.evaluate(() => ["optInvalid", "optStable"].forEach((id) => document.getElementById(id).click()));

        await page.selectOption("#inputSel", STRESS_NAME);
        await page.waitForFunction(() => document.querySelectorAll("#epList li").length === 4 && /NOT_SET/.test(document.getElementById("authBox").textContent));
        await page.waitForTimeout(150);
        await check(`${name}: long input name, base URL, .env variable and path`, async () => {
          const p = await page.evaluate(layoutProblems);
          assert.deepEqual(p, []);
        });
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `ui-${name}.png`), fullPage: true });

        // The main grid is dimmed (no pointer events) until a model is set up, so the tabs are clicked from script.
        for (const [tab, id] of [["Build", "tabCustom"], ["Import", "tabImport"]]) {
          await page.evaluate((id) => document.getElementById(id).click(), id);
          await page.waitForTimeout(100);
          await check(`${name}: ${tab} tab`, async () => {
            const p = [...(await page.evaluate(layoutProblems)), ...(await page.evaluate(truncationProblems))];
            assert.deepEqual(p, []);
          });
        }
      } finally {
        await context.close();
      }
    }
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
