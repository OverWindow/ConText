import { defineConfig } from '@playwright/test';
import config from './playwright.documents.config';

export default defineConfig({
  ...config,
  testMatch: ['elements.spec.ts', 'rag.spec.ts', 'documents.spec.ts'],
  workers: 2,
});
