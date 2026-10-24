import { WorkspaceDetail } from "@/features/workspace/workspace-detail";
export default async function WorkspacePage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  return <WorkspaceDetail key={workspaceId} workspaceId={workspaceId} />;
}
