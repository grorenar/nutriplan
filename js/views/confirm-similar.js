/**
 * Popup de confirmation générique pour la détection d'éléments similaires.
 *
 * Elle est BLOQUANTE : la création est suspendue tant que l'utilisateur n'a pas
 * répondu. Aucun élément n'est jamais fusionné ni supprimé automatiquement, et
 * l'utilisateur peut toujours créer volontairement un élément similaire.
 *
 * Ce module ne connaît ni les aliments ni les catalogues : il reçoit des lignes
 * déjà formatées, ce qui permet de le réutiliser pour toute création disposant
 * d'une détection de similarité.
 */

import { esc } from '../core/util.js';

/**
 * @param {object}   options
 * @param {string}   options.title        titre de la popup
 * @param {string}   options.question     question de confirmation
 * @param {{title:string, detail?:string, reasons?:string[]}[]} options.existing  éléments déjà présents
 * @param {{title:string, detail?:string}} options.candidate  élément en cours de création
 * @param {string}  [options.confirmLabel]
 */
export function similarConfirmModal({
  title = 'Élément similaire détecté',
  question = 'Voulez-vous tout de même créer cet élément ?',
  existing = [],
  candidate = null,
  confirmLabel = 'Créer quand même',
} = {}) {
  const entry = (e) => `<li style="margin-bottom:6px">
      <strong>${esc(e.title)}</strong>
      ${e.detail ? `<div class="nums tag">${esc(e.detail)}</div>` : ''}
      ${e.reasons?.length ? `<div class="tag">${esc(e.reasons.join(', '))}</div>` : ''}
    </li>`;

  return `<div class="modal" data-similar-backdrop role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal__panel">
      <h3 style="margin-bottom:8px">${esc(title)}</h3>
      <p>${existing.length > 1 ? 'Des éléments similaires existent déjà :' : 'Un élément similaire existe déjà :'}</p>
      <ul style="margin:0 0 12px;padding-left:18px">${existing.map(entry).join('')}</ul>
      ${
        candidate
          ? `<p style="margin-bottom:4px">Vous êtes en train de créer :</p>
             <ul style="margin:0 0 12px;padding-left:18px">${entry(candidate)}</ul>`
          : ''
      }
      <p>${esc(question)}</p>
      <div class="row" style="margin-top:14px;justify-content:flex-end">
        <button class="btn" data-similar-cancel>Annuler</button>
        <button class="btn btn--primary" data-similar-confirm>${esc(confirmLabel)}</button>
      </div>
    </div>
  </div>`;
}
