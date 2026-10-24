"use client";
import { FcGoogle } from "react-icons/fc";
import { useState } from "react";
import { browserSupabase } from "@/lib/supabase/client";

export function GoogleLogin({ configured }: { configured: boolean }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function login() {
    setPending(true);
    setError(null);
    try {
      const { error } = await browserSupabase().auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: `${window.location.origin}/auth/callback` },
      });
      if (error) throw error;
    } catch {
      setError("Google 로그인을 시작하지 못했습니다. 다시 시도해 주세요.");
      setPending(false);
    }
  }
  return <>
    <button onClick={login} disabled={!configured || pending} className="primary wide">
      <FcGoogle /> {pending ? "연결 중…" : "Google로 계속하기"}
    </button>
    {!configured && <p role="status" className="notice">로그인 서비스가 아직 준비되지 않았습니다. 관리자에게 문의해 주세요.</p>}
    {error && <p role="alert" className="error">{error}</p>}
  </>;
}
