// Local stand-in for a Supabase project, for end-to-end tests only.
//   /rest/v1/*  -> a real PostgREST in front of a real Postgres with the hospital schema
//   /auth/v1/*  -> a tiny fake of Supabase Auth (password sign-in, user lookup, sign-out)
// Usage: node e2e/stack.mjs   (env: PGREST_BIN, PG_URI, STACK_PORT)
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

export const JWT_SECRET = "e2e-only-secret-that-is-at-least-32-characters-long";
const PORT = Number(process.env.STACK_PORT || 54321);
const PGREST_PORT = PORT + 9;
const PGREST_BIN = process.env.PGREST_BIN;
const PG_URI = process.env.PG_URI || "postgres://authenticator:pw@127.0.0.1:54329/hosp";

const b64 = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
export function sign(payload) {
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64(payload);
  const sig = crypto.createHmac("sha256", JWT_SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}
function verify(token) {
  const [h, b, s] = String(token || "").split(".");
  if (!h || !b || !s) return null;
  const want = crypto.createHmac("sha256", JWT_SECRET).update(`${h}.${b}`).digest("base64url");
  if (want.length !== s.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(s))) return null;
  const p = JSON.parse(Buffer.from(b, "base64url").toString());
  if (p.exp && p.exp < Date.now() / 1000) return null;
  return p;
}

const far = 4102444800; // fixed (year 2100) so the keys never change between runs
export const ANON_KEY = sign({ role: "anon", iss: "e2e", exp: far });
export const SERVICE_KEY = sign({ role: "service_role", iss: "e2e", exp: far });

export const USERS = [
  { email: "admin@clinic.test", password: "admin-pass-1234", role: "admin" },
  { email: "desk@clinic.test", password: "desk-pass-12345", role: "staff" },
  { email: "patient@clinic.test", password: "nope-pass-12345", role: null },
].map((u, i) => ({ ...u, id: `00000000-0000-4000-8000-00000000000${i + 1}` }));

function userObject(u) {
  return {
    id: u.id, aud: "authenticated", role: "authenticated", email: u.email,
    app_metadata: { provider: "email", ...(u.role ? { role: u.role } : {}) },
    user_metadata: {}, created_at: u.created_at ?? "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
    last_sign_in_at: u.last_sign_in_at ?? null,
  };
}
function session(u) {
  const now = Math.floor(Date.now() / 1000);
  const user = userObject(u);
  return {
    access_token: sign({ sub: u.id, role: "authenticated", aud: "authenticated", email: u.email, app_metadata: user.app_metadata, iat: now, exp: now + 3600 }),
    token_type: "bearer", expires_in: 3600, expires_at: now + 3600,
    refresh_token: `rt-${u.id}`, user,
  };
}

const readBody = (req) => new Promise((res) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => res(d)); });
const send = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS" }); res.end(obj === undefined ? "" : JSON.stringify(obj)); };

async function auth(req, res, path) {
  if (req.method === "OPTIONS") return send(res, 204);
  const url = new URL(req.url, "http://x");
  if (path === "/token" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const grant = url.searchParams.get("grant_type");
    let u;
    if (grant === "password") u = USERS.find((x) => x.email === body.email && x.password === body.password);
    if (grant === "refresh_token") u = USERS.find((x) => `rt-${x.id}` === body.refresh_token);
    if (!u) return send(res, 400, { error: "invalid_grant", error_description: "Invalid login credentials", code: "invalid_credentials", msg: "Invalid login credentials" });
    if (grant === "password") u.last_sign_in_at = new Date().toISOString();
    return send(res, 200, session(u));
  }
  if (path === "/user" && req.method === "GET") {
    const p = verify((req.headers.authorization || "").replace(/^Bearer /i, ""));
    const u = p && USERS.find((x) => x.id === p.sub);
    if (!u) return send(res, 401, { code: 401, error_code: "bad_jwt", msg: "invalid JWT" });
    return send(res, 200, userObject(u));
  }
  if (path === "/user" && req.method === "PUT") {
    const p = verify((req.headers.authorization || "").replace(/^Bearer /i, ""));
    const u = p && USERS.find((x) => x.id === p.sub);
    if (!u) return send(res, 401, { code: 401, error_code: "bad_jwt", msg: "invalid JWT" });
    const body = JSON.parse((await readBody(req)) || "{}");
    if (body.password) {
      if (String(body.password).length < 6) return send(res, 422, { code: 422, error_code: "weak_password", msg: "Password should be at least 6 characters." });
      u.password = body.password;
    }
    return send(res, 200, userObject(u));
  }
  if (path === "/logout") return send(res, 204);

  // ---- admin API (service-role key only) ----
  if (path.startsWith("/admin/users")) {
    const p = verify((req.headers.authorization || "").replace(/^Bearer /i, ""));
    if (!p || p.role !== "service_role") return send(res, 403, { code: 403, error_code: "not_admin", msg: "User not allowed" });
    const id = path.split("/")[3];
    if (!id && req.method === "GET") return send(res, 200, { users: USERS.map(userObject), aud: "authenticated" });
    if (!id && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (USERS.some((x) => x.email === String(body.email).toLowerCase())) return send(res, 422, { code: 422, error_code: "email_exists", msg: "A user with this email address has already been registered" });
      const u = { id: crypto.randomUUID(), email: String(body.email).toLowerCase(), password: body.password, role: body.app_metadata?.role ?? null, created_at: new Date().toISOString() };
      USERS.push(u);
      return send(res, 200, userObject(u));
    }
    const u = USERS.find((x) => x.id === id);
    if (!u) return send(res, 404, { code: 404, error_code: "user_not_found", msg: "User not found" });
    if (req.method === "GET") return send(res, 200, userObject(u));
    if (req.method === "PUT") {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (body.app_metadata && "role" in body.app_metadata) u.role = body.app_metadata.role ?? null;
      if (body.password) u.password = body.password;
      return send(res, 200, userObject(u));
    }
    if (req.method === "DELETE") {
      USERS.splice(USERS.indexOf(u), 1);
      return send(res, 200, {});
    }
  }
  return send(res, 404, { msg: `fake auth: ${req.method} ${path} not implemented` });
}

function proxyRest(req, res, path) {
  const up = http.request({ host: "127.0.0.1", port: PGREST_PORT, method: req.method, path, headers: { ...req.headers, host: `127.0.0.1:${PGREST_PORT}` } }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on("error", (e) => send(res, 502, { message: String(e) }));
  req.pipe(up);
}

export function start() {
  const pg = spawn(PGREST_BIN, [], {
    env: { ...process.env, PGRST_DB_URI: PG_URI, PGRST_DB_SCHEMAS: "public", PGRST_DB_ANON_ROLE: "anon", PGRST_JWT_SECRET: JWT_SECRET, PGRST_SERVER_PORT: String(PGREST_PORT), PGRST_SERVER_HOST: "127.0.0.1", PGRST_DB_POOL: "4", PGRST_LOG_LEVEL: "error" },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname.startsWith("/rest/v1")) return proxyRest(req, res, req.url.replace(/^\/rest\/v1/, "") || "/");
    if (u.pathname.startsWith("/auth/v1")) return auth(req, res, u.pathname.replace(/^\/auth\/v1/, ""));
    send(res, 404, { msg: "not found" });
  });
  server.listen(PORT, "127.0.0.1");
  return { close: () => { server.close(); pg.kill(); } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start();
  console.log(JSON.stringify({ url: `http://127.0.0.1:${PORT}`, anon: ANON_KEY, service: SERVICE_KEY }));
}
