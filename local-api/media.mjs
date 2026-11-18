// Media routes of the local demo API, under the base path /media/v1 (input/local-media.json uses
// baseUrl http://localhost:4000/media/v1, so it also proves a base URL with a path). Read-only data
// that never changes: a paged photo list, image downloads and a resize call that answers with a PNG.
// Bad input answers 400 with a JSON error, an unknown photo 404. No planted bugs here.

// A 1x1 PNG and a 1x1 JPEG: real file signatures (89 50 4E 47 and FF D8 FF).
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=", "base64");

const CATEGORIES = ["shoes", "tops", "bags"];
const PHOTOS = [
  ["Canvas Tote", "bags"], ["Denim Jacket", "tops"], ["Hiking Boot", "shoes"], ["Linen Shirt", "tops"], ["Running Shoe", "shoes"], ["Travel Backpack", "bags"], ["Wool Sweater", "tops"],
].map(([title, category], i) => ({ id: 101 + i, title, category, download_url: `/media/v1/files/${101 + i}.png` }));
const byId = new Map(PHOTOS.map((p) => [p.id, p]));

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function image(res, bytes, type) {
  res.writeHead(200, { "Content-Type": type, "Content-Length": String(bytes.length), "Cache-Control": "public, max-age=3600" });
  res.end(bytes);
}

// A positive integer query value, its default when missing, or null when invalid.
function positiveInt(value, fallback, max) {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return n >= 1 && n <= max ? n : null;
}

// parts: the path after /media/v1, split on "/". readBody: the server's JSON body reader.
export async function handleMedia(req, res, parts, url, readBody) {
  // GET /photos?page=1&per_page=10&category=shoes: a paged, read-only list.
  if (parts[0] === "photos" && parts.length === 1) {
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "method not allowed" });
    const page = positiveInt(url.searchParams.get("page"), 1, 10_000);
    if (page === null) return json(res, 400, { error: "page must be a positive integer", field: "page" });
    const perPage = positiveInt(url.searchParams.get("per_page"), 10, 50);
    if (perPage === null) return json(res, 400, { error: "per_page must be an integer from 1 to 50", field: "per_page" });
    const category = url.searchParams.get("category");
    if (category !== null && !CATEGORIES.includes(category)) return json(res, 400, { error: `category must be one of ${CATEGORIES.join(", ")}`, field: "category" });
    const all = category ? PHOTOS.filter((p) => p.category === category) : PHOTOS;
    const data = all.slice((page - 1) * perPage, page * perPage);
    return json(res, 200, { data, page, per_page: perPage, total: all.length, total_pages: Math.max(1, Math.ceil(all.length / perPage)) });
  }
  // GET /thumbnail?format=png|jpeg: an image, cacheable.
  if (parts[0] === "thumbnail" && parts.length === 1) {
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "method not allowed" });
    const format = url.searchParams.get("format") ?? "png";
    if (format === "png") return image(res, PNG, "image/png");
    if (format === "jpeg" || format === "jpg") return image(res, JPEG, "image/jpeg");
    return json(res, 400, { error: "format must be png or jpeg", field: "format" });
  }
  // GET /files/<id>.png: the photo's image.
  if (parts[0] === "files" && parts.length === 2) {
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "method not allowed" });
    if (!byId.has(Number(parts[1].replace(/\.png$/, "")))) return json(res, 404, { error: "file not found" });
    return image(res, PNG, "image/png");
  }
  // POST /resize { photo_id, width, height }: the resized photo as a PNG. Nothing is stored.
  if (parts[0] === "resize" && parts.length === 1) {
    if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
    const body = await readBody(req);
    if (!body.ok || !body.value || typeof body.value !== "object") return json(res, 400, { error: "body must be a JSON object" });
    const { photo_id: id, width, height } = body.value;
    if (!Number.isInteger(id)) return json(res, 400, { error: "photo_id is required and must be an integer", field: "photo_id" });
    for (const [name, v] of [["width", width], ["height", height]]) {
      if (!Number.isInteger(v) || v < 1 || v > 4096) return json(res, 400, { error: `${name} must be an integer from 1 to 4096`, field: name });
    }
    if (!byId.has(id)) return json(res, 404, { error: "photo not found" });
    return image(res, PNG, "image/png");
  }
  return json(res, 404, { error: "not found" });
}

export const MEDIA_PHOTOS = PHOTOS;
