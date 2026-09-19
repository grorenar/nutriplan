/** Écran PLANNING — cycles de courses/batch, sans aucune date réelle. */

import { getState, update, foodsById, ensureCycleMeals, newMeal, recipesById, preparationsById, itemLabel } from '../core/store.js';
import { mealMacros, evaluate, PERSONS, PERSON_LABEL, MEAL_TYPES, autoAdjust } from '../core/nutrition.js';
import { optimizeSuggestions, dayTotals } from '../core/derive.js';
import { dayName, esc, num, toast, uid } from '../core/util.js';
import { openEditor } from './editor.js';

let showSuggestions = false;
let duplicateFrom = null;

export function render(root) {
  const s = getState();
  const byId = foodsById();
  const recipesMap = recipesById();
  const preparationsMap = preparationsById();
  const { startWeekday, duration } = s.settings.cycle;

  const days = [];
  for (let d = 0; d < duration; d++) {
    const meals = ['lunch', 'dinner'].map((type) => s.meals.find((m) => m.dayIndex === d && m.mealType === type));
    days.push(`
      <section class="day">
        <div class="day__head">
          <h2>${esc(dayName(startWeekday, d))}</h2>
          <span class="day__num">Jour ${d + 1}</span>
          <span class="spacer"></span>
          ${PERSONS.map((p) => {
            const t = dayTotals(s, byId, d, p, recipesMap, preparationsMap);
            return `<small class="nums">${PERSON_LABEL[p]} ${num(t.kcal, 0)} kcal · ${num(t.protein, 0)} P</small>`;
          }).join(' ')}
        </div>
        <div class="grid grid--2">
          ${meals.map((m) => mealCard(m, byId, s, recipesMap, preparationsMap)).join('')}
        </div>
      </section>`);
  }

  root.innerHTML = `
    <div class="row" style="margin-bottom:14px">
      <span class="pill pill--accent">Cycle de ${duration} jours — démarrage ${esc(dayName(startWeekday, 0).toLowerCase())}</span>
      <span class="spacer"></span>
      <button class="btn" data-optimize>Optimiser le cycle</button>
    </div>
    ${showSuggestions ? suggestionsPanel(s, byId, recipesMap, preparationsMap) : ''}
    ${days.join('')}
    ${duplicateFrom ? duplicatePanel(s) : ''}
  `;

  wire(root);
}

function mealCard(meal, byId, s, recipesMap, preparationsMap) {
  if (!meal) return '';
  const empty = meal.items.length === 0;
  const ings = meal.items
    .map((it) => itemLabel(it, byId, recipesMap, preparationsMap))
    .slice(0, 6)
    .join(', ');

  const blocks = PERSONS.map((person) => {
    const macros = mealMacros(meal.items, byId, person, recipesMap, preparationsMap);
    const target = s.settings.targets[person][meal.mealType];
    const ev = evaluate(macros, target, s.settings.tolerance);
    const chips = ev.rows
      .map((r) => `<span class="macro is-${r.status}"><b>${num(r.value, r.key === 'kcal' ? 0 : 0)}</b> <span class="goal">${r.label}</span></span>`)
      .join('');
    return `<div class="person-band person-band--${person}" style="margin-bottom:6px">
      <div class="person-name person-name--${person}">${PERSON_LABEL[person]}</div>
      <div class="macros" style="margin-top:3px">${chips}</div>
    </div>`;
  }).join('');

  return `<article class="meal-card ${empty ? 'is-empty' : ''}">
    <div class="meal-card__type">${esc(MEAL_TYPES[meal.mealType])}</div>
    <div class="meal-card__name">${esc(meal.name || (empty ? 'À composer' : 'Sans nom'))}</div>
    ${empty ? '' : `<div class="meal-card__ing">${esc(ings)}${meal.items.length > 6 ? '…' : ''}</div>${blocks}`}
    <div class="meal-card__actions">
      <button class="btn btn--sm btn--primary" data-edit="${meal.id}">${empty ? 'Composer' : 'Modifier'}</button>
      ${empty ? '' : `<button class="btn btn--sm" data-dup="${meal.id}">Dupliquer</button>
      <button class="btn btn--sm btn--danger" data-clear="${meal.id}">Vider</button>`}
    </div>
  </article>`;
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
  const slots = s.meals
    .filter((m) => m.id !== src.id)
    .map(
      (m) => `<label class="check" style="padding:6px 0">
        <input type="checkbox" data-target="${m.id}">
        Jour ${m.dayIndex + 1} — ${esc(MEAL_TYPES[m.mealType])}${m.items.length ? ' (sera remplacé)' : ''}
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

function wire(root) {
  root.querySelectorAll('[data-edit]').forEach((b) =>
    b.addEventListener('click', (e) => openEditor('meal', e.currentTarget.dataset.edit))
  );

  root.querySelectorAll('[data-clear]').forEach((b) =>
    b.addEventListener('click', (e) => {
      const id = e.currentTarget.dataset.clear;
      if (!confirm('Vider ce repas ?')) return;
      update((s) => {
        const m = s.meals.find((x) => x.id === id);
        if (m) { m.items = []; m.name = ''; }
      });
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

  root.querySelector('[data-dup-confirm]')?.addEventListener('click', () => {
    const targets = [...root.querySelectorAll('[data-target]:checked')].map((c) => c.dataset.target);
    const readjust = root.querySelector('[data-dup-adjust]')?.checked;
    if (!targets.length) { toast('Choisis au moins une destination', 'error'); return; }
    update((s) => {
      const src = s.meals.find((m) => m.id === duplicateFrom);
      if (!src) return;
      const byId = Object.fromEntries(s.foods.map((f) => [f.id, f]));
      for (const tid of targets) {
        const dst = s.meals.find((m) => m.id === tid);
        if (!dst) continue;
        dst.name = src.name;
        dst.sameComposition = src.sameComposition;
        dst.items = src.items.map((it) => ({
          ...JSON.parse(JSON.stringify(it)),
          id: uid('it'),
        }));
        if (readjust && s.settings.autoAdjust) {
          autoAdjust(dst.items, byId, {
            thomas: s.settings.targets.thomas[dst.mealType],
            julie: s.settings.targets.julie[dst.mealType],
          });
        }
      }
    });
    toast(`Repas dupliqué sur ${targets.length} créneau(x)`);
    duplicateFrom = null;
    render(root);
  });
}
