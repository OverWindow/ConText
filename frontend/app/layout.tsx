import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ConText · AI와 함께 쓰는 로컬 문서 작업 공간",
  description: "내 문서와 AI가 함께 일하는 공간. 내 PC의 자료를 찾고, 묻고, 문서를 다듬는 로컬 문서 작업 공간",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ko"><body>{children}</body></html>;
}
