import { defineConfig } from '@playwright/test';
import unified from './playwright.unified.config';
export default defineConfig({ ...unified, testMatch: 'unified-live.spec.ts', timeout:90000 });
