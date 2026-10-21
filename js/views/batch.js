/**
 * Écran BATCH COOKING — plan opératoire déduit du planning.
 * Trois catégories : à préparer en batch, à cuire le jour même, à assembler le jour même.
 * Cet écran ne modifie jamais le planning.
 */

import { getState, update, foodsById, recipesById, preparationsById } from '../core/store.js';
import { buildBatchPlan, BATCH_CATEGORY_LABEL, YIELD_DEVIATION_THRESHOLD_PCT } from '../core/derive.js';
import { dayName, esc, grams, num, toast } from '../core/util.js';
import { MEAL_TYPES, PERSONS, PERSON_LABEL } from '../core/nutrition.js';
import { actionConfirmModal, wireActionConfirm } from './confirm-action.js';

let pendingConfirm = null; // { title, message, onConfirm } — ajustement du rendement enregistré d'un aliment

export function render(root) {
  const s = getState();
  if (!s.settings.batch.enabled) {
    root.innerHTML = `<div class="empty">Le batch cooking est désactivé dans les paramètres.</div>`;
    return;
  }
  const byId = foodsById();
  const plan = buildBatchPlan(s, byId, recipesById(), preparationsById());
  const startWeekday = s.settings.cycle.startWeekday;

  const totalGamelles = plan.reduce((n, sess) => n + sess.gamelles.filter((g) => PERSONS.some((p) => g.persons[p].length)).length, 0);
  const totalComponents = plan.reduce((n, sess) => n + sess.components.length + (sess.recipesToPrepare?.length || 0), 0);

  root.innerHTML = `
    <div class="stat-grid" style="margin-bottom:16px">
      <div class="stat-card">
        <div class="stat-card__top"><span class="stat-card__icon">🗓️</span><span class="stat-card__label">Sessions</span></div>
        <span class="stat-card__value">${plan.length}</span>
      </div>
      <div class="stat-card">
        <div class="stat-card__top"><span class="stat-card__icon">🍱</span><span class="stat-card__label">Gamelles couvertes</span></div>
        <span class="stat-card__value">${totalGamelles}</span>
      </div>
      <div class="stat-card">
        <div class="stat-card__top"><span class="stat-card__icon">🧺</span><span class="stat-card__label">Composants à préparer</span></div>
        <span class="stat-card__value">${totalComponents}</span>
      </div>
      <div class="stat-card stat-card--accent">
        <div class="stat-card__top"><span class="stat-card__icon">📦</span><span class="stat-card__label">Conservation</span></div>
        <span class="stat-card__value">${s.settings.batch.maxDays}<small> jours / session</small></span>
      </div>
    </div>
    ${plan.map((sess) => sessionCard(sess, startWeekday)).join('')}
    ${pendingConfirm ? actionConfirmModal(pendingConfirm) : ''}
  `;
  wire(root);
}

/**
 * En-tête d'étape numéroté (parcours réel préparation → cuisson → assemblage
 * → résultat, cf. design system) — purement visuel, aucun effet sur le
 * contenu ni l'ordre des blocs, qui reste celui déjà calculé par
 * buildBatchPlan() (derive.js).
 */
const stepHead = (n, title, icon) =>
  `<div class="step-head"><span class="step-head__num">${n}</span><h3><span aria-hidden="true">${icon}</span> ${esc(title)}</h3></div>`;

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
    ${conservationBlock(sess)}
    ${componentsBlock(sess, startWeekday)}
    ${recipesToPrepareBlock(sess, startWeekday)}
    ${sameDayBlock('cook', sess.cookSameDay, startWeekday)}
    ${sameDayBlock('assemble', sess.assembleSameDay, startWeekday)}
    ${gamellesBlock(sess, startWeekday)}
  </div>`;
}

/** Alerte : la conservation d'un composant ne couvre pas la durée de la session. */
function conservationBlock(sess) {
  if (!sess.conservationAlerts?.length) return '';
  return `<div class="card" style="border-color:#eebeb9;background:var(--off-bg);margin-bottom:12px">
    <strong>⚠️ Conservation insuffisante</strong>
    <ul style="margin:6px 0 0;padding-left:18px">
      ${sess.conservationAlerts.map((a) => `<li>${esc(a.message)}</li>`).join('')}
    </ul>
    <small>Pour résoudre : scinde la session, réduis la durée de conservation dans les paramètres, ou cuisine ces composants plus tard.</small>
  </div>`;
}

/* ---------------------------------------------------- A — à préparer en batch */

/**
 * Conservation plus courte que la session (P0.3/P2.2) : au lieu d'une simple
 * alerte, le calendrier concret de reprise — une ligne par sous-préparation,
 * ancrée sur les jours de consommation réels et sa propre saisie "je prépare"
 * (clé distincte de la ligne principale, cf. `computeSubBatches()` /
 * derive.js). La première préparation est neutre (☐) ; toute préparation
 * supplémentaire après la première porte un ⚠️ (P2.3) pour signaler qu'elle
 * s'ajoute à celle déjà prévue en début de session.
 */
function subBatchRows(subBatches, startWeekday) {
  if (!subBatches?.length) return '';
  return `<table style="margin-top:6px">
    <thead><tr><th>Préparation</th><th class="nums">Besoin</th><th>Je prépare</th></tr></thead>
    <tbody>
      ${subBatches
        .map((b, i) => {
          const marker = i === 0 ? '☐' : '⚠️';
          const label = i === 0 ? 'Préparation' : 'Nouvelle préparation nécessaire';
          const prepDayName = dayName(startWeekday, b.startDay);
          const coversText = (b.coversDays?.length ? b.coversDays : [b.startDay, b.endDay])
            .map((d) => dayName(startWeekday, d)).join(', ');
          return `<tr>
            <td>
              ${marker} <strong>${esc(prepDayName)}</strong> — ${esc(label)}
              <div class="tag muted">couvre ${esc(coversText)}</div>
            </td>
            <td class="nums">${grams(b.requiredRaw)}</td>
            <td><input type="number" step="10" min="0" value="${num(b.preparedRaw, 0).replace(',', '.')}"
                   data-prep="${b.key}" style="width:104px" aria-label="Quantité préparée"> g</td>
          </tr>`;
        })
        .join('')}
    </tbody>
  </table>`;
}

/**
 * Mesure ponctuelle "cuit obtenu" face au rendement théorique de la fiche
 * aliment (c.yieldPct, food.cookedFactor) — jamais calculée pour un
 * composant qui ne se cuit pas (pas de poids crû/cuit distinct à comparer).
 * N'écrit jamais `food.cookedFactor` elle-même : seule l'action explicite
 * derrière `data-adjust-yield` (voir wire()) le fait, après confirmation.
 */
function cookedObtainedCell(c) {
  if (!c.needsCooking) return '<span class="muted">—</span>';
  // Convention d'affichage du rendement alignée sur la fiche aliment
  // (foods.js : coefficient décimal "×X,XX", jamais un pourcentage) — seul
  // le seuil de déclenchement de l'alerte reste exprimé en écart relatif (%),
  // concept interne au calcul, pas une valeur de rendement affichée telle quelle.
  const deviationGrams = c.yieldDeviationGrams;
  const warn = c.yieldDeviationSignificant
    ? `<div class="tag sync-error" style="display:block;margin-top:4px">
        ⚠️ écart ≥ ${YIELD_DEVIATION_THRESHOLD_PCT} % avec le rendement enregistré (×${num(c.food.cookedFactor, 2)}),
        soit ${deviationGrams >= 0 ? '+' : ''}${grams(deviationGrams)} par rapport au cuit attendu
      </div>
      <button type="button" class="btn btn--ghost" style="margin-top:4px;white-space:normal"
        data-adjust-yield="${c.key}" data-food-id="${esc(c.food.id)}" data-food-name="${esc(c.food.name)}"
        data-measured-factor="${c.measuredCookedFactor}" data-current-factor="${c.food.cookedFactor}">
        Ajuster le rendement enregistré
      </button>`
    : '';
  return `<input type="number" step="10" min="0" placeholder="non mesuré"
            value="${c.measuredCooked != null ? num(c.measuredCooked, 0).replace(',', '.') : ''}"
            data-cooked="${c.key}" data-raw="${c.preparedRaw}" style="width:104px" aria-label="Quantité cuite obtenue"> g
          ${c.measuredCookedFactor != null ? `<div class="tag">rendement mesuré ×${num(c.measuredCookedFactor, 2)}</div>` : ''}
          ${warn}`;
}

function componentsBlock(sess, startWeekday) {
  if (!sess.components.length) {
    return `${stepHead(1, BATCH_CATEGORY_LABEL.batch, '🧺')}<p class="muted">Aucun composant batchable sur cette session.</p>`;
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
          ${
            c.shelfLifeDays !== null
              ? `<div class="tag${c.shelfLifeShort ? ' sync-error' : ''}">conservation ${num(c.shelfLifeDays, 0)} j / ${num(c.coveredDays, 0)} j couverts</div>`
              : ''
          }
          ${subBatchRows(c.subBatches, startWeekday)}
        </td>
        <td class="nums">
          ${c.needsCooking ? `${grams(c.requiredRaw)} crus` : grams(c.requiredRaw)}
          ${c.needsCooking ? `<div class="tag">rendement ${num(c.yieldPct, 0)} %</div>` : ''}
        </td>
        <td class="nums">${grams(c.requiredCooked)}${c.needsCooking ? ' cuits' : ''}</td>
        <td><input type="number" step="10" min="0" value="${num(c.preparedRaw, 0).replace(',', '.')}"
               data-prep="${c.key}" style="width:104px" aria-label="Quantité préparée"> g</td>
        <td class="nums">${grams(c.preparedCooked)}</td>
        <td class="nums">${cookedObtainedCell(c)}</td>
        <td class="nums">${surplus >= 0 ? `+ ${grams(surplus)}` : `manque ${grams(-surplus)}`}<div class="tag">${num(coverage, 0)} %</div></td>
      </tr>`;
    })
    .join('');

  return `${stepHead(1, BATCH_CATEGORY_LABEL.batch, '🧺')}
    <div class="table-scroll">
      <table>
        <thead><tr>
          <th>Composant et méthode</th><th>À sortir</th><th>Quantité cuite nécessaire</th>
          <th>Je prépare</th><th>Cuit attendu</th><th>Cuit obtenu</th><th>Surplus</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

/* ---------------------------------------------- A' — recettes à préparer en batch (P0.2) */

function recipesToPrepareBlock(sess, startWeekday) {
  if (!sess.recipesToPrepare?.length) return '';
  const rows = sess.recipesToPrepare
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
          <strong>${esc(c.recipe.name)}</strong> <span class="tag">recette</span>
          <button type="button" class="btn btn--sm" style="margin-left:6px"
            data-create-prep="${esc(c.recipe.id)}" data-create-prep-grams="${c.preparedRaw}">Créer une préparation</button>
          ${method ? `<div class="tag">${method}</div>` : '<div class="tag muted">aucune consigne de cuisson définie dans la fiche recette</div>'}
          ${c.note ? `<div class="tag">${esc(c.note)}</div>` : ''}
          ${
            c.shelfLifeDays !== null
              ? `<div class="tag${c.shelfLifeShort ? ' sync-error' : ''}">conservation ${num(c.shelfLifeDays, 0)} j / ${num(c.coveredDays, 0)} j couverts</div>`
              : ''
          }
          ${ingredientsDetail(c)}
          ${subBatchRows(c.subBatches, startWeekday)}
          ${destinationsDetail(c, startWeekday)}
        </td>
        <td class="nums">${grams(c.requiredRaw)}</td>
        <td><input type="number" step="10" min="0" value="${num(c.preparedRaw, 0).replace(',', '.')}"
               data-prep="${c.key}" style="width:104px" aria-label="Quantité préparée"> g</td>
        <td class="nums">${surplus >= 0 ? `+ ${grams(surplus)}` : `manque ${grams(-surplus)}`}<div class="tag">${num(coverage, 0)} %</div></td>
      </tr>`;
    })
    .join('');

  return `<h3>Recettes à préparer en batch</h3>
    <div class="table-scroll">
      <table>
        <thead><tr><th>Recette et méthode</th><th>Quantité nette nécessaire</th><th>Je prépare</th><th>Surplus</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

/**
 * Étape 1 du « global » : ce qu'il y a DANS la recette, distinctement, à
 * l'échelle de ce qui va être réellement préparé (c.preparedRaw) — pour
 * savoir quoi sortir/peser avant de cuisiner, sans aller rouvrir la fiche
 * recette. Toujours visible (jamais repliée derrière un <details> qu'on
 * manque facilement) : c'est le cœur de ce bloc, pas un détail secondaire.
 * Lecture seule, aucune donnée n'est modifiée ici.
 */
function ingredientsDetail(c) {
  if (!c.ingredients?.length) return '';
  return `<div style="margin-top:8px">
    <strong>Recette totale à préparer</strong> — ${grams(c.preparedRaw)}
    <ul style="margin:4px 0 0;padding-left:18px">
      ${c.ingredients.map((ing) => `<li>${grams(ing.qty)} ${esc(ing.food.name)}${ing.state ? ` (${esc(ing.state)})` : ''}</li>`).join('')}
    </ul>
  </div>`;
}

/**
 * Étape 2 du « global » : une fois la recette préparée EN TOTALITÉ pour la
 * session, vers quelles gamelles ce total se répartit — un bloc distinct
 * sous la recette totale (ligne par gamelle, pas un seul tag illisible),
 * sans dupliquer le calcul de « Détail des gamelles » plus bas ni jamais
 * écrire dans le planning (lecture seule, dérivée des repas de la session).
 */
function destinationsDetail(c, startWeekday) {
  if (!c.destinations?.length) return '';
  return `<div style="margin-top:8px">
    <strong>Répartition dans les gamelles</strong>
    <ul style="margin:4px 0 0;padding-left:18px">
      ${c.destinations
        .map((d) => `<li>${esc(slot(startWeekday, d.dayIndex, d.mealType))}${d.name ? ` — ${esc(d.name)}` : ''} : ${grams(d.qty)}</li>`)
        .join('')}
    </ul>
  </div>`;
}

/* ------------------------------------- B et C — le jour même */

const SAME_DAY_STEP = { cook: { n: 2, icon: '🔥' }, assemble: { n: 3, icon: '🍱' } };

function sameDayBlock(kind, rows, startWeekday) {
  const label = BATCH_CATEGORY_LABEL[kind];
  const step = SAME_DAY_STEP[kind];
  if (!rows.length) return `${stepHead(step.n, label, step.icon)}<p class="muted">Rien dans cette catégorie sur cette session.</p>`;
  const byMeal = {};
  for (const r of rows) {
    const key = `${r.dayIndex}:${r.mealType}`;
    (byMeal[key] ||= { dayIndex: r.dayIndex, mealType: r.mealType, items: [] }).items.push(r);
  }
  return `${stepHead(step.n, label, step.icon)}
    ${Object.values(byMeal)
      .sort((a, b) => a.dayIndex - b.dayIndex || (a.mealType === 'lunch' ? -1 : 1))
      .map(
        (m) => `<div style="margin-bottom:8px">
          <strong>${esc(slot(startWeekday, m.dayIndex, m.mealType))}</strong>
          <ul style="margin:2px 0 0;padding-left:18px">
            ${m.items.map((r) => sameDayItem(r)).join('')}
          </ul>
        </div>`
      )
      .join('')}`;
}

/**
 * Une recette référencée directement (sans préparation, « molle ») n'est pas
 * forcément un plat déjà prêt à assembler : si elle est composée de plusieurs
 * ingrédients bruts (ex. yaourt + flocons + édulcorant + fruit), `r.ingredients`
 * donne le même détail que « Recette totale à préparer » plus haut — sans
 * quoi il serait impossible de savoir quoi peser pour la préparer. Une
 * préparation (stock déjà réellement cuisiné) n'a pas `ingredients` : rien à
 * détailler, elle est prête telle quelle.
 */
function sameDayItem(r) {
  const head = `${esc(r.food.name)} ${grams(r.grams)}${r.summary ? ` (${esc(r.summary)})` : ''}`;
  if (!r.ingredients?.length) return `<li>${head}</li>`;
  return `<li>${head}
    <ul style="margin:2px 0 4px;padding-left:18px">
      ${r.ingredients.map((ing) => `<li>${grams(ing.qty)} ${esc(ing.food.name)}${ing.state ? ` (${esc(ing.state)})` : ''}</li>`).join('')}
    </ul>
  </li>`;
}

/* ------------------------------------- détail des gamelles */

function gamellesBlock(sess, startWeekday) {
  const filled = sess.gamelles.filter((g) => PERSONS.some((p) => g.persons[p].length));
  if (!filled.length) return '';
  return `${stepHead(4, 'Détail des gamelles', '📦')}
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
                      : `<li>${grams(e.bonus > 0 ? e.adjustedGrams : e.grams)} ${esc(e.name)}${e.cooked ? ' cuit' : ''} <span class="tag">${esc(shortCat(e.category))}</span>${e.bonus > 0 ? `<span class="tag">+${grams(e.bonus)} (surplus à servir)</span>` : ''}</li>`
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
  // Lien Batch -> Préparations (lecture seule ici : ce bouton ne crée RIEN
  // par lui-même — il ouvre juste l'écran Préparations avec le formulaire
  // prérempli ; la création reste une action explicite de l'utilisateur sur
  // CET écran-là). Même mécanisme de contexte inter-écrans que
  // `nutriplan:off-barcode` (app.js) : un événement DOM, écouté une seule
  // fois au niveau de l'application.
  root.querySelectorAll('[data-create-prep]').forEach((btn) =>
    btn.addEventListener('click', (e) => {
      document.dispatchEvent(new CustomEvent('nutriplan:create-preparation', {
        detail: { recipeId: e.currentTarget.dataset.createPrep, grams: Number(e.currentTarget.dataset.createPrepGrams) || 0 },
      }));
    })
  );

  root.querySelectorAll('[data-prep]').forEach((input) =>
    input.addEventListener('change', (e) => {
      const key = e.target.dataset.prep;
      const value = Math.max(0, Number(e.target.value) || 0);
      update((s) => { s.batch.overrides[key] = value; });
      toast('Quantité préparée mise à jour');
    })
  );

  root.querySelectorAll('[data-cooked]').forEach((input) =>
    input.addEventListener('change', (e) => {
      const key = e.target.dataset.cooked;
      const raw = Number(e.target.dataset.raw) || 0;
      const value = e.target.value === '' ? null : Math.max(0, Number(e.target.value) || 0);
      update((s) => {
        // Verrouille la quantité crue affichée au moment de la mesure : sans
        // ça, une ligne "cuit obtenu" sans "je prépare" explicite n'aurait
        // aucune quantité crue de référence à synchroniser (sync.js).
        if (!(key in s.batch.overrides)) s.batch.overrides[key] = raw;
        if (value === null) delete s.batch.cookedOverrides[key];
        else s.batch.cookedOverrides[key] = value;
      });
      toast('Quantité cuite obtenue enregistrée');
    })
  );

  root.querySelectorAll('[data-adjust-yield]').forEach((btn) =>
    btn.addEventListener('click', (e) => {
      const { foodId, foodName, measuredFactor, currentFactor } = e.currentTarget.dataset;
      pendingConfirm = {
        title: 'Ajuster le rendement enregistré ?',
        message: `Le rendement mesuré pour « ${foodName} » est de ${num(Number(measuredFactor), 2)} ` +
          `(100 g cru → ${num(Number(measuredFactor) * 100, 0)} g cuit), contre ${num(Number(currentFactor), 2)} ` +
          `actuellement enregistré dans la fiche aliment. Mettre à jour la fiche avec ce nouveau rendement ? ` +
          `Cela changera le calcul de TOUS les repas, recettes et sessions de batch futurs utilisant cet ` +
          `aliment — pas seulement celui-ci.`,
        confirmLabel: 'Mettre à jour la fiche aliment',
        onConfirm: () => {
          update((s) => {
            const food = s.foods.find((f) => f.id === foodId);
            if (food) food.cookedFactor = Math.round(Number(measuredFactor) * 100) / 100;
          });
          toast('Rendement mis à jour sur la fiche aliment');
          render(root);
        },
      };
      render(root);
    })
  );
  wireActionConfirm(root, { getPending: () => pendingConfirm, setPending: (v) => { pendingConfirm = v; }, render });
}
