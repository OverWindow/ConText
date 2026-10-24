/* eslint-disable @next/next/no-location-assign-relative-destination -- A full navigation clears cached protected pages after session changes. */
"use client";
import { browserSupabase } from "./supabase/client";

export type User = { id: string; email: string; display_name: string | null };
export type Workspace = {
  id: string;
  team_id: string;
  name: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  role: "OWNER" | "EDITOR" | "VIEWER";
};

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const { data, error } = await browserSupabase().auth.getSession();
  if (error || !data.session) {
    window.location.assign("/login");
    throw new Error("다시 로그인해 주세요.");
  }
  const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}/api${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
      Authorization: `Bearer ${data.session.access_token}`,
    },
  }).catch(() => { throw new Error("서버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요."); });
  if (response.status === 401) {
    await browserSupabase().auth.signOut({ scope: "local" });
    window.location.assign("/login");
    throw new Error("로그인이 만료되었습니다. 다시 로그인해 주세요.");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const fallback = response.status === 403 ? "이 작업을 수행할 권한이 없습니다." : response.status === 404 ? "요청한 항목을 찾을 수 없습니다." : response.status === 413 ? "파일 크기가 업로드 한도를 초과했습니다." : response.status === 422 ? "입력한 정보나 파일을 확인해 주세요." : response.status === 409 ? "현재 상태에서 요청을 처리할 수 없습니다. 업로드 상태를 확인해 주세요." : "서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.";
    throw new Error(typeof body?.detail === "string" && /[가-힣]/.test(body.detail) ? body.detail : fallback);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
