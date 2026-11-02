import { Modal, Platform } from 'obsidian';

export function observeMobileViewport(target: HTMLElement): () => void {
  const win = target.ownerDocument.defaultView;
  if (!Platform.isMobile || !win) return () => {};
  const viewport = win.visualViewport;
  const update = () => target.setCssProps({ '--li-viewport-height': `${viewport?.height || win.innerHeight}px` });
  update(); viewport?.addEventListener('resize', update); win.addEventListener('resize', update);
  return () => { viewport?.removeEventListener('resize', update); win.removeEventListener('resize', update); };
}

/** Own only this plugin's dialogs; public close() also runs for Escape/backdrop. */
export class MobileModal extends Modal {
  private disposeViewport?: () => void;
  override open(): void { this.disposeViewport?.(); this.disposeViewport = observeMobileViewport(this.modalEl); super.open(); }
  override close(): void { this.disposeViewport?.(); this.disposeViewport = undefined; super.close(); }
}
