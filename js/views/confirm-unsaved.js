/**
 * Garde partagée « fermeture d'un formulaire non sauvegardé » (P2).
 *
 * Même esprit que confirm-similar.js : ce module ne connaît ni les aliments
 * ni les recettes — il reçoit un constat déjà fait (y a-t-il une différence
 * entre l'état actuel et l'état de référence du formulaire ?) et ne fait que
 * produire le dialogue et comparer deux instantanés JSON.
 *
 * Un écran appelant doit :
 *   1. capturer `formBaseline` au moment où le formulaire s'ouvre (après son
 *      premier rendu, pour que toute normalisation de lecture — ex. readForm()
 *      — soit déjà appliquée des deux côtés de la comparaison) ;
 *   2. à chaque tentative de fermeture (clic extérieur, X, Échap), appeler
 *      `isDirty(formBaseline, currentSnapshot())` plutôt que de fermer
 *      directement ;
 *   3. si vrai, afficher `unsavedConfirmModal()` au lieu de fermer ;
 *   4. après un enregistrement réussi, ne jamais repasser par cette garde —
 *      fermer directement (formBaseline n'a alors plus lieu d'être comparé).
 */

/** Compare deux instantanés JSON-sérialisables du formulaire. */
export function isDirty(baseline, current) {
  if (baseline === null || baseline === undefined || current === null || current === undefined) return false;
  return JSON.stringify(baseline) !== JSON.stringify(current);
}

export function unsavedConfirmModal() {
  return `<div class="modal" data-unsaved-backdrop role="dialog" aria-modal="true" aria-label="Modifications non sauvegardées">
    <div class="modal__panel">
      <h3 style="margin-bottom:8px">Modifications non sauvegardées</h3>
      <p>Si vous quittez maintenant, vos modifications ne seront pas sauvegardées. Voulez-vous vraiment fermer ce formulaire ?</p>
      <div class="row" style="margin-top:14px;justify-content:flex-end">
        <button class="btn btn--ghost" data-unsaved-discard>Oui, tant pis</button>
        <button class="btn btn--primary" data-unsaved-stay>Non, retour</button>
      </div>
    </div>
  </div>`;
}
