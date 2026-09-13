/** Écran BATCH COOKING — composants agrégés par session, jamais de recettes. */

import { getState, update, foodsById } from '../core/store.js';
import { buildBatchPlan } from '../core/derive.js';
import { dayName, esc, grams, num, toast } from '../core/util.js';
import { MEAL_TYPES } from '../core/nutrition.js';

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
      <small>Une session ne couvre que les jours qu'elle peut légitimement couvrir.</small>
    </div>
    ${plan.map((sess) => sessionCard(sess, startWeekday)).join('')}
    <small>Modifier une quantité préparée ne modifie jamais le planning : seuls le surplus et la couverture sont recalculés.</small>
  `;
  wire(root);
}

function sessionCard(sess, startWeekday) {
  const range =
    sess.startDay === sess.endDay
      ? `jour ${sess.startDay + 1}`
      : `jours ${sess.startDay + 1} à ${sess.endDay + 1}`;
  const days = `${dayName(startWeekday, sess.startDay)} → ${dayName(startWeekday, sess.endDay)}`;

  const rows = sess.components.length
    ? sess.components
        .map((c) => {
          const surplus = c.preparedRaw - c.requiredRaw;
          const coverage = c.requiredRaw > 0 ? (c.preparedRaw / c.requiredRaw) * 100 : 100;
          return `<tr>
            <td>
              <strong>${esc(c.food.name)}</strong>
              ${c.note ? `<div class="tag">${esc(c.note)}</div>` : ''}
            </td>
            <td class="nums">${c.needsCooking ? `${grams(c.requiredCooked)} cuits` : grams(c.requiredRaw)}</td>
            <td class="nums">${c.needsCooking ? `${grams(c.requiredRaw)} crus` : grams(c.requiredRaw)}</td>
            <td><input type="number" step="10" min="0" value="${num(c.preparedRaw, 0).replace(',', '.')}"
                   data-prep="${c.key}" style="width:110px" aria-label="Quantité préparée"> g</td>
            <td class="nums ${surplus < -1 ? 'muted' : ''}">${surplus >= 0 ? `+ ${grams(surplus)}` : `manque ${grams(-surplus)}`}</td>
            <td class="nums">${num(coverage, 0)} %</td>
          </tr>`;
        })
        .join('')
    : `<tr><td colspan="6" class="muted">Aucun composant batchable sur cette session.</td></tr>`;

  const sameDay = sess.sameDay.length
    ? `<h3 style="margin-top:14px">À cuisiner le jour même</h3>
       <ul style="margin:6px 0 0;padding-left:18px">
         ${sess.sameDay
           .map(
             (x) =>
               `<li>Jour ${x.dayIndex + 1} — ${esc(MEAL_TYPES[x.mealType])} : ${esc(x.food.name)}, ${grams(x.grams)} (non batchable)</li>`
           )
           .join('')}
       </ul>`
    : '';

  return `<div class="card">
    <div class="card__head">
      <h2>Session ${sess.index + 1}</h2>
      <span class="tag">${esc(range)} · ${esc(days)}</span>
    </div>
    <table>
      <thead><tr><th>Composant</th><th>Besoin</th><th>À préparer</th><th>Je prépare</th><th>Surplus</th><th>Couverture</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${sameDay}
  </div>`;
}

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
