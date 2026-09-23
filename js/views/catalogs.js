/**
 * Écrans PETITS-DÉJEUNERS et COLLATIONS.
 *
 * Ce sont des CATALOGUES, jamais des repas datés : on déclare simplement
 * combien de fois chaque option est utilisée dans le cycle, par personne
 * (et, pour les collations, à 16 h ou le soir). La couverture du cycle est
 * comparée au nombre théorique (un par jour et par personne) — de manière
 * purement informative : rien n'est choisi ni corrigé automatiquement.
 */

import { getState, update, foodsById, catalogKey, newOption, recipesById, preparationsById, itemLabel } from '../core/store.js';
import { mealMacros, evaluate, PERSONS, PERSON_LABEL, MEAL_TYPES } from '../core/nutrition.js';
import { coverageReport, optionUses } from '../core/derive.js';
import { esc, num, uid } from '../core/util.js';
import { openEditor } from './editor.js';

export function renderBreakfasts(root) {
  const s = getState();
  const byId = foodsById();
  const recipesMap = recipesById();
  const preparationsMap = preparationsById();
  const report = coverageReport(s);

  root.innerHTML = `
    ${coverageCard([report.breakfast], s)}
    <div class="row" style="margin:14px 0 10px">
      <span class="pill pill--accent">${esc(MEAL_TYPES.breakfast)}</span>
      <small>Cible Thomas ${num(s.settings.targets.thomas.breakfast.kcal, 0)} kcal · Julie ${num(s.settings.targets.julie.breakfast.kcal, 0)} kcal</small>
      <span class="spacer"></span>
      <button class="btn btn--primary" data-new>Nouvelle option</button>
    </div>
    ${
      s.breakfasts.length
        ? `<div class="grid grid--2">${s.breakfasts.map((o) => optionCard(o, 'breakfast', byId, s, recipesMap, preparationsMap)).join('')}</div>`
        : `<div class="empty">Aucun petit-déjeuner enregistré. Crée une composition : elle sera réutilisable sans être liée à un jour.</div>`
    }`;

  wire(root, 'breakfast', renderBreakfasts);
}

export function renderSnacks(root) {
  const s = getState();
  const byId = foodsById();
  const recipesMap = recipesById();
  const preparationsMap = preparationsById();
  const report = coverageReport(s);

  root.innerHTML = `
    ${coverageCard([report.snack_afternoon, report.snack_evening], s)}
    <div class="row" style="margin:14px 0 10px">
      <span class="pill pill--accent">Collations</span>
      <small>Une collation a une composition unique : 16 h et Soir ne sont que des affectations dans le cycle.</small>
      <span class="spacer"></span>
      <button class="btn btn--primary" data-new>Nouvelle option</button>
    </div>
    ${
      s.snacks.length
        ? `<div class="grid grid--2">${s.snacks.map((o) => optionCard(o, 'snack', byId, s, recipesMap, preparationsMap)).join('')}</div>`
        : `<div class="empty">Aucune collation enregistrée.</div>`
    }`;

  wire(root, 'snack', renderSnacks);
}

/* ------------------------------------------------------------------ */
/* Couverture du cycle                                                 */
/* ------------------------------------------------------------------ */

const MARK = { ok: '✓', missing: '⚠️', extra: 'ℹ️' };

function coverageCard(slots, s) {
  const header = slots.length > 1
    ? `<tr><th></th>${slots.map((sl) => `<th>${sl.slot === 'evening' ? 'Soir' : '16 h'}</th>`).join('')}</tr>`
    : '';

  const rows = PERSONS.map(
    (p) => `<tr>
      <td class="person-name person-name--${p}">${PERSON_LABEL[p]}</td>
      ${slots
        .map((sl) => {
          const r = sl.persons[p];
          return `<td class="nums"><span class="pill pill--${r.status === 'ok' ? 'ok' : r.status === 'missing' ? 'off' : 'accent'}">
            ${r.used} / ${r.needed} ${MARK[r.status]}</span></td>`;
        })
        .join('')}
    </tr>`
  ).join('');

  const messages = [];
  for (const sl of slots) {
    for (const p of PERSONS) {
      const r = sl.persons[p];
      if (r.status === 'missing') {
        messages.push(
          `<div class="sync-error">⚠️ ${PERSON_LABEL[p]} — ${esc(sl.label.toLowerCase())} : ${r.used} / ${r.needed}. Il manque ${-r.delta} ${
            -r.delta > 1 ? 'options' : 'option'
          }.</div>`
        );
      } else if (r.status === 'extra') {
        messages.push(
          `<div class="muted">ℹ️ ${PERSON_LABEL[p]} — ${esc(sl.label.toLowerCase())} : ${r.used} / ${r.needed}. ${r.delta} ${
            r.delta > 1 ? 'options supplémentaires sont planifiées' : 'option supplémentaire est planifiée'
          }.</div>`
        );
      }
    }
  }

  const incomplete = slots.some((sl) => PERSONS.some((p) => sl.persons[p].status === 'missing'));

  return `<div class="card">
    <div class="card__head">
      <h2>Couverture du cycle</h2>
      <span class="tag">${s.settings.cycle.duration} jours — ${s.settings.cycle.duration} par personne</span>
    </div>
    <table style="max-width:420px">${header}<tbody>${rows}</tbody></table>
    ${messages.length ? `<div style="margin-top:10px;display:flex;flex-direction:column;gap:4px">${messages.join('')}</div>` : ''}
    ${
      incomplete
        ? `<div class="row" style="margin-top:10px">
             <small>Le cycle reste utilisable : l’avertissement reste affiché, rien n’est complété automatiquement.</small>
           </div>`
        : ''
    }
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Cartes d'option                                                     */
/* ------------------------------------------------------------------ */

function stepper(optionId, person, slot, value) {
  const attr = `data-uses="${optionId}" data-person="${person}"${slot ? ` data-slot="${slot}"` : ''}`;
  return `<span class="row row--tight" style="display:inline-flex">
    <button class="btn btn--sm" ${attr} data-delta="-1" aria-label="Retirer une utilisation">−</button>
    <strong class="nums" style="min-width:18px;text-align:center">${value}</strong>
    <button class="btn btn--sm" ${attr} data-delta="1" aria-label="Ajouter une utilisation">+</button>
  </span>`;
}

function usesBlock(opt, kind) {
  if (kind === 'breakfast') {
    return `<div class="items" style="gap:4px;margin:8px 0 2px">
      ${PERSONS.map(
        (p) => `<div class="row row--tight">
          <span class="person-name person-name--${p}" style="min-width:58px">${PERSON_LABEL[p]}</span>
          ${stepper(opt.id, p, null, Number(opt.uses?.[p]) || 0)}
        </div>`
      ).join('')}
    </div>`;
  }
  return `<table style="margin:8px 0 2px">
    <thead><tr><th></th><th>16 h</th><th>Soir</th></tr></thead>
    <tbody>
      ${PERSONS.map(
        (p) => `<tr>
          <td class="person-name person-name--${p}">${PERSON_LABEL[p]}</td>
          <td>${stepper(opt.id, p, 'afternoon', Number(opt.uses?.[p]?.afternoon) || 0)}</td>
          <td>${stepper(opt.id, p, 'evening', Number(opt.uses?.[p]?.evening) || 0)}</td>
        </tr>`
      ).join('')}
    </tbody>
  </table>`;
}

function optionCard(opt, kind, byId, s, recipesMap = {}, preparationsMap = {}) {
  const ings = opt.items.map((it) => itemLabel(it, byId, recipesMap, preparationsMap)).join(', ');
  const targetType = kind === 'breakfast' ? 'breakfast' : opt.targetSlot === 'evening' ? 'snack_evening' : 'snack_afternoon';

  const blocks = PERSONS.map((person) => {
    const macros = mealMacros(opt.items, byId, person, recipesMap, preparationsMap);
    const ev = evaluate(macros, s.settings.targets[person][targetType], s.settings.tolerance);
    const chips = ev.rows
      .map((r) => `<span class="macro is-${r.status}"><b>${num(r.value, 0)}</b> <span class="goal">${r.label}</span></span>`)
      .join('');
    return `<div class="person-band person-band--${person}" style="margin-bottom:6px">
      <div class="person-name person-name--${person}">${PERSON_LABEL[person]}</div>
      <div class="macros" style="margin-top:3px">${chips}</div>
    </div>`;
  }).join('');

  const total = optionUses(opt, kind);

  return `<article class="meal-card ${opt.items.length ? '' : 'is-empty'}">
    <div class="meal-card__name">${esc(opt.name || 'Sans nom')}</div>
    <div class="meal-card__ing">${esc(ings || 'Aucun ingrédient')}</div>
    ${opt.items.length ? blocks : ''}
    ${
      kind === 'snack'
        ? `<div class="row row--tight" style="margin-top:6px">
             <small>Objectif de référence :</small>
             <button class="chip" data-target-slot="${opt.id}" data-slot="afternoon" aria-pressed="${opt.targetSlot !== 'evening'}">16 h</button>
             <button class="chip" data-target-slot="${opt.id}" data-slot="evening" aria-pressed="${opt.targetSlot === 'evening'}">Soir</button>
           </div>`
        : ''
    }
    <div class="tag" style="margin-top:8px">Utilisations dans ce cycle</div>
    ${usesBlock(opt, kind)}
    <small>${
      total.thomas + total.julie
        ? `Total : Thomas ${total.thomas} · Julie ${total.julie} → comptée dans les courses`
        : 'Non utilisée dans ce cycle → hors courses'
    }</small>
    <div class="meal-card__actions">
      <button class="btn btn--sm btn--primary" data-edit="${opt.id}">Modifier</button>
      <button class="btn btn--sm" data-dup="${opt.id}">Dupliquer</button>
      <button class="btn btn--sm btn--danger" data-del="${opt.id}">Supprimer</button>
    </div>
  </article>`;
}

/* ------------------------------------------------------------------ */

function wire(root, kind, rerender) {
  const key = catalogKey(kind);

  root.querySelector('[data-new]')?.addEventListener('click', () => {
    const opt = newOption('', kind);
    update((st) => { st[key].push(opt); });
    openEditor(kind, opt.id);
  });

  root.querySelectorAll('[data-edit]').forEach((b) =>
    b.addEventListener('click', (e) => openEditor(kind, e.currentTarget.dataset.edit))
  );

  root.querySelectorAll('[data-uses]').forEach((b) =>
    b.addEventListener('click', (e) => {
      const { uses: id, person, slot, delta } = e.currentTarget.dataset;
      update((st) => {
        const o = st[key].find((x) => x.id === id);
        if (!o) return;
        if (slot) o.uses[person][slot] = Math.max(0, (Number(o.uses[person][slot]) || 0) + Number(delta));
        else o.uses[person] = Math.max(0, (Number(o.uses[person]) || 0) + Number(delta));
      });
    })
  );

  root.querySelectorAll('[data-target-slot]').forEach((b) =>
    b.addEventListener('click', (e) => {
      const id = e.currentTarget.dataset.targetSlot;
      const slot = e.currentTarget.dataset.slot;
      update((st) => {
        const o = st[key].find((x) => x.id === id);
        if (o) o.targetSlot = slot;
      });
    })
  );

  root.querySelectorAll('[data-dup]').forEach((b) =>
    b.addEventListener('click', (e) => {
      const id = e.currentTarget.dataset.dup;
      update((st) => {
        const src = st[key].find((o) => o.id === id);
        if (!src) return;
        st[key].push({
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
      update((st) => { st[key] = st[key].filter((o) => o.id !== id); });
    })
  );
}
