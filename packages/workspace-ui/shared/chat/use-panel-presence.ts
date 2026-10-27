"use client";
import { useEffect, useState } from 'react';

export function usePanelPresence(open: boolean) {
  const [phase, setPhase] = useState<'closed' | 'opening' | 'open' | 'closing'>(open ? 'open' : 'closed');
  useEffect(() => {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let secondFrame = 0;
    const frame = requestAnimationFrame(() => {
      if (open && !reduced) secondFrame = requestAnimationFrame(() => setPhase('opening'));
      else setPhase(open ? 'open' : reduced ? 'closed' : 'closing');
    });
    const timer = setTimeout(() => setPhase(open ? 'open' : 'closed'), reduced ? 0 : 280);
    return () => { cancelAnimationFrame(frame); cancelAnimationFrame(secondFrame); clearTimeout(timer); };
  }, [open]);
  return { phase, hidden: !open && phase === 'closed' };
}
