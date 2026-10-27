import { defineConfig } from '@playwright/test';
import documents from './playwright.documents.config';
export default defineConfig({ ...documents, testMatch: ['login-performance.spec.ts', 'auth-callback.spec.ts'], workers: 2, timeout: 45000, webServer: [
  { command: 'node tests/auth-fixture.mjs', url: 'http://127.0.0.1:3101', reuseExistingServer: false },
  { command: 'npm run dev -- --port 3100', url: 'http://localhost:3100/login', reuseExistingServer: false, env: { APP_ORIGIN: 'http://localhost:3100', NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:3101', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-only-key', NEXT_PUBLIC_WORKSPACE_API_URL: 'http://localhost:3102' } },
] });
