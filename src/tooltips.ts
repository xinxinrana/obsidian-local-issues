export function suppressTooltips(container: HTMLElement) {
  if (container.classList.contains('li-no-tooltips')) return;
  container.classList.add('li-no-tooltips');
  const clearTitle = (event: Event) => {
    let target = event.target instanceof Element ? event.target : null;
    while (target && container.contains(target)) {
      target.removeAttribute('title');
      if (target === container) break;
      target = target.parentElement;
    }
  };
  container.addEventListener('mouseover', clearTitle, true);
  container.addEventListener('focusin', clearTitle, true);
}
