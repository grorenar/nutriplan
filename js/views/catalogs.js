/** Écrans PETITS-DÉJEUNERS et COLLATIONS — catalogues indépendants du planning. */

import { getState, update, foodsById, catalogKey, newOption } from '../core/store.js';
import { mealMacros, evaluate, PERSONS, PERSON_LABEL, MEAL_TYPES } from '../core/nutrition.js';
import { esc, num, uid } from '../core/util.js';
import { openEditor } from './editor.js';

let snackKind = 'snack_afternoon';

export function renderBreakfasts(root) {
  renderCatalog(root, 'breakfast');
}

export function renderSnacks(root) {
  const s = getState();
  root.innerHTML = `
    <div class="chips" style="margin-bottom:14px">
      <button class="chip" data-kind="snack_afternoon" aria-pressed="${snackKind === 'snack_afternoon'}">Collations 16 h</button>
      <button class="chip" data-kind="snack_evening" aria-pressed="${snackKind === 'snack_evening'}">Collations du soir</button>
    </div>
    <div data-catalog></div>`;
  root.querySelectorAll('[data-kind]').forEach((b) =>
    b.addEventListener('click', (e) => { snackKind = e.currentTarget.dataset.kind; renderSnacks(root); })
  );
  renderCatalog(root.querySelector('[data-catalog]'), snackKind);
}

function renderCatalog(root, kind) {
  const s = getState();
  const byId = foodsById();
  const list = s[catalogKey(kind)] || [];
  const t = { thomas: s.settings.targets.thomas[kind], julie: s.settings.targets.julie[kind] };

  root.innerHTML = `
    <div class="row" style="margin-bottom:12px">
      <span class="pill pill--accent">${esc(MEAL_TYPES[kind])}</span>
      <small>Cible Thomas ${num(t.thomas.kcal, 0)} kcal · Julie ${num(t.julie.kcal, 0)} kcal</small>
      <span class="spacer"></span>
      <button class="btn btn--primary" data-new>Nouvelle option</button>
    </div>
    ${
      list.length
        ? `<div class="grid grid--2">${list.map((o) => card(o, byId, s, kind)).join('')}</div>`
        : `<div class="empty">Aucune option enregistrée. Crée une première composition : elle sera réutilisable sans être liée à un jour.</div>`
    }`;

  root.querySelector('[data-new]')?.addEventListener('click', () => {
    const opt = newOption('');
    update((st) => { st[catalogKey(kind)].push(opt); });
    openEditor(kind, opt.id);
  });

  root.querySelectorAll('[data-edit]').forEach((b) =>
    b.addEventListener('click', (e) => openEditor(kind, e.currentTarget.dataset.edit))
  );
  root.querySelectorAll('[data-dup]').forEach((b) =>
    b.addEventListener('click', (e) => {
      const id = e.currentTarget.dataset.dup;
      update((st) => {
        const src = st[catalogKey(kind)].find((o) => o.id === id);
        if (!src) return;
        st[catalogKey(kind)].push({
          ...JSON.parse(JSON.stringify(src)),
          id: uid('opt'),
          name: `${src.name || 'Option'} (copie)`,
          items: src.items.map((it) => ({ ...JSON.parse(JSON.stringify(it)), id: uid('it') })),
        });
      });
    })
  );
  root.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', (e) => {
      const id = e.currentTarget.dataset.del;
      if (!confirm('Supprimer cette option ?')) return;
      update((st) => { st[catalogKey(kind)] = st[catalogKey(kind)].filter((o) => o.id !== id); });
    })
  );
}

function card(opt, byId, s, kind) {
  const ings = opt.items.map((it) => (it.foodId ? byId[it.foodId]?.name || '?' : it.free.name)).join(', ');
  const blocks = PERSONS.map((person) => {
    const macros = mealMacros(opt.items, byId, person);
    const ev = evaluate(macros, s.settings.targets[person][kind], s.settings.tolerance);
    const chips = ev.rows
      .map((r) => `<span class="macro is-${r.status}"><b>${num(r.value, 0)}</b> <span class="goal">${r.label}</span></span>`)
      .join('');
    return `<div class="person-band person-band--${person}" style="margin-bottom:6px">
      <div class="person-name person-name--${person}">${PERSON_LABEL[person]}</div>
      <div class="macros" style="margin-top:3px">${chips}</div>
    </div>`;
  }).join('');

  return `<article class="meal-card ${opt.items.length ? '' : 'is-empty'}">
    <div class="meal-card__name">${esc(opt.name || 'Sans nom')}</div>
    <div class="meal-card__ing">${esc(ings || 'Aucun ingrédient')}</div>
    ${opt.items.length ? blocks : ''}
    <div class="meal-card__actions">
      <button class="btn btn--sm btn--primary" data-edit="${opt.id}">Modifier</button>
      <button class="btn btn--sm" data-dup="${opt.id}">Dupliquer</button>
      <button class="btn btn--sm btn--danger" data-del="${opt.id}">Supprimer</button>
    </div>
  </article>`;
}
