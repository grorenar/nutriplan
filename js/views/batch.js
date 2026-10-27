/**
 * Écran BATCH COOKING — plan opératoire déduit du planning.
 * Les sessions de batch sont créées et peuplées à la main par l'utilisateur
 * (glisser-déposer des gamelles depuis le pool, ou d'une session à l'autre) —
 * remplace l'ancien découpage automatique par durée de conservation
 * (`maxDays`), jugé peu lisible au quotidien (retour utilisateur). Les
 * éléments non-batchables (« à cuire »/« à assembler le jour même ») restent
 * une vue globale, indépendante des sessions. Cet écran ne modifie jamais le
 * planning.
 */

import { getState, update, foodsById, recipesById, preparationsById, newBatchSession } from '../core/store.js';
import { buildBatchPlan, BATCH_CATEGORY_LABEL, YIELD_DEVIATION_THRESHOLD_PCT } from '../core/derive.js';
import { dayName, esc, grams, num, toast } from '../core/util.js';
import { MEAL_TYPES, PERSONS, PERSON_LABEL, conversionInfo } from '../core/nutrition.js';
import { actionConfirmModal, wireActionConfirm } from './confirm-action.js';
import { formatFoodQty } from './editor.js';

let pendingConfirm = null; // { title, message, onConfirm } — ajustement du rendement enregistré d'un aliment

// Retour utilisateur : le glisser-déposer directement sur la page (pool et
// cartes de session mêlés à tout le reste — détail des composants, plan
// opératoire…) était difficile à viser. Le DnD vit désormais UNIQUEMENT dans
// une popup dédiée (gamelleAssignModal ci-dessous), ouverte par un bouton :
// pool et sessions y sont affichés côte à côte, sans rien d'autre autour.
// La page elle-même n'affiche plus que des listes en LECTURE SEULE (chips
// sans `draggable`, zones sans `data-drop`).
let assignOpen = false;

// État du glisser-déposer de gamelles — module-level, comme planning.js
// (mêmes contraintes DnD réelles : `dragstart` cible toujours le plus proche
// ancêtre `draggable`, jamais un sous-élément précis ; un geste de drag natif
// peut remettre `window.scrollY` à 0 AVANT même que `drop` ne s'exécute,
// capturé ici au `mousedown`, restauré après chaque render() qui suit un
// dépôt). Voir js/views/planning.js pour le même motif, déjà éprouvé.
let dragMealId = null;
let dragStartScrollY = null;

export function render(root) {
  const s = getState();
  if (!s.settings.batch.enabled) {
    root.innerHTML = `<div class="empty">Le batch cooking est désactivé dans les paramètres.</div>`;
    return;
  }
  const byId = foodsById();
  const plan = buildBatchPlan(s, byId, recipesById(), preparationsById());
  const startWeekday = s.settings.cycle.startWeekday;

  const totalGamelles = plan.sessions.reduce((n, sess) => n + sess.mealIds.length, 0);
  const totalComponents = plan.sessions.reduce((n, sess) => n + sess.components.length + sess.recipesToPrepare.length, 0);

  root.innerHTML = `
    <div class="stat-grid" style="margin-bottom:16px">
      <div class="stat-card">
        <div class="stat-card__top"><span class="stat-card__icon">🗓️</span><span class="stat-card__label">Sessions</span></div>
        <span class="stat-card__value">${plan.sessions.length}</span>
      </div>
      <div class="stat-card">
        <div class="stat-card__top"><span class="stat-card__icon">🍱</span><span class="stat-card__label">Gamelles réparties</span></div>
        <span class="stat-card__value">${totalGamelles}</span>
      </div>
      <div class="stat-card">
        <div class="stat-card__top"><span class="stat-card__icon">🧺</span><span class="stat-card__label">Composants à préparer</span></div>
        <span class="stat-card__value">${totalComponents}</span>
      </div>
      <div class="stat-card ${plan.unassignedGamelles.length ? 'stat-card--warn' : 'stat-card--accent'}">
        <div class="stat-card__top"><span class="stat-card__icon">📥</span><span class="stat-card__label">À répartir</span></div>
        <span class="stat-card__value">${plan.unassignedGamelles.length}</span>
      </div>
    </div>

    <div class="row" style="margin-bottom:16px">
      <button type="button" class="btn btn--primary" data-open-assign>🧩 Répartir les gamelles</button>
      ${plan.unassignedGamelles.length ? `<span class="tag stat-card--warn" style="margin-left:10px">${plan.unassignedGamelles.length} encore à répartir</span>` : ''}
    </div>

    <div class="card">
      <div class="card__head">
        <h2>📥 Gamelles à préparer</h2>
        <p>Utilise « Répartir les gamelles » ci-dessus pour décider quand chacune sera préparée.</p>
      </div>
      ${gamelleZone('pool', plan.unassignedGamelles, startWeekday, 'Toutes les gamelles batchables sont déjà réparties dans une session.')}
    </div>

    <div class="row" style="margin:16px 0 10px">
      <h2 style="margin:0">🗓️ Sessions de batch</h2>
      <span class="spacer"></span>
      <button type="button" class="btn btn--sm btn--primary" data-new-session>+ Nouvelle session</button>
    </div>
    ${
      plan.sessions.length
        ? plan.sessions.map((sess) => sessionCard(sess, startWeekday)).join('')
        : `<div class="empty">Aucune session créée. Commence par « + Nouvelle session », puis « Répartir les gamelles ».</div>`
    }

    ${sameDayBlock('cook', plan.cookSameDay, startWeekday)}
    ${sameDayBlock('assemble', plan.assembleSameDay, startWeekday)}
    ${assignOpen ? gamelleAssignModal(plan, startWeekday) : ''}
    ${pendingConfirm ? actionConfirmModal(pendingConfirm) : ''}
  `;
  wire(root);
}

const slot = (startWeekday, dayIndex, mealType) =>
  `${dayName(startWeekday, dayIndex).toLowerCase()} ${mealType === 'lunch' ? 'midi' : 'soir'}`;

/**
 * Une gamelle — pastille visuelle réutilisée partout (pool, session, popup
 * de répartition). `draggable` : seule la popup de répartition (cf.
 * gamelleAssignModal) la rend réellement DÉPLAÇABLE — ailleurs sur la page
 * (pool, carte de session), elle reste un simple affichage en lecture seule
 * (retour utilisateur : glisser-déposer directement sur la page jugé trop
 * difficile à viser, mélangé au reste du contenu).
 */
function gamelleChip(g, startWeekday, draggable = false) {
  return `<div class="gamelle-chip${draggable ? ' gamelle-chip--draggable' : ''}" ${draggable ? 'draggable="true"' : ''} data-gamelle-id="${esc(g.mealId)}">
    <span class="gamelle-chip__slot">${esc(slot(startWeekday, g.dayIndex, g.mealType))}</span>
    ${g.name ? `<span class="gamelle-chip__name">${esc(g.name)}</span>` : ''}
  </div>`;
}

/**
 * Zone de dépôt (le pool, ou l'intérieur d'une session) — `dropId` = 'pool'
 * ou l'id de la session. `interactive` : seule la popup de répartition pose
 * `data-drop` (et des chips `draggable`) ; sur la page, c'est un affichage
 * statique (cf. gamelleChip ci-dessus).
 */
function gamelleZone(dropId, gamellesLight, startWeekday, emptyText, interactive = false) {
  return `<div class="gamelle-zone" ${interactive ? `data-drop="${esc(dropId)}"` : ''}>
    ${gamellesLight.length ? gamellesLight.map((g) => gamelleChip(g, startWeekday, interactive)).join('') : `<p class="muted" style="margin:0">${esc(emptyText)}</p>`}
  </div>`;
}

function sessionCard(sess, startWeekday) {
  const gamellesLight = sess.gamelles.map((g) => ({ mealId: g.mealId, dayIndex: g.dayIndex, mealType: g.mealType, name: g.name }));
  return `<div class="card">
    <div class="card__head">
      <input type="text" class="session-card__label" data-session-label="${esc(sess.id)}" value="${esc(sess.label)}" placeholder="Session sans nom" aria-label="Nom de la session">
      <span class="spacer"></span>
      <button type="button" class="btn btn--sm btn--ghost" data-delete-session="${esc(sess.id)}">Supprimer la session</button>
    </div>
    ${gamelleZone(sess.id, gamellesLight, startWeekday, 'Utilise « Répartir les gamelles » pour lui en affecter.')}
    ${componentsBlock(sess)}
    ${recipesToPrepareBlock(sess, startWeekday)}
    ${gamellesDetailBlock(sess, startWeekday)}
  </div>`;
}

/**
 * Popup dédiée au glisser-déposer (retour utilisateur) : pool et sessions
 * côte à côte, SANS rien d'autre autour (pas de détail de composants, de
 * plan opératoire…) — rien pour gêner le geste de glisser. Même motif de
 * modale centrale que l'assistant de répartition des préparations
 * (preparations.js::distributeWizard), en plus large pour accueillir
 * plusieurs colonnes ; comme le tableau de jours du Planning, les colonnes
 * RETOURNENT À LA LIGNE plutôt que de défiler horizontalement (retour
 * utilisateur déjà appliqué là-bas).
 */
function gamelleAssignModal(plan, startWeekday) {
  // Classes DÉDIÉES (gamelle-board / gamelle-col), jamais .board/.day-col :
  // planning.js vérifie la présence de .meal-slot (pas .board) avant de se
  // re-rendre au redimensionnement, mais garder des classes bien à nous
  // évite toute collision de ce genre avec n'importe quelle autre vue future.
  const column = (dropId, label, gamellesLight, emptyText) => `<div class="gamelle-col">
    <div class="gamelle-col__head"><h2>${esc(label)}</h2></div>
    ${gamelleZone(dropId, gamellesLight, startWeekday, emptyText, true)}
  </div>`;

  return `<div class="composer" data-assign-backdrop>
    <div class="composer__dialog composer__dialog--wide">
      <div class="composer__head">
        <div class="row"><h3 style="flex:1">🧩 Répartir les gamelles</h3>
        <button type="button" class="btn btn--sm btn--primary" data-new-session>+ Nouvelle session</button>
        <button type="button" class="btn btn--ghost" data-assign-close>Fermer</button></div>
        <small>Glisse une gamelle d'une colonne à l'autre pour décider dans quelle session (ou le pool) elle atterrit.</small>
      </div>
      <div class="composer__main" style="overflow:auto;padding:18px">
        <div class="gamelle-board">
          <div class="gamelle-board__row">
            ${column('pool', '📥 Pool', plan.unassignedGamelles, 'Tout est réparti.')}
            ${plan.sessions
              .map((sess) =>
                column(
                  sess.id,
                  sess.label || 'Session sans nom',
                  sess.gamelles.map((g) => ({ mealId: g.mealId, dayIndex: g.dayIndex, mealType: g.mealType, name: g.name })),
                  'Glisse une gamelle ici.'
                )
              )
              .join('')}
            ${!plan.sessions.length ? '<p class="muted">Aucune session créée pour l’instant — ferme cette popup et crée-en une avec « + Nouvelle session ».</p>' : ''}
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

/**
 * Détail des gamelles DE CETTE SESSION, personne par personne — y compris la
 * suggestion de répartition du surplus (bonus/adjustedGrams, calculée dans
 * buildSessionPlan()/derive.js) : c'est le SEUL endroit où elle est visible,
 * donc jamais supprimée même si elle fait doublon visuel avec les chips de
 * gamelles ci-dessus (celles-ci ne montrent qu'un nom de créneau, pas le
 * contenu).
 */
function gamellesDetailBlock(sess, startWeekday) {
  const filled = sess.gamelles.filter((g) => PERSONS.some((p) => g.persons[p].length));
  if (!filled.length) return '';
  return `<h3 style="margin-top:14px">📦 Détail des gamelles de cette session</h3>
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
                      : `<li>${gamelleQty(e, e.bonus > 0 ? e.adjustedGrams : e.grams)} ${esc(e.name)}${e.cooked ? ' cuit' : ''} <span class="tag">${esc(shortCat(e.category))}</span>${e.bonus > 0 ? `<span class="tag">+${gamelleQty(e, e.bonus)} (surplus à servir)</span>` : ''}
                          ${e.ingredients?.length ? `<ul style="margin:2px 0 0;padding-left:16px">${e.ingredients.map(ingredientLine).join('')}</ul>` : ''}
                        </li>`
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

/**
 * Quantité d'une entrée de gamelle — en unités si l'aliment le demande,
 * SAUF si `e.cooked` (poids déjà converti post-cuisson, cf. derive.js
 * servedGrams()) : le nombre de pièces crues ne se déduit pas proprement
 * d'un poids déjà cuit (rendement non homogène pièce par pièce), donc
 * grammes seuls dans ce cas — même règle que ingredientLine() ci-dessous.
 */
const gamelleQty = (e, qty) => (e.cooked ? grams(qty) : formatFoodQty(e.food, qty));

/* ---------------------------------------------------- à préparer en batch */

/**
 * Mesure ponctuelle "cuit obtenu" face au rendement théorique de la fiche
 * aliment (c.yieldPct, food.cookedFactor) — jamais calculée pour un
 * composant qui ne se cuit pas (pas de poids crû/cuit distinct à comparer).
 * N'écrit jamais `food.cookedFactor` elle-même : seule l'action explicite
 * derrière `data-adjust-yield` (voir wire()) le fait, après confirmation.
 */
function cookedObtainedCell(c) {
  if (!c.needsCooking) return '<span class="muted">—</span>';
  // Un aliment "nécessite une cuisson" peut avoir des valeurs nutritionnelles
  // définies à l'état "prêt à consommer" (ex. plat surgelé à réchauffer,
  // cf. foods.js) : il n'y a alors pas de poids cru distinct à comparer au
  // cuit obtenu, donc rien à mesurer ici — même condition que derive.js
  // (measurable), pour ne jamais afficher un champ qui semble actif mais
  // dont la saisie ne serait jamais relue (retour utilisateur : "le cuit
  // obtenu ne fait rien ... et disparaît après une saisie").
  if (c.food.referenceState !== 'cru') {
    return '<span class="muted">— (déjà à l’état de référence de la fiche)</span>';
  }
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

/**
 * Un composant à préparer en batch = une carte (P4, retour utilisateur : le
 * tableau à 7 colonnes était jugé lourd et amateur). Mêmes data-prep/
 * data-cooked/data-adjust-yield qu'avant (wire() totalement inchangé),
 * seule la présentation change — d'une ligne de tableau dense à une carte
 * avec une bande de mesures compactes, label au-dessus de la valeur.
 */
function componentsBlock(sess) {
  if (!sess.components.length) return '';
  const cards = sess.components
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
      return `<div class="batch-item">
        <div class="batch-item__head">
          <div class="batch-item__name">${esc(c.food.name)}</div>
          <div class="batch-item__tags">
            ${method ? `<span class="tag">${method}</span>` : '<span class="tag muted">aucune consigne de cuisson définie dans la fiche aliment</span>'}
            ${c.note ? `<span class="tag">${esc(c.note)}</span>` : ''}
            ${c.shelfLifeDays !== null ? `<span class="tag">conservation ${num(c.shelfLifeDays, 0)} j</span>` : ''}
          </div>
        </div>
        <div class="batch-item__metrics">
          <div class="batch-item__metric">
            <span class="batch-item__metric-label">À sortir</span>
            <span class="batch-item__metric-value">${c.needsCooking ? `${formatFoodQty(c.food, c.requiredRaw)} crus` : formatFoodQty(c.food, c.requiredRaw)}</span>
            ${c.needsCooking ? `<span class="tag">rendement ${num(c.yieldPct, 0)} %</span>` : ''}
          </div>
          <div class="batch-item__metric">
            <span class="batch-item__metric-label">Cuit nécessaire</span>
            <!-- Toujours en grammes, jamais en unités même si l'aliment est
                 réglé en unités : le nombre de pièces CRUES ne se déduit pas
                 proprement d'un poids déjà cuit (rendement non homogène pièce
                 par pièce) — « À sortir » ci-dessus donne déjà ce compte. -->
            <span class="batch-item__metric-value">${grams(c.requiredCooked)}${c.needsCooking ? ' cuits' : ''}</span>
          </div>
          <div class="batch-item__metric batch-item__metric--input">
            <span class="batch-item__metric-label">Je prépare</span>
            <span><input type="number" step="10" min="0" value="${num(c.preparedRaw, 0).replace(',', '.')}"
               data-prep="${c.key}" style="width:104px" aria-label="Quantité préparée"> g</span>
          </div>
          <div class="batch-item__metric">
            <span class="batch-item__metric-label">Cuit attendu</span>
            <span class="batch-item__metric-value">${grams(c.preparedCooked)}</span>
          </div>
          <div class="batch-item__metric batch-item__metric--input">
            <span class="batch-item__metric-label">Cuit obtenu</span>
            <span>${cookedObtainedCell(c)}</span>
          </div>
          <div class="batch-item__metric batch-item__metric--${surplus >= 0 ? 'ok' : 'warn'}">
            <span class="batch-item__metric-label">Surplus</span>
            <span class="batch-item__metric-value">${surplus >= 0 ? `+ ${formatFoodQty(c.food, surplus)}` : `manque ${formatFoodQty(c.food, -surplus)}`}</span>
            <span class="tag">${num(coverage, 0)} %</span>
          </div>
        </div>
      </div>`;
    })
    .join('');

  return `<h3 style="margin-top:14px">🧺 ${esc(BATCH_CATEGORY_LABEL.batch)}</h3>
    <div class="batch-item-list">${cards}</div>`;
}

/* ---------------------------------------------- recettes à préparer en batch */

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
          ${c.shelfLifeDays !== null ? `<div class="tag">conservation ${num(c.shelfLifeDays, 0)} j</div>` : ''}
          ${ingredientsDetail(c)}
          ${destinationsDetail(c, startWeekday)}
        </td>
        <td class="nums">${grams(c.requiredRaw)}</td>
        <td><input type="number" step="10" min="0" value="${num(c.preparedRaw, 0).replace(',', '.')}"
               data-prep="${c.key}" style="width:104px" aria-label="Quantité préparée"> g</td>
        <td class="nums">${surplus >= 0 ? `+ ${grams(surplus)}` : `manque ${grams(-surplus)}`}<div class="tag">${num(coverage, 0)} %</div></td>
      </tr>`;
    })
    .join('');

  return `<h3 style="margin-top:14px">Recettes à préparer en batch</h3>
    <div class="table-scroll">
      <table>
        <thead><tr><th>Recette et méthode</th><th>Quantité nette nécessaire</th><th>Je prépare</th><th>Surplus</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

/**
 * Ce qu'il y a DANS la recette, distinctement, à l'échelle de ce qui va être
 * réellement préparé (c.preparedRaw) — pour savoir quoi sortir/peser avant
 * de cuisiner, sans aller rouvrir la fiche recette. Toujours visible (jamais
 * repliée derrière un <details> qu'on manque facilement). Lecture seule,
 * aucune donnée n'est modifiée ici.
 */
function ingredientsDetail(c) {
  if (!c.ingredients?.length) return '';
  return `<div style="margin-top:8px">
    <strong>Recette totale à préparer</strong> — ${grams(c.preparedRaw)}
    <ul style="margin:4px 0 0;padding-left:18px">
      ${c.ingredients.map(ingredientLine).join('')}
    </ul>
  </div>`;
}

/**
 * Une ligne d'ingrédient de recette (détail "recette totale à préparer" ET
 * "à assembler le jour même", même structure {food, qty, state}) — signale
 * explicitement quand l'état saisi pour CET ingrédient n'est pas convertible
 * vers l'état de référence de sa fiche aliment (ex. "prêt" alors que la
 * fiche est en "cru", sans rendement cru/cuit entre les deux) : sans cette
 * alerte, la quantité correspondante est silencieusement exclue du besoin
 * agrégé par aggregateNeeds() (derive.js) — un aliment utilisé À LA FOIS
 * directement ET via une telle recette paraît alors sous-compté, jamais
 * signalé (retour utilisateur). aggregateNeeds() n'invente jamais de poids ;
 * la correction revient à l'utilisateur, ici rendue visible.
 */
function ingredientLine(ing) {
  const conv = conversionInfo(ing.food, ing.state || ing.food.referenceState);
  const warn = conv.needed && !conv.possible
    ? ` <span class="tag sync-error">⚠️ conversion impossible — non compté dans le besoin total, à corriger dans la recette ou la fiche aliment</span>`
    : '';
  const labelState = ing.labelState ?? ing.state;
  // Jamais en unités pour un poids déjà converti post-cuisson (labelState
  // "cuit") : le nombre de pièces CRUES ne se déduit pas proprement d'un
  // poids déjà cuit (rendement non homogène pièce par pièce) — seul un poids
  // encore dans l'état saisi dans la recette (jamais cuit) peut s'afficher
  // en unités, comme partout ailleurs dans l'application.
  // Suggestion de surplus (retour utilisateur : augmenter la viande hachée
  // du burrito plutôt que d'avoir du cuit en trop) — même mécanisme que les
  // entrées directes de gamelle ci-dessus (buildSessionPlan()/derive.js),
  // jamais une modification de la recette elle-même, juste un affichage.
  const shownQty = ing.bonus > 0 ? ing.adjustedQty : ing.qty;
  const qtyText = labelState === 'cuit' ? grams(shownQty) : formatFoodQty(ing.food, shownQty);
  const bonusTag = ing.bonus > 0 ? ` <span class="tag">+${grams(ing.bonus)} (surplus à servir)</span>` : '';
  return `<li>${qtyText} ${esc(ing.food.name)}${labelState ? ` (${esc(labelState)})` : ''}${bonusTag}${warn}</li>`;
}

/**
 * Une fois la recette préparée EN TOTALITÉ pour la session, vers quelles
 * gamelles ce total se répartit — lecture seule, dérivée des repas de la
 * session, n'écrit jamais dans le planning.
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

/* ------------------------------------- à cuire / à assembler le jour même (global) */

const SAME_DAY_ICON = { cook: '🔥', assemble: '🍱' };

function sameDayBlock(kind, rows, startWeekday) {
  const label = BATCH_CATEGORY_LABEL[kind];
  if (!rows.length) {
    return `<div class="card" style="margin-top:14px">
      <div class="card__head"><h2>${SAME_DAY_ICON[kind]} ${esc(label)}</h2></div>
      <p class="muted">Rien dans cette catégorie pour l’instant.</p>
    </div>`;
  }
  const byMeal = {};
  for (const r of rows) {
    const key = `${r.dayIndex}:${r.mealType}`;
    (byMeal[key] ||= { dayIndex: r.dayIndex, mealType: r.mealType, items: [] }).items.push(r);
  }
  return `<div class="card" style="margin-top:14px">
    <div class="card__head"><h2>${SAME_DAY_ICON[kind]} ${esc(label)}</h2></div>
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
      .join('')}
  </div>`;
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
  const head = `${esc(r.food.name)} ${formatFoodQty(r.food, r.grams)}${r.summary ? ` (${esc(r.summary)})` : ''}`;
  if (!r.ingredients?.length) return `<li>${head}</li>`;
  return `<li>${head}
    <ul style="margin:2px 0 4px;padding-left:18px">
      ${r.ingredients.map(ingredientLine).join('')}
    </ul>
  </li>`;
}

/* ------------------------------------------------------------------ */
/* Glisser-déposer des gamelles (pool <-> sessions)                    */
/* ------------------------------------------------------------------ */

function wireDragAndDrop(root) {
  root.querySelectorAll('[data-gamelle-id]').forEach((chip) => {
    // Capturé au mousedown : un geste de drag natif peut remettre
    // window.scrollY à 0 avant même que `drop` ne s'exécute (constaté sur
    // Chrome réel, cf. planning.js) — trop tard pour le capturer dans `drop`.
    chip.addEventListener('mousedown', () => { dragStartScrollY = window.scrollY; });
    chip.addEventListener('dragstart', (e) => {
      dragMealId = chip.dataset.gamelleId;
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', dragMealId);
      }
    });
    chip.addEventListener('dragend', () => { dragMealId = null; });
  });

  root.querySelectorAll('[data-drop]').forEach((zone) => {
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      zone.classList.add('is-drop-target');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('is-drop-target'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('is-drop-target');
      const mealId = dragMealId || e.dataTransfer?.getData('text/plain');
      dragMealId = null;
      if (!mealId) return;
      assignGamelle(root, mealId, zone.dataset.drop);
    });
  });
}

function assignGamelle(root, mealId, targetId) {
  const savedScrollY = dragStartScrollY;
  update((s) => {
    for (const sess of s.batch.sessions) sess.mealIds = sess.mealIds.filter((id) => id !== mealId);
    if (targetId !== 'pool') {
      const sess = s.batch.sessions.find((x) => x.id === targetId);
      if (sess && !sess.mealIds.includes(mealId)) sess.mealIds.push(mealId);
    }
  });
  render(root);
  // le render() ci-dessus tente déjà de restaurer le scroll (voir app.js/
  // planning.js) mais ne suffit pas seul après un drag natif (le saut a déjà
  // eu lieu avant ce point) : on réapplique explicitement la valeur capturée
  // au mousedown.
  if (savedScrollY != null) window.scrollTo(0, savedScrollY);
}

function wire(root) {
  wireDragAndDrop(root);

  root.querySelector('[data-open-assign]')?.addEventListener('click', () => {
    assignOpen = true;
    render(root);
  });
  root.querySelector('[data-assign-close]')?.addEventListener('click', () => {
    assignOpen = false;
    render(root);
  });
  root.querySelector('[data-assign-backdrop]')?.addEventListener('mousedown', (e) => {
    if (e.target.dataset.assignBackdrop !== undefined) {
      assignOpen = false;
      render(root);
    }
  });

  // querySelectorAll, pas querySelector : le bouton existe potentiellement
  // deux fois à la fois (page principale + en-tête de la popup de
  // répartition, qui reste dans le DOM par-dessus elle plutôt que de la
  // remplacer — cf. gamelleAssignModal()).
  root.querySelectorAll('[data-new-session]').forEach((btn) =>
    btn.addEventListener('click', () => {
      update((s) => {
        s.batch.sessions.push(newBatchSession(`Session ${s.batch.sessions.length + 1}`));
      });
      render(root);
    })
  );

  root.querySelectorAll('[data-session-label]').forEach((input) =>
    input.addEventListener('change', (e) => {
      const id = e.target.dataset.sessionLabel;
      const value = e.target.value.trim();
      update((s) => {
        const sess = s.batch.sessions.find((x) => x.id === id);
        if (sess) sess.label = value;
      });
    })
  );

  root.querySelectorAll('[data-delete-session]').forEach((btn) =>
    btn.addEventListener('click', (e) => {
      const id = e.currentTarget.dataset.deleteSession;
      update((s) => { s.batch.sessions = s.batch.sessions.filter((x) => x.id !== id); });
      toast('Session supprimée — ses gamelles reviennent dans le pool');
      render(root);
    })
  );

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
