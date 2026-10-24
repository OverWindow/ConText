import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ConText · 팀 워크스페이스",
  description: "문서를 연결하고 팀의 지식을 함께 만들어 가는 공간",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ko"><body>{children}</body></html>;
}
