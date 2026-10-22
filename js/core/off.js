/**
 * Service Open Food Facts (OFF) — recherche d'un produit par code-barres ou
 * par nom/marque, et conversion vers un brouillon d'aliment Nutriplan.
 *
 * Deux endpoints DISTINCTS (OFF ne propose pas la recherche texte sur le même
 * endpoint que la fiche produit) :
 *   - fiche produit par code-barres : /api/v2/product/{code}.json (API v2,
 *     encore officiellement supportée ; v3 existe mais son schéma de réponse
 *     exact n'a pas pu être vérifié depuis cet environnement — accès réseau
 *     à world.openfoodfacts.org et à la documentation OFF bloqués dans ce
 *     bac à sable. v2 reste documentée, stable, et c'est celle utilisée ici ;
 *     à reconsidérer si v3 peut être vérifiée directement) ;
 *   - recherche texte : Search-a-licious (search.openfoodfacts.org/search).
 *     CHANGEMENT (confirmé en usage réel après la première mise en ligne) :
 *     l'endpoint historique /cgi/search.pl, initialement retenu ici par
 *     prudence (Search-a-licious encore en bêta, schéma non vérifiable depuis
 *     ce bac à sable), s'est révélé renvoyer systématiquement une erreur 503
 *     en production — très probablement déprioritisé par OFF côté
 *     infrastructure maintenant que Search-a-licious existe. Un 503 sans
 *     en-tête CORS est rapporté par le navigateur comme une erreur CORS
 *     (message trompeur : la cause réelle est le 503, visible uniquement via
 *     l'onglet Réseau des outils de développement). Search-a-licious est donc
 *     utilisé malgré un schéma de réponse non confirmé avec certitude :
 *     l'analyse de la réponse (parseSearchResponse() ci-dessous) reste
 *     volontairement tolérante (plusieurs noms de clé possibles pour le
 *     tableau de résultats) pour s'adapter sans casser si le schéma exact
 *     diffère légèrement de l'hypothèse retenue.
 *
 * CORS : `search.openfoodfacts.org` ne renvoie pas d'en-tête
 * `Access-Control-Allow-Origin` pour un site tiers (confirmé en usage réel —
 * la requête aboutit, 200 OK côté serveur, mais le navigateur bloque la
 * réponse). Nutriplan étant un site statique pur, ceci est incontournable
 * côté client seul : `cloudflare-worker/off-proxy.js` (racine du dépôt) est
 * un relais minimal à déployer séparément (voir README) qui fait la requête
 * lui-même et ajoute l'en-tête manquant. `OFF_PROXY_URL` (js/config.js)
 * active ce relais pour les deux endpoints une fois configuré ; tant qu'il
 * reste vide, les deux fonctions ci-dessous appellent Open Food Facts
 * directement (fonctionne pour la fiche produit par code-barres à ce jour,
 * pas pour la recherche).
 *
 * Aucune clé API n'est nécessaire (lecture publique). OFF demande par
 * ailleurs un User-Agent personnalisé pour identifier l'appli cliente — un
 * navigateur REFUSE qu'une page web positionne cet en-tête sur une requête
 * fetch() (« forbidden header name », imposé par le navigateur lui-même) ;
 * le proxy, lui, le peut (et le fait) puisque c'est un serveur.
 *
 * Respecte les limites publiées par OFF (documentation officielle) :
 * 15 req/min/IP pour la lecture de fiches produit, 10 req/min/IP pour la
 * recherche — largement au-delà de ce qu'un usage manuel, à deux personnes,
 * peut générer ; la temporisation (debounce) de la recherche texte côté
 * interface (foods.js) les respecte par construction.
 */

import { OFF_PROXY_URL } from '../config.js';
import { suggestCategoryFromOff } from './off-category.js';
import { normalizeWords } from './util.js';

// Avec proxy configuré : mêmes chemins que ceux attendus par
// cloudflare-worker/off-proxy.js (/product/{code}.json, /search). Sans
// proxy : appel direct à Open Food Facts (cf. commentaire d'en-tête).
const PRODUCT_BASE = OFF_PROXY_URL ? `${OFF_PROXY_URL}/product` : 'https://world.openfoodfacts.org/api/v2/product';
// Search-a-licious : pas de paramètre `fields=` connu avec certitude (schéma
// non vérifiable depuis cet environnement) — on ne le tente pas, au risque
// sinon qu'un paramètre mal deviné fasse échouer toute la requête ; les
// documents complets sont filtrés après coup par mapOffProductToFoodDraft().
const SEARCH_BASE = OFF_PROXY_URL ? `${OFF_PROXY_URL}/search` : 'https://search.openfoodfacts.org/search';

const PRODUCT_FIELDS = [
  'code', 'product_name', 'product_name_fr', 'generic_name', 'generic_name_fr',
  'brands', 'quantity', 'categories_tags',
  'image_front_url', 'image_front_small_url', 'image_url', 'url',
  'nutriments', 'nutriscore_grade', 'nova_group', 'ecoscore_grade',
  'ingredients_text', 'ingredients_text_fr', 'allergens_tags', 'traces_tags',
].join(',');

/**
 * Un code-barres est TOUJOURS une chaîne — jamais passé par Number() nulle
 * part dans ce module ni dans ses appelants (un zéro initial, par ex. un EAN
 * français commençant par « 0 », serait sinon silencieusement perdu). On ne
 * garde que les chiffres (un scanner ou une saisie peuvent ajouter espaces
 * ou tirets), sans jamais réinterpréter la valeur comme un nombre.
 */
export function normalizeBarcode(value) {
  return String(value ?? '').replace(/[^0-9]/g, '');
}

function describeFetchError(e) {
  if (e?.name === 'AbortError') return null; // annulation volontaire, jamais une erreur à afficher
  return 'Connexion à Open Food Facts impossible (réseau indisponible ou hors ligne).';
}

async function getJson(url, signal) {
  let res;
  try {
    res = await fetch(url, { signal });
  } catch (e) {
    const msg = describeFetchError(e);
    return msg ? { ok: false, aborted: false, error: msg } : { ok: false, aborted: true };
  }
  if (!res.ok) {
    // 429/503 documentés par OFF en cas de dépassement de quota ou de
    // service indisponible — même message générique, l'utilisateur n'a de
    // toute façon qu'un seul recours : réessayer plus tard.
    return { ok: false, aborted: false, error: `Open Food Facts a répondu une erreur (${res.status}).` };
  }
  let json;
  try {
    json = await res.json();
  } catch {
    return { ok: false, aborted: false, error: 'Réponse Open Food Facts illisible (format inattendu).' };
  }
  return { ok: true, json };
}

/**
 * Récupère une fiche produit par code-barres.
 * @returns {Promise<{status:'found', code, raw, draft} | {status:'not-found', code} | {status:'error', error} | {status:'aborted'}>}
 */
export async function fetchProductByBarcode(barcode, { signal } = {}) {
  const code = normalizeBarcode(barcode);
  if (!code) return { status: 'error', error: 'Code-barres vide.' };
  const url = `${PRODUCT_BASE}/${encodeURIComponent(code)}.json?fields=${PRODUCT_FIELDS}&lc=fr`;
  const res = await getJson(url, signal);
  if (res.aborted) return { status: 'aborted' };
  if (!res.ok) return { status: 'error', error: res.error };
  const json = res.json;
  // status === 1 : produit trouvé (convention OFF v2, status_verbose confirme
  // en texte) ; toute autre valeur (0, absente) = produit absent de la base,
  // jamais une erreur réseau à ce stade (déjà écartée ci-dessus).
  if (json?.status !== 1 || !json.product) return { status: 'not-found', code };
  return { status: 'found', code, raw: json.product, draft: mapOffProductToFoodDraft(json.product, code) };
}

/**
 * Extrait la liste des produits et le total d'une réponse Search-a-licious —
 * schéma non confirmé avec certitude (cf. en-tête du fichier) : plusieurs
 * noms de clé plausibles sont essayés dans l'ordre, et chaque élément est
 * désenveloppé s'il est imbriqué sous `.document`/`._source` (motif courant
 * pour un wrapper au-dessus d'un moteur Elasticsearch). Si l'un des champs
 * s'avère un jour différent de ce qui est tenté ici, le résultat le plus
 * probable est une liste vide (« aucun résultat ») plutôt qu'une exception —
 * jamais un plantage de l'écran de recherche.
 */
function parseSearchResponse(json) {
  const rawList = json?.hits ?? json?.results ?? json?.products ?? json?.items ?? [];
  const list = Array.isArray(rawList) ? rawList : [];
  const products = list.map((item) => item?.document ?? item?._source ?? item).filter(Boolean);
  const count = Number(json?.count ?? json?.total ?? json?.total_count) || 0;
  return { products, count };
}

/**
 * Search-a-licious peut renvoyer des produits ne correspondant qu'à UN SEUL
 * des mots cherchés (voire indirectement, via un autre champ indexé que le
 * nom/la marque), sans qu'un paramètre de tri par pertinence texte ait pu
 * être confirmé (cf. commentaire d'en-tête : schéma/API non vérifiables avec
 * certitude depuis ce bac à sable). Repéré en usage réel (retour
 * utilisateur) : « pinsa harrys » renvoyait une vingtaine de résultats
 * hétéroclites, quand le site OFF lui-même, sur la même recherche, n'en
 * affiche qu'un seul. On resserre donc côté client en ne gardant que les
 * produits dont le nom OU la marque contiennent TOUS les mots tapés
 * (recherche « ET », jamais « OU ») — jamais une liste totalement vide pour
 * autant : si ce resserrement n'en garde aucun (ex. les mots sont répartis
 * sur d'autres champs que nom/marque, ou l'orthographe diffère), on retombe
 * sur la liste complète plutôt que de masquer un résultat que ce filtre,
 * volontairement simple, aurait raté à tort.
 */
function filterRelevantProducts(products, terms) {
  const words = normalizeWords(terms).trim().split(' ').filter((w) => w.length >= 2);
  if (!words.length) return products;
  return products.filter((p) => {
    const haystack = normalizeWords(
      [p.product_name_fr, p.product_name, p.generic_name_fr, p.generic_name, p.brands].filter(Boolean).join(' ')
    );
    return words.every((w) => haystack.includes(` ${w} `));
  });
}

/**
 * Recherche textuelle par nom et/ou marque (deux champs distincts, combinables).
 * @returns {Promise<{status:'ok', count, results:[{code,raw,draft}]} | {status:'no-results'} | {status:'error', error} | {status:'aborted'}>}
 */
export async function searchProductsByText({ name = '', brand = '' } = {}, { signal, page = 1, pageSize = 20 } = {}) {
  const terms = [name, brand].map((s) => String(s ?? '').trim()).filter(Boolean).join(' ');
  if (!terms) return { status: 'error', error: 'Indique un nom ou une marque.' };
  const params = new URLSearchParams({
    q: terms,
    page: String(page),
    page_size: String(pageSize),
    langs: 'fr',
  });
  const res = await getJson(`${SEARCH_BASE}?${params.toString()}`, signal);
  if (res.aborted) return { status: 'aborted' };
  if (!res.ok) return { status: 'error', error: res.error };
  const { products, count } = parseSearchResponse(res.json);
  if (!products.length) return { status: 'no-results', count: 0, results: [] };
  const relevant = filterRelevantProducts(products, terms);
  const kept = relevant.length ? relevant : products;
  return {
    status: 'ok',
    count: count || products.length,
    results: kept.map((p) => {
      const code = normalizeBarcode(p.code);
      return { code, raw: p, draft: mapOffProductToFoodDraft(p, code) };
    }),
  };
}

/* ------------------------------------------------------------------ */
/* Correspondance OFF -> modèle Nutriplan                              */
/* ------------------------------------------------------------------ */

/** Nombre OFF -> nombre JS, ou `null` si absent/non numérique — ne JAMAIS renvoyer 0 pour une valeur manquante. */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * OFF fournit `brands` comme une chaîne de marques séparées par des virgules
 * (ex. "Danone,Groupe Danone") : on ne garde que la première, Nutriplan
 * n'ayant qu'un seul champ marque par aliment.
 */
function firstBrand(brands) {
  const first = String(brands ?? '').split(',')[0]?.trim();
  return first || '';
}

/**
 * `quantity` OFF est un texte libre ("500 g", "1 L", "4 x 125 g"…), jamais
 * structuré. On ne tente une conversion en grammes que pour le cas simple et
 * non ambigu (un seul nombre + une seule unité reconnue) ; tout le reste
 * (multi-conditionnement, plages, unités inconnues) reste du texte affiché
 * tel quel pour que l'utilisateur complète lui-même `packageWeight` — jamais
 * une estimation approximative présentée comme une valeur fiable.
 */
function parsePackageWeight(quantity) {
  const m = String(quantity ?? '').trim().match(/^(\d+(?:[.,]\d+)?)\s*(kg|g|l|ml)$/i);
  if (!m) return null;
  const value = Number(m[1].replace(',', '.'));
  if (!Number.isFinite(value)) return null;
  const unit = m[2].toLowerCase();
  if (unit === 'kg' || unit === 'l') return Math.round(value * 1000);
  return Math.round(value);
}

/**
 * Supprime le préfixe de langue des tags OFF (ex. "en:gluten" -> "gluten")
 * pour un affichage lisible — jamais utilisé pour une comparaison logique.
 */
const stripLangPrefix = (tag) => String(tag ?? '').replace(/^[a-z]{2,3}:/, '').replace(/-/g, ' ');

/**
 * Convertit une fiche produit OFF en brouillon partiel d'aliment Nutriplan.
 * Ne renvoie QUE les champs effectivement disponibles (jamais de 0 ni de
 * chaîne vide à la place d'une valeur absente) — à l'appelant de fusionner
 * avec un brouillon existant ou `blank()`. `category` est déduite via
 * suggestCategoryFromOff() (off-category.js, module dédié et testé
 * séparément) UNIQUEMENT quand la correspondance est fiable et sans
 * ambiguïté ; sinon le champ est absent du brouillon (jamais une valeur
 * inventée ni « Autre » par défaut) et l'utilisateur la choisit lui-même,
 * exactement comme à la création manuelle. Dans tous les cas, reste
 * modifiable avant ET après enregistrement — ceci ne fait que préremplir la
 * valeur par défaut du formulaire, jamais une décision figée.
 */
export function mapOffProductToFoodDraft(p, code) {
  if (!p) return null;
  const n = p.nutriments || {};
  const name = p.product_name_fr?.trim() || p.product_name?.trim() || p.generic_name_fr?.trim() || p.generic_name?.trim() || '';
  const allergens = [...(p.allergens_tags || []), ...(p.traces_tags || [])].map(stripLangPrefix);
  const categorySuggestion = suggestCategoryFromOff({ categoriesTags: p.categories_tags, name });
  const draft = {
    barcode: code || normalizeBarcode(p.code) || null,
    name,
    ...(categorySuggestion ? { category: categorySuggestion.category } : {}),
    brand: firstBrand(p.brands),
    // kcal : uniquement le champ kcal direct ('energy-kcal_100g'), jamais
    // dérivé de l'énergie en kJ ('energy_100g') — cette dernière n'a pas pu
    // être vérifiée comme systématiquement exprimée dans la même unité sur
    // toutes les fiches, et une conversion incertaine est pire qu'une
    // valeur absente (cf. règle « ne jamais déduire une valeur »).
    kcal: num(n['energy-kcal_100g']),
    protein: num(n.proteins_100g),
    carbs: num(n.carbohydrates_100g),
    fat: num(n.fat_100g),
    fiber: num(n.fiber_100g),
    satFat: num(n['saturated-fat_100g']),
    sugars: num(n.sugars_100g),
    salt: num(n.salt_100g),
    sodium: num(n.sodium_100g),
    packageWeight: parsePackageWeight(p.quantity),
    offQuantity: p.quantity?.trim() || null,
    nutriScore: p.nutriscore_grade ? String(p.nutriscore_grade).toLowerCase() : null,
    novaGroup: num(p.nova_group),
    ecoScore: p.ecoscore_grade ? String(p.ecoscore_grade).toLowerCase() : null,
    ingredientsText: p.ingredients_text_fr?.trim() || p.ingredients_text?.trim() || null,
    allergensText: allergens.length ? allergens.join(', ') : null,
    imageUrl: p.image_front_url || p.image_url || null,
    imageThumbUrl: p.image_front_small_url || null,
    offUrl: p.url || (code ? `https://world.openfoodfacts.org/product/${code}` : null),
    offFetchedAt: new Date().toISOString(),
  };
  return draft;
}
