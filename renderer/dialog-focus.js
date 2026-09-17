// Keep keyboard navigation inside the active dialog and return to its opener.
(() => {
  const focusable = (root) => [...root.querySelectorAll('button, input, select, textarea, a[href], summary, [tabindex="0"]')]
    .filter((element) => !element.disabled && element.getClientRects().length);
  const openers = new WeakMap();
  const dialogs = [...document.querySelectorAll('.modal-backdrop')];
  for (const modal of dialogs) {
    new MutationObserver(() => {
      if (!modal.hidden) {
        if (!modal.contains(document.activeElement)) openers.set(modal, document.activeElement);
        if (!modal.contains(document.activeElement)) focusable(modal)[0]?.focus();
      } else {
        const opener = openers.get(modal);
        if (opener?.isConnected) opener.focus();
        openers.delete(modal);
      }
    }).observe(modal, { attributes: true, attributeFilter: ['hidden'] });
  }
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const modal = dialogs.findLast((item) => !item.hidden);
    if (!modal) return;
    const items = focusable(modal);
    if (!items.length) { event.preventDefault(); return; }
    if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1).focus(); }
    else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0].focus(); }
  });
})();
