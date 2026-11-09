// Local demo API with a catalog of planted bugs. No dependencies. Run: node local-api/server.mjs
// In-memory product store. Data resets every time the server restarts.
//
// PLANTED BUGS: listed in local-api/bugs.json (the one source of truth, also read by the eval harness).
//   BUGS=<id,id,...>  turns on exactly those bugs. Unknown id: exit 1.
//   BUGS unset        turns on the catalog's default set (the two original demo bugs).
//   FIXED=1           turns every bug off (same as BUGS="").
// Set LOG_REQUESTS=1 to print "<METHOD> <path>" for every request (used to prove the safety guard).

import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT || 4000);
const TOKEN = "Bearer hackathon-demo-token";
const LOG_REQUESTS = process.env.LOG_REQUESTS === "1";

const catalog = JSON.parse(readFileSync(fileURLToPath(new URL("./bugs.json", import.meta.url)), "utf8"));
const KNOWN = new Set(catalog.bugs.map((b) => b.id));

function activeBugs() {
  if (process.env.FIXED === "1") return new Set();
  if (process.env.BUGS === undefined) return new Set(catalog.default);
  const ids = process.env.BUGS.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = ids.filter((id) => !KNOWN.has(id));
  if (unknown.length) {
    console.error(`Unknown bug id(s) in BUGS: ${unknown.join(", ")}. Known ids: ${[...KNOWN].join(", ")}`);
    process.exit(1);
  }
  return new Set(ids);
}

const BUGS = activeBugs();
const bug = (id) => BUGS.has(id);

let nextId = 1;
const products = new Map();

const seed = [
  { name: "Classic Tee", price: 19.99, category: "tops", inStock: true },
  { name: "Yoga Legging", price: 59.0, category: "bottoms", inStock: true },
  { name: "Rain Jacket", price: 120.0, category: "outerwear", inStock: false },
];
for (const p of seed) {
  const id = nextId++;
  products.set(id, { id, ...p, createdAt: new Date().toISOString() });
}

function send(res, status, body) {
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (!raw) return resolve({ ok: true, value: undefined });
      try {
        resolve({ ok: true, value: JSON.parse(raw) });
      } catch {
        resolve({ ok: false });
      }
    });
  });
}

function authed(req) {
  return req.headers["authorization"] === TOKEN;
}

// Returns a list of problems. Empty list means valid.
function validate(b, { checkPriceType, checkName }) {
  const errors = [];
  if (!b || typeof b !== "object") return ["body must be a JSON object"];
  if (checkName && (typeof b.name !== "string" || b.name.trim() === "")) errors.push("name is required and must be a non-empty string");
  if (b.price === undefined) errors.push("price is required");
  else if (checkPriceType && (typeof b.price !== "number" || b.price < 0)) errors.push("price must be a non-negative number");
  if (typeof b.category !== "string" || b.category.trim() === "") errors.push("category is required and must be a string");
  if (typeof b.inStock !== "boolean") errors.push("inStock is required and must be a boolean");
  return errors;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (LOG_REQUESTS) console.log(`${req.method} ${url.pathname}`);
  const parts = url.pathname.split("/").filter(Boolean);

  if (parts[0] === "health" && parts.length === 1 && req.method === "GET") {
    return send(res, 200, { status: "ok", bugsEnabled: BUGS.size > 0, bugs: [...BUGS] });
  }
  if (parts[0] !== "products" || parts.length > 2) {
    return send(res, 404, { error: "not found" });
  }

  const id = parts.length === 2 ? Number(parts[1]) : null;
  if (parts.length === 2 && (!Number.isInteger(id) || id < 1)) {
    // get-bad-id-500: a non-numeric id crashes the GET instead of a 400.
    if (req.method === "GET" && bug("get-bad-id-500")) return send(res, 500, { error: "internal server error" });
    return send(res, 400, { error: "id must be a positive integer" });
  }

  // /products
  if (id === null) {
    if (req.method === "GET") {
      const list = [...products.values()];
      // list-wrong-type: the list comes wrapped in an object instead of a bare array.
      if (bug("list-wrong-type")) return send(res, 200, { items: list });
      return send(res, 200, list);
    }
    if (req.method === "POST") {
      if (!authed(req)) return send(res, 401, { error: "unauthorized" });
      const body = await readBody(req);
      if (!body.ok) return send(res, 400, { error: "invalid JSON" });
      // price-text-500: the price type is not validated, so a string price crashes below.
      // create-accepts-missing-name: the name is not validated.
      const errors = validate(body.value, { checkPriceType: !bug("price-text-500"), checkName: !bug("create-accepts-missing-name") });
      if (errors.length) return send(res, 400, { error: "validation failed", details: errors });
      if (typeof body.value.price !== "number") {
        return send(res, 500, { error: "internal server error" });
      }
      const newId = nextId++;
      const product = {
        id: newId,
        name: body.value.name,
        price: body.value.price,
        category: body.value.category,
        inStock: body.value.inStock,
        createdAt: new Date().toISOString(),
      };
      products.set(newId, product);
      return send(res, 201, product);
    }
    return send(res, 405, { error: "method not allowed" });
  }

  // /products/:id
  const existing = products.get(id);
  if (req.method === "GET") {
    if (!existing) return send(res, 404, { error: "product not found" });
    return send(res, 200, existing);
  }
  if (req.method === "PUT") {
    // update-no-auth: the auth check is skipped.
    if (!bug("update-no-auth") && !authed(req)) return send(res, 401, { error: "unauthorized" });
    if (!existing) return send(res, 404, { error: "product not found" });
    const body = await readBody(req);
    if (!body.ok) return send(res, 400, { error: "invalid JSON" });
    const errors = validate(body.value, { checkPriceType: true, checkName: true });
    if (errors.length) return send(res, 400, { error: "validation failed", details: errors });
    const updated = {
      ...existing,
      name: body.value.name,
      price: body.value.price,
      category: body.value.category,
      inStock: body.value.inStock,
      updatedAt: new Date().toISOString(),
    };
    // update-not-persisted: the response looks right but the store is not changed.
    if (!bug("update-not-persisted")) products.set(id, updated);
    return send(res, 200, updated);
  }
  if (req.method === "DELETE") {
    // delete-no-auth: the auth check is skipped.
    if (!bug("delete-no-auth") && !authed(req)) return send(res, 401, { error: "unauthorized" });
    if (!existing) return send(res, 404, { error: "product not found" });
    products.delete(id);
    res.writeHead(204);
    return res.end();
  }
  return send(res, 405, { error: "method not allowed" });
});

server.listen(PORT, () => {
  const bugsLine = BUGS.size ? `bugs ON: ${[...BUGS].join(",")}` : "bugs OFF";
  console.log(`Local shop API running on http://localhost:${PORT}  (${bugsLine})${LOG_REQUESTS ? "  (logging requests)" : ""}`);
});
