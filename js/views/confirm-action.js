/**
 * Confirmation générique réutilisable pour une action destructrice ou
 * irréversible (suppression, remplacement de données, réinitialisation…) —
 * P1 : remplace les `confirm()` natifs (libellés non personnalisables, pas
 * de style) par le même composant `.modal` déjà utilisé pour la fermeture de
 * formulaire non sauvegardé (confirm-unsaved.js) et les confirmations de
 * préparations (préparations.js).
 *
 * Ce module ne connaît ni l'action qu'il protège ni l'écran qui l'utilise :
 * il reçoit un texte déjà rédigé et ne fait que produire le dialogue. Un
 * écran appelant garde un état local `let pendingConfirm = null` et :
 *   1. au clic sur l'action, remplace le `confirm()` natif par
 *      `pendingConfirm = { message, onConfirm }; render(root);` ;
 *   2. ajoute `${pendingConfirm ? actionConfirmModal(pendingConfirm) : ''}`
 *      à son render() ;
 *   3. câble data-action-confirm / data-action-cancel / data-action-backdrop
 *      une fois (wireActionConfirm(), ci-dessous) — jamais de fusion/
 *      suppression automatique, toujours une étape de confirmation explicite.
 */

import { esc } from '../core/util.js';

export function actionConfirmModal({
  title = 'Confirmer ?',
  message,
  confirmLabel = 'Confirmer',
  cancelLabel = 'Annuler',
  danger = true,
} = {}) {
  return `<div class="modal" data-action-backdrop role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal__panel">
      <h3 style="margin-bottom:8px">${esc(title)}</h3>
      <p>${esc(message)}</p>
      <div class="row" style="margin-top:14px;justify-content:flex-end">
        <button class="btn btn--ghost" data-action-cancel>${esc(cancelLabel)}</button>
        <button class="btn ${danger ? 'btn--danger' : 'btn--primary'}" data-action-confirm>${esc(confirmLabel)}</button>
      </div>
    </div>
  </div>`;
}

/**
 * Câblage générique : `getPending`/`setPending` donnent accès à la variable
 * module-level `pendingConfirm` de l'écran appelant (fermeture = accès par
 * référence, comme le reste de l'application). `onConfirm` peut être async ;
 * son résultat n'est pas attendu ici (chaque écran gère son propre re-rendu
 * si l'action est asynchrone, même convention que les boutons push/pull de
 * settings.js).
 */
// P4 : un seul écouteur Échap pour toute l'application (jamais réinstallé à
// chaque appel de wireActionConfirm(), lui-même rappelé à chaque rendu) — il
// agit sur le bouton Annuler réellement présent dans le DOM au moment de la
// frappe, quel que soit l'écran qui l'a affiché ; sans effet si aucune
// confirmation n'est ouverte (le sélecteur ne trouve alors rien).
let escBound = false;
function onEscape(e) {
  if (e.key === 'Escape') document.querySelector('[data-action-cancel]')?.click();
}

export function wireActionConfirm(root, { getPending, setPending, render }) {
  root.querySelector('[data-action-cancel]')?.addEventListener('click', () => { setPending(null); render(root); });
  root.querySelector('[data-action-backdrop]')?.addEventListener('mousedown', (e) => {
    if (e.target.dataset.actionBackdrop !== undefined) { setPending(null); render(root); }
  });
  root.querySelector('[data-action-confirm]')?.addEventListener('click', () => {
    const pending = getPending();
    setPending(null);
    pending?.onConfirm?.();
  });
  if (!escBound) { escBound = true; document.addEventListener('keydown', onEscape); }
}
