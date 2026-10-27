import type { Metadata } from "next";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { LandingPage } from "@/features/landing/landing-page";

export const metadata: Metadata = {
  title: "ConText · 문서를 연결하고, 생각을 이어가세요",
  description: "흩어진 문서를 하나의 맥락으로. 문서를 연결하고, AI와 생각을 정리하는 ConText를 웹에서 시작하거나 데스크톱 앱으로 만나보세요.",
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
