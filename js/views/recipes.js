/**
 * Écran RECETTES — catalogue global de recettes (composition figée, macros
 * dérivées, jamais stockées). Une recette est une convenance d'auteur : le
 * moteur nutritionnel, le volume et les dérivés (batch/courses) ne la
 * connaissent qu'au travers de `recipeAsVirtualFood()` (nutrition.js).
 */

import { getState, update, newRecipe, newRecipeItem } from '../core/store.js';
import { CATEGORIES, STATES, recipeMacrosPer100g, canAddIngredientToRecipe, isWholeUnitFood } from '../core/nutrition.js';
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
  const portionBase = r.items.reduce((sum, it) => sum + (Number(it.qty) || 0), 0);
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
  const portionBase = r.items.reduce((sum, it) => sum + (Number(it.qty) || 0), 0);

  const ingredientRows = r.items.length
    ? r.items.map((it, idx) => {
        const food = byId[it.foodId];
        return `<div class="item">
          <div class="item__main">
            <div class="item__name">${food ? esc(food.name) : 'Aliment supprimé'}</div>
            <div class="item__qty" style="margin-top:6px">
              <div class="qty-box">
                <div class="qty-box__row">
                  <input type="number" min="0" step="1" data-ing-qty="${idx}" value="${num(it.qty, 0)}" aria-label="Quantité">
                  <span class="item__unit">g</span>
                </div>
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
                 <small style="grid-column:1/-1">Poids RÉELLEMENT obtenu après cuisson pour cette composition — sert de référence à l'optimiseur, jamais une contrainte.</small>`
              : `<small style="grid-column:1/-1">Recette portion : la composition ci-dessous décrit UNE portion (${num(portionBase, 0)} g). L'intégration à l'optimiseur (nombre entier de portions) arrive à une étape ultérieure.</small>`
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

        <div class="row" style="margin-top:18px">
          <button class="btn btn--primary" data-save>Enregistrer</button>
          ${editing === 'new' ? '' : `<span class="spacer"></span><button class="btn btn--danger" data-delete="${r.id}">Supprimer</button>`}
        </div>
      </div>
    </div>
  </div>`;
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

  root.querySelectorAll('[data-r]').forEach((input) => {
    input.addEventListener('change', (e) => {
      const key = e.target.dataset.r;
      const draft = currentDraft(getState());
      if (key === 'baseGrams') draft.baseGrams = Math.max(0, Number(e.target.value) || 0);
      else if (key === 'kind') {
        draft.kind = e.target.value;
        if (draft.kind === 'weight' && !draft.baseGrams) draft.baseGrams = 0;
        // basculer en "portion" retire toute contrainte de fractionnabilité :
        // aucun ingrédient n'est supprimé, la règle ne s'applique qu'à l'ajout.
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
      draft.items.push(newRecipeItem(foodId, 100, food.referenceState));
      render(root);
    });
  });

  root.querySelectorAll('[data-ing-qty]').forEach((input) => {
    input.addEventListener('change', (e) => {
      const idx = Number(e.target.dataset.ingQty);
      const draft = currentDraft(getState());
      if (draft.items[idx]) draft.items[idx].qty = Math.max(0, Number(e.target.value) || 0);
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
      draft.items.splice(idx, 1);
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
