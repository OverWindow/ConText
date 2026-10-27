export type TextDocument = { filename: string; text: string; revision: string };
export interface TextRepository {
  load(): Promise<TextDocument>;
  save(revision: string, text: string): Promise<TextDocument>;
  saveAs?(text: string): Promise<void>;
}
