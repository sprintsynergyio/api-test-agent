// Local demo API with a catalog of planted bugs. No dependencies. Run: node local-api/server.mjs
// In-memory product store. Data resets every time the server restarts.
//
// PLANTED BUGS: listed in local-api/bugs.json (the one source of truth, also read by the eval harness).
//   BUGS=<id,id,...>  turns on exactly those bugs. Unknown id: exit 1.
//   BUGS unset        turns on the catalog's default set (the two original demo bugs).
//   FIXED=1           turns every bug off (same as BUGS="").
// Set LOG_REQUESTS=1 to print "<METHOD> <path>" for every request (used to prove the safety guard).
// FAIL_DELETE_IDS=6,9 (tests only, not a planted bug): DELETE /products/<id> answers 500 for those ids,
// so npm run test:cleanup can prove a failed cleanup is reported and never hidden.

import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT || 4000);
const TOKEN = "Bearer hackathon-demo-token";
const LOG_REQUESTS = process.env.LOG_REQUESTS === "1";
const FAIL_DELETE_IDS = new Set((process.env.FAIL_DELETE_IDS ?? "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0));

// Login (POST /auth/login with { username, password }) for input/local-shop-login.json. Demo users
// of a fake local API: admin can do everything the fixed token can, viewer can only read. Issued
// tokens are random per login and accepted anywhere the fixed token is.
const USERS = { admin: { password: "admin-pass", role: "admin" }, viewer: { password: "viewer-pass", role: "viewer" } };
const issuedTokens = new Map(); // "Bearer <token>" -> role

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

// The caller's role from the Authorization header: "admin" for the fixed demo token or an admin
// login token, "viewer" for a viewer login token, null without a valid token.
function roleOf(req) {
  const value = req.headers["authorization"];
  if (value === TOKEN) return "admin";
  return issuedTokens.get(value) ?? null;
}

function authed(req) {
  return roleOf(req) !== null;
}

// Writes need the admin role. viewer-can-delete: DELETE forgets the role check and lets a viewer through.
function canWrite(req, { bugId } = {}) {
  const role = roleOf(req);
  if (role === null) return false;
  if (role === "admin") return true;
  return bugId ? bug(bugId) : false;
}

function randomToken() {
  return [...Array(24)].map(() => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("");
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

// Reviews live under a product. POST needs auth, DELETE needs auth, GET is public.
let nextReviewId = 1;
const reviews = new Map(); // reviewId -> { id, productId, rating, text, createdAt }

async function handleReviews(req, res, parts) {
  const productId = Number(parts[1]);
  if (!Number.isInteger(productId) || productId < 1) return send(res, 400, { error: "id must be a positive integer" });
  if (!products.has(productId)) return send(res, 404, { error: "product not found" });

  if (parts.length === 3) {
    if (req.method === "GET") {
      return send(res, 200, [...reviews.values()].filter((r) => r.productId === productId));
    }
    if (req.method === "POST") {
      if (!authed(req)) return send(res, 401, { error: "unauthorized" });
      if (!canWrite(req)) return send(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      if (!body.ok) return send(res, 400, { error: "invalid JSON" });
      const b = body.value;
      const errors = [];
      if (!b || typeof b !== "object") errors.push("body must be a JSON object");
      else {
        if (!Number.isInteger(b.rating) || b.rating < 1 || b.rating > 5) errors.push("rating is required and must be an integer from 1 to 5");
        if (typeof b.text !== "string" || b.text.trim() === "") errors.push("text is required and must be a non-empty string");
      }
      if (errors.length) return send(res, 400, { error: "validation failed", details: errors });
      const review = { id: nextReviewId++, productId, rating: b.rating, text: b.text, createdAt: new Date().toISOString() };
      reviews.set(review.id, review);
      return send(res, 201, review);
    }
    return send(res, 405, { error: "method not allowed" });
  }

  const reviewId = Number(parts[3]);
  if (!Number.isInteger(reviewId) || reviewId < 1) return send(res, 400, { error: "reviewId must be a positive integer" });
  const review = reviews.get(reviewId);
  if (req.method === "GET") {
    if (!review || review.productId !== productId) return send(res, 404, { error: "review not found" });
    return send(res, 200, review);
  }
  if (req.method === "DELETE") {
    if (!authed(req)) return send(res, 401, { error: "unauthorized" });
    if (!canWrite(req)) return send(res, 403, { error: "forbidden" });
    if (!review || review.productId !== productId) return send(res, 404, { error: "review not found" });
    reviews.delete(reviewId);
    res.writeHead(204);
    return res.end();
  }
  return send(res, 405, { error: "method not allowed" });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (LOG_REQUESTS) console.log(`${req.method} ${url.pathname}${url.search}`);
  const parts = url.pathname.split("/").filter(Boolean);

  if (parts[0] === "health" && parts.length === 1 && req.method === "GET") {
    return send(res, 200, { status: "ok", bugsEnabled: BUGS.size > 0, bugs: [...BUGS] });
  }
  // POST /auth/login: { username, password } -> { data: { token } }. Wrong credentials: 401.
  if (parts[0] === "auth" && parts[1] === "login" && parts.length === 2) {
    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
    const body = await readBody(req);
    if (!body.ok || !body.value || typeof body.value !== "object") return send(res, 400, { error: "invalid JSON" });
    const user = USERS[body.value.username];
    if (!user || user.password !== body.value.password) return send(res, 401, { error: "invalid credentials" });
    const token = randomToken();
    issuedTokens.set(`Bearer ${token}`, user.role);
    return send(res, 200, { data: { token, role: user.role } });
  }
  // /products/:id/reviews and /products/:id/reviews/:reviewId (nested resource, used by
  // input/local-shop-nested.json to prove paths with more than one placeholder).
  if (parts[0] === "products" && parts[2] === "reviews" && (parts.length === 3 || parts.length === 4)) {
    return handleReviews(req, res, parts);
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
      let list = [...products.values()];
      // Query parameters: category=<name> filters, limit=<n> cuts the list (used to prove endpoint query support).
      const category = url.searchParams.get("category");
      if (category !== null) list = list.filter((p) => p.category === category);
      const limit = url.searchParams.get("limit");
      if (limit !== null) {
        const n = Number(limit);
        if (!Number.isInteger(n) || n < 1) return send(res, 400, { error: "limit must be a positive integer" });
        list = list.slice(0, n);
      }
      // list-wrong-type: the list comes wrapped in an object instead of a bare array.
      if (bug("list-wrong-type")) return send(res, 200, { items: list });
      return send(res, 200, list);
    }
    if (req.method === "POST") {
      if (!authed(req)) return send(res, 401, { error: "unauthorized" });
      if (!canWrite(req)) return send(res, 403, { error: "forbidden" });
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
    // update-no-auth: the missing-token check is skipped (a token that is present is still checked).
    if (!bug("update-no-auth") && !authed(req)) return send(res, 401, { error: "unauthorized" });
    if (authed(req) && !canWrite(req)) return send(res, 403, { error: "forbidden" });
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
    // delete-no-auth: the missing-token check is skipped (a token that is present is still checked).
    if (!bug("delete-no-auth") && !authed(req)) return send(res, 401, { error: "unauthorized" });
    // viewer-can-delete: the role check is skipped, so a viewer's token can delete.
    if (authed(req) && !canWrite(req, { bugId: "viewer-can-delete" })) return send(res, 403, { error: "forbidden" });
    if (!existing) return send(res, 404, { error: "product not found" });
    if (FAIL_DELETE_IDS.has(id)) return send(res, 500, { error: "internal server error (FAIL_DELETE_IDS test hook)" });
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
