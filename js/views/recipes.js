/**
 * Écran RECETTES — catalogue global de recettes (composition figée, macros
 * dérivées, jamais stockées). Une recette est une convenance d'auteur : le
 * moteur nutritionnel, le volume et les dérivés (batch/courses) ne la
 * connaissent qu'au travers de `recipeAsVirtualFood()` (nutrition.js).
 */

import { getState, update, newRecipe, newRecipeItem } from '../core/store.js';
import {
  CATEGORIES, STATES, recipeMacrosPer100g, canAddIngredientToRecipe,
  isUnitFood, isWholeUnitFood, toUnits, fromUnits, quantityStep, snapQuantity, initialQuantity,
  portionGramsOf,
} from '../core/nutrition.js';
import { unitLabel, unitHint } from './editor.js';
import { esc, num, normalize, toast, deepCopy } from '../core/util.js';

let editing = null; // id de recette, ou 'new'
let formDraft = null; // copie de travail, jamais écrite dans l'état avant "Enregistrer"
let ingQuery = '';

const foodsMapOf = (s) => Object.fromEntries(s.foods.map((f) => [f.id, f]));

export function render(root) {
  const s = getState();
  const byId = foodsMapOf(s);
  const list = [...s.recipes].sort((a, b) => a.name.localeCompare(b.name, 'fr'));

  root.innerHTML = `
    <div class="row" style="margin-bottom:12px">
      <button class="btn btn--primary" data-new>Nouvelle recette</button>
    </div>
    <div class="card">
      <table>
        <thead><tr>
          <th>Recette</th><th>Type</th><th class="nums">Référence</th><th class="nums">kcal / 100</th>
          <th>Ingrédients</th><th></th>
        </tr></thead>
        <tbody>
          ${list.length ? list.map((r) => rowOf(r, s, byId)).join('') : `<tr><td colspan="6" class="muted">Aucune recette créée.</td></tr>`}
        </tbody>
      </table>
    </div>
    <small>Les macros d'une recette sont toujours recalculées depuis ses ingrédients, jamais stockées.</small>
    ${editing ? formPanel(s, byId) : ''}
  `;
  wire(root, s);
}

function rowOf(r, s, byId) {
  const per100 = recipeMacrosPer100g(r, byId);
  const usedByPreparations = s.preparations.some((p) => p.recipeId === r.id);
  const portionBase = portionGramsOf(r);
  return `<tr>
    <td><strong>${esc(r.name || '(sans nom)')}</strong></td>
    <td>${r.kind === 'weight' ? 'Au poids' : 'Portion'}</td>
    <td class="nums">${r.kind === 'weight' ? `${num(r.baseGrams, 0)} g` : `${num(portionBase, 0)} g / portion`}</td>
    <td class="nums">${num(per100.kcal, 0)}</td>
    <td>${r.items.length} ingrédient(s)${usedByPreparations ? ' <span class="tag">utilisée par une préparation</span>' : ''}</td>
    <td style="text-align:right;white-space:nowrap"><button class="btn btn--sm" data-edit="${r.id}">Modifier</button></td>
  </tr>`;
}

function currentDraft(s) {
  if (formDraft) return formDraft;
  if (editing === 'new') { formDraft = newRecipe('', 'weight'); return formDraft; }
  const found = s.recipes.find((r) => r.id === editing);
  formDraft = found ? deepCopy(found) : null;
  return formDraft;
}

function ingredientPicker(state) {
  const q = normalize(ingQuery);
  let list = state.foods;
  if (q) list = list.filter((f) => normalize(`${f.name} ${f.brand}`).includes(q));
  list = list.slice(0, 30);
  return `<div class="row" style="margin-top:10px">
    <input type="text" data-ing-search value="${esc(ingQuery)}" placeholder="Rechercher un ingrédient…" style="flex:1;min-width:180px">
  </div>
  <div class="picker__results" style="position:static;border:1px solid var(--line);border-radius:var(--radius-sm);max-height:200px;margin-top:6px">
    ${
      list.length
        ? list.map((f) => `<button data-ing-add="${f.id}">
            <strong>${esc(f.name)}</strong>${isWholeUnitFood(f) ? ' <span class="tag">non fractionnable</span>' : ''}
            <div class="cat">${esc(CATEGORIES.find((c) => c.id === f.category)?.label || '')} · ${num(f.kcal, 0)} kcal / 100 g</div>
          </button>`).join('')
        : `<div style="padding:12px" class="muted">Aucun ingrédient ne correspond.</div>`
    }
  </div>`;
}

function formPanel(s, byId) {
  const r = currentDraft(s);
  if (!r) return '';
  const per100 = recipeMacrosPer100g(r, byId);
  const portionBase = portionGramsOf(r);

  const ingredientRows = r.items.length
    ? r.items.map((it, idx) => {
        const food = byId[it.foodId];
        if (!food) {
          return `<div class="item">
            <div class="item__main"><div class="item__name">Aliment supprimé</div></div>
            <div class="item__tools"><button class="btn btn--sm btn--danger" data-ing-del="${idx}">Retirer</button></div>
          </div>`;
        }
        // saisie unit-aware — réutilise EXACTEMENT le mécanisme de l'éditeur
        // de repas (`food.unitEntry`, `toUnits`/`fromUnits`, `unitLabel`) :
        // un aliment non fractionnable se saisit dans son unité naturelle.
        const unitMode = isUnitFood(food) && food.unitEntry;
        const step = quantityStep(food, { inUnits: unitMode });
        const shown = unitMode ? num(toUnits(food, it.qty), isWholeUnitFood(food) ? 0 : 1) : num(it.qty, 0);
        return `<div class="item">
          <div class="item__main">
            <div class="item__name">${esc(food.name)}</div>
            ${isUnitFood(food) ? `<button type="button" class="btn btn--sm" data-ing-unit-toggle="${idx}" style="margin-top:4px">Saisie : ${food.unitEntry ? esc(unitLabel(food, 1)) : 'grammes'}</button>` : ''}
            <div class="item__qty" style="margin-top:6px">
              <div class="qty-box">
                <div class="qty-box__row">
                  <input type="number" min="0" step="${step}" data-ing-qty="${idx}" data-unitmode="${unitMode ? '1' : '0'}"
                         value="${String(shown).replace(',', '.')}" aria-label="Quantité">
                  <span class="item__unit">${unitMode ? esc(unitLabel(food, toUnits(food, it.qty))) : 'g'}</span>
                </div>
                ${unitHint(food, it.qty) ? `<small>${unitHint(food, it.qty)}</small>` : ''}
              </div>
              <div class="qty-box">
                <select data-ing-state="${idx}">
                  ${STATES.map((st) => `<option value="${st.id}" ${(it.state || food?.referenceState) === st.id ? 'selected' : ''}>${st.label}</option>`).join('')}
                </select>
              </div>
            </div>
          </div>
          <div class="item__tools"><button class="btn btn--sm btn--danger" data-ing-del="${idx}">Retirer</button></div>
        </div>`;
      }).join('')
    : `<div class="empty" style="margin:8px 0">Aucun ingrédient. Ajoute-en un ci-dessous.</div>`;

  return `<div class="drawer" data-form-backdrop>
    <div class="drawer__panel" style="width:min(560px,100%)">
      <div class="drawer__head"><div class="row">
        <h3 style="flex:1">${editing === 'new' ? 'Nouvelle recette' : 'Modifier la recette'}</h3>
        <button class="btn btn--ghost" data-form-cancel>Fermer</button>
      </div></div>
      <div class="drawer__body">
        <div class="grid grid--3">
          <label class="field" style="grid-column:1/-1">Nom
            <input type="text" data-r="name" value="${esc(r.name)}"></label>
          <label class="field">Type
            <select data-r="kind">
              <option value="weight" ${r.kind === 'weight' ? 'selected' : ''}>Au poids (grammes)</option>
              <option value="portion" ${r.kind === 'portion' ? 'selected' : ''}>Portion (unité indivisible)</option>
            </select>
          </label>
          ${
            r.kind === 'weight'
              ? `<label class="field">Poids de référence (g)
                   <input type="number" min="1" step="1" data-r="baseGrams" value="${num(r.baseGrams, 0)}"></label>
                 <small style="grid-column:1/-1">Calculé automatiquement depuis la composition (${num(portionBase, 0)} g) — modifie-le uniquement si le poids RÉELLEMENT obtenu après cuisson diffère (perte/gain à la cuisson). Sert de référence à l'optimiseur, jamais une contrainte.</small>`
              : `<small style="grid-column:1/-1">Recette portion : la composition ci-dessous décrit UNE portion (${num(portionBase, 0)} g). Utilisée dans un repas, la recette se sélectionne en nombre entier de portions.</small>`
          }
        </div>

        <h3 style="margin:16px 0 6px">Ingrédients</h3>
        <small>kcal / 100${r.kind === 'weight' ? ' g' : ' (base = 1 portion)'} : ${num(per100.kcal, 0)} · P ${num(per100.protein, 1)} g · G ${num(per100.carbs, 1)} g · L ${num(per100.fat, 1)} g</small>
        <div class="items" style="margin:10px 0">${ingredientRows}</div>
        ${
          r.kind === 'weight'
            ? `<small style="display:block;margin-bottom:6px">Une recette « au poids » ne peut pas contenir d'aliment non fractionnable (décision verrouillée) — une telle recette doit être créée en type « Portion ».</small>`
            : ''
        }
        ${ingredientPicker(s)}

        <h3 style="margin:16px 0 6px">Batch cooking</h3>
        <label class="check"><input type="checkbox" data-r="batchAllowed" ${r.batchAllowed ? 'checked' : ''}> Autorisée en batch cooking</label>
        <small style="display:block;margin:4px 0 8px">Une recette autorisée en batch cooking, référencée directement dans un repas (pas encore préparée), apparaît dans l'écran Batch avec sa quantité nette à préparer.</small>
        <div class="grid grid--3">
          <label class="field">Durée maximale de conservation après préparation (jours)
            <input type="number" step="1" min="0" data-r="shelfLifeDays" value="${num(r.shelfLifeDays)}" placeholder="laisser vide si inconnue"></label>
        </div>
        <small style="display:block;margin:4px 0 8px">Si la conservation est plus courte que la durée d'une session de batch, le plan indique automatiquement les préparations supplémentaires nécessaires en cours de session.</small>
        <div class="grid grid--3">
          <label class="field">Méthode de cuisson
            <input type="text" data-r="cookingMethod" value="${esc(r.cookingMethod || '')}" placeholder="Four, mijoteuse, poêle…"></label>
          <label class="field">Température (°C)
            <input type="number" step="5" data-r="cookingTemp" value="${num(r.cookingTemp)}"></label>
          <label class="field">Durée de cuisson (min)
            <input type="number" step="1" data-r="cookingTime" value="${num(r.cookingTime)}"></label>
          <label class="field">Temps de préparation (min)
            <input type="number" step="1" data-r="prepTime" value="${num(r.prepTime)}"></label>
          <label class="field">Matériel
            <input type="text" data-r="equipment" value="${esc(r.equipment || '')}" placeholder="Four, sauteuse…"></label>
        </div>
        <label class="field" style="margin-top:8px">Consignes libres
          <textarea data-r="instructions" rows="3" placeholder="Ex. mijoter à couvert, remuer à mi-cuisson.">${esc(r.instructions || '')}</textarea></label>

        <div class="row" style="margin-top:18px">
          <button class="btn btn--primary" data-save>Enregistrer</button>
          ${editing === 'new' ? '' : `<span class="spacer"></span><button class="btn btn--danger" data-delete="${r.id}">Supprimer</button>`}
        </div>
      </div>
    </div>
  </div>`;
}

/**
 * Auto-dérivation de `baseGrams` pour une recette `weight` : tant que la
 * valeur n'a pas été personnalisée par l'utilisateur (elle vaut 0/absente,
 * ou elle correspond encore exactement à la somme calculée AVANT la
 * modification en cours), elle suit automatiquement la somme des
 * ingrédients — évite d'obliger une saisie manuelle pour le cas simple
 * (150 g + 50 g = 200 g). Dès que l'utilisateur tape une valeur différente
 * (ex. poids réellement obtenu après cuisson), elle n'est plus jamais
 * recalculée automatiquement : aucune donnée saisie n'est écrasée.
 */
function syncAutoBaseGrams(draft, previousSum) {
  if (draft.kind !== 'weight') return;
  if (!draft.baseGrams || draft.baseGrams === previousSum) {
    draft.baseGrams = portionGramsOf(draft);
  }
}

function resetForm() {
  editing = null;
  formDraft = null;
  ingQuery = '';
}

function wire(root, s) {
  root.querySelector('[data-new]')?.addEventListener('click', () => { resetForm(); editing = 'new'; render(root); });
  root.querySelectorAll('[data-edit]').forEach((b) =>
    b.addEventListener('click', (e) => { resetForm(); editing = e.currentTarget.dataset.edit; render(root); })
  );

  root.querySelector('[data-form-cancel]')?.addEventListener('click', () => { resetForm(); render(root); });
  root.querySelector('[data-form-backdrop]')?.addEventListener('mousedown', (e) => {
    if (e.target.dataset.formBackdrop !== undefined) { resetForm(); render(root); }
  });

  const RECIPE_NUMERIC_FIELDS = ['shelfLifeDays', 'cookingTemp', 'cookingTime', 'prepTime'];
  const RECIPE_TEXT_FIELDS = ['cookingMethod', 'equipment', 'instructions'];
  root.querySelectorAll('[data-r]').forEach((input) => {
    input.addEventListener('change', (e) => {
      const key = e.target.dataset.r;
      const draft = currentDraft(getState());
      if (key === 'baseGrams') draft.baseGrams = Math.max(0, Number(e.target.value) || 0);
      else if (key === 'batchAllowed') draft.batchAllowed = e.target.checked;
      else if (RECIPE_NUMERIC_FIELDS.includes(key)) draft[key] = e.target.value === '' ? null : Number(e.target.value);
      else if (RECIPE_TEXT_FIELDS.includes(key)) draft[key] = e.target.value;
      else if (key === 'kind') {
        const newKind = e.target.value;
        if (newKind === 'weight') {
          // même règle qu'à l'ajout d'un ingrédient (décision verrouillée) :
          // une recette au poids ne peut jamais contenir de non fractionnable.
          const byId = foodsMapOf(getState());
          const invalid = draft.items.find((it) => isWholeUnitFood(byId[it.foodId]));
          if (invalid) {
            toast(
              `Impossible de basculer en recette « au poids » : « ${byId[invalid.foodId]?.name || 'un ingrédient'} » ` +
              `est non fractionnable. Retire-le d'abord, ou garde cette recette en type « portion ».`,
              'error'
            );
            render(root); // réaffiche le select sur sa valeur réelle (draft.kind inchangé)
            return;
          }
        }
        draft.kind = newKind;
        // en basculant vers "weight", la référence part de la composition
        // actuelle (au lieu de forcer une saisie manuelle à 0).
        if (draft.kind === 'weight' && !draft.baseGrams) draft.baseGrams = portionGramsOf(draft);
      } else draft.name = e.target.value;
      render(root);
    });
  });

  root.querySelector('[data-ing-search]')?.addEventListener('input', (e) => {
    ingQuery = e.target.value;
    render(root);
    const el = root.querySelector('[data-ing-search]');
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  });

  root.querySelectorAll('[data-ing-add]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const foodId = e.currentTarget.dataset.ingAdd;
      const food = getState().foods.find((f) => f.id === foodId);
      if (!food) return;
      const draft = currentDraft(getState());
      const check = canAddIngredientToRecipe(draft, food);
      if (!check.ok) { toast(check.reason, 'error'); return; }
      // quantité initiale cohérente avec l'aliment (comme dans l'éditeur de
      // repas) : 1 unité pour un non fractionnable, la référence de catégorie sinon.
      const previousSum = portionGramsOf(draft);
      draft.items.push(newRecipeItem(foodId, initialQuantity(food), food.referenceState));
      syncAutoBaseGrams(draft, previousSum);
      render(root);
    });
  });

  root.querySelectorAll('[data-ing-unit-toggle]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const idx = Number(e.currentTarget.dataset.ingUnitToggle);
      const draft = currentDraft(getState());
      const foodId = draft.items[idx]?.foodId;
      if (!foodId) return;
      // `food.unitEntry` est partagé avec l'éditeur de repas (même aliment,
      // même bascule grammes/unités partout dans l'application).
      update((st) => {
        const f = st.foods.find((x) => x.id === foodId);
        if (f) f.unitEntry = !f.unitEntry;
      });
      render(root);
    });
  });

  root.querySelectorAll('[data-ing-qty]').forEach((input) => {
    input.addEventListener('change', (e) => {
      const idx = Number(e.target.dataset.ingQty);
      const inUnits = e.target.dataset.unitmode === '1';
      const raw = Math.max(0, Number(String(e.target.value).replace(',', '.')) || 0);
      const draft = currentDraft(getState());
      const item = draft.items[idx];
      if (!item) return;
      const food = getState().foods.find((f) => f.id === item.foodId);
      const grams = inUnits && food ? fromUnits(food, raw) : raw;
      // contrainte absolue : multiple entier de gramsPerUnit si non fractionnable
      // (même garantie que dans l'éditeur de repas — jamais 37 g de Wasa).
      const previousSum = portionGramsOf(draft);
      item.qty = snapQuantity(food, grams);
      syncAutoBaseGrams(draft, previousSum);
      render(root);
    });
  });

  root.querySelectorAll('[data-ing-state]').forEach((sel) => {
    sel.addEventListener('change', (e) => {
      const idx = Number(e.target.dataset.ingState);
      const draft = currentDraft(getState());
      if (draft.items[idx]) draft.items[idx].state = e.target.value;
      render(root);
    });
  });

  root.querySelectorAll('[data-ing-del]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const idx = Number(e.target.dataset.ingDel);
      const draft = currentDraft(getState());
      const previousSum = portionGramsOf(draft);
      draft.items.splice(idx, 1);
      syncAutoBaseGrams(draft, previousSum);
      render(root);
    });
  });

  root.querySelector('[data-save]')?.addEventListener('click', () => {
    const draft = currentDraft(getState());
    if (!draft.name.trim()) { toast('Le nom est obligatoire', 'error'); return; }
    if (!draft.items.length) { toast('Ajoute au moins un ingrédient', 'error'); return; }
    if (draft.kind === 'weight' && !(Number(draft.baseGrams) > 0)) {
      toast('Indique le poids de référence (g)', 'error'); return;
    }
    // filet de sécurité : une recette au poids ne doit jamais être enregistrée
    // avec un ingrédient non fractionnable, quel que soit le chemin emprunté
    // pour y arriver (l'ajout et le changement de type le bloquent déjà).
    if (draft.kind === 'weight') {
      const byId = foodsMapOf(getState());
      const invalid = draft.items.find((it) => isWholeUnitFood(byId[it.foodId]));
      if (invalid) {
        toast(
          `« ${byId[invalid.foodId]?.name || 'cet ingrédient'} » est non fractionnable : impossible ` +
          `d'enregistrer une recette au poids avec cet ingrédient.`,
          'error'
        );
        return;
      }
    }
    update((st) => {
      const idx = st.recipes.findIndex((x) => x.id === draft.id);
      if (idx >= 0) st.recipes[idx] = draft;
      else st.recipes.push(draft);
    });
    resetForm();
    toast('Recette enregistrée');
    render(root);
  });

  root.querySelector('[data-delete]')?.addEventListener('click', (e) => {
    const id = e.currentTarget.dataset.delete;
    const st = getState();
    // décision verrouillée (§9 de la spécification) : une recette ayant des
    // préparations existantes n'est jamais supprimée silencieusement — pas de
    // perte d'historique (équivalent local du "on delete restrict" prévu côté Supabase).
    if (st.preparations.some((p) => p.recipeId === id)) {
      toast('Impossible : des préparations existent encore pour cette recette.', 'error');
      return;
    }
    if (!confirm('Supprimer cette recette ?')) return;
    update((s2) => { s2.recipes = s2.recipes.filter((x) => x.id !== id); });
    resetForm();
    render(root);
  });
}
