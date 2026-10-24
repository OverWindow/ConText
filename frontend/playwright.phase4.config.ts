import { defineConfig } from "@playwright/test";
import config from "./playwright.documents.config";
export default defineConfig({ ...config, testMatch: ["canvas.spec.ts", "documents.spec.ts", "processing.spec.ts"], workers: 2 });
