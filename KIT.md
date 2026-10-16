# Hackathon Test Kit

Everything the agent needs to test against: two APIs and three input files.

## What is in the kit

| File | Purpose |
|---|---|
| input/endpoints.json | Main demo. Restful Booker (public API), 5 endpoints |
| input/demo-small.json | Fast live run. Restful Booker, 3 endpoints, no auth |
| input/local-shop.json | Backup demo. Local shop API on your Mac, 5 endpoints |
| local-api/server.mjs | The local shop API. No install needed, just Node |
| .env.example | All environment values the agent needs |

## API 1: Restful Booker (public)

Base URL: https://restful-booker.herokuapp.com
Auth: Basic auth, user admin, password password123 (already encoded in .env.example)
Use it for: the main demo. Real public API, no setup.
Risk: free server, can be slow or down.

## API 2: Local shop API (backup, runs on your Mac)

Base URL: http://localhost:4000
Auth: header `Authorization: Bearer hackathon-demo-token`

Endpoints:
- GET /products (public)
- POST /products (needs auth)
- GET /products/{id} (public)
- PUT /products/{id} (needs auth)
- DELETE /products/{id} (needs auth)
- GET /health (check the server is up)

It has two planted bugs, so your agent has something real to catch:
1. POST /products with price as text (for example "ten") returns 500. Correct answer is 400.
2. DELETE /products/{id} works without a token. Correct answer is 401.

Start it with bugs ON (the demo):
```
node local-api/server.mjs
```
Expected output: `Local shop API running on http://localhost:4000  (bugs ON)`

Start it with bugs OFF (to show the suite going green after the "fix"):
```
FIXED=1 node local-api/server.mjs
```
Expected output: `Local shop API running on http://localhost:4000  (bugs OFF)`

Stop it: press Ctrl+C in that terminal.

Data lives in memory and resets on every restart. Three products are seeded with ids 1, 2 and 3.

## Verified behaviour (bugs ON)

| Request | Status |
|---|---|
| GET /health | 200 |
| GET /products | 200 |
| POST /products valid, with token | 201 |
| POST /products without token | 401 |
| POST /products missing fields | 400 |
| POST /products price "ten" | 500 (BUG 1) |
| GET /products/1 | 200 |
| GET /products/999 | 404 |
| PUT /products/1 without token | 401 |
| PUT /products/1 bad body | 400 |
| DELETE /products/2 without token | 204 (BUG 2) |

With FIXED=1: price "ten" gives 400, DELETE without token gives 401.
