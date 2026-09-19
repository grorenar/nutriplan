/** Écran COURSES — besoin vs quantité à acheter, budget. Aucune gestion de stock. */

import { getState, update, foodsById, recipesById, preparationsById } from '../core/store.js';
import { buildShoppingList } from '../core/derive.js';
import { CATEGORIES } from '../core/nutrition.js';
import { esc, grams, euros, num } from '../core/util.js';

export function render(root) {
  const s = getState();
  const byId = foodsById();
  const { lines, total, unpriced, budget, overBudget } = buildShoppingList(s, byId, recipesById(), preparationsById());
  const unpricedLines = lines.filter((l) => l.cost === null);

  const groups = {};
  for (const l of lines) (groups[l.food.category] ||= []).push(l);

  const sections = Object.entries(groups)
    .map(([catId, ls]) => {
      const label = CATEGORIES.find((c) => c.id === catId)?.label || catId;
      return `<div class="card">
        <div class="card__head"><h3>${esc(label)}</h3><span class="tag">${ls.length}</span></div>
        ${ls.map(lineOf).join('')}
      </div>`;
    })
    .join('');

  root.innerHTML = `
    <div class="card" style="margin-bottom:12px">
      <div class="kv">
        <div><small>Budget cible</small><b>${euros(budget)}</b></div>
        <div><small>Estimation du cycle</small><b>${euros(total)}</b></div>
        <div><small>Écart</small><b class="${overBudget > 0 ? '' : ''}">${overBudget > 0 ? `dépassement de ${euros(overBudget)}` : `marge de ${euros(-overBudget)}`}</b></div>
        <div><small>Articles</small><b>${lines.length}</b></div>
      </div>
      ${overBudget > 0 ? `<small>Le budget n'est pas bloquant. L'écran Planning propose des substitutions moins chères, à valider manuellement.</small>` : ''}
      ${
        unpricedLines.length
          ? `<div style="margin-top:8px">
               <small>Prix non renseigné pour ${unpricedLines.length} article(s) — ils ne sont pas comptés dans l'estimation :</small>
               <ul style="margin:4px 0 0;padding-left:18px">
                 ${unpricedLines
                   .map((l) => `<li><button class="btn btn--sm btn--ghost" data-open-food="${l.food.id}">${esc(l.food.name)}</button></li>`)
                   .join('')}
               </ul>
             </div>`
          : ''
      }
    </div>
    ${lines.length ? sections : `<div class="empty">Aucun repas planifié : la liste de courses est vide.</div>`}
    ${lines.length ? `<div class="row" style="margin-top:12px"><button class="btn btn--sm" data-uncheck>Tout décocher</button></div>` : ''}
  `;
  wire(root);
}

function lineOf(l) {
  const buy = l.packages
    ? `${l.packages} × ${grams(l.packageWeight)}`
    : `${grams(l.buyGrams)} (vrac)`;
  return `<label class="list-row ${l.purchased ? 'is-done' : ''}">
    <input type="checkbox" data-buy="${l.food.id}" ${l.purchased ? 'checked' : ''}>
    <div class="list-row__main">
      <strong>${esc(l.food.name)}</strong> — ${esc(buy)}
      <div class="tag nums">Besoin ${grams(l.required)}${l.packages ? ` · surplus ${grams(l.surplus)}` : ''}${l.cost !== null ? ` · ${euros(l.cost)}` : ' · prix non renseigné'}</div>
    </div>
  </label>`;
}

function wire(root) {
  root.querySelectorAll('[data-buy]').forEach((cb) =>
    cb.addEventListener('change', (e) => {
      const id = e.target.dataset.buy;
      const checked = e.target.checked;
      update((s) => { s.shopping.purchased[id] = checked; });
    })
  );
  // ouverture directe de la fiche aliment pour renseigner le prix manquant
  root.querySelectorAll('[data-open-food]').forEach((b) =>
    b.addEventListener('click', (e) => {
      document.dispatchEvent(
        new CustomEvent('nutriplan:open-food', { detail: { id: e.currentTarget.dataset.openFood } })
      );
    })
  );

  root.querySelector('[data-uncheck]')?.addEventListener('click', () => {
    update((s) => { s.shopping.purchased = {}; });
  });
}
