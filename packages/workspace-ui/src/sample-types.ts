import type { Entry } from './runtime';
import type { NormalizedDocument } from '../shared/core/documents';
export type SampleDocument = { entry_id: string; path: string; sha256: string; content: NormalizedDocument | null; image_url: string | null };
export type SampleWorkspaceData = { workspace_id: string; name: string; entries: Entry[]; documents: SampleDocument[] };
