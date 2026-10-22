/** Écran PLANNING — cycles de courses/batch, sans aucune date réelle. */

import { getState, update, foodsById, recipesById, preparationsById, itemLabel } from '../core/store.js';
import {
  mealMacros, evaluate, PERSONS, PERSON_LABEL, MEAL_TYPES, MACRO_META, autoAdjust,
} from '../core/nutrition.js';
import { optimizeSuggestions, dayTotals } from '../core/derive.js';
import { dayName, esc, num, toast, uid, debounce } from '../core/util.js';
import { openEditor } from './editor.js';
import { actionConfirmModal, wireActionConfirm } from './confirm-action.js';
import { progressRing } from './charts.js';

let showSuggestions = false;
let duplicateFrom = null;
let pendingConfirm = null; // { title, message, confirmLabel, onConfirm } — P1, remplace confirm() natif

// Bascule discrète des anneaux de synthèse : cycle entier, ou un seul type de
// repas à la fois (retour utilisateur) — un seul réglage partagé par les deux
// cartes Thomas/Julie, jamais une donnée persistée (purement un angle d'affichage).
let summaryScope = 'total'; // 'total' | 'lunch' | 'dinner'
const SUMMARY_SCOPES = [
  { id: 'total', label: 'Total' },
  { id: 'lunch', label: 'Déjeuner' },
  { id: 'dinner', label: 'Dîner' },
];

// Glisser-déposer : la charge utile voyage dans une variable de module plutôt
// que dataTransfer.getData() — plus simple, plus fiable (DataTransfer n'est
// pas disponible partout, notamment en environnement de test) puisque tout se
// passe dans la même page. dataTransfer n'est renseigné que pour les repères
// visuels natifs du navigateur (curseur, image fantôme), jamais lu au drop.
let dragPayload = null; // { mealId }

const DAY_COL_WIDTH = 272;
const DAY_COL_GAP = 16;
let resizeWired = false;

/**
 * Nombre de colonnes de jour affichables sur une ligne sans défilement, vu la
 * largeur réellement disponible (retour utilisateur : plus de défilement
 * horizontal sur ce tableau, cf. .board flex-wrap déjà en place — ceci va
 * plus loin en répartissant les lignes de façon équilibrée).
 */
function colsPerRow(root) {
  const view = root.ownerDocument?.defaultView;
  if (!view) return 1; // environnement sans layout réel (tests) : une colonne par ligne, sans effet sur le contenu
  const cs = view.getComputedStyle(root);
  const avail = root.clientWidth - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0);
  return Math.max(1, Math.floor((avail + DAY_COL_GAP) / (DAY_COL_WIDTH + DAY_COL_GAP)));
}

/**
 * Répartit `n` éléments sur le nombre de lignes minimal, le plus
 * équitablement possible (jamais une ligne pleine suivie d'un reliquat isolé :
 * 6 tuiles pour 5 affichables par ligne -> 3 + 3, jamais 5 + 1).
 */
function balancedRowSizes(n, perRow) {
  if (n <= 0) return [];
  const rows = Math.max(1, Math.ceil(n / perRow));
  const base = Math.floor(n / rows);
  const extra = n % rows;
  return Array.from({ length: rows }, (_, i) => base + (i < extra ? 1 : 0));
}

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

  const sizes = balancedRowSizes(cols.length, colsPerRow(root));
  const rowsHtml = [];
  let i = 0;
  for (const size of sizes) {
    rowsHtml.push(`<div class="board__row">${cols.slice(i, i + size).join('')}</div>`);
    i += size;
  }

  root.innerHTML = `
    <div class="summary-scope">
      ${SUMMARY_SCOPES.map((o) => `<button class="chip chip--xs" data-scope="${o.id}" aria-pressed="${summaryScope === o.id}">${esc(o.label)}</button>`).join('')}
    </div>
    <div class="day-summary">${PERSONS.map((p) => cycleSummaryCard(p, s, byId, recipesMap, preparationsMap, summaryScope)).join('')}</div>

    <div class="row" style="margin-bottom:14px">
      <span class="pill pill--accent">Cycle de ${duration} jours — démarrage ${esc(dayName(startWeekday, 0).toLowerCase())}</span>
      <span class="spacer"></span>
      <button class="btn" data-optimize>✨ Suggestions du cycle</button>
    </div>
    ${showSuggestions ? suggestionsPanel(s, byId, recipesMap, preparationsMap) : ''}

    <div class="board">${rowsHtml.join('')}</div>

    ${duplicateFrom ? duplicatePanel(s) : ''}
    ${pendingConfirm ? actionConfirmModal(pendingConfirm) : ''}
  `;

  wire(root);

  // Recalcule la répartition par ligne au redimensionnement (jamais pour une
  // autre vue : root n'a alors plus de .board, le re-rendu est un no-op sans
  // effet visible — évité en vérifiant sa présence avant de relancer render()).
  if (!resizeWired) {
    resizeWired = true;
    window.addEventListener('resize', debounce(() => {
      if (root.isConnected && root.querySelector('.board')) render(root);
    }, 200));
  }
}

/**
 * Carte de synthèse par personne, en haut de l'écran — portée par défaut
 * fixée au cycle entier (somme de tous les jours vs somme de tous les
 * objectifs), jamais à "aujourd'hui" : ce planificateur n'a aucune date
 * réelle (cf. en-tête de ce fichier), donc aucune notion de jour courant à
 * mettre en avant sans l'inventer. "Sur l'ensemble du cycle" reste un
 * agrégat honnête et toujours défini, quelle que soit la durée du cycle.
 * `scope` (bascule discrète, retour utilisateur) restreint la somme à un
 * seul type de repas (déjeuner/dîner) au lieu des deux — jamais à UN jour en
 * particulier, pour la même raison (aucune date réelle à privilégier).
 */
function cycleSummaryCard(person, s, byId, recipesMap, preparationsMap, scope) {
  const { duration } = s.settings.cycle;
  const types = scope === 'total' ? ['lunch', 'dinner'] : [scope];
  const total = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  const target = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  for (let d = 0; d < duration; d++) {
    for (const type of types) {
      const meal = s.meals.find((m) => m.dayIndex === d && m.mealType === type);
      if (meal) {
        const macros = mealMacros(meal.items, byId, person, recipesMap, preparationsMap);
        total.kcal += macros.kcal; total.protein += macros.protein; total.carbs += macros.carbs; total.fat += macros.fat;
      }
      const t = s.settings.targets[person][type];
      if (t) {
        target.kcal += t.kcal || 0; target.protein += t.protein || 0; target.carbs += t.carbs || 0; target.fat += t.fat || 0;
      }
    }
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
  const scopeLabel = SUMMARY_SCOPES.find((o) => o.id === scope)?.label || 'Total';
  return `<div class="day-summary__card">
    <div class="day-summary__head person-name person-name--${person}">${PERSON_LABEL[person]} <span class="tag" style="font-weight:500">· ${scope === 'total' ? "sur l'ensemble du cycle" : `${esc(scopeLabel)}, sur l'ensemble du cycle`}</span></div>
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

  return `<div class="meal-slot" data-slot="${meal.id}" data-drop-meal="${meal.id}" draggable="true" data-drag-meal="${meal.id}" title="Glisser vers un autre créneau" aria-label="Repas : ${esc(meal.name || 'Sans nom')}. Glisser vers un autre créneau, ou utiliser les boutons">
    <div class="meal-slot__dropzone">Déposer ici</div>
    <span class="meal-slot__drag-handle" aria-hidden="true">⠿</span>
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

/** Dépose la charge `dragPayload` courante sur le créneau `dstId`, avec confirmation si celui-ci n'est pas vide. */
function handleDrop(root, dstId) {
  const payload = dragPayload;
  dragPayload = null;
  if (!payload) return;
  const s0 = getState();
  const dst = s0.meals.find((m) => m.id === dstId);
  if (!dst) return;
  if (payload.mealId === dstId) return; // dépose sur soi-même : rien à faire

  const apply = () => {
    update((s) => { copyMealTo(s, payload.mealId, dstId, { readjust: true }); });
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

  root.querySelectorAll('[data-scope]').forEach((b) =>
    b.addEventListener('click', (e) => { summaryScope = e.currentTarget.dataset.scope; render(root); })
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

  wireDragAndDrop(root);
}

/** Glisser-déposer : un repas déjà composé peut être tiré vers un autre créneau. */
function wireDragAndDrop(root) {
  // La carte ENTIÈRE est draggable (retour utilisateur — même principe déjà
  // appliqué aux tuiles d'aliment du composeur : glisser depuis n'importe où
  // sur la carte, pas seulement une petite poignée ⠿, gardée en pure
  // décoration dans le markup). Sûr ici UNIQUEMENT parce que dragstart
  // écarte explicitement ses propres sous-éléments interactifs (bouton
  // « Modifier », menu « ⋯ » et son contenu) : partir d'un clic sur l'un
  // d'eux annule le glisser (e.preventDefault()) et laisse le clic normal
  // suivre son cours — exactement le bug déjà rencontré et évité ici, plutôt
  // que contourné en gardant une poignée dédiée comme avant.
  root.querySelectorAll('[data-drag-meal]').forEach((card) => {
    card.addEventListener('dragstart', (e) => {
      if (e.target.closest('button, details, summary')) { e.preventDefault(); return; }
      dragPayload = { mealId: card.dataset.dragMeal };
      card.classList.add('is-dragging');
      try {
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('text/plain', card.dataset.dragMeal);
        e.dataTransfer.setDragImage(card, 24, 24);
      } catch { /* environnement sans dataTransfer (tests) */ }
    });
    card.addEventListener('dragend', () => card.classList.remove('is-dragging'));
  });

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
