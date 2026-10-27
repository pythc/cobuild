/** A cancellable presentation effect: never remounts content or delays navigation. */
export function createContentMotion(view = window) {
  const preference = view.matchMedia('(prefers-reduced-motion: reduce)');
  let key;
  let frame = null;
  let animation = null;
  let disposed = false;

  function cancel() {
    if (frame !== null) view.cancelAnimationFrame(frame);
    frame = null;
    animation?.cancel();
    animation = null;
  }

  function enter(element, nextKey) {
    if (disposed || !element || nextKey === key) return;
    key = nextKey;
    cancel();
    if (preference.matches || typeof element.animate !== 'function') return;
    frame = view.requestAnimationFrame(() => {
      frame = null;
      if (!element.isConnected || preference.matches || disposed) return;
      // Opacity only: fixed children and editor coordinates keep their containing block.
      const current = element.animate([{ opacity: 0.72 }, { opacity: 1 }], {
        duration: 160,
        easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
      });
      animation = current;
      // cancel() rejects finished. Both outcomes release the reference, without styles.
      current.finished.then(
        () => { if (animation === current) animation = null; },
        () => { if (animation === current) animation = null; },
      );
    });
  }

  const changed = () => { if (preference.matches) cancel(); };
  preference.addEventListener('change', changed);
  return {
    enter,
    cancel,
    dispose() {
      disposed = true;
      cancel();
      preference.removeEventListener('change', changed);
    },
  };
}
