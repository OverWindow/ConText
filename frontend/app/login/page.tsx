import Link from "next/link";
import { BrandLogo } from "@/features/brand/brand-logo";
import { redirect } from "next/navigation";
import { GoogleLogin } from "@/features/auth/google-login";
import { serverSupabase } from "@/lib/supabase/server";

export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const supabase = await serverSupabase();
  if (supabase) {
    const { data } = await supabase.auth.getUser();
    if (data.user) redirect("/workspaces");
  }
  const { error } = await searchParams;
  return <main className="login-shell"><section className="login-card">
    <h1 className="login-brand" aria-label="ConText"><BrandLogo /></h1>
    <p className="eyebrow">팀의 생각이 자라는 공간</p>
    <p className="muted">흩어진 문서를 연결하고, 함께 새로운 생각을 만들어 보세요.</p>
    <GoogleLogin configured={!!supabase} />
    <p><Link href="/preview" className="login-sample-link">로그인 없이 샘플 먼저 둘러보기 →</Link></p>
    {error && <p role="alert" className="error">로그인을 완료하지 못했습니다. 다시 시도해 주세요.</p>}
  </section></main>;
}
