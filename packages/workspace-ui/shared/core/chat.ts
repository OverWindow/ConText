import type { Source } from "./sources";
export type Scope = "auto" | "current" | "history" | "as_of";
export type DocumentReference = { document_id: string; version_number: number };
export type Evidence = { sources: Source[]; scope: Scope; as_of: string | null; warnings: string[] };
export type Result = Evidence & { claims: { text: string; source_ids: string[] }[]; insufficient: boolean };
export type ChatMessage = { id: string; role: "user" | "assistant"; state: string; content: string; error_code: string | null; result: Result | null; created_at: string };
export type Session = { id: string; title: string };
export type IndexCount = { versions: number; completed: number; failed: number; chunks: number; indexed_chunks: number };
export type IndexStatus = { current: IndexCount; all: IndexCount };

export type SearchInput = { question: string; scope: Scope; as_of: string | null };
export interface ChatRepository {
  sessions(offset: number): Promise<Session[]>;
  indexStatus(): Promise<IndexStatus>;
  messages(sessionId: string): Promise<ChatMessage[]>;
  search(input: SearchInput): Promise<Evidence>;
  createSession(input: { requestId: string; title: string }): Promise<Session>;
  ask(sessionId: string, input: SearchInput & { requestId: string }): Promise<ChatMessage>;
  retry(sessionId: string, messageId: string): Promise<ChatMessage>;
  reindex(): Promise<void>;
}
