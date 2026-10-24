"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type EditorJS from "@editorjs/editorjs";
import type { OutputData, ToolConstructable } from "@editorjs/editorjs";
import type { WritingBlock } from "./types";

export type EditorHandle = { read: () => Promise<WritingBlock[]> };
function escape(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
}
function plain(value: unknown): string {
  const node = document.createElement("div");
  node.innerHTML = String(value ?? "").replace(/<br\s*\/?\s*>/gi, "\n");
  return node.textContent || "";
}
function output(blocks: WritingBlock[]): OutputData {
  return { blocks: blocks.map(b => ({ id: b.id, type: b.type === "heading" ? "header" : b.type,
    data: b.type === "table" ? { withHeadings: true, content: b.rows.map(r => r.map(escape)) }
      : b.type === "list" ? { style: "unordered", items: b.items.map(s => ({ content: escape(s), meta: {}, items: [] })) }
      : { text: escape(b.text), level: b.level },
  })) };
}

export const BlockEditor = forwardRef<EditorHandle, {
  blocks: WritingBlock[]; readOnly: boolean; onDirty: () => void; onSelect: (id: string) => void;
}>(function BlockEditor({ blocks, readOnly, onDirty, onSelect }, ref) {
  const holder = useRef<HTMLDivElement>(null);
  const instance = useRef<EditorJS | null>(null);
  const initial = useRef(blocks);
  const changed = useRef(onDirty);
  const [error, setError] = useState("");
  useEffect(() => { changed.current = onDirty; }, [onDirty]);
  useEffect(() => {
    let disposed = false;
    let editor: EditorJS | null = null;
    let destroyed = false;
    const destroy = () => { if (editor && !destroyed) { destroyed = true; editor.destroy(); } };
    void Promise.all([import("@editorjs/editorjs"), import("@editorjs/header"), import("@editorjs/table"), import("@editorjs/list")]).then(async ([core, header, table, list]) => {
      if (disposed || !holder.current) return;
      // The document schema uses flat bullet lists; hide styles that cannot round-trip.
      class BulletList extends list.default {
        renderSettings() { return []; }
        static get toolbox() { const entries = super.toolbox; return Array.isArray(entries) ? entries.slice(0, 1) : entries; }
      }
      class DocumentTable extends table.default {
        renderSettings() { return []; }
      }
      editor = new core.default({
        holder: holder.current, data: output(initial.current), readOnly, minHeight: 280,
        placeholder: "문서 내용을 작성하세요…", inlineToolbar: false,
        tools: {
          header: { class: header.default as unknown as ToolConstructable, inlineToolbar: false, config: { levels: [1, 2, 3, 4, 5, 6], defaultLevel: 2 } },
          table: { class: DocumentTable as unknown as ToolConstructable, inlineToolbar: false, config: { withHeadings: true } },
          list: { class: BulletList as unknown as ToolConstructable, inlineToolbar: false, pasteConfig: false, config: { maxLevel: 1, defaultStyle: "unordered" } },
        },
        onChange: () => { if (!disposed) changed.current(); },
        i18n: { messages: { toolNames: { Text: "본문", Heading: "제목", Table: "표", List: "목록" }, blockTunes: { delete: { Delete: "삭제", "Click to delete": "눌러서 삭제" }, moveUp: { "Move up": "위로 이동" }, moveDown: { "Move down": "아래로 이동" } } } },
      });
      await editor.isReady;
      if (disposed) destroy(); else instance.current = editor;
    }).catch(() => { if (!disposed) setError("편집기를 불러오지 못했습니다. 문서를 다시 열어 주세요."); });
    return () => { disposed = true; instance.current = null; if (editor) void editor.isReady.then(destroy).catch(() => {}); };
  }, [readOnly]);
  useImperativeHandle(ref, () => ({ read: async () => {
    if (!instance.current) throw new Error("편집기가 준비될 때까지 잠시 기다려 주세요.");
    const data = await instance.current.save();
    const original = new Map(initial.current.map(b => [b.id, b]));
    return data.blocks.map(b => {
      const id = b.id || crypto.randomUUID();
      const previous = original.get(id);
      const result: WritingBlock = { id, type: b.type === "header" ? "heading" : b.type as WritingBlock["type"], text: "", level: 2, items: [], rows: [], source_ids: previous?.source_ids || [] };
      if (b.type === "table") result.rows = (b.data.content as unknown[][]).map(r => r.map(plain));
      else if (b.type === "list") result.items = (b.data.items as { content: string }[]).map(i => plain(i.content));
      else { result.text = plain(b.data.text); result.level = b.data.level || 2; }
      // Edited claims retain the source link for review, not an assertion of verification.
      return result;
    });
  } }), []);
  return <div className="writing-editor" onInput={() => { if (!readOnly) changed.current(); }} onClick={event => {
    const block = (event.target as HTMLElement).closest<HTMLElement>(".ce-block[data-id]");
    if (block?.dataset.id) onSelect(block.dataset.id);
  }}>
    {error && <p role="alert" className="error">{error}</p>}
    <div ref={holder} aria-label="문서 본문 편집기" />
  </div>;
});
