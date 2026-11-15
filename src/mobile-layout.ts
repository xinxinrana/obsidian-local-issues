/** Phone-only page chrome. The host pane stays still; its content owns scrolling. */
export function mobilePage(root: HTMLElement) {
  const node = <K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, cls: string) => parent.createEl(tag, { cls });
  root.addClass('li-mobile-page');
  const nav = node(root, 'header', 'li-topbar li-mobile-nav');
  const leading = node(nav, 'div', 'li-mobile-leading');
  const title = node(nav, 'div', 'li-mobile-page-title');
  const actions = node(nav, 'div', 'li-mobile-nav-actions');
  const controls = node(root, 'div', 'li-mobile-controls');
  const content = node(root, 'main', 'li-mobile-content');
  content.setAttribute('aria-label', '页面内容');
  return { root, nav, leading, title, actions, controls, content,
    edit(element: HTMLElement, label: string, buttons?: HTMLElement) {
      const marker = root.ownerDocument.createComment('editor'); element.before(marker);
      const page = node(root, 'section', 'li-mobile-edit-page');
      const bar = node(page, 'header', 'li-mobile-edit-nav');
      const cancel = buttons?.querySelector<HTMLButtonElement>('button:not(.mod-cta)');
      const cancelMarker = cancel ? root.ownerDocument.createComment('cancel') : undefined;
      if (cancel && cancelMarker) { cancel.before(cancelMarker); bar.append(cancel); }
      const heading = node(bar, 'strong', 'li-mobile-page-title'); heading.textContent = label; heading.title = label;
      const actionsMarker = buttons ? root.ownerDocument.createComment('actions') : undefined;
      if (buttons && actionsMarker) { buttons.before(actionsMarker); bar.append(buttons); }
      const body = node(page, 'div', 'li-mobile-edit-body'); body.append(element);
      if (element.classList.contains('li-editor')) page.addClass('li-mobile-text-page');
      nav.hidden = true; controls.hidden = true; content.hidden = true;
      return () => {
        if (cancel && cancelMarker?.isConnected) cancelMarker.replaceWith(cancel);
        if (buttons && actionsMarker?.isConnected) actionsMarker.replaceWith(buttons);
        if (marker.isConnected) marker.replaceWith(element);
        page.remove(); nav.hidden = false; controls.hidden = false; content.hidden = false;
      };
    },
  };
}
export type MobilePage = ReturnType<typeof mobilePage>;
