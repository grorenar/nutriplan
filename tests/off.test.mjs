/**
 * Tests du service Open Food Facts (js/core/off.js) — correspondance des
 * champs, gestion des unités, des valeurs absentes/nulles, des erreurs
 * réseau/HTTP, et des deux endpoints (code-barres vs recherche texte).
 *
 *   node tests/off.test.mjs
 *
 * AUCUN appel réseau réel : `fetch` est entièrement simulé ci-dessous, avec
 * des réponses construites à partir de la structure JSON réellement
 * documentée d'Open Food Facts (champs `nutriments`, enveloppe
 * status/code/product pour la fiche produit, count/products pour la
 * recherche). Cette suite ne dépend donc jamais de la disponibilité du
 * service distant.
 */

import {
  normalizeBarcode, fetchProductByBarcode, searchProductsByText, mapOffProductToFoodDraft,
} from '../js/core/off.js';

let passed = 0;
const failures = [];
let currentTest = '';

function test(name, fn) {
  currentTest = name;
  try {
    fn();
    console.log(`\n✔ ${name}`);
  } catch (e) {
    console.log(`\n✘ ${name}\n   ${e.message}`);
    failures.push(`${name} — ${e.message}`);
  }
}
async function testAsync(name, fn) {
  currentTest = name;
  try {
    await fn();
    console.log(`\n✔ ${name}`);
  } catch (e) {
    console.log(`\n✘ ${name}\n   ${e.message}`);
    failures.push(`${name} — ${e.message}`);
  }
}
function check(label, condition, detail = '') {
  if (condition) { passed++; console.log(`   ok   ${label}${detail ? ` — ${detail}` : ''}`); }
  else { failures.push(`${currentTest} / ${label}${detail ? ` (${detail})` : ''}`); console.log(`   FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}

/* ---------------------------------------------------------------- fetch simulé */

const realFetch = globalThis.fetch;
function mockFetchOnce(impl) { globalThis.fetch = impl; }
function restoreFetch() { globalThis.fetch = realFetch; }
const jsonRes = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });

/* ---------------------------------------------------------------- normalizeBarcode */

test('normalizeBarcode() : toujours une chaîne, zéro initial préservé, jamais Number()', () => {
  check('zéro initial préservé', normalizeBarcode('03017620422003') === '03017620422003');
  check('espaces/tirets retirés (saisie ou scanner)', normalizeBarcode(' 3 017-620-422003 ') === '3017620422003');
  check('type chaîne, même sur une entrée qui ressemble à un nombre', typeof normalizeBarcode('3017620422003') === 'string');
  check('entrée vide -> chaîne vide', normalizeBarcode('') === '' && normalizeBarcode(null) === '' && normalizeBarcode(undefined) === '');
});

/* ---------------------------------------------------------------- mapOffProductToFoodDraft */

test('mapOffProductToFoodDraft() : valeur absente -> null, jamais 0 ; valeur 0 réelle -> 0, jamais confondue', () => {
  const p = {
    product_name: 'Yaourt nature', brands: 'Danone,Groupe Danone', quantity: '500 g',
    nutriments: {
      'energy-kcal_100g': 60, proteins_100g: 4, carbohydrates_100g: 5, fat_100g: 1.5,
      sugars_100g: 0, // vraie valeur zéro (ex. produit sans sucre) — ne doit pas devenir "absente"
      // fiber_100g, salt_100g, sodium_100g, saturated-fat_100g : volontairement absents
    },
  };
  const d = mapOffProductToFoodDraft(p, '3017620422003');
  check('nom repris', d.name === 'Yaourt nature');
  check('une seule marque gardée (première avant la virgule)', d.brand === 'Danone');
  check('kcal repris tel quel', d.kcal === 60);
  check('sucres = 0 (vraie valeur) PRÉSERVÉE, jamais null', d.sugars === 0);
  check('fibre absente -> null (jamais 0)', d.fiber === null);
  check('sel absent -> null (jamais 0, jamais confondu avec sodium)', d.salt === null);
  check('sodium absent -> null, indépendant du sel', d.sodium === null);
  check('graisses saturées absentes -> null', d.satFat === null);
  check('quantité simple "500 g" convertie en packageWeight = 500', d.packageWeight === 500);
  check('texte brut de la quantité conservé telle quelle', d.offQuantity === '500 g');
  check('code-barres repris, sous forme de chaîne', d.barcode === '3017620422003' && typeof d.barcode === 'string');
  check('offFetchedAt renseigné (traçabilité)', typeof d.offFetchedAt === 'string' && d.offFetchedAt.length > 0);
});

test('mapOffProductToFoodDraft() : kcal jamais dérivé de l’énergie en kJ (ambiguïté d’unité)', () => {
  const p = { product_name: 'Test', nutriments: { energy_100g: 250 /* kJ, pas kcal */ } };
  const d = mapOffProductToFoodDraft(p, '123');
  check('energy-kcal_100g absent -> kcal reste null (pas de conversion depuis energy_100g/kJ)', d.kcal === null);
});

test('mapOffProductToFoodDraft() : dénomination française privilégiée quand disponible', () => {
  const d1 = mapOffProductToFoodDraft({ product_name: 'Plain yogurt', product_name_fr: 'Yaourt nature', nutriments: {} }, '1');
  check('product_name_fr préféré à product_name', d1.name === 'Yaourt nature');
  const d2 = mapOffProductToFoodDraft({ product_name: 'Plain yogurt', nutriments: {} }, '2');
  check('repli sur product_name si pas de version française', d2.name === 'Plain yogurt');
});

test('mapOffProductToFoodDraft() : quantité ambiguë (multi-conditionnement) jamais devinée', () => {
  const d = mapOffProductToFoodDraft({ product_name: 'Compotes', quantity: '4 x 90 g', nutriments: {} }, '1');
  check('packageWeight reste null (pas de parsing hasardeux d’un multi-pack)', d.packageWeight === null);
  check('le texte brut reste affiché pour complément manuel', d.offQuantity === '4 x 90 g');
});

test('mapOffProductToFoodDraft() : unités simples reconnues (kg, L) converties en grammes', () => {
  check('"1 kg" -> 1000', mapOffProductToFoodDraft({ nutriments: {}, quantity: '1 kg' }, '1').packageWeight === 1000);
  check('"1 L" -> 1000', mapOffProductToFoodDraft({ nutriments: {}, quantity: '1 L' }, '1').packageWeight === 1000);
  check('"250 ml" -> 250', mapOffProductToFoodDraft({ nutriments: {}, quantity: '250 ml' }, '1').packageWeight === 250);
});

test('mapOffProductToFoodDraft() : indicateurs complémentaires (Nutri-Score, NOVA, Eco-Score, ingrédients, allergènes)', () => {
  const d = mapOffProductToFoodDraft({
    nutriments: {}, nutriscore_grade: 'B', nova_group: 3, ecoscore_grade: 'c',
    ingredients_text_fr: 'Lait, ferments lactiques.',
    allergens_tags: ['en:milk'], traces_tags: ['en:gluten'],
  }, '1');
  check('Nutri-Score normalisé en minuscule', d.nutriScore === 'b');
  check('groupe NOVA repris comme nombre', d.novaGroup === 3);
  check('Eco-Score repris', d.ecoScore === 'c');
  check('texte des ingrédients repris', d.ingredientsText === 'Lait, ferments lactiques.');
  check('allergènes ET traces combinés, préfixe de langue retiré', d.allergensText === 'milk, gluten');
});

test('mapOffProductToFoodDraft() : préparation OFF reprise telle quelle dans "instructions" (retour utilisateur)', () => {
  const d1 = mapOffProductToFoodDraft({
    nutriments: {},
    preparation: 'Bake at 220°C.',
    preparation_fr: 'Enfourner 5 minutes à 220°, chaleur tournante.',
  }, '1');
  check('version française privilégiée quand disponible', d1.instructions === 'Enfourner 5 minutes à 220°, chaleur tournante.');
  const d2 = mapOffProductToFoodDraft({ nutriments: {}, preparation: 'Bake at 220°C.' }, '2');
  check('repli sur la version non traduite si pas de version française', d2.instructions === 'Bake at 220°C.');
  const d3 = mapOffProductToFoodDraft({ nutriments: {} }, '3');
  check('absente de la fiche OFF -> null, jamais une chaîne vide inventée', d3.instructions === null);
});

test('mapOffProductToFoodDraft() : category déduite via suggestCategoryFromOff() quand la correspondance est fiable', () => {
  const d = mapOffProductToFoodDraft({ nutriments: {}, categories_tags: ['en:yogurts', 'en:dairies'] }, '1');
  check('catégorie Nutriplan correctement déduite (laitier)', d.category === 'laitier');
});

test('mapOffProductToFoodDraft() : category ABSENTE du brouillon quand aucune suggestion fiable (jamais inventée)', () => {
  const d1 = mapOffProductToFoodDraft({ nutriments: {}, categories_tags: ['en:snacks'] }, '1');
  check('tag OFF inconnu de la table -> aucun champ "category"', !('category' in d1));
  const d2 = mapOffProductToFoodDraft({ nutriments: {} }, '1');
  check('categories_tags absent -> aucun champ "category"', !('category' in d2));
  // Détail OFF : "Beurres salés" porte à la fois "Produits laitiers" ET
  // "Matières grasses" (ancêtres automatiques) — deux catégories Nutriplan
  // différentes -> ambigu, jamais une certitude artificielle.
  const d3 = mapOffProductToFoodDraft({ nutriments: {}, categories_tags: ['en:dairies', 'en:fats'] }, '1');
  check('tags pointant vers deux catégories Nutriplan différentes -> ambigu, aucun champ "category"', !('category' in d3));
});

/* ---------------------------------------------------------------- fetchProductByBarcode */

await testAsync('fetchProductByBarcode() : produit trouvé', async () => {
  mockFetchOnce(async (url) => {
    // chemin stable que OFF_PROXY_URL soit configuré ou non (direct :
    // world.openfoodfacts.org/api/v2/product/…, proxié : {OFF_PROXY_URL}/product/…
    // — seul l'hôte et le préfixe /api/v2 changent, jamais /product/{code}.json).
    check('endpoint fiche produit (code-barres dans l’URL)', /\/product\/3017620422003\.json/.test(url));
    check('les champs demandés sont limités via `fields=` (pas une fiche complète inutile)', /fields=/.test(url));
    return jsonRes({ status: 1, status_verbose: 'product found', code: '3017620422003', product: { product_name: 'Nutella', nutriments: { 'energy-kcal_100g': 539 } } });
  });
  const res = await fetchProductByBarcode('3017620422003');
  check('status = found', res.status === 'found');
  check('code renvoyé', res.code === '3017620422003');
  check('brouillon construit', res.draft?.name === 'Nutella' && res.draft.kcal === 539);
  restoreFetch();
});

await testAsync('fetchProductByBarcode() : code-barres inconnu de la base', async () => {
  mockFetchOnce(async () => jsonRes({ status: 0, status_verbose: 'product not found', code: '0000000000000' }));
  const res = await fetchProductByBarcode('0000000000000');
  check('status = not-found (pas une erreur)', res.status === 'not-found');
  restoreFetch();
});

await testAsync('fetchProductByBarcode() : code-barres vide', async () => {
  const res = await fetchProductByBarcode('   ');
  check('status = error sans même tenter de requête réseau', res.status === 'error');
  check('message explicite', /vide/i.test(res.error));
});

await testAsync('fetchProductByBarcode() : erreur réseau (fetch rejette)', async () => {
  mockFetchOnce(async () => { throw new TypeError('Failed to fetch'); });
  const res = await fetchProductByBarcode('123');
  check('status = error', res.status === 'error');
  check('message explicite sur la connexion', /connexion|réseau/i.test(res.error));
  restoreFetch();
});

await testAsync('fetchProductByBarcode() : erreur HTTP (ex. 503, quota dépassé)', async () => {
  mockFetchOnce(async () => jsonRes({}, 503));
  const res = await fetchProductByBarcode('123');
  check('status = error', res.status === 'error');
  check('code HTTP mentionné', /503/.test(res.error));
  restoreFetch();
});

await testAsync('fetchProductByBarcode() : réponse illisible (JSON invalide)', async () => {
  mockFetchOnce(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } }));
  const res = await fetchProductByBarcode('123');
  check('status = error plutôt qu’une exception non interceptée', res.status === 'error');
  restoreFetch();
});

await testAsync('fetchProductByBarcode() : requête annulée (AbortController)', async () => {
  mockFetchOnce(async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; });
  const res = await fetchProductByBarcode('123', { signal: new AbortController().signal });
  check('status = aborted, jamais présenté comme une erreur à l’utilisateur', res.status === 'aborted');
  restoreFetch();
});

/* ---------------------------------------------------------------- searchProductsByText */

await testAsync('searchProductsByText() : recherche texte — endpoint DISTINCT de la fiche produit (Search-a-licious)', async () => {
  let calledUrl = null;
  mockFetchOnce(async (url) => {
    calledUrl = url;
    return jsonRes({
      count: 2,
      hits: [
        { code: '111', product_name: 'Yaourt nature', brands: 'MarqueA', nutriments: { 'energy-kcal_100g': 60 } },
        { code: '222', product_name: 'Yaourt nature allégé', brands: 'MarqueB', nutriments: { 'energy-kcal_100g': 45 } },
      ],
    });
  });
  const res = await searchProductsByText({ name: 'yaourt nature', brand: '' });
  // chemin stable que OFF_PROXY_URL soit configuré ou non — jamais le même
  // chemin que la fiche produit par code-barres, dans les deux cas.
  check('endpoint de recherche, jamais le même chemin que la fiche produit', /\/search\?/.test(calledUrl) && !/\/product\//.test(calledUrl));
  check('terme de recherche transmis', /q=/.test(calledUrl));
  check('status = ok avec 2 résultats', res.status === 'ok' && res.results.length === 2);
  check('chaque résultat porte son brouillon mappé', res.results[0].draft.name === 'Yaourt nature' && res.results[1].draft.kcal === 45);
  restoreFetch();
});

await testAsync('searchProductsByText() : analyse tolérante — autre nom de clé pour la liste de résultats', async () => {
  // le schéma exact de Search-a-licious n'a pas pu être vérifié avec
  // certitude (cf. commentaire d'en-tête de off.js) : vérifie que la lecture
  // reste correcte si la clé s'avère être "results" plutôt que "hits".
  mockFetchOnce(async () => jsonRes({
    total: 1,
    results: [{ code: '333', product_name: 'Compote Test', nutriments: {} }],
  }));
  const res = await searchProductsByText({ name: 'compote' });
  check('status = ok malgré une clé de résultats différente de "hits"', res.status === 'ok' && res.results.length === 1);
  check('total repris depuis "total" si "count" est absent', res.count === 1);
  restoreFetch();
});

await testAsync('searchProductsByText() : résultats hors-sujet écartés — ne garde que les produits dont nom/marque contiennent TOUS les mots cherchés', async () => {
  // Retour utilisateur : « pinsa harrys » renvoyait en production une
  // vingtaine de résultats très hétéroclites (ne matchant qu'un seul des
  // deux mots), alors que le site OFF lui-même n'en affiche qu'un seul.
  mockFetchOnce(async () => jsonRes({
    count: 4,
    hits: [
      { code: '1', product_name: 'Pinsa 230g', brands: 'Harrys', nutriments: {} }, // les deux mots -> gardé
      { code: '2', product_name: 'Pain de mie', brands: 'Harrys', nutriments: {} }, // "harrys" seul -> écarté
      { code: '3', product_name: 'Pinsa 4 fromages', brands: 'Casa Leonardo', nutriments: {} }, // "pinsa" seul -> écarté
      { code: '4', product_name: 'Brioche tranchée', brands: 'Jacquet', nutriments: {} }, // aucun des deux -> écarté
    ],
  }));
  const res = await searchProductsByText({ name: 'pinsa harrys', brand: '' });
  check('un seul résultat conservé, le vrai match', res.status === 'ok' && res.results.length === 1 && res.results[0].code === '1');
  restoreFetch();
});

await testAsync('searchProductsByText() : un nombre isolé dans la saisie (quantité séparée par un espace) n\'empêche pas le filtre de fonctionner', async () => {
  // Retour utilisateur : taper le titre exact « Pinsa 230g – Harrys – 230 g »
  // (avec la quantité répétée, séparée par un espace) faisait exiger le mot
  // isolé "230", absent de la fiche ("230g" y est collé) -> plus aucun
  // produit ne matchait tout, y compris le bon -> repli sur liste complète.
  mockFetchOnce(async () => jsonRes({
    count: 2,
    hits: [
      { code: '1', product_name: 'Pinsa 230g', brands: 'Harrys', nutriments: {} },
      { code: '2', product_name: 'Confiture de fraise', brands: 'Albert Ménès', nutriments: {} },
    ],
  }));
  const res = await searchProductsByText({ name: 'Pinsa 230g – Harrys – 230 g', brand: '' });
  check('le bon produit reste trouvé malgré le "230" isolé dans la saisie', res.status === 'ok' && res.results.length === 1 && res.results[0].code === '1');
  restoreFetch();
});

await testAsync('searchProductsByText() : filtre « tous les mots » jamais trop strict — repli sur la liste complète si personne ne matche tout', async () => {
  // Si le resserrement ne garde aucun produit (mots répartis ailleurs que
  // nom/marque, orthographe différente…), mieux vaut montrer une liste trop
  // large que de cacher à tort un résultat pertinent que ce filtre simple
  // n'aurait pas su reconnaître.
  mockFetchOnce(async () => jsonRes({
    count: 2,
    hits: [
      { code: '1', product_name: 'Yaourt nature', brands: 'MarqueA', nutriments: {} },
      { code: '2', product_name: 'Fromage blanc', brands: 'MarqueB', nutriments: {} },
    ],
  }));
  const res = await searchProductsByText({ name: 'produit totalement absent des deux fiches', brand: '' });
  check('repli sur les 2 résultats renvoyés par OFF, rien de masqué', res.status === 'ok' && res.results.length === 2);
  restoreFetch();
});

await testAsync('searchProductsByText() : nom et marque combinables', async () => {
  let calledUrl = null;
  mockFetchOnce(async (url) => { calledUrl = url; return jsonRes({ count: 0, hits: [] }); });
  await searchProductsByText({ name: 'yaourt', brand: 'Danone' });
  check('les deux champs sont présents dans la requête envoyée', calledUrl.includes('yaourt') && calledUrl.includes('Danone'));
  restoreFetch();
});

await testAsync('searchProductsByText() : recherche sans résultat', async () => {
  mockFetchOnce(async () => jsonRes({ count: 0, hits: [] }));
  const res = await searchProductsByText({ name: 'produit totalement inexistant xyz123' });
  check('status = no-results', res.status === 'no-results');
  restoreFetch();
});

await testAsync('searchProductsByText() : réponse sans clé de résultats reconnue — liste vide, jamais un plantage', async () => {
  mockFetchOnce(async () => jsonRes({ unexpected_shape: true }));
  const res = await searchProductsByText({ name: 'test' });
  check('status = no-results plutôt qu’une exception non interceptée', res.status === 'no-results');
  restoreFetch();
});

await testAsync('searchProductsByText() : ni nom ni marque fournis', async () => {
  const res = await searchProductsByText({ name: '  ', brand: '' });
  check('status = error sans requête réseau', res.status === 'error');
});

await testAsync('searchProductsByText() : erreur réseau', async () => {
  mockFetchOnce(async () => { throw new TypeError('network down'); });
  const res = await searchProductsByText({ name: 'test' });
  check('status = error', res.status === 'error');
  restoreFetch();
});

await testAsync('searchProductsByText() : erreur HTTP', async () => {
  mockFetchOnce(async () => jsonRes({}, 500));
  const res = await searchProductsByText({ name: 'test' });
  check('status = error avec le code HTTP', res.status === 'error' && /500/.test(res.error));
  restoreFetch();
});

await testAsync('searchProductsByText() : requête annulée (recherche plus récente démarrée entre-temps)', async () => {
  mockFetchOnce(async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; });
  const res = await searchProductsByText({ name: 'test' }, { signal: new AbortController().signal });
  check('status = aborted', res.status === 'aborted');
  restoreFetch();
});

/* ---------------------------------------------------------------- bilan */

console.log('\n' + '='.repeat(60));
console.log(`${passed} vérifications réussies, ${failures.length} échec(s).`);
if (failures.length) {
  console.log('\nÉchecs :');
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
}
