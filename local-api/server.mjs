// Local backup demo API for the hackathon. No dependencies. Run: node local-api/server.mjs
// In-memory product store. Data resets every time the server restarts.
//
// TWO PLANTED BUGS (for the "agent found a bug" demo moment):
//   BUG 1: POST /products with a non-number price returns 500 instead of 400.
//   BUG 2: DELETE /products/:id does not check the auth token (anyone can delete).
// Set FIXED=1 to turn both bugs off and show the suite going green.
// Set LOG_REQUESTS=1 to print "<METHOD> <path>" for every request (used to prove the safety guard).

import http from "node:http";

const PORT = Number(process.env.PORT || 4000);
const TOKEN = "Bearer hackathon-demo-token";
const FIXED = process.env.FIXED === "1";
const LOG_REQUESTS = process.env.LOG_REQUESTS === "1";

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
function validate(b, { checkPriceType }) {
  const errors = [];
  if (!b || typeof b !== "object") return ["body must be a JSON object"];
  if (typeof b.name !== "string" || b.name.trim() === "") errors.push("name is required and must be a non-empty string");
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
    return send(res, 200, { status: "ok", bugsEnabled: !FIXED });
  }
  if (parts[0] !== "products" || parts.length > 2) {
    return send(res, 404, { error: "not found" });
  }

  const id = parts.length === 2 ? Number(parts[1]) : null;
  if (parts.length === 2 && (!Number.isInteger(id) || id < 1)) {
    return send(res, 400, { error: "id must be a positive integer" });
  }

  // /products
  if (id === null) {
    if (req.method === "GET") {
      return send(res, 200, [...products.values()]);
    }
    if (req.method === "POST") {
      if (!authed(req)) return send(res, 401, { error: "unauthorized" });
      const body = await readBody(req);
      if (!body.ok) return send(res, 400, { error: "invalid JSON" });
      const errors = validate(body.value, { checkPriceType: FIXED });
      if (errors.length) return send(res, 400, { error: "validation failed", details: errors });
      // BUG 1: without the type check, a string price crashes here.
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
    if (!authed(req)) return send(res, 401, { error: "unauthorized" });
    if (!existing) return send(res, 404, { error: "product not found" });
    const body = await readBody(req);
    if (!body.ok) return send(res, 400, { error: "invalid JSON" });
    const errors = validate(body.value, { checkPriceType: true });
    if (errors.length) return send(res, 400, { error: "validation failed", details: errors });
    const updated = {
      ...existing,
      name: body.value.name,
      price: body.value.price,
      category: body.value.category,
      inStock: body.value.inStock,
      updatedAt: new Date().toISOString(),
    };
    products.set(id, updated);
    return send(res, 200, updated);
  }
  if (req.method === "DELETE") {
    // BUG 2: auth check skipped unless FIXED=1.
    if (FIXED && !authed(req)) return send(res, 401, { error: "unauthorized" });
    if (!existing) return send(res, 404, { error: "product not found" });
    products.delete(id);
    res.writeHead(204);
    return res.end();
  }
  return send(res, 405, { error: "method not allowed" });
});

server.listen(PORT, () => {
  console.log(`Local shop API running on http://localhost:${PORT}  (bugs ${FIXED ? "OFF" : "ON"})${LOG_REQUESTS ? "  (logging requests)" : ""}`);
});
