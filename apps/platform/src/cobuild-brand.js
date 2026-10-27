// Match WeKnow's suite/application identity without allowing a parked mouse
// to obscure the application link while a keyboard user tabs through it.
export function initCoBuildBrand(root) {
  for (const identity of root.querySelectorAll('.hf-brand-identity')) {
    identity.addEventListener('keydown', event => {
      if (event.key === 'Tab') identity.dataset.preserveAppFocus = '';
    }, true);
    identity.addEventListener('pointerdown', () => {
      delete identity.dataset.preserveAppFocus;
    }, true);
    identity.querySelector('.hf-brand-link').addEventListener('pointermove', () => {
      delete identity.dataset.preserveAppFocus;
    });
  }
}
