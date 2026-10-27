"use client";
import { useMemo } from "react";
import { api } from "@/lib/api";
import { useCanvasElements as useSharedElements, type CanvasElement, type Patch } from "@/shared/canvas/canvas-elements";
export * from "@/shared/canvas/canvas-elements";

export function useCanvasElements(workspaceId: string, editable: boolean) {
  const repository = useMemo(() => {
    const path = `/workspaces/${workspaceId}/canvas/elements`;
    return {
      create: (value: CanvasElement) => api<CanvasElement>(path, { method: "POST", body: JSON.stringify(value) }),
      update: (id: string, patch: Patch) => api(`${path}/${id}`, { method: "PATCH", body: JSON.stringify(patch) }).then(() => {}),
      remove: (id: string) => api(`${path}/${id}`, { method: "DELETE" }).then(() => {}),
    };
  }, [workspaceId]);
  return useSharedElements(repository, editable);
}
