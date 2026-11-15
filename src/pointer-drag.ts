/** Public Pointer Events keep mouse, pen and touch drags on the same path. */
export function pointerDrag(handle: HTMLElement, callbacks: {
  start(event: PointerEvent): boolean;
  move(event: PointerEvent): void;
  end(event: PointerEvent, cancelled: boolean): void;
}): () => void {
  let active: PointerEvent | undefined;
  const finish = (event: PointerEvent, cancelled: boolean) => {
    if (!active || event.pointerId !== active.pointerId) return;
    active = undefined;
    if (handle.hasPointerCapture?.(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    callbacks.end(event, cancelled);
  };
  const down = (event: PointerEvent) => {
    if (active || event.button !== 0 || !event.isPrimary || !callbacks.start(event)) return;
    active = event; event.preventDefault(); event.stopPropagation(); handle.focus({ preventScroll: true });
    try { handle.setPointerCapture(event.pointerId); } catch { /* Synthetic pointer events have no native capture. */ }
  };
  const move = (event: PointerEvent) => { if (active?.pointerId === event.pointerId) { active = event; event.preventDefault(); callbacks.move(event); } };
  const up = (event: PointerEvent) => finish(event, false);
  const cancel = (event: PointerEvent) => finish(event, true);
  const escape = (event: KeyboardEvent) => { if (active && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(active, true); } };
  handle.addEventListener('pointerdown', down); handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up);
  handle.addEventListener('pointercancel', cancel); handle.addEventListener('lostpointercapture', cancel); handle.addEventListener('keydown', escape);
  return () => {
    if (active) finish(active, true);
    handle.removeEventListener('pointerdown', down); handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up);
    handle.removeEventListener('pointercancel', cancel); handle.removeEventListener('lostpointercapture', cancel); handle.removeEventListener('keydown', escape);
  };
}
