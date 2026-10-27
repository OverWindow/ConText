import { redirect } from "next/navigation";
import { serverSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const supabase = await serverSupabase();
  if (!supabase) redirect("/login");
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) redirect("/login");
  return <div className="app-shell">{children}</div>;
}
