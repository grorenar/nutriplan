/**
 * Écran PRÉPARATIONS — une préparation vue comme un STOCK (P4).
 *
 * Remplace le parcours « ouvrir chaque repas → ajouter la préparation →
 * cocher zéro reste → revenir répartir » par un assistant guidé unique :
 * choisir les repas/collations concernés, indiquer la quantité à répartir,
 * l'application calcule automatiquement le reste.
 *
 * Aucune nouvelle logique de calcul du stock ou de répartition ici : tout
 * passe par `preparedGramsOf()`/`preparationUsed()`/`preparationAvailable()`
 * (derive.js/nutrition.js) et par `planPreparationDistribution()`
 * (derive.js), qui réutilise `resolveZeroWasteAllocation()` telle quelle.
 * Cet écran ne fait que construire les sélections et écrire le résultat via
 * `update()`, exactement comme les autres écrans.
 */

import {
  getState, update, foodsById, recipesById, preparationsById, newPreparationItem,
  newPreparation, newPreparationLoss,
} from '../core/store.js';
import { mealMacros, evaluate, preparedGramsOf, portionGramsOf, PERSONS, PERSON_LABEL } from '../core/nutrition.js';
import {
  preparationUsed, preparationAvailable, preparationWasted, preparationAssignments,
  distributionCandidates, planPreparationDistribution, deployItems,
} from '../core/derive.js';
import { analyzeMealVolume } from '../core/meal-volume.js';
import { esc, num, toast } from '../core/util.js';
import { isDirty, unsavedConfirmModal } from './confirm-unsaved.js';
import { actionConfirmModal, wireActionConfirm } from './confirm-action.js';

// État d'interface uniquement (jamais persisté) — même convention que
// `pickerQuery`/`ctx` dans editor.js ou `duplicateFrom` dans planning.js.
let wizard = null;   // { preparationId, amount, mealIds: Set<string>, catalog: Map<key, {picked, perServiceQty}> }
let quickUse = null; // { preparationId, mealId, qty }
let lastResult = null;
let creating = null;    // { recipeId, qty } — P1.A, création depuis une recette
let createBaseline = null; // instantané de `creating` à l'ouverture (P1 — garde non-sauvegardé)
let confirmingCloseCreate = false; // le dialogue « Modifications non sauvegardées » est affiché sur ce panneau
let discardConfirm = null; // { preparationId } — jet de LA TOTALITÉ du disponible, un seul dialogue (2 clics)
let discarding = null;  // { preparationId, qty } — jet d'une quantité PARTIELLE, flux distinct et volontairement séparé
let exhaustedOpen = false; // la section "préparations épuisées" (disponible = 0) est-elle dépliée ?
let deletePrep = null; // { preparationId } — suppression DÉFINITIVE de la préparation elle-même
let pendingConfirm = null; // { title, message, confirmLabel, onConfirm } — P1, remplace confirm() natif (jet partiel)
const assignmentsOpen = new Set(); // ids de préparation dont la liste d'affectations est dépliée

export function render(root) {
  const s = getState();
  const recipesMap = recipesById();
  // Une préparation épuisée (disponible = 0, même seuil que les boutons déjà
  // désactivés plus bas — aucune nouvelle tolérance : les quantités saisies
  // sont toujours des grammes/portions entiers, jamais de résidu flottant à
  // filtrer) ne doit plus apparaître dans la liste active, mais rien n'est
  // supprimé : elle reste consultable (affectations comprises) dans la
  // section repliée ci-dessous, réévaluée à CHAQUE rendu (jamais un drapeau
  // stocké) — donc jamais réaffichée par erreur après un reset/une synchro.
  const active = [];
  const exhausted = [];
  for (const p of s.preparations) (preparationAvailable(s, p) > 0 ? active : exhausted).push(p);

  root.innerHTML = `
    <div class="row" style="margin-bottom:12px">
      <small style="flex:1">Une préparation est un stock : préparée une fois, elle peut être répartie sur plusieurs repas au fil du cycle, sans devoir cocher un « zéro reste » repas par repas.</small>
      <button class="btn btn--primary" data-open-create ${s.recipes.length ? '' : 'disabled'}
        title="${s.recipes.length ? '' : 'Crée d’abord une recette dans l’écran Recettes.'}">Nouvelle préparation</button>
    </div>
    ${lastResult ? resultCard(lastResult) : ''}
    ${creating ? createPanel(s) : ''}
    ${creating && confirmingCloseCreate ? unsavedConfirmModal() : ''}
    ${discardConfirm ? discardConfirmModal(s) : ''}
    ${discarding ? discardPanel(s) : ''}
    ${deletePrep ? deletePrepModal(s) : ''}
    ${pendingConfirm ? actionConfirmModal(pendingConfirm) : ''}
    ${wizard ? distributeWizard(s) : ''}
    ${quickUse ? quickUseCard(s) : ''}
    ${
      active.length
        ? active.map((p) => prepCard(p, s, recipesMap)).join('')
        : exhausted.length
          ? '<div class="empty">Toutes les préparations ont été entièrement affectées ou jetées. Vois-les ci-dessous, ou crée-en une nouvelle.</div>'
          : `<div class="empty">Aucune préparation. Crée-en une à partir d'une recette avec le bouton « Nouvelle préparation » ci-dessus.</div>`
    }
    ${exhausted.length ? exhaustedSection(exhausted, s, recipesMap) : ''}
  `;
  wire(root, s);
}

/**
 * Section repliée des préparations épuisées (disponible = 0) : jamais
 * supprimées, jamais perdues de vue — juste reléguées hors de la liste
 * active. prepCard() y désactive déjà tous les boutons d'action (Répartir,
 * +Utiliser, Jeter), mais « Voir les affectations » y reste utilisable pour
 * vérifier/retirer une affectation existante si besoin.
 */
function exhaustedSection(exhausted, s, recipesMap) {
  return `<div style="margin-top:16px">
    <button class="btn btn--sm btn--ghost" data-toggle-exhausted>${exhaustedOpen ? 'Masquer' : 'Voir'} les préparations épuisées (${exhausted.length})</button>
    ${exhaustedOpen ? `<div style="margin-top:10px">${exhausted.map((p) => prepCard(p, s, recipesMap)).join('')}</div>` : ''}
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Carte préparation (stock)                                           */
/* ------------------------------------------------------------------ */

function unitLabelFor(prep, grams) {
  if (prep.recipeSnapshot?.kind === 'portion') {
    const portionGrams = portionGramsOf(prep.recipeSnapshot);
    return `${num(grams / portionGrams, 1)} portion(s)`;
  }
  return `${num(grams, 0)} g`;
}

function prepCard(p, s, recipesMap) {
  const prepared = preparedGramsOf(p);
  const used = preparationUsed(s, p.id);
  const jete = preparationWasted(p);
  const disponible = preparationAvailable(s, p);
  const recipeName = recipesMap[p.recipeId]?.name || '?';
  const epuisee = disponible <= 0;
  const assignments = preparationAssignments(s, p.id, s.settings.cycle.startWeekday);
  const open = assignmentsOpen.has(p.id);

  return `<div class="card" style="margin-bottom:12px">
    <div class="card__head">
      <h3>${esc(p.label)}</h3>
      <span class="tag">${esc(recipeName)}</span>
    </div>
    <div class="kv">
      <div><small>Préparé</small><b>${unitLabelFor(p, prepared)}</b></div>
      <div><small>Affecté</small><b>${unitLabelFor(p, Math.max(0, used))}</b></div>
      ${jete > 0 ? `<div><small>Jeté</small><b>${unitLabelFor(p, jete)}</b></div>` : ''}
      <div><small>Disponible</small><b class="${epuisee ? 'muted' : ''}">${unitLabelFor(p, Math.max(0, disponible))}</b></div>
    </div>
    ${epuisee ? '<small class="muted">Entièrement affectée ou jetée : conservée, mais plus proposée pour une nouvelle répartition.</small>' : ''}
    <div class="row" style="margin-top:10px">
      <button class="btn btn--primary" data-open-distribute="${p.id}" ${epuisee ? 'disabled' : ''}>Répartir</button>
      <button class="btn btn--sm" data-open-quick-use="${p.id}" ${epuisee ? 'disabled' : ''}>+ Utiliser dans un repas</button>
      <button class="btn btn--sm btn--danger" data-open-discard-confirm="${p.id}" ${epuisee ? 'disabled' : ''}>Jeter les restes</button>
      <button class="btn btn--sm btn--ghost" data-open-discard-partial="${p.id}" ${epuisee ? 'disabled' : ''}>Jeter une quantité partielle…</button>
      ${assignments.length ? `<button class="btn btn--sm btn--ghost" data-toggle-assignments="${p.id}">${open ? 'Masquer' : 'Voir'} les affectations (${assignments.length})</button>` : ''}
      <button class="btn btn--sm btn--ghost" data-open-delete-prep="${p.id}"
        title="${assignments.length ? 'Retire d’abord ses affectations (ci-dessus) pour pouvoir la supprimer.' : ''}">Supprimer la préparation</button>
    </div>
    ${open ? assignmentsSection(p, assignments) : ''}
  </div>`;
}

/**
 * Liste éditable des affectations actuelles d'une préparation (P1.B) : modifie
 * la quantité de l'item EN PLACE (jamais de doublon, jamais un second
 * décompte) — même `itemId` retrouvé et réécrit par `onEditAssignment()`.
 */
function assignmentsSection(p, assignments) {
  const disponible = preparationAvailable(getState(), p);
  const rows = assignments.map((a) => {
    const total = a.qtyByPerson.thomas + a.qtyByPerson.julie;
    // la nouvelle quantité peut aller jusqu'à (ce qui est déjà affecté ICI +
    // le disponible restant ailleurs) — jamais plus, jamais de stock négatif.
    const max = Math.round(total + disponible);
    return `<div class="item" style="padding:6px 0">
      <div class="item__main">
        <div class="item__name">${esc(a.label)}</div>
      </div>
      <div class="item__qty">
        <input type="number" min="0" max="${max}" step="1" data-assignment-qty="${a.itemId}" value="${num(total, 0)}" style="width:90px"> <small>g</small>
        <button class="btn btn--sm btn--danger" data-assignment-remove="${a.itemId}">Retirer</button>
      </div>
    </div>`;
  }).join('');
  return `<div style="margin-top:10px;border-top:1px solid var(--line);padding-top:8px">
    <small class="muted">Modifier une quantité met à jour l'affectation existante. La retirer libère le disponible.</small>
    <div class="items" style="margin-top:6px">${rows}</div>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Création d'une préparation à partir d'une recette (P1.A)            */
/* ------------------------------------------------------------------ */

function createPanel(s) {
  const recipe = s.recipes.find((r) => r.id === creating.recipeId) || s.recipes[0];
  if (!recipe) return '';
  const isPortion = recipe.kind === 'portion';
  const refGrams = isPortion ? portionGramsOf(recipe) : (Number(recipe.baseGrams) || 0);
  const byId = foodsById();
  const qty = Number(creating.qty) || 0;
  // préparation PORTION : la quantité saisie est un NOMBRE DE PORTIONS (même
  // convention que newPreparation()/preparedGramsOf(), décision verrouillée) ;
  // c'est donc bien × refGrams, et non refGrams lui-même, qu'il faut passer à
  // deployItems() pour obtenir les quantités d'ingrédients réellement nécessaires.
  const targetGrams = isPortion ? qty * refGrams : qty;
  // réutilise EXACTEMENT le mécanisme déjà utilisé par le batch/les courses
  // pour déplier une recette en aliments réels à une échelle donnée — aucun
  // second calcul de proportion ici.
  const previewItems = qty > 0 && refGrams > 0
    ? deployItems([{ recipeId: recipe.id, qty: { thomas: targetGrams, julie: 0 } }], recipesById(), {})
    : [];

  const refRows = recipe.items
    .map((it) => `<div class="item" style="padding:4px 0">
        <div class="item__main"><div class="item__name">${esc(byId[it.foodId]?.name || 'Aliment supprimé')}</div></div>
        <div class="item__meta nums">${num(it.qty, 0)} g (référence)</div>
      </div>`)
    .join('');

  const previewRows = previewItems
    .map((it) => `<div class="item" style="padding:4px 0">
        <div class="item__main"><div class="item__name">${esc(byId[it.foodId]?.name || 'Aliment supprimé')}</div></div>
        <div class="item__meta nums">${num(it.qty.thomas, 0)} g</div>
      </div>`)
    .join('');

  return `<div class="drawer" data-create-backdrop>
    <div class="drawer__panel" style="width:min(520px,100%)">
      <div class="drawer__head"><div class="row">
        <h3 style="flex:1">Nouvelle préparation</h3>
        <button class="btn btn--ghost" data-create-cancel>Fermer</button>
      </div></div>
      <div class="drawer__body">
        <label class="field">Recette
          <select data-create-recipe>
            ${s.recipes.map((r) => `<option value="${r.id}" ${r.id === recipe.id ? 'selected' : ''}>${esc(r.name)} (${r.kind === 'portion' ? 'portion' : 'au poids'})</option>`).join('')}
          </select>
        </label>
        <small style="display:block;margin-top:6px">${isPortion ? `Référence : 1 portion = ${num(refGrams, 0)} g` : `Référence : ${num(refGrams, 0)} g`} · ${recipe.items.length} ingrédient(s)</small>
        <div class="items" style="margin:8px 0">${refRows}</div>

        <label class="field" style="margin-top:10px">${isPortion ? 'Nombre de portions obtenues' : 'Quantité obtenue (g)'}
          <input type="number" min="0" step="1" data-create-qty value="${creating.qty || ''}"
                 placeholder="${isPortion ? 'ex. 4 portions' : 'ex. 1200 g'}"></label>
        <small style="display:block;margin-top:4px">Quantité RÉELLEMENT obtenue après cuisson — jamais recalculée depuis les ingrédients.</small>

        ${
          qty > 0
            ? `<h4 style="margin-top:14px">Quantités d'ingrédients nécessaires pour ${isPortion ? `${num(qty, 0)} portion(s)` : `${num(qty, 0)} g`}</h4>
               <div class="items" style="margin-top:6px">${previewRows}</div>`
            : ''
        }

        <div class="row" style="margin-top:14px">
          <button class="btn btn--ghost" data-create-cancel>Annuler</button>
          <button class="btn btn--primary" data-create-confirm ${qty > 0 ? '' : 'disabled'}>Créer la préparation</button>
        </div>
      </div>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* « Jeter les restes » — jet total en un seul dialogue (2 clics)       */
/* ------------------------------------------------------------------ */

/**
 * Confirmation UNIQUE du jet de la totalité du disponible : le clic sur
 * « Jeter les restes » ouvre directement ce dialogue (aucun écran
 * intermédiaire), et la quantité affichée comme celle réellement jetée sont
 * toutes deux calculées via preparationAvailable() au moment du rendu —
 * jamais figées à l'ouverture — pour rester exactes si le stock a changé
 * entre-temps (autre onglet, synchronisation, affectation concurrente).
 */
function discardConfirmModal(s) {
  const p = s.preparations.find((x) => x.id === discardConfirm.preparationId);
  if (!p) return '';
  const disponible = preparationAvailable(s, p);
  return `<div class="modal" data-discard-confirm-backdrop role="dialog" aria-modal="true" aria-label="Jeter les restes ?">
    <div class="modal__panel">
      <h3 style="margin-bottom:8px">Jeter les restes ?</h3>
      <p>Vous allez jeter les ${unitLabelFor(p, Math.max(0, disponible))} restants de « ${esc(p.label)} ». Cette action est irréversible.</p>
      <div class="row" style="margin-top:14px;justify-content:flex-end">
        <button class="btn" data-discard-confirm-cancel>Annuler</button>
        <button class="btn btn--danger" data-discard-confirm-ok>Confirmer le jet</button>
      </div>
    </div>
  </div>`;
}

/**
 * Suppression DÉFINITIVE d'une préparation — contrairement à « Jeter les
 * restes » (qui trace une perte mais garde la préparation), ceci retire la
 * ligne elle-même. Seule façon de lever le blocage « impossible de
 * supprimer une recette » (recipes.js, restriction verrouillée : une
 * recette avec des préparations existantes n'est jamais supprimée
 * silencieusement) une fois la préparation réellement terminée. N'affiche
 * cet avertissement que s'il reste du stock à perdre — une préparation déjà
 * à 0 n'a rien de plus à signaler.
 */
function deletePrepModal(s) {
  const p = s.preparations.find((x) => x.id === deletePrep.preparationId);
  if (!p) return '';
  const disponible = preparationAvailable(s, p);
  const hasStock = disponible > 1e-6;
  return `<div class="modal" data-delete-prep-backdrop role="dialog" aria-modal="true" aria-label="Supprimer la préparation ?">
    <div class="modal__panel">
      <h3 style="margin-bottom:8px">Supprimer la préparation ?</h3>
      <p>
        ${hasStock ? `« ${esc(p.label)} » a encore <strong>${unitLabelFor(p, disponible)}</strong> disponibles : ils seront perdus avec la préparation. ` : `« ${esc(p.label)} » va être supprimée. `}
        Cette action est irréversible.
      </p>
      <div class="row" style="margin-top:14px;justify-content:flex-end">
        <button class="btn" data-delete-prep-cancel>Annuler</button>
        <button class="btn btn--danger" data-delete-prep-ok>Confirmer la suppression</button>
      </div>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* « Jeter une quantité partielle » — flux distinct, volontairement à part */
/* ------------------------------------------------------------------ */

function discardPanel(s) {
  const p = s.preparations.find((x) => x.id === discarding.preparationId);
  if (!p) return '';
  const disponible = preparationAvailable(s, p);
  const qty = Number(discarding.qty) || 0;
  const valid = qty > 0 && qty <= disponible + 1e-6;
  return `<div class="drawer" data-discard-backdrop>
    <div class="drawer__panel" style="width:min(420px,100%)">
      <div class="drawer__head"><div class="row">
        <h3 style="flex:1">Jeter une quantité partielle — « ${esc(p.label)} »</h3>
        <button class="btn btn--ghost" data-discard-cancel>Fermer</button></div>
        <small>Disponible : ${unitLabelFor(p, disponible)}</small>
      </div>
      <div class="drawer__body">
        <label class="field">Quantité à jeter (g)
          <input type="number" min="0" max="${Math.max(0, Math.round(disponible))}" step="1" data-discard-qty value="${discarding.qty || ''}"></label>
        ${
          !valid && discarding.qty !== ''
            ? `<small class="sync-error" style="display:block;margin-top:8px">${
                qty > disponible
                  ? `Tu ne peux pas jeter plus que les ${num(disponible, 0)} g disponibles.`
                  : 'Indique une quantité à jeter supérieure à 0.'
              }</small>`
            : ''
        }
        <div class="row" style="margin-top:14px">
          <button class="btn btn--ghost" data-discard-cancel>Annuler</button>
          <button class="btn btn--danger" data-discard-partial-confirm ${valid ? '' : 'disabled'}>Confirmer la perte</button>
        </div>
      </div>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Assistant « Répartir » (variante B — checklist directe)             */
/* ------------------------------------------------------------------ */

const catalogKeyOf = (c) => `${c.kind}:${c.optionId}:${c.slot ?? 'x'}`;

function distributeWizard(s) {
  const p = s.preparations.find((x) => x.id === wizard.preparationId);
  if (!p) return '';
  const disponible = preparationAvailable(s, p);
  const cand = distributionCandidates(s, s.settings.cycle.startWeekday);

  const mealRows = cand.meals
    .map(
      (c) => `<label class="check" style="display:block;padding:4px 0">
        <input type="checkbox" data-pick-meal="${c.mealId}" ${wizard.mealIds.has(c.mealId) ? 'checked' : ''}>
        ${esc(c.label)}
      </label>`
    )
    .join('');

  const catalogRows = cand.catalog
    .map((c) => {
      const key = catalogKeyOf(c);
      const entry = wizard.catalog.get(key) || { picked: false, perServiceQty: 0 };
      return `<div style="padding:6px 0">
        <label class="check">
          <input type="checkbox" data-pick-catalog="${key}" ${entry.picked ? 'checked' : ''}>
          ${esc(c.label)} <span class="tag">habituel : ${c.usesCount} utilisation(s)/cycle</span>
        </label>
        ${
          entry.picked
            ? `<div class="row" style="margin:4px 0 0 24px">
                 <small>Quantité par service :</small>
                 <input type="number" min="0" step="1" data-catalog-qty="${key}" value="${entry.perServiceQty || ''}" style="width:90px">
                 <small>g</small>
               </div>`
            : ''
        }
      </div>`;
    })
    .join('');

  const catalogTotal = [...wizard.catalog.entries()].reduce((sum, [key, entry]) => {
    if (!entry.picked) return sum;
    const c = cand.catalog.find((x) => catalogKeyOf(x) === key);
    return sum + Number(entry.perServiceQty || 0) * (c?.usesCount || 0);
  }, 0);
  const mealCount = wizard.mealIds.size;
  const remainder = wizard.amount - catalogTotal;
  const valid = wizard.amount > 0 && wizard.amount <= disponible + 1e-6 && catalogTotal <= wizard.amount + 1e-6
    && (remainder <= 1e-6 || mealCount > 0) && (remainder > 1e-6 || mealCount === 0);

  return `<div class="drawer" data-wizard-backdrop>
    <div class="drawer__panel" style="width:min(560px,100%)">
      <div class="drawer__head">
        <div class="row"><h3 style="flex:1">Répartir « ${esc(p.label)} »</h3>
        <button class="btn btn--ghost" data-wizard-cancel>Fermer</button></div>
        <small>Disponible : ${unitLabelFor(p, disponible)}</small>
      </div>
      <div class="drawer__body">
        <div class="row" style="margin-bottom:12px">
          <small>Combien répartir maintenant ?</small>
          <input type="number" min="0" step="1" data-wizard-amount value="${wizard.amount}" style="width:110px"> <small>g</small>
        </div>

        <h4>Repas classiques</h4>
        ${cand.meals.length ? mealRows : '<small class="muted">Aucun repas dans le cycle actuel.</small>'}
        <small>${mealCount} repas sélectionné(s)</small>

        ${
          cand.catalog.length
            ? `<h4 style="margin-top:14px">Petits-déjeuners / Collations</h4>
               <small class="muted">Réparties par service (une option n'est pas liée à un jour précis).</small>
               ${catalogRows}`
            : ''
        }

        <div class="row" style="margin-top:12px">
          <span class="tag${wizard.amount + 0 !== catalogTotal + remainder ? '' : ''}">Total demandé : ${num(catalogTotal + Math.max(0, remainder), 0)} g / ${num(wizard.amount, 0)} g à répartir</span>
        </div>
        ${!valid ? `<small class="sync-error">${
          wizard.amount > disponible
            ? `Cette sélection nécessite ${num(wizard.amount, 0)} g pour ${num(disponible, 0)} g disponibles. Réduis la quantité ou retire un repas.`
            : catalogTotal > wizard.amount
              ? `Les collations/petits-déjeuners sélectionnés nécessitent ${num(catalogTotal, 0)} g, plus que les ${num(wizard.amount, 0)} g à répartir.`
              : remainder > 0
                ? `${num(remainder, 0)} g resteraient sans repas sélectionné pour les recevoir.`
                : 'Aucune quantité ne reste pour les repas sélectionnés : retire-les ou augmente la quantité à répartir.'
        }</small>` : ''}

        <div class="row" style="margin-top:14px">
          <button class="btn btn--ghost" data-wizard-cancel>Annuler</button>
          <button class="btn btn--primary" data-wizard-submit ${valid ? '' : 'disabled'}>Répartir</button>
        </div>
      </div>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* « + Utiliser dans un repas » (assignation directe, sans solveur)     */
/* ------------------------------------------------------------------ */

function quickUseCard(s) {
  const p = s.preparations.find((x) => x.id === quickUse.preparationId);
  if (!p) return '';
  const disponible = preparationAvailable(s, p);
  const cand = distributionCandidates(s, s.settings.cycle.startWeekday);
  return `<div class="drawer" data-quickuse-backdrop>
    <div class="drawer__panel" style="width:min(420px,100%)">
      <div class="drawer__head"><div class="row"><h3 style="flex:1">Utiliser « ${esc(p.label)} »</h3>
        <button class="btn btn--ghost" data-quickuse-cancel>Fermer</button></div>
        <small>Disponible : ${unitLabelFor(p, disponible)}</small>
      </div>
      <div class="drawer__body">
        <div class="row" style="margin-bottom:10px">
          <select data-quickuse-meal style="flex:1">
            ${cand.meals.map((c) => `<option value="${c.mealId}" ${quickUse.mealId === c.mealId ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}
          </select>
        </div>
        <div class="row">
          <input type="number" min="1" step="1" data-quickuse-qty value="${quickUse.qty}" style="width:110px"> <small>g</small>
        </div>
        <div class="row" style="margin-top:12px">
          <button class="btn btn--primary" data-quickuse-confirm>Ajouter au repas</button>
        </div>
      </div>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Résultat après répartition                                          */
/* ------------------------------------------------------------------ */

function resultCard(result) {
  const rows = result.lines
    .map((l) => {
      const macroText = PERSONS.map((person) => {
        const ev = l.macros[person];
        return `${PERSON_LABEL[person]} ${ev.rows.map((r) => `${num(r.value, r.key === 'kcal' ? 0 : 1)}${r.key === 'kcal' ? '' : 'g'} ${r.label}`).join(' · ')}`;
      }).join(' — ');
      return `<div class="item" style="padding:6px 0">
        <div class="item__main">
          <div class="item__name">${esc(l.label)} — ${num(l.qty, 0)} g</div>
          <div class="item__meta">${esc(macroText)}</div>
          ${l.volumeAlert ? `<div class="tag sync-error">⚠️ ${esc(l.volumeAlert)}</div>` : ''}
        </div>
      </div>`;
    })
    .join('');
  const catalogRows = result.catalogLines
    .map((c) => `<div class="item" style="padding:6px 0"><div class="item__main"><div class="item__name">${esc(c.label)} — ${num(c.qty, 0)} g/service</div></div></div>`)
    .join('');

  return `<div class="card" style="margin-bottom:16px;border-color:#8fbf9f">
    <div class="card__head">
      <h3>Répartition terminée</h3>
      <button class="btn btn--sm btn--ghost" data-dismiss-result>Fermer</button>
    </div>
    <p><strong>${num(result.total, 0)} g</strong> affectés (« ${esc(result.prepLabel)} »).</p>
    ${rows}
    ${catalogRows}
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Interactions                                                        */
/* ------------------------------------------------------------------ */

function wire(root, s) {
  root.querySelectorAll('[data-open-distribute]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const id = e.currentTarget.dataset.openDistribute;
      const p = getState().preparations.find((x) => x.id === id);
      if (!p) return;
      const disponible = preparationAvailable(getState(), p);
      wizard = { preparationId: id, amount: Math.max(0, Math.round(disponible)), mealIds: new Set(), catalog: new Map() };
      lastResult = null;
      render(root);
    });
  });

  // deux boutons portent ce même attribut (Fermer en en-tête, Annuler en
  // pied de panneau) : querySelector() seul n'aurait câblé que le premier,
  // laissant "Annuler" totalement inerte — d'où le bug rapporté.
  root.querySelectorAll('[data-wizard-cancel]').forEach((btn) => btn.addEventListener('click', () => { wizard = null; render(root); }));
  root.querySelector('[data-wizard-backdrop]')?.addEventListener('mousedown', (e) => {
    if (e.target.dataset.wizardBackdrop !== undefined) { wizard = null; render(root); }
  });

  root.querySelector('[data-wizard-amount]')?.addEventListener('change', (e) => {
    wizard.amount = Math.max(0, Number(e.target.value) || 0);
    render(root);
  });

  root.querySelectorAll('[data-pick-meal]').forEach((cb) => {
    cb.addEventListener('change', (e) => {
      const id = e.currentTarget.dataset.pickMeal;
      if (e.currentTarget.checked) wizard.mealIds.add(id); else wizard.mealIds.delete(id);
      render(root);
    });
  });

  root.querySelectorAll('[data-pick-catalog]').forEach((cb) => {
    cb.addEventListener('change', (e) => {
      const key = e.currentTarget.dataset.pickCatalog;
      const entry = wizard.catalog.get(key) || { picked: false, perServiceQty: 0 };
      entry.picked = e.currentTarget.checked;
      wizard.catalog.set(key, entry);
      render(root);
    });
  });

  root.querySelectorAll('[data-catalog-qty]').forEach((inp) => {
    inp.addEventListener('change', (e) => {
      const key = e.currentTarget.dataset.catalogQty;
      const entry = wizard.catalog.get(key) || { picked: true, perServiceQty: 0 };
      entry.perServiceQty = Math.max(0, Number(e.target.value) || 0);
      wizard.catalog.set(key, entry);
      render(root);
    });
  });

  root.querySelector('[data-wizard-submit]')?.addEventListener('click', () => onSubmitDistribution(root));

  // « + Utiliser dans un repas »
  root.querySelectorAll('[data-open-quick-use]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const id = e.currentTarget.dataset.openQuickUse;
      const st = getState();
      const p = st.preparations.find((x) => x.id === id);
      if (!p) return;
      const cand = distributionCandidates(st, st.settings.cycle.startWeekday);
      if (!cand.meals.length) { toast('Aucun repas dans le cycle actuel', 'error'); return; }
      const disponible = preparationAvailable(st, p);
      const isPortion = p.recipeSnapshot?.kind === 'portion';
      const qty = isPortion
        ? Math.min(portionGramsOf(p.recipeSnapshot), Math.max(1, disponible))
        : Math.max(1, Math.round(Math.min(disponible, 200)));
      quickUse = { preparationId: id, mealId: cand.meals[0].mealId, qty };
      render(root);
    });
  });
  root.querySelector('[data-quickuse-cancel]')?.addEventListener('click', () => { quickUse = null; render(root); });
  root.querySelector('[data-quickuse-backdrop]')?.addEventListener('mousedown', (e) => {
    if (e.target.dataset.quickuseBackdrop !== undefined) { quickUse = null; render(root); }
  });
  root.querySelector('[data-quickuse-meal]')?.addEventListener('change', (e) => { quickUse.mealId = e.target.value; });
  root.querySelector('[data-quickuse-qty]')?.addEventListener('change', (e) => { quickUse.qty = Math.max(1, Number(e.target.value) || 1); });
  root.querySelector('[data-quickuse-confirm]')?.addEventListener('click', () => {
    const { preparationId, mealId, qty } = quickUse;
    if (!(qty > 0)) { toast('Indique une quantité supérieure à 0', 'error'); return; }
    update((st) => {
      const meal = st.meals.find((m) => m.id === mealId);
      if (!meal) return;
      meal.items.push(newPreparationItem(preparationId, qty));
    });
    toast('Préparation ajoutée au repas');
    quickUse = null;
  });

  root.querySelector('[data-dismiss-result]')?.addEventListener('click', () => { lastResult = null; render(root); });

  // --- Nouvelle préparation (P1.A)
  root.querySelector('[data-open-create]')?.addEventListener('click', () => {
    const st = getState();
    if (!st.recipes.length) return;
    creating = { recipeId: st.recipes[0].id, qty: '' };
    createBaseline = { ...creating };
    render(root);
  });
  const closeCreate = () => { creating = null; createBaseline = null; confirmingCloseCreate = false; render(root); };
  // Garde « modifications non sauvegardées » (P1, même composant que
  // foods.js/recipes.js) : ce panneau n'a que deux champs (recette, quantité),
  // donc `creating` lui-même sert d'instantané — pas besoin d'un lecteur de
  // formulaire séparé comme readForm() dans foods.js.
  const attemptCloseCreate = () => {
    if (confirmingCloseCreate) return; // déjà en train de demander confirmation
    if (isDirty(createBaseline, creating)) { confirmingCloseCreate = true; render(root); return; }
    closeCreate();
  };
  // même cause que ci-dessus : Fermer (en-tête) ET Annuler (pied) partagent
  // cet attribut — les deux doivent être câblés.
  root.querySelectorAll('[data-create-cancel]').forEach((btn) => btn.addEventListener('click', attemptCloseCreate));
  root.querySelector('[data-create-backdrop]')?.addEventListener('mousedown', (e) => {
    if (e.target.dataset.createBackdrop !== undefined) attemptCloseCreate();
  });
  root.querySelector('[data-unsaved-stay]')?.addEventListener('click', () => { confirmingCloseCreate = false; render(root); });
  root.querySelector('[data-unsaved-discard]')?.addEventListener('click', closeCreate);
  root.querySelector('[data-unsaved-backdrop]')?.addEventListener('mousedown', (e) => {
    // le fond du dialogue revient à « Non, retour » (action sûre par défaut), jamais à une fermeture silencieuse.
    if (e.target.dataset.unsavedBackdrop !== undefined) { confirmingCloseCreate = false; render(root); }
  });
  root.querySelector('[data-create-recipe]')?.addEventListener('change', (e) => {
    creating.recipeId = e.target.value;
    creating.qty = ''; // changer de recette invalide la quantité (unité différente possible : g vs portions)
    render(root);
  });
  root.querySelector('[data-create-qty]')?.addEventListener('change', (e) => {
    creating.qty = e.target.value === '' ? '' : Math.max(0, Number(e.target.value) || 0);
    render(root);
  });
  root.querySelector('[data-create-confirm]')?.addEventListener('click', () => {
    const st = getState();
    const recipe = st.recipes.find((r) => r.id === creating.recipeId);
    const qty = Number(creating.qty);
    if (!recipe) { toast('Choisis une recette', 'error'); return; }
    if (!(qty > 0)) { toast('Indique la quantité réellement obtenue', 'error'); return; }
    update((s2) => {
      const r = s2.recipes.find((x) => x.id === recipe.id);
      if (r) s2.preparations.push(newPreparation(r, qty));
    });
    toast(`Préparation « ${recipe.name} » créée`);
    creating = null;
    createBaseline = null;
    confirmingCloseCreate = false;
    render(root);
  });

  // --- Jeter les restes : jet total, UN SEUL dialogue (clic -> confirmation directe)
  root.querySelectorAll('[data-open-discard-confirm]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const id = e.currentTarget.dataset.openDiscardConfirm;
      if (!getState().preparations.some((x) => x.id === id)) return;
      discardConfirm = { preparationId: id };
      render(root);
    });
  });
  const closeDiscardConfirm = () => { discardConfirm = null; render(root); };
  root.querySelector('[data-discard-confirm-cancel]')?.addEventListener('click', closeDiscardConfirm);
  root.querySelector('[data-discard-confirm-backdrop]')?.addEventListener('mousedown', (e) => {
    if (e.target.dataset.discardConfirmBackdrop !== undefined) closeDiscardConfirm();
  });
  root.querySelector('[data-discard-confirm-ok]')?.addEventListener('click', () => {
    const st0 = getState();
    const p0 = st0.preparations.find((x) => x.id === discardConfirm.preparationId);
    if (!p0) { discardConfirm = null; render(root); return; }
    // revérifié ICI, pas la valeur affichée à l'ouverture : le stock a pu
    // changer entre-temps (autre action, synchronisation).
    const qty = preparationAvailable(st0, p0);
    if (!(qty > 1e-6)) {
      // plus rien à jeter : aucune perte inutile enregistrée.
      discardConfirm = null;
      render(root);
      return;
    }
    update((s2) => {
      const p = s2.preparations.find((x) => x.id === p0.id);
      if (!p) return;
      p.losses = p.losses || [];
      p.losses.push(newPreparationLoss(qty));
    });
    toast('Reste jeté');
    discardConfirm = null;
    render(root);
  });

  // --- Jeter une quantité partielle : flux distinct, inchangé à part son déclencheur
  root.querySelectorAll('[data-open-discard-partial]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const id = e.currentTarget.dataset.openDiscardPartial;
      if (!getState().preparations.some((x) => x.id === id)) return;
      discarding = { preparationId: id, qty: '' };
      render(root);
    });
  });
  const closeDiscard = () => { discarding = null; render(root); };
  // même cause : Fermer (en-tête) ET Annuler (pied) partagent cet attribut.
  root.querySelectorAll('[data-discard-cancel]').forEach((btn) => btn.addEventListener('click', closeDiscard));
  root.querySelector('[data-discard-backdrop]')?.addEventListener('mousedown', (e) => {
    if (e.target.dataset.discardBackdrop !== undefined) closeDiscard();
  });
  root.querySelector('[data-discard-qty]')?.addEventListener('change', (e) => {
    discarding.qty = e.target.value === '' ? '' : Math.max(0, Number(e.target.value) || 0);
    render(root);
  });
  root.querySelector('[data-discard-partial-confirm]')?.addEventListener('click', () => {
    const st0 = getState();
    const p0 = st0.preparations.find((x) => x.id === discarding.preparationId);
    if (!p0) return;
    const qty = Number(discarding.qty) || 0;
    const disponible = preparationAvailable(st0, p0);
    if (!(qty > 0)) { toast('Indique une quantité à jeter supérieure à 0', 'error'); return; }
    if (qty > disponible + 1e-6) { toast(`Tu ne peux pas jeter plus que les ${unitLabelFor(p0, disponible)} disponibles.`, 'error'); return; }
    // confirmation bloquante avant toute perte, même motif que la suppression
    // d'un aliment/d'une recette ailleurs dans l'application.
    pendingConfirm = {
      title: 'Jeter cette quantité ?',
      message: `Jeter ${unitLabelFor(p0, qty)} de « ${p0.label} » ? Cette quantité ne sera plus comptée dans le disponible.`,
      confirmLabel: 'Jeter cette quantité',
      onConfirm: () => {
        update((s2) => {
          const p = s2.preparations.find((x) => x.id === p0.id);
          if (!p) return;
          p.losses = p.losses || [];
          p.losses.push(newPreparationLoss(qty));
        });
        toast('Perte enregistrée');
        discarding = null;
        render(root);
      },
    };
    render(root);
  });

  // --- Section repliée des préparations épuisées
  root.querySelector('[data-toggle-exhausted]')?.addEventListener('click', () => {
    exhaustedOpen = !exhaustedOpen;
    render(root);
  });

  // --- Supprimer la préparation (définitif, distinct de « Jeter les restes »)
  root.querySelectorAll('[data-open-delete-prep]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const id = e.currentTarget.dataset.openDeletePrep;
      const st = getState();
      const p = st.preparations.find((x) => x.id === id);
      if (!p) return;
      // des affectations existantes ne doivent jamais disparaître en silence
      // avec la préparation : on bloque, comme le fait déjà la suppression
      // d'une recette ayant des préparations existantes.
      const assignments = preparationAssignments(st, id, st.settings.cycle.startWeekday);
      if (assignments.length) {
        toast('Impossible : des affectations existent encore pour cette préparation. Retire-les d’abord (« Voir les affectations »).', 'error');
        return;
      }
      deletePrep = { preparationId: id };
      render(root);
    });
  });
  const closeDeletePrep = () => { deletePrep = null; render(root); };
  root.querySelector('[data-delete-prep-cancel]')?.addEventListener('click', closeDeletePrep);
  root.querySelector('[data-delete-prep-backdrop]')?.addEventListener('mousedown', (e) => {
    if (e.target.dataset.deletePrepBackdrop !== undefined) closeDeletePrep();
  });
  root.querySelector('[data-delete-prep-ok]')?.addEventListener('click', () => {
    const st0 = getState();
    const p0 = st0.preparations.find((x) => x.id === deletePrep.preparationId);
    if (!p0) { deletePrep = null; render(root); return; }
    // revérifié ICI, pas seulement à l'ouverture : une affectation a pu être
    // ajoutée entre-temps (autre action, synchronisation) — jamais de
    // suppression qui orphelinerait un item de repas.
    const assignments = preparationAssignments(st0, p0.id, st0.settings.cycle.startWeekday);
    if (assignments.length) {
      toast('Impossible : des affectations existent encore pour cette préparation.', 'error');
      deletePrep = null;
      render(root);
      return;
    }
    update((s2) => { s2.preparations = s2.preparations.filter((x) => x.id !== p0.id); });
    toast('Préparation supprimée');
    deletePrep = null;
    render(root);
  });

  wireActionConfirm(root, { getPending: () => pendingConfirm, setPending: (v) => { pendingConfirm = v; }, render });

  // --- Affectations actuelles (P1.B) : édition en place, jamais de doublon
  root.querySelectorAll('[data-toggle-assignments]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const id = e.currentTarget.dataset.toggleAssignments;
      if (assignmentsOpen.has(id)) assignmentsOpen.delete(id); else assignmentsOpen.add(id);
      render(root);
    });
  });
  root.querySelectorAll('[data-assignment-qty]').forEach((input) => {
    input.addEventListener('change', (e) => onEditAssignment(root, e.currentTarget.dataset.assignmentQty, Number(e.target.value)));
  });
  root.querySelectorAll('[data-assignment-remove]').forEach((btn) => {
    btn.addEventListener('click', (e) => onEditAssignment(root, e.currentTarget.dataset.assignmentRemove, 0));
  });
}

/**
 * Localise l'item (repas ou option de catalogue) référencé par `itemId` et
 * réécrit sa quantité EN PLACE — jamais de nouvel item créé, jamais un double
 * décompte. `newQty` réparti selon le ratio thomas/julie déjà en place (ou
 * également réparti si l'affectation existante était nulle). `newQty = 0`
 * retire entièrement l'item.
 */
function onEditAssignment(root, itemId, newQty) {
  if (!(newQty >= 0)) { toast('Indique une quantité valide', 'error'); return; }
  const st0 = getState();
  let found = null;
  for (const meal of st0.meals) { const it = meal.items.find((x) => x.id === itemId); if (it) { found = { container: 'meal', ownerId: meal.id, item: it }; break; } }
  if (!found) for (const o of st0.breakfasts) { const it = o.items.find((x) => x.id === itemId); if (it) { found = { container: 'breakfasts', ownerId: o.id, item: it }; break; } }
  if (!found) for (const o of st0.snacks) { const it = o.items.find((x) => x.id === itemId); if (it) { found = { container: 'snacks', ownerId: o.id, item: it }; break; } }
  if (!found) return;

  const prep = st0.preparations.find((p) => p.id === found.item.preparationId);
  if (!prep) return;
  const oldTotal = (found.item.qty?.thomas || 0) + (found.item.qty?.julie || 0);
  const disponible = preparationAvailable(st0, prep);
  if (newQty > oldTotal + disponible + 1e-6) {
    toast(`Cette affectation ne peut pas dépasser ${Math.round(oldTotal + disponible)} g (disponible actuel compris).`, 'error');
    return;
  }

  update((s) => {
    const owners = found.container === 'meal' ? s.meals : s[found.container];
    const owner = owners.find((x) => x.id === found.ownerId);
    if (!owner) return;
    if (newQty <= 1e-6) {
      owner.items = owner.items.filter((x) => x.id !== itemId);
      return;
    }
    const it = owner.items.find((x) => x.id === itemId);
    if (!it) return;
    // conserve le ratio thomas/julie déjà en place (ex. issu du solveur) ;
    // 0/0 (jamais affecté avant) se répartit également.
    const ratio = oldTotal > 1e-6 ? newQty / oldTotal : 0.5;
    if (oldTotal > 1e-6) {
      it.qty.thomas = (it.qty.thomas || 0) * ratio;
      it.qty.julie = (it.qty.julie || 0) * ratio;
    } else {
      it.qty.thomas = newQty / 2;
      it.qty.julie = newQty / 2;
    }
  });
  toast(newQty <= 1e-6 ? 'Affectation retirée' : 'Affectation mise à jour');
  render(root);
}

function onSubmitDistribution(root) {
  const s0 = getState();
  const p = s0.preparations.find((x) => x.id === wizard.preparationId);
  if (!p) return;
  const cand = distributionCandidates(s0, s0.settings.cycle.startWeekday);

  const mealPicks = [...wizard.mealIds].map((mealId) => ({ mealId, item: newPreparationItem(p.id, 0) }));
  const catalogPicks = [...wizard.catalog.entries()]
    .filter(([, entry]) => entry.picked && Number(entry.perServiceQty) > 0)
    .map(([key, entry]) => {
      const c = cand.catalog.find((x) => catalogKeyOf(x) === key);
      return c ? { kind: c.kind, optionId: c.optionId, slot: c.slot, usesCount: c.usesCount, perServiceQty: entry.perServiceQty } : null;
    })
    .filter(Boolean);

  const byIdFoods = foodsById();
  const recMap = recipesById();
  const prepMap = preparationsById();
  const plan = planPreparationDistribution(s0, byIdFoods, recMap, prepMap, p.id, {
    amount: wizard.amount, mealPicks, catalogPicks,
  });
  if (!plan.ok) { toast(plan.reason, 'error'); return; }

  const amountRequested = wizard.amount;
  const prepLabel = p.label;

  update((s) => {
    const prep = s.preparations.find((x) => x.id === p.id);

    for (const w of plan.catalogWrites) {
      const list = w.kind === 'breakfast' ? s.breakfasts : s.snacks;
      const opt = list.find((o) => o.id === w.optionId);
      if (!opt) continue;
      opt.items.push(newPreparationItem(prep.id, w.qty));
    }

    const foodsMap = Object.fromEntries(s.foods.map((f) => [f.id, f]));
    const recipesMap = Object.fromEntries(s.recipes.map((r) => [r.id, r]));
    const preparationsMap = Object.fromEntries(s.preparations.map((x) => [x.id, x]));

    const lines = [];
    for (const w of plan.mealWrites) {
      const meal = s.meals.find((m) => m.id === w.mealId);
      if (!meal) continue;
      w.item.qty = { thomas: w.qtyByPerson.thomas || 0, julie: w.qtyByPerson.julie || 0 };
      w.item.locked = { thomas: true, julie: true };
      // conserve la possibilité de rééquilibrer plus tard avec l'ancien
      // mécanisme "zéro reste" — aucun nouveau champ, celui-ci existe déjà.
      w.item.zeroWaste = true;
      meal.items.push(w.item);
      for (const [itemId, qtyByPerson] of Object.entries(w.otherQuantities)) {
        const other = meal.items.find((x) => x.id === itemId);
        if (!other) continue;
        for (const person of PERSONS) if (qtyByPerson[person] !== undefined) other.qty[person] = qtyByPerson[person];
      }

      const macros = {};
      for (const person of PERSONS) {
        const m = mealMacros(meal.items, foodsMap, person, recipesMap, preparationsMap);
        macros[person] = evaluate(m, s.settings.targets[person][meal.mealType], s.settings.tolerance);
      }
      let volumeAlert = null;
      for (const person of PERSONS) {
        const vol = analyzeMealVolume(meal.items, foodsMap, person);
        if (vol.level >= 2) { volumeAlert = `${PERSON_LABEL[person]} — assiette ${vol.label.toLowerCase()}`; break; }
      }
      const label = cand.meals.find((c) => c.mealId === meal.id)?.label
        || `${meal.mealType === 'lunch' ? 'Déjeuner' : 'Dîner'}`;
      lines.push({ label, qty: (w.qtyByPerson.thomas || 0) + (w.qtyByPerson.julie || 0), macros, volumeAlert });
    }

    lastResult = {
      prepLabel,
      total: amountRequested,
      lines,
      catalogLines: plan.catalogWrites.map((w) => {
        const c = cand.catalog.find((x) => x.kind === w.kind && x.optionId === w.optionId && x.slot === w.slot);
        return { label: c?.label || '', qty: w.qty };
      }),
    };
    wizard = null;
  });

  toast('Répartition effectuée');
  render(root);
}
