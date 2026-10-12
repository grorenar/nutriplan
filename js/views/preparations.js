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

import { getState, update, foodsById, recipesById, preparationsById, newPreparationItem } from '../core/store.js';
import { mealMacros, evaluate, preparedGramsOf, portionGramsOf, PERSONS, PERSON_LABEL } from '../core/nutrition.js';
import {
  preparationUsed, preparationAvailable, distributionCandidates, planPreparationDistribution,
} from '../core/derive.js';
import { analyzeMealVolume } from '../core/meal-volume.js';
import { esc, num, toast } from '../core/util.js';

// État d'interface uniquement (jamais persisté) — même convention que
// `pickerQuery`/`ctx` dans editor.js ou `duplicateFrom` dans planning.js.
let wizard = null;   // { preparationId, amount, mealIds: Set<string>, catalog: Map<key, {picked, perServiceQty}> }
let quickUse = null; // { preparationId, mealId, qty }
let lastResult = null;

export function render(root) {
  const s = getState();
  const recipesMap = recipesById();
  const preps = s.preparations;

  root.innerHTML = `
    <div class="row" style="margin-bottom:12px">
      <small>Une préparation est un stock : préparée une fois, elle peut être répartie sur plusieurs repas au fil du cycle, sans devoir cocher un « zéro reste » repas par repas.</small>
    </div>
    ${lastResult ? resultCard(lastResult) : ''}
    ${wizard ? distributeWizard(s, recipesMap) : ''}
    ${quickUse ? quickUseCard(s, recipesMap) : ''}
    ${
      preps.length
        ? preps.map((p) => prepCard(p, s, recipesMap)).join('')
        : `<div class="empty">Aucune préparation. Crée-en une depuis l'éditeur d'un repas (panneau « Recettes & préparations »).</div>`
    }
  `;
  wire(root, s);
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
  const disponible = preparationAvailable(s, p);
  const recipeName = recipesMap[p.recipeId]?.name || '?';
  const epuisee = disponible <= 0;

  return `<div class="card" style="margin-bottom:12px">
    <div class="card__head">
      <h3>${esc(p.label)}</h3>
      <span class="tag">${esc(recipeName)}</span>
    </div>
    <div class="kv">
      <div><small>Préparé</small><b>${unitLabelFor(p, prepared)}</b></div>
      <div><small>Affecté</small><b>${unitLabelFor(p, Math.max(0, used))}</b></div>
      <div><small>Disponible</small><b class="${epuisee ? 'muted' : ''}">${unitLabelFor(p, Math.max(0, disponible))}</b></div>
    </div>
    ${epuisee ? '<small class="muted">Entièrement affectée : conservée dans la liste, mais plus proposée pour une nouvelle répartition.</small>' : ''}
    <div class="row" style="margin-top:10px">
      <button class="btn btn--primary" data-open-distribute="${p.id}" ${epuisee ? 'disabled' : ''}>Répartir</button>
      <button class="btn btn--sm" data-open-quick-use="${p.id}" ${epuisee ? 'disabled' : ''}>+ Utiliser dans un repas</button>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Assistant « Répartir » (variante B — checklist directe)             */
/* ------------------------------------------------------------------ */

const catalogKeyOf = (c) => `${c.kind}:${c.optionId}:${c.slot ?? 'x'}`;

function distributeWizard(s, recipesMap) {
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

function quickUseCard(s, recipesMap) {
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

  root.querySelector('[data-wizard-cancel]')?.addEventListener('click', () => { wizard = null; render(root); });
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
