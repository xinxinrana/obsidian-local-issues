export type HistoryDirection = 'back' | 'forward';

interface TrackpadNavigationOptions {
  enabled(): boolean;
  navigate(direction: HistoryDirection): void;
  now?: () => number;
}

function horizontalScroller(target: EventTarget | null, root: HTMLElement): boolean {
  let node = target && 'closest' in target ? target as HTMLElement : undefined;
  while (node && node !== root) {
    const style = node.ownerDocument.defaultView?.getComputedStyle(node);
    if ((style?.overflowX === 'auto' || style?.overflowX === 'scroll') && node.scrollWidth > node.clientWidth) return true;
    node = node.parentElement ?? undefined;
  }
  return false;
}

/** Recognizes a deliberate horizontal trackpad swipe without stealing vertical scrolling. */
export function trackpadNavigation(element: HTMLElement, options: TrackpadNavigationOptions): () => void {
  const now = options.now ?? (() => Date.now());
  let x = 0, y = 0, last = 0, locked = false, triggeredAt = -Infinity;
  const reset = () => { x = y = 0; locked = false; };
  const wheel = (event: WheelEvent) => {
    if (!options.enabled() || event.defaultPrevented || event.ctrlKey) { reset(); return; }
    const target = event.target as HTMLElement | null;
    if (target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), .cm-content, .modal') || horizontalScroller(event.target, element)) { reset(); return; }
    const time = now();
    if (time - last > 180) reset();
    last = time;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientWidth : 1;
    const dx = event.deltaX * unit, dy = event.deltaY * unit;
    if (locked) { event.preventDefault(); return; }
    if (Math.abs(dx) < Math.abs(dy)) { reset(); return; }
    x += dx; y += dy;
    if (Math.abs(x) < Math.abs(y) || Math.abs(x) < 2) { reset(); return; }
    // Stop the browser's own overscroll navigation as well as repeated plugin triggers.
    event.preventDefault();
    if (Math.abs(x) < 90 || time - triggeredAt < 700) return;
    const direction: HistoryDirection = x < 0 ? 'back' : 'forward';
    triggeredAt = time; locked = true; x = y = 0;
    options.navigate(direction);
  };
  element.addEventListener('wheel', wheel, { passive: false });
  return () => element.removeEventListener('wheel', wheel);
}
