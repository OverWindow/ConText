/** Run once after drawer/viewport resizing stops, rather than on every animation frame. */
export function settledCanvas(element: HTMLElement, callback: () => void) {
  let timer: ReturnType<typeof setTimeout>;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(() => { observer.disconnect(); callback(); }, 100); };
  const observer = new ResizeObserver(schedule);
  observer.observe(element); schedule();
  return () => { clearTimeout(timer); observer.disconnect(); };
}
