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
 *   - recherche texte : /cgi/search.pl?search_terms=…&json=1 (« Search API
 *     v2 », endpoint historique mais toujours en production). Search-a-licious
 *     (search.openfoodfacts.org) est le futur remplaçant officiellement
 *     annoncé, mais encore en bêta à l'écriture de ce module, avec un schéma
 *     de réponse non confirmé et un signalement (issue GitHub publique) d'un
 *     index de production resté désynchronisé plusieurs mois — risque jugé
 *     trop élevé pour une implémentation qui ne peut pas être testée en
 *     direct ici. Documenté dans le README (§ Open Food Facts).
 *
 * Aucune clé API n'est nécessaire (lecture publique). OFF demande un
 * User-Agent personnalisé pour identifier l'appli cliente — un navigateur
 * REFUSE qu'une page web positionne cet en-tête sur une requête fetch()
 * (« forbidden header name », imposé par le navigateur lui-même, pas
 * contournable côté client) : limitation documentée, sans solution côté
 * navigateur pur sans serveur proxy (hors de portée ici, cf. README).
 *
 * Respecte les limites publiées par OFF (documentation officielle) :
 * 15 req/min/IP pour la lecture de fiches produit, 10 req/min/IP pour la
 * recherche — largement au-delà de ce qu'un usage manuel, à deux personnes,
 * peut générer ; la temporisation (debounce) de la recherche texte côté
 * interface (foods.js) les respecte par construction.
 */

const PRODUCT_BASE = 'https://world.openfoodfacts.org/api/v2/product';
const SEARCH_BASE = 'https://world.openfoodfacts.org/cgi/search.pl';

const PRODUCT_FIELDS = [
  'code', 'product_name', 'product_name_fr', 'generic_name', 'generic_name_fr',
  'brands', 'quantity', 'categories_tags',
  'image_front_url', 'image_front_small_url', 'image_url', 'url',
  'nutriments', 'nutriscore_grade', 'nova_group', 'ecoscore_grade',
  'ingredients_text', 'ingredients_text_fr', 'allergens_tags', 'traces_tags',
].join(',');

// Liste volontairement plus courte pour la recherche (plusieurs résultats à
// la fois) : seulement ce qui est affiché dans la liste de résultats.
const SEARCH_FIELDS = [
  'code', 'product_name', 'product_name_fr', 'brands', 'quantity',
  'image_front_small_url', 'nutriments', 'nutriscore_grade',
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
 * Recherche textuelle par nom et/ou marque (deux champs distincts, combinables).
 * @returns {Promise<{status:'ok', count, results:[{code,raw,draft}]} | {status:'no-results'} | {status:'error', error} | {status:'aborted'}>}
 */
export async function searchProductsByText({ name = '', brand = '' } = {}, { signal, page = 1, pageSize = 20 } = {}) {
  const terms = [name, brand].map((s) => String(s ?? '').trim()).filter(Boolean).join(' ');
  if (!terms) return { status: 'error', error: 'Indique un nom ou une marque.' };
  const params = new URLSearchParams({
    search_terms: terms,
    json: '1',
    page: String(page),
    page_size: String(pageSize),
    fields: SEARCH_FIELDS,
    // popularité d'usage plutôt que pertinence textuelle brute : les
    // produits génériques/mal renseignés remontent moins souvent en tête.
    sort_by: 'unique_scans_n',
    lc: 'fr',
  });
  const res = await getJson(`${SEARCH_BASE}?${params.toString()}`, signal);
  if (res.aborted) return { status: 'aborted' };
  if (!res.ok) return { status: 'error', error: res.error };
  const products = Array.isArray(res.json?.products) ? res.json.products : [];
  if (!products.length) return { status: 'no-results', count: 0, results: [] };
  return {
    status: 'ok',
    count: Number(res.json.count) || products.length,
    results: products.map((p) => {
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
 * avec un brouillon existant ou `blank()`. `category` n'est JAMAIS déduite
 * des catégories OFF (taxonomie trop large et sans correspondance fiable
 * avec les catégories internes de Nutriplan) : l'utilisateur la choisit
 * toujours lui-même, comme à la création manuelle.
 */
export function mapOffProductToFoodDraft(p, code) {
  if (!p) return null;
  const n = p.nutriments || {};
  const name = p.product_name_fr?.trim() || p.product_name?.trim() || p.generic_name_fr?.trim() || p.generic_name?.trim() || '';
  const allergens = [...(p.allergens_tags || []), ...(p.traces_tags || [])].map(stripLangPrefix);
  const draft = {
    barcode: code || normalizeBarcode(p.code) || null,
    name,
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
