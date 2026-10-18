/** Écran ALIMENTS — banque alimentaire entièrement modifiable. */

import { getState, update, mergeFoods } from '../core/store.js';
import { CATEGORIES, STATES, computeYield } from '../core/nutrition.js';
import { esc, num, normalize, toast, uid, euros, debounce } from '../core/util.js';
import { findSimilarFoods, findDuplicateGroups } from '../core/similarity.js';
import { fetchProductByBarcode, searchProductsByText, normalizeBarcode } from '../core/off.js';
import { similarConfirmModal } from './confirm-similar.js';
import { isDirty, unsavedConfirmModal } from './confirm-unsaved.js';
import { actionConfirmModal, wireActionConfirm } from './confirm-action.js';

let pendingConfirm = null; // { title, message, confirmLabel, onConfirm } — P1, remplace confirm() natif
let offSearch = null; // panneau de recherche Open Food Facts — voir openOffSearch()
let offRequestId = 0; // garde-fou anti-réponse périmée (une recherche plus récente écrase la précédente)
let offController = null; // AbortController de la requête OFF en cours, pour l'annuler si une autre démarre
let query = '';
let cat = 'all';
let duplicatesOpen = false; // P3 : section « Doublons détectés » dépliée ou non
let mergeKeep = {}; // id du premier aliment d'un groupe -> id choisi pour être conservé
let editing = null; // id d'aliment ou 'new'
let similarWarning = null; // { list, pending } — popup de confirmation de doublon
let formDraft = null;      // saisie en cours, préservée entre deux rendus du formulaire
let yieldCalc = null;      // { raw, cooked, result, error } — aide au calcul du rendement
let formBaseline = null;   // P2 : instantané du formulaire à l'ouverture, pour détecter une modification non sauvegardée
let confirmingClose = false; // P2 : le dialogue « Modifications non sauvegardées » est affiché
let escBound = false;      // P2 : évite d'empiler plusieurs écouteurs Échap entre deux rendus
let duplicateGroupsCache = { foods: null, groups: [] }; // P4 : voir getDuplicateGroups()

/**
 * findDuplicateGroups() est en O(n²) (chaque aliment comparé à tous les
 * autres) : mesuré à plusieurs centaines de ms dès quelques centaines
 * d'aliments. renderFull() tournant à chaque frappe dans la recherche ou
 * changement de filtre (aucun rapport avec les doublons), le recalculer à
 * chaque fois gèlerait l'interface sur une banque alimentaire un peu
 * fournie. On ne recalcule que si `foods` a réellement changé (longueur ou
 * référence d'un élément — suffisant : la banque n'est modifiée que par
 * remplacement de tableau, push, ou remplacement d'un élément, jamais par
 * mutation interne silencieuse d'un aliment existant pertinente ici).
 *
 * Le cache garde un INSTANTANÉ (copie superficielle, `.slice()`) du tableau,
 * jamais une référence directe : `s.foods` est muté en place par certains
 * appelants (`.push()` à la création) — garder la référence vivante rendrait
 * l'instantané et l'état courant indiscernables (même tableau), la
 * comparaison ne détecterait alors plus jamais un ajout.
 */
function getDuplicateGroups(foods) {
  const c = duplicateGroupsCache;
  if (c.foods && c.foods.length === foods.length && c.foods.every((f, i) => f === foods[i])) {
    return c.groups;
  }
  const groups = findDuplicateGroups(foods);
  duplicateGroupsCache = { foods: foods.slice(), groups };
  return groups;
}

/** Ouvre directement la fiche d'un aliment (appelé depuis l'écran Courses). */
export function openFoodForm(id) {
  editing = id;
  similarWarning = null;
  formDraft = null;
  yieldCalc = null;
  formBaseline = null; // recapturé au prochain render() via wire()
  confirmingClose = false;
  closeOffSearch();
}

/**
 * Point d'entrée pour un futur lecteur de code-barres (caméra ou douchette) :
 * un module de scan n'a qu'à appeler cette fonction (ou, de façon découplée,
 * déclencher `document.dispatchEvent(new CustomEvent('nutriplan:off-barcode',
 * { detail: { barcode } }))`, écouté dans app.js comme `nutriplan:open-food`)
 * pour ouvrir directement la création d'un aliment avec la recherche OFF déjà
 * lancée sur ce code — aucune caméra/douchette n'est implémentée ici.
 */
export function openFoodFormWithBarcode(root, barcode) {
  resetForm();
  editing = 'new';
  formDraft = blank();
  openOffSearch();
  offSearch.barcodeInput = normalizeBarcode(barcode);
  render(root);
  runBarcodeSearch(root);
}

export function render(root) {
  const s = getState();

  // Le formulaire est déjà ouvert (.drawer__panel existe déjà dans le DOM) :
  // on ne met à jour QUE son contenu et les sur-couches (rendement, doublon,
  // confirmation), jamais .drawer/.drawer__panel eux-mêmes — voir
  // refreshOpenForm() pour la raison (rejeu de l'animation d'entrée, cf.
  // correctif « clipping » de recipes.js, même cause ici).
  if (editing && root.querySelector('.drawer__panel')) {
    refreshOpenForm(root, s);
    return;
  }

  renderFull(root, s);
}

function renderFull(root, s) {
  const q = normalize(query);
  let list = [...s.foods].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  if (cat === 'fav') list = list.filter((f) => f.favorite);
  else if (cat !== 'all') list = list.filter((f) => f.category === cat);
  if (q) list = list.filter((f) => normalize(`${f.name} ${f.brand}`).includes(q));

  const duplicateGroups = getDuplicateGroups(s.foods);

  root.innerHTML = `
    <div class="row" style="margin-bottom:12px">
      <input type="text" data-q value="${esc(query)}" placeholder="Rechercher un aliment…" style="flex:1;min-width:200px">
      <button class="btn btn--primary" data-new>Nouvel aliment</button>
    </div>
    <div class="chips" style="margin-bottom:12px">
      ${[['all', 'Tous'], ['fav', 'Favoris'], ...CATEGORIES.map((c) => [c.id, c.label])]
        .map(([id, label]) => `<button class="chip" data-cat="${id}" aria-pressed="${cat === id}">${esc(label)}</button>`)
        .join('')}
    </div>
    ${duplicateGroups.length ? `<div class="row" style="margin-bottom:12px">
      <button class="btn btn--sm" data-toggle-duplicates>${duplicatesOpen ? 'Masquer' : 'Voir'} les doublons possibles (${duplicateGroups.length})</button>
    </div>` : ''}
    ${duplicatesOpen ? duplicatesPanel(duplicateGroups) : ''}
    <div class="card">
      <table>
        <thead><tr>
          <th>Aliment</th><th class="nums">kcal</th><th class="nums">P</th><th class="nums">G</th><th class="nums">L</th>
          <th>État</th><th>Unité</th><th class="nums">Prix</th><th>Batch</th><th></th>
        </tr></thead>
        <tbody>
          ${list.length ? list.map(rowOf).join('') : `<tr><td colspan="10" class="muted">Aucun aliment ne correspond.</td></tr>`}
        </tbody>
      </table>
    </div>
    <small>${list.length} aliment(s) affiché(s) sur ${s.foods.length}. Valeurs pour 100 g dans l'état de référence.</small>
    ${editing ? formPanel(s) : ''}
    <div id="food-overlays">${overlaysHtml(s)}</div>
  `;
  wireList(root);
  if (editing) { wireDrawerChrome(root); wireDrawerBody(root); wireOverlays(root); }
  // câblé une seule fois ici (jamais dans wireList()/wireOverlays()
  // individuellement) : les deux peuvent s'exécuter dans le même passage
  // quand editing est vrai, ce qui doublonnerait l'écouteur sur le même bouton.
  wireActionConfirm(root, { getPending: () => pendingConfirm, setPending: (v) => { pendingConfirm = v; }, render });
  captureBaselineIfNeeded(root, s);
}

/**
 * Section « Doublons détectés » (P3) — jamais de fusion automatique : chaque
 * groupe propose un choix explicite (lequel garder), puis une confirmation
 * bloquante avant toute fusion réelle. findDuplicateGroups() ne fait que
 * DÉTECTER (similarity.js, inchangé) ; la fusion elle-même est nouvelle.
 */
function duplicatesPanel(groups) {
  return `<div class="card" style="margin-bottom:12px;border-color:#ecd7ae;background:var(--warn-bg)">
    <div class="card__head"><h3>Doublons possibles</h3></div>
    <small style="display:block;margin-bottom:10px">Rien n'est fusionné automatiquement : choisis l'aliment à conserver dans chaque groupe, les autres y seront redirigés partout où ils sont utilisés (recettes, repas, catalogues, courses, batch), puis supprimés.</small>
    ${groups.map((g) => {
      const members = [g.food, ...g.similar.map((x) => x.food)];
      const groupKey = g.food.id;
      const keepId = mergeKeep[groupKey] || g.food.id;
      return `<div class="card" style="margin-bottom:8px">
        ${members.map((f) => `<label class="check" style="display:block;padding:4px 0">
            <input type="radio" name="merge-keep-${esc(groupKey)}" data-merge-keep="${groupKey}" value="${f.id}" ${f.id === keepId ? 'checked' : ''}>
            <strong>${esc(f.name)}</strong>${f.brand ? ` — ${esc(f.brand)}` : ''}
            <span class="tag">${num(f.kcal, 0)} kcal/100g · ${esc(f.category)}${f.gramsPerUnit ? ` · ${num(f.gramsPerUnit, 0)} g/unité` : ''}</span>
          </label>`).join('')}
        <div class="row" style="margin-top:8px">
          <button class="btn btn--sm btn--danger" data-merge-group="${groupKey}">Fusionner dans l'aliment coché</button>
        </div>
      </div>`;
    }).join('')}
  </div>`;
}

/**
 * Met à jour UNIQUEMENT le contenu du formulaire déjà ouvert (.drawer__body)
 * et les sur-couches (#food-overlays : rendement, doublon, confirmation de
 * fermeture) — .drawer/.drawer__panel/.drawer__head ne sont JAMAIS recréés
 * pendant que le formulaire reste ouvert, qu'il s'agisse d'afficher ou de
 * fermer le dialogue « Modifications non sauvegardées », d'ouvrir l'aide au
 * rendement, ou de toute autre interaction pendant l'édition.
 */
function refreshOpenForm(root, s) {
  const body = root.querySelector('.drawer__body');
  if (!body) { renderFull(root, s); return; }
  const f = currentFormData(s);
  if (!f) { renderFull(root, s); return; }
  body.innerHTML = formBodyHtml(f);
  let overlays = root.querySelector('#food-overlays');
  if (!overlays) { renderFull(root, s); return; }
  overlays.innerHTML = overlaysHtml(s);
  wireDrawerBody(root);
  wireOverlays(root);
  wireActionConfirm(root, { getPending: () => pendingConfirm, setPending: (v) => { pendingConfirm = v; }, render });
  captureBaselineIfNeeded(root, s);
}

function overlaysHtml(s) {
  return `${editing && yieldCalc ? yieldPanel() : ''}${editing && offSearch ? offSearchPanel(s) : ''}${similarWarning ? similarModal() : ''}${editing && confirmingClose ? unsavedConfirmModal() : ''}${pendingConfirm ? actionConfirmModal(pendingConfirm) : ''}`;
}

/** L'aliment affiché dans le formulaire actuellement ouvert (brouillon ou fiche existante). */
function currentFormData(s) {
  return formDraft || (editing === 'new' ? similarWarning?.pending || blank() : s.foods.find((x) => x.id === editing));
}

// P2 : capturé une seule fois, juste après le premier rendu du formulaire —
// readForm() applique déjà toutes ses normalisations des deux côtés de la
// future comparaison (voir confirm-unsaved.js), donc un formulaire ouvert
// sans aucune frappe ne se signale jamais comme modifié.
function captureBaselineIfNeeded(root, s) {
  if (!editing || formBaseline !== null) return;
  const base = currentFormData(s);
  if (base) formBaseline = readForm(root, base);
}

function rowOf(f) {
  return `<tr>
    <td><strong>${esc(f.name)}</strong>${f.brand ? ` <span class="tag">${esc(f.brand)}</span>` : ''}
      ${f.favorite ? ' ★' : ''}
      <div class="tag">${esc(CATEGORIES.find((c) => c.id === f.category)?.label || '')}</div></td>
    <td class="nums">${num(f.kcal, 0)}</td>
    <td class="nums">${num(f.protein, 1)}</td>
    <td class="nums">${num(f.carbs, 1)}</td>
    <td class="nums">${num(f.fat, 1)}</td>
    <td>${esc(STATES.find((s) => s.id === f.referenceState)?.label || '')}${f.cookedFactor && f.cookedFactor !== 1 ? ` <span class="tag">×${num(f.cookedFactor, 2)}</span>` : ''}</td>
    <td>${f.gramsPerUnit ? `${esc(f.unitName || 'unité')} = ${num(f.gramsPerUnit, 0)} g${f.fractionable ? '' : ' (entier)'}` : '—'}</td>
    <td class="nums">${f.price ? `${euros(f.price)} / ${num(f.packageWeight, 0)} g` : '—'}</td>
    <td>${f.batchAllowed ? 'oui' : 'non'}</td>
    <td style="text-align:right;white-space:nowrap">
      <button class="btn btn--sm" data-fav="${f.id}">${f.favorite ? '★' : '☆'}</button>
      <button class="btn btn--sm" data-edit="${f.id}">Modifier</button>
    </td>
  </tr>`;
}

const blank = () => ({
  id: `f_${uid('custom')}`, name: '', category: 'autre', brand: '',
  kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0,
  referenceState: 'pret', cookedFactor: 1, unitName: '', gramsPerUnit: 0,
  fractionable: true, unitEntry: false, price: null, packageWeight: null,
  batchAllowed: false, shelfLifeDays: null, requiresCooking: false, favorite: false, lastUsed: null,
  cookingMethod: '', cookingTemp: null, cookingTime: null, prepTime: null, equipment: '', instructions: '',
  // Open Food Facts (cf. normalizeFood(), store.js) — null tant que rien
  // n'a été récupéré ou saisi, jamais 0 ou ''.
  barcode: null, satFat: null, sugars: null, salt: null, sodium: null,
  nutriScore: null, novaGroup: null, ecoScore: null,
  ingredientsText: null, allergensText: null,
  imageUrl: null, imageThumbUrl: null, offUrl: null, offQuantity: null, offFetchedAt: null,
});

function formPanel(s) {
  const f = currentFormData(s);
  if (!f) return '';
  return `<div class="drawer" data-form-backdrop>
    <div class="drawer__panel" style="width:min(560px,100%)">
      <div class="drawer__head"><div class="row">
        <h3 style="flex:1">${editing === 'new' ? 'Nouvel aliment' : 'Modifier l\'aliment'}</h3>
        <button class="btn btn--ghost" data-form-cancel>Fermer</button>
      </div></div>
      <div class="drawer__body">${formBodyHtml(f)}</div>
    </div>
  </div>`;
}

/** Contenu de .drawer__body — réutilisé tel quel par refreshOpenForm(). */
function formBodyHtml(f) {
  const n = (v) => (v === null || v === undefined ? '' : v);
  return `${editing === 'new' ? `<div class="row" style="margin-bottom:12px">
          <button class="btn btn--sm" data-off-open type="button">Rechercher sur Open Food Facts</button>
          <small>Préremplit la fiche depuis un produit existant — tout reste modifiable avant d'enregistrer.</small>
        </div>` : ''}
        <div class="grid grid--3">
          <label class="field" style="grid-column:1/-1">Nom
            <input type="text" data-f="name" value="${esc(f.name)}"></label>
          <label class="field">Marque (facultatif)
            <input type="text" data-f="brand" value="${esc(f.brand)}"></label>
          <label class="field">Catégorie
            <select data-f="category">${CATEGORIES.map((c) => `<option value="${c.id}" ${f.category === c.id ? 'selected' : ''}>${c.label}</option>`).join('')}</select></label>
          <label class="field">Code-barres (facultatif)
            <input type="text" inputmode="numeric" pattern="[0-9]*" data-f="barcode" value="${esc(f.barcode || '')}" placeholder="EAN…"></label>
        </div>
        <h3 style="margin:16px 0 6px">Pour 100 g</h3>
        <small style="display:block;margin-bottom:6px">Les valeurs ci-dessous correspondent à l'état sélectionné plus bas dans « État des valeurs nutritionnelles ».</small>
        <div class="grid grid--3">
          <label class="field">kcal <input type="number" step="1" data-f="kcal" value="${n(f.kcal)}"></label>
          <label class="field">Protéines (g) <input type="number" step="0.1" data-f="protein" value="${n(f.protein)}"></label>
          <label class="field">Glucides (g) <input type="number" step="0.1" data-f="carbs" value="${n(f.carbs)}"></label>
          <label class="field">Lipides (g) <input type="number" step="0.1" data-f="fat" value="${n(f.fat)}"></label>
          <label class="field">Fibres (g) <input type="number" step="0.1" data-f="fiber" value="${n(f.fiber)}"></label>
        </div>
        ${offInfoBlock(f)}
        <h3 style="margin:16px 0 6px">État et unités</h3>
        <div class="grid grid--3">
          <label class="field">État des valeurs nutritionnelles
            <select data-f="referenceState">${STATES.map((st) => `<option value="${st.id}" ${f.referenceState === st.id ? 'selected' : ''}>${st.label}</option>`).join('')}</select></label>
          <label class="field">Rendement après cuisson
            <input type="number" step="0.05" min="0" data-f="cookedFactor" value="${n(f.cookedFactor)}"></label>
          <label class="field">Nom de l'unité
            <input type="text" data-f="unitName" value="${esc(f.unitName)}" placeholder="tranche, pot, œuf…"></label>
          <label class="field">Poids d'une unité (g)
            <input type="number" step="1" data-f="gramsPerUnit" value="${n(f.gramsPerUnit)}"></label>
        </div>
        <div class="row" style="margin-top:6px">
          <button class="btn btn--sm" data-yield-open>Calculer le rendement</button>
          <small>Coefficient = poids cuit ÷ poids cru. 2,00 → 100 g cru donnent 200 g cuit ; 0,75 → 100 g cru donnent 75 g cuit.</small>
        </div>
        <label class="check" style="margin-top:8px"><input type="checkbox" data-f="fractionable" ${f.fractionable ? 'checked' : ''}> Unité fractionnable (sinon quantités par unité entière)</label>
        <label class="check" style="margin-top:6px"><input type="checkbox" data-f="unitEntry" ${f.unitEntry ? 'checked' : ''}> Saisir les quantités en unités plutôt qu'en grammes</label>
        <small style="display:block;margin-top:4px">Un aliment non fractionnable ne peut exister qu'en multiples entiers de son poids par unité, quelle que soit la façon dont la quantité est saisie.</small>
        <h3 style="margin:16px 0 6px">Achat</h3>
        <div class="grid grid--3">
          <label class="field">Prix du conditionnement (€)
            <input type="number" step="0.01" data-f="price" value="${n(f.price)}"></label>
          <label class="field">Poids du conditionnement (g)
            <input type="number" step="1" data-f="packageWeight" value="${n(f.packageWeight)}"></label>
        </div>
        <label class="check" style="margin-top:8px"><input type="checkbox" data-f="batchAllowed" ${f.batchAllowed ? 'checked' : ''}> Autorisé en batch cooking</label>
        <div class="grid grid--3" style="margin-top:8px">
          <label class="field">Durée maximale de conservation après préparation (jours)
            <input type="number" step="1" min="0" data-f="shelfLifeDays" value="${n(f.shelfLifeDays)}" placeholder="laisser vide si inconnue"></label>
        </div>
        <h3 style="margin:16px 0 6px">Préparation</h3>
        <label class="check"><input type="checkbox" data-f="requiresCooking" ${f.requiresCooking ? 'checked' : ''}> Nécessite une cuisson</label>
        <small style="display:block;margin:4px 0 8px">Indépendant de l'état de référence : un aliment cru peut se consommer tel quel, un aliment prêt à consommer peut demander une cuisson. Sert au classement du batch : batchable → à préparer en batch ; sinon, cuisson nécessaire → à cuire le jour même ; sinon → à assembler le jour même.</small>
        <div class="grid grid--3">
          <label class="field">Méthode de cuisson
            <input type="text" data-f="cookingMethod" value="${esc(f.cookingMethod || '')}" placeholder="Four, poêle, vapeur…"></label>
          <label class="field">Température (°C)
            <input type="number" step="5" data-f="cookingTemp" value="${n(f.cookingTemp)}"></label>
          <label class="field">Durée de cuisson (min)
            <input type="number" step="1" data-f="cookingTime" value="${n(f.cookingTime)}"></label>
          <label class="field">Temps de préparation (min)
            <input type="number" step="1" data-f="prepTime" value="${n(f.prepTime)}"></label>
          <label class="field">Matériel
            <input type="text" data-f="equipment" value="${esc(f.equipment || '')}" placeholder="Four, sauteuse…"></label>
        </div>
        <label class="field" style="margin-top:8px">Consignes libres
          <textarea data-f="instructions" rows="3" placeholder="Ex. cuire entier, laisser tiédir, couper ensuite.">${esc(f.instructions || '')}</textarea></label>
        <small style="display:block;margin-top:4px">Rendement actuel : ${num(f.cookedFactor || 1, 2)} — 100 g crus donnent ${num((f.cookedFactor || 1) * 100, 0)} g cuits. Ces informations sont reprises telles quelles dans le plan de batch.</small>
        <label class="check" style="margin-top:6px"><input type="checkbox" data-f="favorite" ${f.favorite ? 'checked' : ''}> Favori</label>
        <div class="row" style="margin-top:18px">
          <button class="btn btn--primary" data-save="${f.id}">Enregistrer</button>
          ${editing === 'new' ? '' : `<span class="spacer"></span><button class="btn btn--danger" data-delete="${f.id}">Supprimer</button>`}
        </div>
        <small style="display:block;margin-top:10px">Les valeurs livrées par défaut sont génériques. Pour un produit de marque, recopie les valeurs de l'emballage.</small>`;
}

/**
 * Valeurs complémentaires (jamais utilisées par le moteur nutritionnel, qui
 * reste kcal/protein/carbs/fat/fiber uniquement) + informations Open Food
 * Facts quand la fiche en provient. Tout reste modifiable, y compris après
 * un préremplissage — aucun champ n'est présenté comme verrouillé.
 */
function offInfoBlock(f) {
  const n = (v) => (v === null || v === undefined ? '' : v);
  const fromOff = Boolean(f.offUrl || f.offFetchedAt);
  return `<details style="margin:10px 0" ${fromOff ? 'open' : ''}>
    <summary>Valeurs complémentaires ${fromOff ? '(Open Food Facts)' : '(facultatif)'}</summary>
    <div class="grid grid--3" style="margin-top:8px">
      <label class="field">Graisses saturées (g) <input type="number" step="0.1" data-f="satFat" value="${n(f.satFat)}"></label>
      <label class="field">Sucres (g) <input type="number" step="0.1" data-f="sugars" value="${n(f.sugars)}"></label>
      <label class="field">Sel (g) <input type="number" step="0.01" data-f="salt" value="${n(f.salt)}"></label>
      <label class="field">Sodium (g) <input type="number" step="0.01" data-f="sodium" value="${n(f.sodium)}"></label>
    </div>
    <small style="display:block;margin-top:4px">Sel et sodium sont deux données distinctes sur l'emballage — jamais l'une déduite de l'autre ici.</small>
    ${
      fromOff
        ? `<div class="grid grid--3" style="margin-top:8px">
             <label class="field">Nutri-Score <input type="text" data-f="nutriScore" value="${esc((f.nutriScore || '').toUpperCase())}" maxlength="1" style="text-transform:uppercase"></label>
             <label class="field">Groupe NOVA <input type="number" step="1" min="1" max="4" data-f="novaGroup" value="${n(f.novaGroup)}"></label>
             <label class="field">Eco-Score <input type="text" data-f="ecoScore" value="${esc((f.ecoScore || '').toUpperCase())}" maxlength="1" style="text-transform:uppercase"></label>
           </div>
           <label class="field" style="margin-top:8px">Ingrédients (Open Food Facts)
             <textarea data-f="ingredientsText" rows="2">${esc(f.ingredientsText || '')}</textarea></label>
           <label class="field" style="margin-top:8px">Allergènes / traces (Open Food Facts)
             <textarea data-f="allergensText" rows="2">${esc(f.allergensText || '')}</textarea></label>
           <small style="display:block;margin-top:6px">
             ${f.offQuantity ? `Conditionnement indiqué : ${esc(f.offQuantity)}. ` : ''}
             ${f.offFetchedAt ? `Récupéré le ${esc(new Date(f.offFetchedAt).toLocaleDateString('fr-FR'))}` : ''}
             ${f.offUrl ? ` — <a href="${esc(f.offUrl)}" target="_blank" rel="noopener">fiche Open Food Facts</a>` : ''}.
             Indicatif : vérifie toujours contre l'emballage réel, en particulier si le produit a changé depuis.
           </small>`
        : ''
    }
  </details>`;
}

/** Aide au calcul du rendement après cuisson (coefficient = cuit ÷ cru). */
function yieldPanel() {
  return `<div class="drawer" data-yield-backdrop>
    <div class="drawer__panel" style="width:min(400px,100%)">
      <div class="drawer__head"><div class="row">
        <h3 style="flex:1">Calcul du rendement après cuisson</h3>
        <button class="btn btn--ghost" data-yield-cancel>Fermer</button>
      </div></div>
      <div class="drawer__body">
        <div class="grid grid--2">
          <label class="field">Poids cru (g)
            <input type="number" step="1" min="0" data-yield-raw value="${esc(yieldCalc.raw ?? '')}"></label>
          <label class="field">Poids cuit (g)
            <input type="number" step="1" min="0" data-yield-cooked value="${esc(yieldCalc.cooked ?? '')}"></label>
        </div>
        <div class="row" style="margin-top:12px"><button class="btn btn--primary" data-yield-run>Calculer</button></div>
        ${yieldCalc.error ? `<p class="sync-error" style="margin-top:12px">${esc(yieldCalc.error)}</p>` : ''}
        ${
          yieldCalc.result !== null && yieldCalc.result !== undefined
            ? `<div class="card" style="margin-top:12px">
                 <strong>Rendement calculé : ${num(yieldCalc.result, 2)}</strong>
                 <div>100 g cru → ${num(yieldCalc.result * 100, 0)} g cuit</div>
                 <div class="row" style="margin-top:10px">
                   <button class="btn btn--primary btn--sm" data-yield-apply>Utiliser ce rendement</button>
                 </div>
               </div>`
            : ''
        }
        <small style="display:block;margin-top:12px">Coefficient = poids cuit ÷ poids cru.</small>
      </div>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Recherche Open Food Facts (préremplissage à la création)            */
/* ------------------------------------------------------------------ */

function openOffSearch() {
  offSearch = {
    barcodeInput: '', nameInput: '', brandInput: '',
    status: 'idle', // idle | loading | found | not-found | results | no-results | error
    error: null,
    foundProduct: null, // { code, draft } — résultat direct d'une recherche par code-barres
    results: [],        // [{ code, draft }] — résultats d'une recherche par nom/marque
  };
}

function closeOffSearch() {
  offController?.abort();
  offController = null;
  offSearch = null;
}

/**
 * Un aliment de la banque référence-t-il déjà ce code-barres ? Critère FORT
 * de doublon (contrairement à une simple similarité de nom) : si trouvé, la
 * recherche ne propose jamais de créer un second aliment pour le même
 * produit — seulement d'ouvrir la fiche existante, ou de passer outre en
 * connaissance de cause (produit réellement différent partageant par erreur
 * le même code dans la base OFF, cas rare mais pas impossible).
 */
function existingFoodForBarcode(code) {
  if (!code) return null;
  return getState().foods.find((f) => f.barcode && f.barcode === code) || null;
}

function offSearchPanel(s) {
  const o = offSearch;
  return `<div class="drawer" data-off-backdrop>
    <div class="drawer__panel" style="width:min(640px,100%)">
      <div class="drawer__head"><div class="row">
        <h3 style="flex:1">Rechercher sur Open Food Facts</h3>
        <button class="btn btn--ghost" data-off-cancel>Fermer</button>
      </div></div>
      <div class="drawer__body">
        <h3 style="margin-top:0">Par code-barres</h3>
        <div class="row">
          <input type="text" inputmode="numeric" pattern="[0-9]*" data-off-barcode
            value="${esc(o.barcodeInput)}" placeholder="Code-barres (EAN)…" style="flex:1;min-width:160px">
          <button class="btn btn--primary" data-off-barcode-go ${o.barcodeInput.trim() ? '' : 'disabled'}>Rechercher</button>
        </div>
        <h3 style="margin-top:16px">Par nom et/ou marque</h3>
        <div class="grid grid--2">
          <input type="text" data-off-name value="${esc(o.nameInput)}" placeholder="Nom du produit…">
          <input type="text" data-off-brand value="${esc(o.brandInput)}" placeholder="Marque (facultatif)…">
        </div>
        <div style="margin-top:14px">${offSearchStatusHtml(o)}</div>
        <small style="display:block;margin-top:16px">Données © <a href="https://world.openfoodfacts.org" target="_blank" rel="noopener">Open Food Facts</a>, sous licence ouverte ODbL — vérifie toujours les valeurs avant d'enregistrer.</small>
      </div>
    </div>
  </div>`;
}

function offSearchStatusHtml(o) {
  if (o.status === 'loading') return `<p class="muted">Recherche en cours…</p>`;
  if (o.status === 'error') {
    return `<div class="card" style="border-color:#eebeb9">
      <strong>${esc(o.error)}</strong>
      <div class="row" style="margin-top:8px"><button class="btn btn--sm" data-off-retry>Réessayer</button></div>
    </div>`;
  }
  if (o.status === 'not-found') {
    return `<p class="muted">Aucun produit trouvé pour ce code-barres sur Open Food Facts. Tu peux continuer la saisie manuellement (ferme cette fenêtre).</p>`;
  }
  if (o.status === 'no-results') {
    return `<p class="muted">Aucun résultat pour cette recherche. Essaie un autre terme, ou continue en saisie manuelle.</p>`;
  }
  if (o.status === 'found' && o.foundProduct) {
    return offResultCard(o.foundProduct, { standalone: true });
  }
  if (o.status === 'results' && o.results.length) {
    return `<div class="grid grid--2">${o.results.map((r) => offResultCard(r, { standalone: false })).join('')}</div>`;
  }
  return '';
}

function offResultCard({ code, draft }, { standalone }) {
  const existing = existingFoodForBarcode(code);
  const macro = (label, v, unit = 'g') => (v === null || v === undefined ? '' : `${num(v, 1)} ${unit} ${label}`);
  const macros = [
    draft.kcal !== null ? `${num(draft.kcal, 0)} kcal` : '',
    macro('P', draft.protein), macro('G', draft.carbs), macro('L', draft.fat),
  ].filter(Boolean).join(' · ');
  return `<div class="card" style="margin-bottom:${standalone ? 0 : '10px'}">
    <div class="row" style="align-items:flex-start">
      ${draft.imageThumbUrl ? `<img src="${esc(draft.imageThumbUrl)}" alt="" style="width:56px;height:56px;object-fit:contain;border-radius:var(--radius-sm,6px);background:#fff" loading="lazy">` : ''}
      <div style="flex:1;min-width:0">
        <strong>${esc(draft.name || 'Nom non renseigné')}</strong>${draft.brand ? ` <span class="tag">${esc(draft.brand)}</span>` : ''}
        ${draft.offQuantity ? `<div class="tag">${esc(draft.offQuantity)}</div>` : ''}
        ${macros ? `<div class="tag">${esc(macros)} / 100 g</div>` : '<div class="tag muted">valeurs nutritionnelles incomplètes sur Open Food Facts</div>'}
        ${draft.nutriScore ? `<span class="tag">Nutri-Score ${esc(draft.nutriScore.toUpperCase())}</span>` : ''}
      </div>
    </div>
    ${
      existing
        ? `<div class="row" style="margin-top:8px;flex-wrap:wrap">
             <small style="flex:1;min-width:100%">Déjà dans ta banque : « ${esc(existing.name)} ».</small>
             <button class="btn btn--sm btn--primary" data-off-open-existing="${esc(existing.id)}">Ouvrir cette fiche</button>
             <button class="btn btn--sm btn--ghost" data-off-use="${esc(code)}">Utiliser quand même</button>
           </div>`
        : `<div class="row" style="margin-top:8px"><button class="btn btn--sm btn--primary" data-off-use="${esc(code)}">Utiliser ce produit</button></div>`
    }
  </div>`;
}

/**
 * Prépare une requête : annule la précédente (AbortController) et protège
 * contre une réponse périmée qui arriverait APRÈS une recherche plus
 * récente (compteur monotone comparé à la résolution, jamais sur la seule
 * annulation réseau — un abort() n'empêche pas toujours une promesse déjà
 * résolue de continuer son .then()).
 */
function startOffRequest() {
  offController?.abort();
  offController = new AbortController();
  return { id: ++offRequestId, signal: offController.signal };
}

function isStaleOffRequest(id) {
  return id !== offRequestId;
}

async function runBarcodeSearch(root) {
  if (!offSearch) return;
  const code = normalizeBarcode(offSearch.barcodeInput);
  if (!code) return;
  const { id, signal } = startOffRequest();
  offSearch.status = 'loading';
  offSearch.error = null;
  render(root);
  const res = await fetchProductByBarcode(code, { signal });
  if (isStaleOffRequest(id) || !offSearch) return; // une recherche plus récente (ou la fermeture du panneau) a pris le dessus
  if (res.status === 'aborted') return;
  if (res.status === 'error') { offSearch.status = 'error'; offSearch.error = res.error; }
  else if (res.status === 'not-found') { offSearch.status = 'not-found'; offSearch.foundProduct = null; }
  else { offSearch.status = 'found'; offSearch.foundProduct = { code: res.code, draft: res.draft }; }
  render(root);
}

async function runTextSearch(root) {
  if (!offSearch) return;
  const name = offSearch.nameInput.trim();
  const brand = offSearch.brandInput.trim();
  if (!name && !brand) { offSearch.status = 'idle'; offSearch.results = []; render(root); return; }
  const { id, signal } = startOffRequest();
  offSearch.status = 'loading';
  offSearch.error = null;
  render(root);
  const res = await searchProductsByText({ name, brand }, { signal });
  if (isStaleOffRequest(id) || !offSearch) return;
  if (res.status === 'aborted') return;
  if (res.status === 'error') { offSearch.status = 'error'; offSearch.error = res.error; }
  else if (res.status === 'no-results') { offSearch.status = 'no-results'; offSearch.results = []; }
  else { offSearch.status = 'results'; offSearch.results = res.results.map((r) => ({ code: r.code, draft: r.draft })); }
  render(root);
}

const runTextSearchDebounced = debounce((root) => runTextSearch(root), 500);

/**
 * Préremplit le formulaire avec un produit OFF choisi explicitement. Si le
 * brouillon courant contient déjà une saisie réelle (pas un formulaire
 * vierge), une confirmation est demandée avant d'écraser — jamais silencieux.
 */
function applyOffDraft(root, draft) {
  const current = formDraft || blank();
  const merged = { ...current, ...draft, id: current.id };
  const apply = () => {
    formDraft = merged;
    closeOffSearch();
    toast('Fiche préremplie depuis Open Food Facts — vérifie les valeurs avant d\'enregistrer');
    render(root);
  };
  // le formulaire contient-il déjà une saisie réelle depuis son OUVERTURE ?
  // `formBaseline` (capturé une seule fois à l'ouverture par
  // captureBaselineIfNeeded(), déjà passé par readForm() à ce moment-là, sur
  // un formulaire alors réellement vierge) est exactement la référence qu'il
  // faut ici — la même que celle utilisée par attemptClose() pour la même
  // question. Reconstruire un blank() frais et le relire MAINTENANT serait
  // trompeur : la lecture refléterait la saisie déjà faite des deux côtés de
  // la comparaison, qui paraîtrait alors toujours identique (jamais "sale").
  if (isDirty(formBaseline, current)) {
    pendingConfirm = {
      title: 'Remplacer la saisie actuelle ?',
      message: 'Le formulaire contient déjà une saisie. La remplacer par les données récupérées sur Open Food Facts ?',
      confirmLabel: 'Remplacer',
      danger: false,
      onConfirm: apply,
    };
    render(root);
    return;
  }
  apply();
}

function wireOffSearch(root) {
  if (!offSearch) return;
  const o = offSearch;
  root.querySelector('[data-off-cancel]')?.addEventListener('click', () => { closeOffSearch(); render(root); });
  root.querySelector('[data-off-backdrop]')?.addEventListener('mousedown', (e) => {
    if (e.target.dataset.offBackdrop !== undefined) { closeOffSearch(); render(root); }
  });
  root.querySelector('[data-off-retry]')?.addEventListener('click', () => {
    if (o.barcodeInput.trim() && o.status === 'error') runBarcodeSearch(root);
    else runTextSearch(root);
  });

  const barcodeInput = root.querySelector('[data-off-barcode]');
  barcodeInput?.addEventListener('input', (e) => {
    o.barcodeInput = e.target.value;
    // re-rendu nécessaire pour activer/désactiver le bouton Rechercher selon
    // la saisie — même motif que [data-q] (écran Aliments) pour ne pas
    // perdre le focus/curseur à chaque frappe.
    render(root);
    const el2 = root.querySelector('[data-off-barcode]');
    el2?.focus();
    el2?.setSelectionRange(el2.value.length, el2.value.length);
  });
  barcodeInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') runBarcodeSearch(root); });
  root.querySelector('[data-off-barcode-go]')?.addEventListener('click', () => runBarcodeSearch(root));

  root.querySelector('[data-off-name]')?.addEventListener('input', (e) => {
    o.nameInput = e.target.value;
    runTextSearchDebounced(root);
  });
  root.querySelector('[data-off-brand]')?.addEventListener('input', (e) => {
    o.brandInput = e.target.value;
    runTextSearchDebounced(root);
  });

  root.querySelectorAll('[data-off-use]').forEach((btn) =>
    btn.addEventListener('click', (e) => {
      const code = e.currentTarget.dataset.offUse;
      const item = o.foundProduct?.code === code ? o.foundProduct : o.results.find((r) => r.code === code);
      if (item) applyOffDraft(root, item.draft);
    })
  );
  root.querySelectorAll('[data-off-open-existing]').forEach((btn) =>
    btn.addEventListener('click', (e) => {
      const id = e.currentTarget.dataset.offOpenExisting;
      openFoodForm(id);
      // un tiroir de création est déjà ouvert (.drawer__panel existe) : le
      // dispatcher render() prendrait sinon le chemin refreshOpenForm(), qui
      // ne touche jamais .drawer__head (titre « Nouvel aliment » resterait
      // affiché) — ici, on change délibérément de fiche, un rendu complet
      // est le comportement correct (même motif que navigate(), qui vide
      // #view avant de rendre, sauf qu'ici ce n'est pas un changement d'écran).
      renderFull(root, getState());
    })
  );
}

/** Ligne de comparaison d'un aliment dans la popup de doublon. */
const foodLine = (f) =>
  `${num(f.kcal, 0)} kcal · ${num(f.protein, 1)} g P · ${num(f.carbs, 1)} g G · ${num(f.fat, 1)} g L / 100 g`;

/**
 * Popup BLOQUANTE de confirmation : la création est suspendue tant que
 * l'utilisateur n'a pas tranché. Aucun toast ni message en bas de fenêtre
 * n'est utilisé pour ce cas, afin de n'avoir qu'un seul mécanisme.
 */
function similarModal() {
  return similarConfirmModal({
    existing: similarWarning.list.map((x) => ({
      title: `${x.food.name}${x.food.brand ? ` — ${x.food.brand}` : ''}`,
      detail: foodLine(x.food),
      reasons: x.reasons,
    })),
    candidate: {
      title: `${similarWarning.pending.name}${similarWarning.pending.brand ? ` — ${similarWarning.pending.brand}` : ''}`,
      detail: foodLine(similarWarning.pending),
    },
  });
}

/** Remet le formulaire à zéro (fermeture, enregistrement, changement d'aliment). */

function resetForm() {
  editing = null;
  similarWarning = null;
  formDraft = null;
  yieldCalc = null;
  formBaseline = null;
  confirmingClose = false;
  pendingConfirm = null;
  closeOffSearch();
  if (escBound) { document.removeEventListener('keydown', onEscapeKey); escBound = false; }
}

/**
 * Tentative de fermeture (clic extérieur, X, Échap) — P2. Compare l'état
 * courant du formulaire à son instantané d'ouverture ; ne ferme directement
 * que si rien n'a changé. Un enregistrement réussi appelle resetForm() en
 * direct, jamais cette fonction : aucune confirmation après une sauvegarde.
 */
function attemptClose(root) {
  if (confirmingClose) return; // déjà en train de demander confirmation
  const base = formDraft || (editing === 'new' ? similarWarning?.pending || blank() : getState().foods.find((x) => x.id === editing));
  const current = base ? readForm(root, base) : null;
  if (isDirty(formBaseline, current)) {
    // capture la saisie AVANT de rouvrir le dialogue par-dessus : les champs
    // [data-f] n'ont pas d'écouteur 'change' propre (readForm() ne lit le DOM
    // qu'à la demande) — sans ceci, le prochain render() reconstruirait le
    // formulaire depuis le brouillon resté vierge et effacerait la saisie
    // visible à l'écran, qui redeviendrait donc "non modifiée" au clic suivant.
    formDraft = current;
    confirmingClose = true;
    render(root);
    return;
  }
  resetForm();
  render(root);
}

function onEscapeKey(e) {
  if (e.key !== 'Escape' || !editing) return;
  const root = document.getElementById('view');
  // tant que le dialogue de confirmation est déjà ouvert, Échap revient à
  // « Non, retour » (l'action sûre par défaut) plutôt que de rester sans effet.
  if (confirmingClose) { confirmingClose = false; render(root); return; }
  // un sous-panneau (calcul du rendement, doublon détecté) se ferme d'abord —
  // jamais fermer le formulaire principal par-dessous sans que l'utilisateur
  // l'ait demandé explicitement.
  if (yieldCalc) { yieldCalc = null; render(root); return; }
  if (similarWarning) { formDraft = { ...similarWarning.pending }; similarWarning = null; render(root); return; }
  attemptClose(root);
}

/** Mémorise la saisie en cours avant un rendu qui recrée le formulaire. */
function captureDraft(root) {
  const s = getState();
  const base =
    formDraft ||
    (editing === 'new' ? similarWarning?.pending || blank() : s.foods.find((x) => x.id === editing)) ||
    blank();
  formDraft = readForm(root, base);
}

function readForm(root, base) {
  const out = { ...base };
  root.querySelectorAll('[data-f]').forEach((input) => {
    const key = input.dataset.f;
    if (input.type === 'checkbox') out[key] = input.checked;
    else if (input.type === 'number') {
      const v = input.value === '' ? null : Number(input.value);
      out[key] = v;
    } else out[key] = input.value.trim();
  });
  if (!out.cookedFactor) out.cookedFactor = 1;
  if (!out.gramsPerUnit) out.gramsPerUnit = 0;
  for (const k of ['kcal', 'protein', 'carbs', 'fat', 'fiber']) out[k] = Number(out[k]) || 0;
  return out;
}

/** Table/recherche/filtres — jamais recréés pendant qu'un formulaire reste ouvert. */
function wireList(root) {
  const qEl = root.querySelector('[data-q]');
  qEl?.addEventListener('input', (e) => {
    query = e.target.value;
    render(root);
    const el2 = root.querySelector('[data-q]');
    el2.focus();
    el2.setSelectionRange(el2.value.length, el2.value.length);
  });

  root.querySelectorAll('[data-cat]').forEach((c) =>
    c.addEventListener('click', (e) => { cat = e.currentTarget.dataset.cat; render(root); })
  );

  root.querySelector('[data-new]')?.addEventListener('click', () => {
    resetForm();
    editing = 'new';
    // P2 : fige le brouillon tout de suite (blank() génère un id aléatoire à
    // chaque appel) — sans cela, la prochaine lecture de comparaison (dirty
    // check) regénérerait un id différent et signalerait à tort un
    // formulaire vierge comme modifié.
    formDraft = blank();
    render(root);
  });

  root.querySelectorAll('[data-edit]').forEach((b) =>
    b.addEventListener('click', (e) => { const id = e.currentTarget.dataset.edit; resetForm(); editing = id; render(root); })
  );

  root.querySelectorAll('[data-fav]').forEach((b) =>
    b.addEventListener('click', (e) => {
      const id = e.currentTarget.dataset.fav;
      update((s) => {
        const f = s.foods.find((x) => x.id === id);
        if (f) f.favorite = !f.favorite;
      });
    })
  );

  // --- P3 : doublons détectés, fusion sur choix explicite uniquement
  root.querySelector('[data-toggle-duplicates]')?.addEventListener('click', () => {
    duplicatesOpen = !duplicatesOpen;
    render(root);
  });
  root.querySelectorAll('[data-merge-keep]').forEach((input) =>
    input.addEventListener('change', (e) => {
      mergeKeep[e.currentTarget.dataset.mergeKeep] = e.currentTarget.value;
      render(root);
    })
  );
  root.querySelectorAll('[data-merge-group]').forEach((btn) =>
    btn.addEventListener('click', (e) => {
      const groupKey = e.currentTarget.dataset.mergeGroup;
      const st = getState();
      const groups = findDuplicateGroups(st.foods);
      const group = groups.find((g) => g.food.id === groupKey);
      if (!group) return;
      const members = [group.food, ...group.similar.map((x) => x.food)];
      const keepId = mergeKeep[groupKey] || group.food.id;
      const keepFood = members.find((f) => f.id === keepId);
      const mergeAway = members.filter((f) => f.id !== keepId);
      if (!keepFood || !mergeAway.length) return;
      pendingConfirm = {
        title: 'Fusionner ces aliments ?',
        message: `${mergeAway.map((f) => `« ${f.name} »`).join(', ')} ${mergeAway.length > 1 ? 'seront redirigés' : 'sera redirigé'} vers « ${keepFood.name} » partout où ${mergeAway.length > 1 ? 'ils sont' : 'il est'} utilisé (recettes, repas, catalogues, courses, batch), puis ${mergeAway.length > 1 ? 'supprimés' : 'supprimé'} de la banque. Les valeurs nutritionnelles et métadonnées de « ${keepFood.name} » ne changent pas. Cette action est irréversible.`,
        confirmLabel: 'Fusionner',
        onConfirm: () => {
          let summary;
          update((s2) => { summary = mergeFoods(s2, keepId, mergeAway.map((f) => f.id)); });
          const total = summary.recipes + summary.meals + summary.breakfasts + summary.snacks + summary.shopping + summary.batch;
          toast(`Fusion effectuée : ${summary.foodsRemoved} aliment(s) supprimé(s), ${total} référence(s) redirigée(s)`);
          delete mergeKeep[groupKey];
          render(root);
        },
      };
      render(root);
    })
  );
}

/**
 * Chrome du tiroir (bouton Fermer, clic sur le fond, Échap) : vit dans
 * .drawer et .drawer__head, jamais recréés par refreshOpenForm() — ne se
 * câble donc qu'une fois, à l'ouverture (sinon : écouteurs dupliqués à
 * chaque ouverture/fermeture de la confirmation ou du calcul de rendement).
 */
function wireDrawerChrome(root) {
  // P2 : X et clic extérieur passent par attemptClose() — une confirmation
  // n'est demandée que si le formulaire a réellement changé.
  root.querySelector('[data-form-cancel]')?.addEventListener('click', () => attemptClose(root));
  root.querySelector('[data-form-backdrop]')?.addEventListener('mousedown', (e) => {
    if (e.target.dataset.formBackdrop !== undefined && !yieldCalc && !similarWarning) attemptClose(root);
  });
  // P2 : Échap câblé une seule fois par ouverture de formulaire (jamais
  // réempilé entre deux rendus successifs du même formulaire).
  if (!escBound) { document.addEventListener('keydown', onEscapeKey); escBound = true; }
}

/** Contenu de .drawer__body : recâblé à chaque renderFull() ET refreshOpenForm(). */
function wireDrawerBody(root) {
  root.querySelector('[data-save]')?.addEventListener('click', (e) => {
    const id = e.currentTarget.dataset.save;
    const s = getState();
    const base = formDraft
      ? { ...formDraft, id }
      : editing === 'new'
        ? { ...(similarWarning?.pending || blank()), id }
        : s.foods.find((x) => x.id === id);
    const data = readForm(root, base);
    if (!data.name) { toast('Le nom est obligatoire', 'error'); return; }

    // Détection de doublon à la création : la popup de confirmation suspend la
    // création (un seul mécanisme, aucun toast ni message en bas de fenêtre).
    // Un code-barres identique est un critère FORT (pas une simple
    // ressemblance de nom) : prioritaire en tête de liste si trouvé, sans
    // dupliquer l'entrée si findSimilarFoods() a déjà détecté le même aliment.
    if (editing === 'new' && !similarWarning?.confirmed) {
      const list = findSimilarFoods(data, s.foods);
      const barcodeMatch = data.barcode ? s.foods.find((x) => x.barcode && x.barcode === data.barcode) : null;
      if (barcodeMatch && !list.some((x) => x.food.id === barcodeMatch.id)) {
        list.unshift({ food: barcodeMatch, score: 1, reasons: ['même code-barres'] });
      }
      if (list.length) {
        similarWarning = { list, pending: data, confirmed: false };
        render(root);
        return;
      }
    }
    similarWarning = null;

    update((st) => {
      const idx = st.foods.findIndex((x) => x.id === id);
      if (idx >= 0) st.foods[idx] = data;
      else st.foods.push(data);
    });
    resetForm();
    toast('Aliment enregistré');
    render(root);
  });

  root.querySelector('[data-delete]')?.addEventListener('click', (e) => {
    const id = e.currentTarget.dataset.delete;
    const s = getState();
    // Un aliment référencé dans une recette est un cas DIFFÉRENT d'un simple
    // usage dans un repas/catalogue (ci-dessous) : la composition d'une
    // recette est une donnée de référence réutilisée partout (macros,
    // courses, batch, préparations déjà matérialisées via recipeSnapshot) —
    // la supprimer silencieusement fausserait ces calculs durablement, sans
    // qu'aucun écran ne le signale jamais. Bloqué, comme la suppression
    // d'une recette l'est déjà quand une préparation en dépend (recipes.js).
    const recipesUsing = s.recipes.filter((r) => r.items.some((it) => it.foodId === id));
    if (recipesUsing.length) {
      const names = recipesUsing.map((r) => `« ${r.name} »`).join(', ');
      toast(`Impossible : cet aliment est utilisé dans ${recipesUsing.length > 1 ? 'les recettes' : 'la recette'} ${names}. Retire-le de ${recipesUsing.length > 1 ? 'leur composition' : 'sa composition'} avant de le supprimer.`, 'error');
      return;
    }
    // Un aliment peut avoir déjà disparu d'une recette LIVE (retiré/remplacé
    // depuis) tout en restant présent dans le recipeSnapshot figé d'une
    // préparation déjà matérialisée (snapshot volontairement indépendant de
    // la recette source, cf. preparationAsVirtualFood() ci-dessus) : même
    // risque de macros silencieusement faussées pour cette préparation.
    const prepsUsing = s.preparations.filter((p) => p.recipeSnapshot?.items?.some((it) => it.foodId === id));
    if (prepsUsing.length) {
      const names = prepsUsing.map((p) => `« ${p.label} »`).join(', ');
      toast(`Impossible : cet aliment fait partie de la composition figée de ${prepsUsing.length > 1 ? 'préparations existantes' : 'la préparation'} ${names}. Supprime d’abord ${prepsUsing.length > 1 ? 'ces préparations' : 'cette préparation'} si tu veux retirer cet aliment.`, 'error');
      return;
    }
    const used =
      s.meals.some((m) => m.items.some((i) => i.foodId === id)) ||
      [...s.breakfasts, ...s.snacks].some((o) => o.items.some((i) => i.foodId === id));
    pendingConfirm = {
      title: 'Supprimer cet aliment ?',
      message: used
        ? 'Cet aliment est utilisé dans des repas ou des catalogues. Le supprimer quand même ?'
        : 'Cet aliment sera définitivement supprimé de la banque alimentaire.',
      confirmLabel: 'Supprimer',
      onConfirm: () => {
        update((st) => { st.foods = st.foods.filter((x) => x.id !== id); });
        resetForm();
        render(root);
      },
    };
    render(root);
  });
}

/** #food-overlays (rendement, doublon, confirmation) : recâblé à chaque render de cette zone. */
function wireOverlays(root) {
  // --- recherche Open Food Facts (préremplissage à la création uniquement)
  root.querySelector('[data-off-open]')?.addEventListener('click', () => {
    captureDraft(root);
    openOffSearch();
    render(root);
  });
  wireOffSearch(root);

  // --- aide au calcul du rendement après cuisson
  root.querySelector('[data-yield-open]')?.addEventListener('click', () => {
    captureDraft(root);
    yieldCalc = { raw: '', cooked: '', result: null, error: null };
    render(root);
  });
  const closeYield = () => { yieldCalc = null; render(root); };
  root.querySelector('[data-yield-cancel]')?.addEventListener('click', closeYield);
  root.querySelector('[data-yield-backdrop]')?.addEventListener('mousedown', (e) => {
    if (e.target.dataset.yieldBackdrop !== undefined) closeYield();
  });
  root.querySelector('[data-yield-run]')?.addEventListener('click', () => {
    const raw = root.querySelector('[data-yield-raw]').value;
    const cooked = root.querySelector('[data-yield-cooked]').value;
    const res = computeYield(raw, cooked);
    yieldCalc = { raw, cooked, result: res.ok ? res.factor : null, error: res.ok ? null : res.error };
    render(root);
  });
  root.querySelector('[data-yield-apply]')?.addEventListener('click', () => {
    const factor = yieldCalc.result;
    captureDraft(root);
    formDraft = { ...formDraft, cookedFactor: factor };
    yieldCalc = null;
    render(root);
    toast(`Rendement appliqué : ${num(factor, 2)}`);
  });

  // --- popup bloquante de doublon
  root.querySelector('[data-similar-cancel]')?.addEventListener('click', () => {
    // Annuler : la popup se ferme, l'aliment n'est PAS créé, la saisie est conservée.
    formDraft = { ...similarWarning.pending };
    similarWarning = null;
    render(root);
  });
  root.querySelector('[data-similar-confirm]')?.addEventListener('click', () => {
    similarWarning = { ...similarWarning, confirmed: true };
    formDraft = { ...similarWarning.pending };
    render(root);
    root.querySelector('[data-save]')?.click();
  });

  root.querySelector('[data-unsaved-stay]')?.addEventListener('click', () => { confirmingClose = false; render(root); });
  root.querySelector('[data-unsaved-discard]')?.addEventListener('click', () => { resetForm(); render(root); });
  root.querySelector('[data-unsaved-backdrop]')?.addEventListener('mousedown', (e) => {
    // le fond du dialogue de confirmation lui-même revient à « Non, retour »
    // (action sûre par défaut), jamais à une fermeture silencieuse.
    if (e.target.dataset.unsavedBackdrop !== undefined) { confirmingClose = false; render(root); }
  });
}
