import { defineConfig } from '@playwright/test';
import documents from './playwright.documents.config';
export default defineConfig({ ...documents, testMatch: ['cloud.spec.ts', 'workspace-deletion.spec.ts'] });
