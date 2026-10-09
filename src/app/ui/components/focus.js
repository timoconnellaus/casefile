// Keeping keyboard focus across a re-render: a screen that rebuilds its DOM asks where focus is
// now and gets a function that puts it back on the same control in the new DOM.
const FOCUSABLE = "button, input, select, a, [tabindex]";

/**
 * Where focus is inside `root` now, and a function that puts it back after `root` is re-rendered;
 * null when focus is elsewhere. A control is found again by its `data-fk` key; failing that, by
 * its position among the focusable elements of its `data-region` (the nearest one that still
 * exists, so removing the last row moves focus to the new last row). Disabled controls are skipped.
 * @param {HTMLElement} root
 * @returns {(() => void)|null}
 */
export function focusMemo(root) {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || !root.contains(el)) return null;
  const fk = el.dataset.fk;
  const region = /** @type {HTMLElement|null} */ (el.closest("[data-region]"));
  const index = region ? [...region.querySelectorAll(FOCUSABLE)].indexOf(el) : -1;
  const regionName = region?.dataset.region;
  return () => {
    let target = fk ? root.querySelector(`[data-fk="${CSS.escape(fk)}"]`) : null;
    if (!target && regionName && index >= 0) {
      const r = root.querySelector(`[data-region="${CSS.escape(regionName)}"]`);
      const list = r ? [...r.querySelectorAll(FOCUSABLE)] : [];
      target = list[Math.min(index, list.length - 1)] ?? null;
    }
    if (target instanceof HTMLElement && !target.hasAttribute("disabled")) target.focus();
  };
}
