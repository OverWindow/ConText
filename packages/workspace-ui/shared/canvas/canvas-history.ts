"use client";

import { useCallback, useRef, useState } from "react";

type Action = { label: string; undo: () => Promise<void>; redo: () => Promise<void> };

/** Keep only this user's local canvas actions; never snapshot the whole workspace. */
export function useCanvasHistory() {
  const past = useRef<Action[]>([]);
  const future = useRef<Action[]>([]);
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [labels, setLabels] = useState({ undo: "", redo: "" });
  const publish = useCallback(() => setLabels({ undo: past.current.at(-1)?.label || "", redo: future.current.at(-1)?.label || "" }), []);
  const record = useCallback((action: Action) => {
    if (running.current) return;
    past.current = [...past.current.slice(-49), action];
    future.current = [];
    setError(""); publish();
  }, [publish]);
  const run = useCallback(async (direction: "undo" | "redo") => {
    if (running.current) return;
    const from = direction === "undo" ? past.current : future.current;
    const to = direction === "undo" ? future.current : past.current;
    const action = from.at(-1);
    if (!action) return;
    running.current = true; setBusy(true); setError("");
    try {
      await action[direction]();
      from.pop(); to.push(action); publish();
    } catch (err) {
      setError(`${direction === "undo" ? "되돌리기" : "다시 실행"}에 실패했습니다. ${err instanceof Error ? err.message : "다시 시도해 주세요."}`);
    } finally { running.current = false; setBusy(false); }
  }, [publish]);
  return { record, run, busy, error, undoLabel: labels.undo, redoLabel: labels.redo };
}
