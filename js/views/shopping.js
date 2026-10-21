/** Écran COURSES — besoin vs quantité à acheter, budget. Aucune gestion de stock. */

import { getState, update, foodsById, recipesById, preparationsById } from '../core/store.js';
import { buildShoppingList } from '../core/derive.js';
import { CATEGORIES } from '../core/nutrition.js';
import { esc, grams, euros, num } from '../core/util.js';

let activeCategory = 'all'; // filtre affiché (n'affecte jamais le calcul du total/budget, toujours sur l'ensemble)

export function render(root) {
  const s = getState();
  const byId = foodsById();
  const { lines, total, budget, overBudget } = buildShoppingList(s, byId, recipesById(), preparationsById());
  const unpricedLines = lines.filter((l) => l.cost === null);

  const groups = {};
  for (const l of lines) (groups[l.food.category] ||= []).push(l);
  // Ordre de groupes préservé tel que buildShoppingList() le produit (lignes
  // déjà triées par catégorie puis nom) — seule la métadonnée (icône/libellé)
  // est enrichie ici, jamais l'ordre d'affichage des catégories.
  const catsPresent = Object.keys(groups).map((id) => CATEGORIES.find((c) => c.id === id) || { id, label: id, icon: '🏷️' });

  if (activeCategory !== 'all' && !groups[activeCategory]) activeCategory = 'all';
  const shown = activeCategory === 'all' ? catsPresent : catsPresent.filter((c) => c.id === activeCategory);

  const sections = shown
    .map((c) => {
      const ls = groups[c.id];
      return `<div class="card">
        <div class="card__head">
          <span class="cat-badge" data-cat="${c.id}">${c.icon} ${esc(c.label)}</span>
          <span class="tag">${ls.length} article${ls.length > 1 ? 's' : ''}</span>
        </div>
        ${ls.map(lineOf).join('')}
      </div>`;
    })
    .join('');

  const budgetPct = budget > 0 ? Math.min(100, (total / budget) * 100) : 0;

  root.innerHTML = `
    <div class="stat-strip" style="margin-bottom:14px">
      <div class="stat-strip__cell">
        <span class="stat-strip__label">💰 Budget cible</span>
        <span class="stat-strip__value">${euros(budget)}</span>
      </div>
      <div class="stat-strip__cell">
        <span class="stat-strip__label">🛒 Estimation du cycle</span>
        <span class="stat-strip__value">${euros(total)}</span>
        ${budget > 0 ? `<div class="progress" style="margin-top:4px"><div class="progress__bar ${overBudget > 0 ? 'is-over' : ''}" style="width:${num(budgetPct, 0)}%"></div></div>` : ''}
      </div>
      <div class="stat-strip__cell ${overBudget > 0 ? 'stat-strip__cell--off' : 'stat-strip__cell--accent'}">
        <span class="stat-strip__label">📉 Écart</span>
        <span class="stat-strip__value">${overBudget > 0 ? `+${euros(overBudget)}` : `−${euros(-overBudget)}`}</span>
        <span class="stat-strip__sub">${overBudget > 0 ? 'dépassement' : 'marge'}</span>
      </div>
      <div class="stat-strip__cell">
        <span class="stat-strip__label">📋 Articles</span>
        <span class="stat-strip__value">${lines.length}</span>
        <span class="stat-strip__sub">répartis dans ${catsPresent.length} catégorie${catsPresent.length > 1 ? 's' : ''}</span>
      </div>
    </div>
    ${overBudget > 0 ? `<p class="tag" style="margin-bottom:10px">Le budget n'est pas bloquant. L'écran Planning propose des substitutions moins chères, à valider manuellement.</p>` : ''}
    ${
      unpricedLines.length
        ? `<div class="card" style="margin-bottom:12px;border-color:#ecd7ae;background:var(--warn-bg)">
             <strong>Prix non renseigné pour ${unpricedLines.length} article(s)</strong> — ils ne sont pas comptés dans l'estimation.
             <div class="chips" style="margin-top:8px">
               ${unpricedLines
                 .map((l) => `<button class="chip" data-open-food="${l.food.id}">${esc(l.food.name)}</button>`)
                 .join('')}
             </div>
           </div>`
        : ''
    }
    ${
      lines.length
        ? `<div class="row" style="margin-bottom:14px">
            <div class="chips">
              <button class="chip" data-cat-filter="all" aria-pressed="${activeCategory === 'all'}">Toutes (${lines.length})</button>
              ${catsPresent
                .map(
                  (c) =>
                    `<button class="chip" data-cat-filter="${c.id}" aria-pressed="${activeCategory === c.id}">${c.icon} ${esc(c.label)} (${groups[c.id].length})</button>`
                )
                .join('')}
            </div>
            <span class="spacer"></span>
            <button class="btn btn--sm" data-uncheck>Tout décocher</button>
          </div>`
        : ''
    }
    ${lines.length ? sections : `<div class="empty">Aucun repas planifié : la liste de courses est vide.</div>`}
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

  root.querySelectorAll('[data-cat-filter]').forEach((b) =>
    b.addEventListener('click', (e) => {
      activeCategory = e.currentTarget.dataset.catFilter;
      render(root);
    })
  );

  root.querySelector('[data-uncheck]')?.addEventListener('click', () => {
    update((s) => { s.shopping.purchased = {}; });
  });
}
