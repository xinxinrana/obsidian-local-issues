import { Modal, Platform } from 'obsidian';

export function observeMobileViewport(target: HTMLElement): () => void {
  const win = target.ownerDocument.defaultView;
  if (!Platform.isMobile || !win) return () => {};
  const viewport = win.visualViewport;
  let frame = 0;
  const update = () => {
    const height = viewport?.height || win.innerHeight;
    const available = Math.max(0, height + (viewport?.offsetTop || 0) - target.getBoundingClientRect().top);
    target.setCssProps({ '--li-viewport-height': `${height}px`, '--li-page-height': `${Math.min(target.clientHeight || height, available)}px` });
    win.cancelAnimationFrame(frame);
    frame = win.requestAnimationFrame(() => {
      const active = target.ownerDocument.activeElement;
      if (!(active instanceof HTMLElement) || !target.contains(active) || !active.matches('input,textarea,select')) return;
      const scroll = active.closest('.li-mobile-edit-body, .li-mobile-content, .modal-content');
      if (!scroll) return;
      const field = active.getBoundingClientRect(), bounds = scroll.getBoundingClientRect();
      if (field.top < bounds.top || field.bottom > Math.min(bounds.bottom, height + (viewport?.offsetTop || 0)) - 12) active.scrollIntoView?.({ block: 'nearest' });
    });
  };
  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
  observer?.observe(target);
  update(); viewport?.addEventListener('resize', update); viewport?.addEventListener('scroll', update); win.addEventListener('resize', update);
  return () => { win.cancelAnimationFrame(frame); observer?.disconnect(); viewport?.removeEventListener('resize', update); viewport?.removeEventListener('scroll', update); win.removeEventListener('resize', update); };
}

/** Own only this plugin's dialogs; public close() also runs for Escape/backdrop. */
export class MobileModal extends Modal {
  private disposeViewport?: () => void;
  override open(): void { this.disposeViewport?.(); this.disposeViewport = observeMobileViewport(this.modalEl); super.open(); }
  override close(): void { this.disposeViewport?.(); this.disposeViewport = undefined; super.close(); }
}
