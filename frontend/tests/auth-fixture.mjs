// Test-only Supabase user endpoint. Never imported by application code.
import http from "node:http";
const user = { id: "00000000-0000-0000-0000-000000000001", email: "test@example.test", aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
http.createServer(async (request, response) => {
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Access-Control-Allow-Origin", "http://localhost:3100");
  response.setHeader("Access-Control-Allow-Headers", "authorization,apikey,content-type,x-client-info,x-supabase-api-version");
  if (request.method === "OPTIONS") { response.end(); return; }
  if (request.url === "/auth/v1/token?grant_type=pkce" && request.method === "POST") {
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    if (input.auth_code !== "test-only-valid-code" || input.code_verifier !== "test-only-valid-verifier-abcdefghijklmnopqrstuvwxyz") {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: "invalid_grant", error_description: "Invalid test-only OAuth exchange" }));
      return;
    }
    const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const token = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: user.id, exp: expires, aud: "authenticated", role: "authenticated" })}.test-signature`;
    response.end(JSON.stringify({ access_token: token, refresh_token: "test-refresh", expires_at: expires, expires_in: 3600, token_type: "bearer", user }));
    return;
  }
  response.end(JSON.stringify(user));
}).listen(3101, "127.0.0.1");
