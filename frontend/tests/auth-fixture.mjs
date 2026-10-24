// Test-only Supabase user endpoint. Never imported by application code.
import http from "node:http";
const user = { id: "00000000-0000-0000-0000-000000000001", email: "test@example.test", aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
http.createServer((request, response) => {
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Access-Control-Allow-Origin", "http://localhost:3100");
  response.setHeader("Access-Control-Allow-Headers", "authorization,apikey,content-type,x-client-info,x-supabase-api-version");
  if (request.method === "OPTIONS") { response.end(); return; }
  response.end(JSON.stringify(user));
}).listen(3101, "127.0.0.1");
