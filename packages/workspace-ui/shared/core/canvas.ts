export type ElementKind = "text" | "rectangle" | "ellipse" | "triangle";
export type CanvasElement = { id: string; kind: ElementKind; text: string; x: number; y: number; width: number; height: number; color: string; font_size: number };
export type Patch = Partial<Pick<CanvasElement, "text" | "x" | "y" | "width" | "height" | "color" | "font_size">>;

export interface CanvasElementRepository {
  create(value: CanvasElement): Promise<CanvasElement>;
  update(id: string, patch: Patch): Promise<void>;
  remove(id: string): Promise<void>;
}
export type RelationKind = 'REFERENCE' | 'DERIVED_FROM' | 'GENERATED_FROM' | 'RELATED_TO';
export type CanvasRelation = { id: string; source_document_id: string; target_document_id: string; relation_type: RelationKind; source_handle?: string; target_handle?: string };
export const relationLabels: Record<RelationKind, string> = { REFERENCE: '참조', DERIVED_FROM: '파생', GENERATED_FROM: '생성 출처', RELATED_TO: '관련 문서' };
