/* eslint-disable @next/next/no-location-assign-relative-destination -- A full navigation clears cached protected pages after session changes. */
"use client";
import { LuLogOut } from "react-icons/lu";
import { useState } from "react";
import { browserSupabase } from "@/lib/supabase/client";

export function SignOut({ compact = false, beforeSignOut }: { compact?: boolean; beforeSignOut?: () => Promise<boolean> }) {
  const [error, setError] = useState(false);
  const [pending, setPending] = useState(false);
  async function signOut() {
    setPending(true);
    if (beforeSignOut && !await beforeSignOut()) { setPending(false); return; }
    const { error } = await browserSupabase().auth.signOut({ scope: "local" });
    if (error) { setError(true); setPending(false); return; }
    window.location.assign("/login");
  }
  return <div><button className="secondary" aria-label="로그아웃" title="로그아웃" disabled={pending} onClick={signOut}><LuLogOut />{!compact && "로그아웃"}</button>
    {error && <p role="alert">로그아웃하지 못했습니다. 다시 시도해 주세요.</p>}</div>;
}
