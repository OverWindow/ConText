import { defineConfig } from "@playwright/test";
import base from "./playwright.documents.config";

export default defineConfig({ ...base, testMatch: "writing.spec.ts" });
