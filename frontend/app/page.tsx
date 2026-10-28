import type { Metadata } from "next";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { LandingPage } from "@/features/landing/landing-page";

export const metadata: Metadata = {
  title: "ConText · 내 PC에서 시작하는 AI 문서 작업 공간",
  description: "내 문서와 AI가 함께 일하는 공간. 평소 쓰던 폴더에서 자료를 찾고, AI에게 묻고, 문서를 다듬으세요. 경희대 ChatKHU와 함께하는 로컬 문서 작업 공간, ConText.",
};

export default async function Home({ searchParams }: { searchParams: Promise<{ code?: string | string[] }> }) {
  const { code } = await searchParams;
  // Supabase may return to its Site URL instead of the requested callback.
  // Complete the same PKCE exchange before showing the public landing page.
  if (typeof code === "string" && code) redirect(`/auth/callback?${new URLSearchParams({ code })}`);
  // Download locations can be configured when deploying the same built image.
  await connection();
  return <LandingPage
    macDownloadUrl={process.env.DESKTOP_MAC_DOWNLOAD_URL}
    windowsDownloadUrl={process.env.DESKTOP_WINDOWS_DOWNLOAD_URL}
  />;
}
