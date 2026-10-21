/** Écran PLANNING — cycles de courses/batch, sans aucune date réelle. */

import { getState, update, foodsById, recipesById, preparationsById, itemLabel, newRecipeMealItem, newPreparationItem, autoMealName } from '../core/store.js';
import {
  mealMacros, evaluate, PERSONS, PERSON_LABEL, MEAL_TYPES, MACRO_META,
  autoAdjust, portionGramsOf, recipeMacrosPer100g,
} from '../core/nutrition.js';
import { optimizeSuggestions, dayTotals, preparationAvailable } from '../core/derive.js';
import { dayName, esc, num, toast, uid } from '../core/util.js';
import { openEditor } from './editor.js';
import { actionConfirmModal, wireActionConfirm } from './confirm-action.js';
import { progressRing } from './charts.js';

let showSuggestions = false;
let duplicateFrom = null;
let pendingConfirm = null; // { title, message, confirmLabel, onConfirm } — P1, remplace confirm() natif

// Glisser-déposer : la charge utile voyage dans une variable de module plutôt
// que dataTransfer.getData() — plus simple, plus fiable (DataTransfer n'est
// pas disponible partout, notamment en environnement de test) puisque tout se
// passe dans la même page. dataTransfer n'est renseigné que pour les repères
// visuels natifs du navigateur (curseur, image fantôme), jamais lu au drop.
let dragPayload = null; // { kind: 'meal', mealId } | { kind: 'recipe'|'preparation', id }

let libraryTab = 'recipes'; // 'recipes' | 'batch' | 'preparations'
let libraryQuery = '';

export function render(root) {
  const s = getState();
  const byId = foodsById();
  const recipesMap = recipesById();
  const preparationsMap = preparationsById();
  const { startWeekday, duration } = s.settings.cycle;

  const cols = [];
  for (let d = 0; d < duration; d++) {
    const meals = ['lunch', 'dinner'].map((type) => s.meals.find((m) => m.dayIndex === d && m.mealType === type));
    const dayStats = PERSONS.map((p) => dayTotals(s, byId, d, p, recipesMap, preparationsMap));
    cols.push(`
      <div class="day-col">
        <div class="day-col__head">
          <h2>${esc(dayName(startWeekday, d))}</h2>
          <span class="day-col__num">Jour ${d + 1}</span>
        </div>
        <div class="day-col__stats">
          ${PERSONS.map((p, i) => `<span class="person-name person-name--${p}">${PERSON_LABEL[p]}</span> ${num(dayStats[i].kcal, 0)} kcal · ${num(dayStats[i].protein, 0)} P · ${num(dayStats[i].carbs, 0)} G · ${num(dayStats[i].fat, 0)} L`).join('<br>')}
        </div>
        ${meals.map((m) => mealSlot(m, byId, s, recipesMap, preparationsMap)).join('')}
      </div>`);
  }

  root.innerHTML = `
    <div class="day-summary">${PERSONS.map((p) => cycleSummaryCard(p, s, byId, recipesMap, preparationsMap)).join('')}</div>

    <div class="row" style="margin-bottom:14px">
      <span class="pill pill--accent">Cycle de ${duration} jours — démarrage ${esc(dayName(startWeekday, 0).toLowerCase())}</span>
      <span class="spacer"></span>
      <button class="btn" data-optimize>✨ Suggestions du cycle</button>
    </div>
    ${showSuggestions ? suggestionsPanel(s, byId, recipesMap, preparationsMap) : ''}

    <div class="board">${cols.join('')}</div>

    ${libraryHtml(s)}

    ${duplicateFrom ? duplicatePanel(s) : ''}
    ${pendingConfirm ? actionConfirmModal(pendingConfirm) : ''}
  `;

  wire(root);
}

/**
 * Carte de synthèse par personne, en haut de l'écran — portée VOLONTAIREMENT
 * fixée au cycle entier (somme de tous les jours vs somme de tous les
 * objectifs), jamais à "aujourd'hui" : ce planificateur n'a aucune date
 * réelle (cf. en-tête de ce fichier), donc aucune notion de jour courant à
 * mettre en avant sans l'inventer. "Sur l'ensemble du cycle" reste un
 * agrégat honnête et toujours défini, quelle que soit la durée du cycle.
 */
function cycleSummaryCard(person, s, byId, recipesMap, preparationsMap) {
  const { duration } = s.settings.cycle;
  const total = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  const target = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  for (let d = 0; d < duration; d++) {
    const t = dayTotals(s, byId, d, person, recipesMap, preparationsMap);
    total.kcal += t.kcal; total.protein += t.protein; total.carbs += t.carbs; total.fat += t.fat;
    target.kcal += s.settings.targets[person].lunch?.kcal || 0; target.kcal += s.settings.targets[person].dinner?.kcal || 0;
    target.protein += s.settings.targets[person].lunch?.protein || 0; target.protein += s.settings.targets[person].dinner?.protein || 0;
    target.carbs += s.settings.targets[person].lunch?.carbs || 0; target.carbs += s.settings.targets[person].dinner?.carbs || 0;
    target.fat += s.settings.targets[person].lunch?.fat || 0; target.fat += s.settings.targets[person].dinner?.fat || 0;
  }
  const rings = Object.keys(MACRO_META)
    .map((key) => {
      const meta = MACRO_META[key];
      const pct = target[key] > 0 ? (total[key] / target[key]) * 100 : 0;
      return `<div class="day-summary__ring">
        ${progressRing(pct, { size: 62, thickness: 6, color: `var(--${meta.cls})`, label: meta.label })}
        <span class="day-summary__ring-label">${meta.icon} ${meta.short}</span>
        <span class="day-summary__ring-value">${num(total[key], 0)}${target[key] ? ` / ${num(target[key], 0)}` : ''}${key === 'kcal' ? '' : ' g'}</span>
      </div>`;
    })
    .join('');
  return `<div class="day-summary__card">
    <div class="day-summary__head person-name person-name--${person}">${PERSON_LABEL[person]} <span class="tag" style="font-weight:500">· sur l'ensemble du cycle</span></div>
    <div class="day-summary__rings">${rings}</div>
  </div>`;
}

function mealSlot(meal, byId, s, recipesMap, preparationsMap) {
  if (!meal) return '';
  const empty = meal.items.length === 0;
  const icon = meal.mealType === 'lunch' ? '☀️' : '🌙';

  if (empty) {
    return `<div class="meal-slot is-empty" data-slot="${meal.id}" data-drop-meal="${meal.id}">
      <div class="meal-slot__dropzone">Déposer ici</div>
      <span class="meal-slot__ico">${icon}</span>
      <div class="meal-slot__type">${esc(MEAL_TYPES[meal.mealType])}</div>
      <span class="meal-slot__empty-text">Glissez un menu ici<br>ou cliquez sur « Composer »</span>
      <button class="meal-slot__add" data-edit="${meal.id}" title="Composer ${esc(MEAL_TYPES[meal.mealType]).toLowerCase()}" aria-label="Composer">+</button>
    </div>`;
  }

  const ings = meal.items.map((it) => itemLabel(it, byId, recipesMap, preparationsMap)).slice(0, 4).join(', ');
  const macroRow = PERSONS.map((person) => {
    const macros = mealMacros(meal.items, byId, person, recipesMap, preparationsMap);
    const target = s.settings.targets[person][meal.mealType];
    const ev = evaluate(macros, target, s.settings.tolerance);
    const chips = ev.rows
      .map((r) => `<span class="macro is-${r.status}"><b>${num(r.value, 0)}</b> <span class="goal">${r.label}</span></span>`)
      .join('');
    return `<div class="person-band person-band--${person}" style="margin-top:6px">
      <div class="person-name person-name--${person}">${PERSON_LABEL[person]}</div>
      <div class="macros" style="margin-top:3px">${chips}</div>
    </div>`;
  }).join('');

  return `<div class="meal-slot" data-slot="${meal.id}" data-drop-meal="${meal.id}" draggable="true" data-drag-meal="${meal.id}">
    <div class="meal-slot__dropzone">Déposer ici</div>
    <span class="meal-slot__drag-handle" aria-hidden="true" title="Glisser vers un autre créneau">⠿</span>
    <details class="item-menu meal-slot__menu">
      <summary aria-label="Options du repas">⋯</summary>
      <div class="meal-slot__menu__body">
        <button type="button" data-dup="${meal.id}">Dupliquer vers…</button>
        <button type="button" class="is-danger" data-clear="${meal.id}">Vider</button>
      </div>
    </details>
    <div class="meal-slot__head">
      <span class="meal-slot__ico">${icon}</span>
      <span class="meal-slot__type">${esc(MEAL_TYPES[meal.mealType])}</span>
    </div>
    <div class="meal-slot__name">${esc(meal.name || 'Sans nom')}</div>
    <div class="meal-slot__ing">${esc(ings)}${meal.items.length > 4 ? '…' : ''}</div>
    ${macroRow}
    <button class="btn btn--sm btn--secondary" data-edit="${meal.id}" style="margin-top:10px;width:100%">Modifier</button>
  </div>`;
}

function suggestionsPanel(s, byId, recipesMap, preparationsMap) {
  const list = optimizeSuggestions(s, byId, recipesMap, preparationsMap);
  return `<div class="card" style="margin-bottom:16px">
    <div class="card__head">
      <h3>Suggestions pour ce cycle</h3>
      <button class="btn btn--sm btn--ghost" data-close-sugg>Masquer</button>
    </div>
    <ul style="margin:0;padding-left:18px">
      ${list.map((x) => `<li style="margin-bottom:4px">${esc(x.text)}</li>`).join('')}
    </ul>
    <small>Aucune de ces suggestions n'est appliquée automatiquement : le planning n'est modifié que par toi.</small>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Bibliothèque « Menus disponibles »                                  */
/* ------------------------------------------------------------------ */

const LIBRARY_TABS = [
  { id: 'recipes', label: 'Mes recettes', icon: '📖' },
  { id: 'batch', label: 'Batch cooking', icon: '🍲' },
  { id: 'preparations', label: 'Préparations', icon: '🍱' },
];

/**
 * Éléments glissables vers un créneau — uniquement des données DÉJÀ
 * existantes (recettes, préparations en stock) : pas de nouvel objet
 * « menu » inventé, pas de notion de « récent »/« favori » qui n'existe pas
 * encore pour les recettes dans ce modèle de données (seuls les aliments ont
 * `favorite`/`lastUsed` aujourd'hui).
 */
function libraryItems(s) {
  if (libraryTab === 'preparations') {
    return s.preparations
      .map((p) => ({ p, disponible: preparationAvailable(s, p) }))
      .filter((x) => x.disponible > 0)
      .map(({ p, disponible }) => ({
        kind: 'preparation', id: p.id, name: p.label,
        macros: null, sub: `Disponible : ${num(disponible, 0)} g`,
      }));
  }
  const recipes = libraryTab === 'batch' ? s.recipes.filter((r) => r.batchAllowed) : s.recipes;
  const byId = foodsById();
  return recipes.map((r) => ({
    kind: 'recipe', id: r.id, name: r.name, macros: recipeMacrosPer100g(r, byId),
    sub: r.kind === 'portion' ? `${num(portionGramsOf(r), 0)} g / portion` : `${num(r.baseGrams, 0)} g de référence`,
  }));
}

/** HTML des seules cartes glissables — réutilisé tel quel par la mise à jour de la recherche (sans reconstruire tout le bloc). */
function libraryRowHtml(s) {
  const q = libraryQuery.trim().toLowerCase();
  let items = libraryItems(s);
  if (q) items = items.filter((x) => x.name.toLowerCase().includes(q));

  return items.length
    ? items.map((it) => `<div class="library-card" draggable="true" data-drag-lib="${it.kind}:${it.id}">
        <div class="library-card__name">${esc(it.name)}</div>
        <div class="library-card__macros">
          ${it.macros ? `<span class="macro-badge" data-macro="kcal"><b>${num(it.macros.kcal, 0)}</b> kcal</span>` : ''}
          ${!it.macros ? `<span class="tag">${esc(it.sub)}</span>` : ''}
        </div>
      </div>`).join('')
    : `<div class="empty" style="min-width:260px">Rien à montrer ici pour l'instant.</div>`;
}

function libraryHtml(s) {
  return `<div class="library">
    <div class="card__head"><h3>Menus disponibles</h3><p>Glisse une recette ou une préparation directement sur un créneau du tableau ci-dessus.</p></div>
    <div class="row" style="margin-bottom:10px">
      <div class="chips">
        ${LIBRARY_TABS.map((t) => `<button class="chip" data-lib-tab="${t.id}" aria-pressed="${libraryTab === t.id}">${t.icon} ${esc(t.label)}</button>`).join('')}
      </div>
      <span class="spacer"></span>
      <input type="text" data-lib-q value="${esc(libraryQuery)}" placeholder="Rechercher…" style="max-width:220px">
    </div>
    <div class="library__row">${libraryRowHtml(s)}</div>
  </div>`;
}

function duplicatePanel(s) {
  const src = s.meals.find((m) => m.id === duplicateFrom);
  if (!src) return '';
  const startWeekday = s.settings.cycle.startWeekday;
  const slots = s.meals
    .filter((m) => m.id !== src.id)
    .map(
      (m) => `<label class="check" style="padding:6px 0">
        <input type="checkbox" data-target="${m.id}">
        ${esc(dayName(startWeekday, m.dayIndex))} (jour ${m.dayIndex + 1}) — ${esc(MEAL_TYPES[m.mealType])}${m.items.length ? ' (sera remplacé)' : ''}
      </label>`
    )
    .join('');
  return `<div class="drawer" data-dup-backdrop>
    <div class="drawer__panel" style="width:min(460px,100%)">
      <div class="drawer__head"><div class="row"><h3 style="flex:1">Dupliquer « ${esc(src.name || 'repas')} »</h3>
      <button class="btn btn--ghost" data-dup-cancel>Fermer</button></div></div>
      <div class="drawer__body">
        ${slots}
        <div class="row" style="margin-top:14px">
          <button class="btn btn--primary" data-dup-confirm>Dupliquer</button>
          <label class="check"><input type="checkbox" data-dup-adjust checked> Réajuster les quantités après copie</label>
        </div>
      </div>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Mutations partagées (bouton « Dupliquer » ET glisser-déposer)       */
/* ------------------------------------------------------------------ */

/**
 * Copie la composition d'un repas vers un autre créneau — logique
 * EXTRAITE telle quelle de l'ancien gestionnaire `data-dup-confirm` (aucun
 * changement de comportement), désormais partagée par la modale « Dupliquer »
 * ET le glisser-déposer : une seule mécanique, jamais deux implémentations
 * parallèles pour le même résultat.
 */
function copyMealTo(s, srcId, dstId, { readjust = true } = {}) {
  const src = s.meals.find((m) => m.id === srcId);
  const dst = s.meals.find((m) => m.id === dstId);
  if (!src || !dst || src.id === dst.id) return false;
  const byId = Object.fromEntries(s.foods.map((f) => [f.id, f]));
  dst.name = src.name;
  dst.nameAuto = src.nameAuto;
  dst.sameComposition = src.sameComposition;
  dst.items = src.items.map((it) => ({ ...JSON.parse(JSON.stringify(it)), id: uid('it') }));
  if (readjust && s.settings.autoAdjust) {
    autoAdjust(dst.items, byId, {
      thomas: s.settings.targets.thomas[dst.mealType],
      julie: s.settings.targets.julie[dst.mealType],
    });
  }
  return true;
}

/**
 * Applique un élément de la bibliothèque (recette ou préparation) à un
 * créneau — remplace entièrement sa composition par CET élément unique
 * (même principe que « Vider » + « Composer », en un seul geste). Réutilise
 * exactement les constructeurs d'item et le calcul de quantité initiale déjà
 * utilisés par l'éditeur de repas (editor.js) pour la même action au clic.
 */
function applyLibraryItemToMeal(s, dstId, payload) {
  const dst = s.meals.find((m) => m.id === dstId);
  if (!dst) return false;
  const recipesMap = Object.fromEntries(s.recipes.map((r) => [r.id, r]));
  const preparationsMap = Object.fromEntries(s.preparations.map((p) => [p.id, p]));
  const byId = Object.fromEntries(s.foods.map((f) => [f.id, f]));
  let item = null;
  if (payload.kind === 'recipe') {
    const recipe = recipesMap[payload.id];
    if (!recipe) return false;
    const qty = recipe.kind === 'portion' ? portionGramsOf(recipe) : Math.max(1, Math.round(Number(recipe.baseGrams) || 0));
    item = newRecipeMealItem(payload.id, qty);
  } else if (payload.kind === 'preparation') {
    const prep = preparationsMap[payload.id];
    if (!prep) return false;
    const disponible = preparationAvailable(s, prep);
    const qty = prep.recipeSnapshot?.kind === 'portion'
      ? Math.min(portionGramsOf(prep.recipeSnapshot), Math.max(1, disponible))
      : Math.max(1, Math.round(Math.min(disponible, 200)));
    item = newPreparationItem(payload.id, qty);
  } else {
    return false;
  }
  dst.items = [item];
  dst.nameAuto = true;
  if (s.settings.autoAdjust) {
    autoAdjust(dst.items, byId, { thomas: s.settings.targets.thomas[dst.mealType], julie: s.settings.targets.julie[dst.mealType] }, {
      recipesById: recipesMap, preparationsById: preparationsMap,
    });
  }
  dst.name = autoMealName(dst.items, byId, recipesMap, preparationsMap);
  return true;
}

/** Dépose la charge `dragPayload` courante sur le créneau `dstId`, avec confirmation si celui-ci n'est pas vide. */
function handleDrop(root, dstId) {
  const payload = dragPayload;
  dragPayload = null;
  if (!payload) return;
  const s0 = getState();
  const dst = s0.meals.find((m) => m.id === dstId);
  if (!dst) return;
  if (payload.kind === 'meal' && payload.mealId === dstId) return; // dépose sur soi-même : rien à faire

  const apply = () => {
    update((s) => {
      if (payload.kind === 'meal') copyMealTo(s, payload.mealId, dstId, { readjust: true });
      else applyLibraryItemToMeal(s, dstId, payload);
    });
    toast('Repas mis à jour');
    render(root);
  };

  if (dst.items.length) {
    pendingConfirm = {
      title: 'Remplacer ce repas ?',
      message: `« ${dst.name || 'Ce repas'} » sera entièrement remplacé par ce que tu viens de déposer.`,
      confirmLabel: 'Remplacer',
      onConfirm: apply,
    };
    render(root);
  } else {
    apply();
  }
}

function wire(root) {
  root.querySelectorAll('[data-edit]').forEach((b) =>
    b.addEventListener('click', (e) => openEditor('meal', e.currentTarget.dataset.edit))
  );

  root.querySelectorAll('[data-clear]').forEach((b) =>
    b.addEventListener('click', (e) => {
      const id = e.currentTarget.dataset.clear;
      pendingConfirm = {
        title: 'Vider ce repas ?',
        message: 'Tous les ingrédients de ce repas seront retirés, et son nom réinitialisé.',
        confirmLabel: 'Vider le repas',
        onConfirm: () => update((s) => {
          // Vider le repas le ramène à un état vraiment vide — équivalent à
          // newMeal() — donc nameAuto repasse à true : un nom manuellement tapé
          // puis explicitement vidé DANS L'ÉDITEUR reste figé (règle existante,
          // data-name), mais « Vider ce repas » depuis le planning est un reset
          // complet, pas un simple effacement du champ nom ; sans ce repli, un
          // repas qui avait un nom manuel resterait bloqué sans auto-nommage
          // pour toujours, même une fois recomposé.
          const m = s.meals.find((x) => x.id === id);
          if (m) { m.items = []; m.name = ''; m.nameAuto = true; }
        }),
      };
      render(root);
    })
  );

  root.querySelectorAll('[data-dup]').forEach((b) =>
    b.addEventListener('click', (e) => {
      duplicateFrom = e.currentTarget.dataset.dup;
      render(root);
    })
  );

  root.querySelector('[data-optimize]')?.addEventListener('click', () => {
    showSuggestions = !showSuggestions;
    render(root);
  });
  root.querySelector('[data-close-sugg]')?.addEventListener('click', () => {
    showSuggestions = false;
    render(root);
  });

  root.querySelector('[data-dup-cancel]')?.addEventListener('click', () => {
    duplicateFrom = null;
    render(root);
  });
  root.querySelector('[data-dup-backdrop]')?.addEventListener('mousedown', (e) => {
    if (e.target.dataset.dupBackdrop !== undefined) { duplicateFrom = null; render(root); }
  });
  wireActionConfirm(root, { getPending: () => pendingConfirm, setPending: (v) => { pendingConfirm = v; }, render });

  root.querySelector('[data-dup-confirm]')?.addEventListener('click', () => {
    const targets = [...root.querySelectorAll('[data-target]:checked')].map((c) => c.dataset.target);
    const readjust = root.querySelector('[data-dup-adjust]')?.checked;
    if (!targets.length) { toast('Choisis au moins une destination', 'error'); return; }
    update((s) => {
      for (const tid of targets) copyMealTo(s, duplicateFrom, tid, { readjust });
    });
    toast(`Repas dupliqué sur ${targets.length} créneau(x)`);
    duplicateFrom = null;
    render(root);
  });

  root.querySelectorAll('[data-lib-tab]').forEach((b) =>
    b.addEventListener('click', (e) => { libraryTab = e.currentTarget.dataset.libTab; render(root); })
  );
  root.querySelector('[data-lib-q]')?.addEventListener('input', (e) => {
    libraryQuery = e.target.value;
    const row = root.querySelector('.library__row');
    if (row) row.innerHTML = libraryRowHtml(getState());
    wireLibraryDrag(root);
  });

  wireDragAndDrop(root);
}

/** Glisser-déposer : repère les deux sources possibles (repas déjà composé, élément de la bibliothèque) et les créneaux cibles. */
function wireDragAndDrop(root) {
  root.querySelectorAll('[data-drag-meal]').forEach((el) => {
    el.addEventListener('dragstart', (e) => {
      dragPayload = { kind: 'meal', mealId: el.dataset.dragMeal };
      el.classList.add('is-dragging');
      try { e.dataTransfer.effectAllowed = 'copy'; e.dataTransfer.setData('text/plain', el.dataset.dragMeal); } catch { /* environnement sans dataTransfer (tests) */ }
    });
    el.addEventListener('dragend', () => el.classList.remove('is-dragging'));
  });

  wireLibraryDrag(root);

  root.querySelectorAll('[data-drop-meal]').forEach((el) => {
    el.addEventListener('dragover', (e) => {
      if (!dragPayload) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'copy'; } catch { /* no-op */ }
      el.classList.add('is-drop-target');
    });
    el.addEventListener('dragleave', () => el.classList.remove('is-drop-target'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('is-drop-target');
      handleDrop(root, el.dataset.dropMeal);
    });
  });
}

function wireLibraryDrag(root) {
  root.querySelectorAll('[data-drag-lib]').forEach((el) => {
    el.addEventListener('dragstart', (e) => {
      const [kind, id] = el.dataset.dragLib.split(':');
      dragPayload = { kind, id };
      el.classList.add('is-dragging');
      try { e.dataTransfer.effectAllowed = 'copy'; e.dataTransfer.setData('text/plain', id); } catch { /* no-op */ }
    });
    el.addEventListener('dragend', () => el.classList.remove('is-dragging'));
  });
}
