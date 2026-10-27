"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { folderVisibility, type VisibleFolder } from './folder-visibility';

export function useFolderVisibility(items: VisibleFolder[], zoom: number, bypass = false) {
  const signature = JSON.stringify(items);
  const folders = useMemo(() => JSON.parse(signature) as VisibleFolder[], [signature]);
  const [previous, setPrevious] = useState(new Set<string>()), [forced, setForced] = useState(new Set<string>());
  const [targetZoom, setTargetZoom] = useState(0);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  const result = folderVisibility(folders, zoom, previous, forced, bypass);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setPrevious(current => {
      const next = folderVisibility(folders, zoom, current, new Set(), bypass).opened;
      return next.size === current.size && [...next].every(id => current.has(id)) ? current : next;
    }));
    return () => cancelAnimationFrame(frame);
  }, [folders, zoom, bypass]);
  const reveal = useCallback((id: string, requestedZoom = 0) => {
    const epoch = ++generation.current, path = new Set<string>();
    while (id && !path.has(id)) { path.add(id); id = folders.find(folder => folder.id === id)?.parentId || ''; }
    setTargetZoom(requestedZoom); setForced(path);
    return () => { if (generation.current === epoch) { setForced(new Set()); setTargetZoom(0); } };
  }, [folders]);
  return { ...result, maxZoom: Math.max(result.maxZoom, targetZoom), reveal };
}
