"use client";
import { createBrowserClient } from "@supabase/ssr";
import { supabaseConfig } from "./config";

export function browserSupabase() {
  const config = supabaseConfig();
  if (!config) throw new Error("로그인 서비스가 아직 준비되지 않았습니다.");
  return createBrowserClient(config.url, config.key);
}
