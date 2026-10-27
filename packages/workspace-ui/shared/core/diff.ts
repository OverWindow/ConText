export type Evidence = { id: number; type: string; level?: number; source: { page?: number }; text: string; truncated: boolean };
export type Change = { id: string; kind: "added" | "removed" | "modified"; before: Evidence | null; after: Evidence | null; text_diff: { kind: "equal" | "added" | "removed"; text: string }[] };
export type Diff = { counts: { added: number; removed: number; modified: number; unchanged: number }; changes: Change[]; total_changes: number; truncated: boolean };
