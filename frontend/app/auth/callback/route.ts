import { NextRequest, NextResponse } from "next/server";
import { serverSupabase } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  // Use the public frontend origin on Vercel and in standalone Docker deployments.
  const origin = process.env.APP_ORIGIN || request.nextUrl.origin;
  const code = request.nextUrl.searchParams.get("code");
  const supabase = await serverSupabase();
  if (code && supabase) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL("/workspaces", origin));
  }
  return NextResponse.redirect(new URL("/login?error=callback", origin));
}
