/**
 * Écran BATCH COOKING — plan opératoire déduit du planning.
 * Trois catégories : à préparer en batch, à cuire le jour même, à assembler le jour même.
 * Cet écran ne modifie jamais le planning.
 */

import { getState, update, foodsById } from '../core/store.js';
import { buildBatchPlan, BATCH_CATEGORY_LABEL } from '../core/derive.js';
import { dayName, esc, grams, num, toast } from '../core/util.js';
import { MEAL_TYPES, PERSONS, PERSON_LABEL } from '../core/nutrition.js';

export function render(root) {
  const s = getState();
  if (!s.settings.batch.enabled) {
    root.innerHTML = `<div class="empty">Le batch cooking est désactivé dans les paramètres.</div>`;
    return;
  }
  const byId = foodsById();
  const plan = buildBatchPlan(s, byId);
  const startWeekday = s.settings.cycle.startWeekday;

  root.innerHTML = `
    <div class="row" style="margin-bottom:12px">
      <span class="pill pill--accent">Conservation : ${s.settings.batch.maxDays} jours par session</span>
      <small>Le plan est une conséquence du planning : le modifier ici ne change jamais les repas.</small>
    </div>
    ${plan.map((sess) => sessionCard(sess, startWeekday)).join('')}
  `;
  wire(root);
}

const slot = (startWeekday, dayIndex, mealType) =>
  `${dayName(startWeekday, dayIndex).toLowerCase()} ${mealType === 'lunch' ? 'midi' : 'soir'}`;

function sessionCard(sess, startWeekday) {
  const range = sess.startDay === sess.endDay ? `jour ${sess.startDay + 1}` : `jours ${sess.startDay + 1} à ${sess.endDay + 1}`;
  const days = `${dayName(startWeekday, sess.startDay)} → ${dayName(startWeekday, sess.endDay)}`;

  const covered = sess.gamelles.length
    ? `<p>Préparer les gamelles de : ${sess.gamelles
        .map((g) => `<strong>${esc(slot(startWeekday, g.dayIndex, g.mealType))}</strong>`)
        .join(', ')}.</p>`
    : '<p class="muted">Aucun repas planifié sur cette session.</p>';

  return `<div class="card">
    <div class="card__head">
      <h2>Session ${sess.index + 1}</h2>
      <span class="tag">${esc(range)} · ${esc(days)}</span>
    </div>
    ${covered}
    ${componentsBlock(sess)}
    ${sameDayBlock('cook', sess.cookSameDay, startWeekday)}
    ${sameDayBlock('assemble', sess.assembleSameDay, startWeekday)}
    ${gamellesBlock(sess, startWeekday)}
  </div>`;
}

/* ---------------------------------------------------- A — à préparer en batch */

function componentsBlock(sess) {
  if (!sess.components.length) {
    return `<h3>${BATCH_CATEGORY_LABEL.batch}</h3><p class="muted">Aucun composant batchable sur cette session.</p>`;
  }
  const rows = sess.components
    .map((c) => {
      const surplus = c.preparedRaw - c.requiredRaw;
      const coverage = c.requiredRaw > 0 ? (c.preparedRaw / c.requiredRaw) * 100 : 100;
      const method = [
        c.method ? `méthode : ${esc(c.method)}` : null,
        c.temperature ? `${num(c.temperature, 0)} °C` : null,
        c.duration ? `${num(c.duration, 0)} min` : null,
        c.prepTime ? `préparation ${num(c.prepTime, 0)} min` : null,
        c.equipment ? esc(c.equipment) : null,
      ].filter(Boolean).join(' · ');
      return `<tr>
        <td>
          <strong>${esc(c.food.name)}</strong>
          ${method ? `<div class="tag">${method}</div>` : '<div class="tag muted">aucune consigne de cuisson définie dans la fiche aliment</div>'}
          ${c.note ? `<div class="tag">${esc(c.note)}</div>` : ''}
        </td>
        <td class="nums">
          ${c.needsCooking ? `${grams(c.requiredRaw)} crus` : grams(c.requiredRaw)}
          ${c.needsCooking ? `<div class="tag">rendement ${num(c.yieldPct, 0)} %</div>` : ''}
        </td>
        <td class="nums">${grams(c.requiredCooked)}${c.needsCooking ? ' cuits' : ''}</td>
        <td><input type="number" step="10" min="0" value="${num(c.preparedRaw, 0).replace(',', '.')}"
               data-prep="${c.key}" style="width:104px" aria-label="Quantité préparée"> g</td>
        <td class="nums">${grams(c.preparedCooked)}</td>
        <td class="nums">${surplus >= 0 ? `+ ${grams(surplus)}` : `manque ${grams(-surplus)}`}<div class="tag">${num(coverage, 0)} %</div></td>
      </tr>`;
    })
    .join('');

  return `<h3>${BATCH_CATEGORY_LABEL.batch}</h3>
    <table>
      <thead><tr>
        <th>Composant et méthode</th><th>À sortir</th><th>Quantité cuite nécessaire</th>
        <th>Je prépare</th><th>Cuit attendu</th><th>Surplus</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/* ------------------------------------- B et C — le jour même */

function sameDayBlock(kind, rows, startWeekday) {
  const label = BATCH_CATEGORY_LABEL[kind];
  if (!rows.length) return `<h3>${label}</h3><p class="muted">Rien dans cette catégorie sur cette session.</p>`;
  const byMeal = {};
  for (const r of rows) {
    const key = `${r.dayIndex}:${r.mealType}`;
    (byMeal[key] ||= { dayIndex: r.dayIndex, mealType: r.mealType, items: [] }).items.push(r);
  }
  return `<h3>${label}</h3>
    <ul style="margin:4px 0 10px;padding-left:18px">
      ${Object.values(byMeal)
        .sort((a, b) => a.dayIndex - b.dayIndex || (a.mealType === 'lunch' ? -1 : 1))
        .map(
          (m) => `<li><strong>${esc(slot(startWeekday, m.dayIndex, m.mealType))}</strong> — ${m.items
            .map((r) => `${esc(r.food.name)} ${grams(r.grams)}${r.summary ? ` (${esc(r.summary)})` : ''}`)
            .join(', ')}</li>`
        )
        .join('')}
    </ul>`;
}

/* ------------------------------------- détail des gamelles */

function gamellesBlock(sess, startWeekday) {
  const filled = sess.gamelles.filter((g) => PERSONS.some((p) => g.persons[p].length));
  if (!filled.length) return '';
  return `<h3>Détail des gamelles</h3>
    <div class="grid grid--2">
      ${filled
        .map(
          (g) => `<div class="meal-card">
          <div class="meal-card__type">${esc(MEAL_TYPES[g.mealType])} — ${esc(slot(startWeekday, g.dayIndex, g.mealType))}</div>
          <div class="meal-card__name">${esc(g.name || 'Sans nom')}</div>
          ${PERSONS.map(
            (p) => `<div class="person-band person-band--${p}" style="margin-bottom:6px">
              <div class="person-name person-name--${p}">${PERSON_LABEL[p]}</div>
              <ul style="margin:2px 0 0;padding-left:16px">
                ${g.persons[p]
                  .map((e) =>
                    e.free
                      ? `<li>${esc(e.name)} — ${esc(e.quantity || 'au goût')}</li>`
                      : `<li>${grams(e.grams)} ${esc(e.name)}${e.cooked ? ' cuit' : ''} <span class="tag">${esc(shortCat(e.category))}</span></li>`
                  )
                  .join('') || '<li class="muted">rien</li>'}
              </ul>
            </div>`
          ).join('')}
        </div>`
        )
        .join('')}
    </div>`;
}

const shortCat = (category) =>
  ({ batch: 'batch', cook: 'cuisson du jour', assemble: 'assemblage', free: 'libre' }[category] || '');

function wire(root) {
  root.querySelectorAll('[data-prep]').forEach((input) =>
    input.addEventListener('change', (e) => {
      const key = e.target.dataset.prep;
      const value = Math.max(0, Number(e.target.value) || 0);
      update((s) => { s.batch.overrides[key] = value; });
      toast('Quantité préparée mise à jour');
    })
  );
}
