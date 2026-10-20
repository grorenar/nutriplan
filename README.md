# Nutriplan — Thomas & Julie

Application web de planification nutritionnelle et de batch cooking pour deux personnes.
Frontend statique (HTML / CSS / JavaScript modules, aucune dépendance de build), données locales
avec synchronisation Supabase optionnelle.

---

## 1. Architecture

```
index.html                point d'entrée unique
css/app.css               interface
css/print.css             impression A4 (#print uniquement)
js/config.js              ← les 2 clés Supabase à renseigner
js/app.js                 coquille : navigation, rendu de la vue active, cycle de sync
js/core/util.js           formatage, helpers
js/core/nutrition.js      MOTEUR : macros, conversions cru/cuit, ajustement automatique
js/core/meal-volume.js    analyse du volume d'un repas — couche informative, séparée du moteur
js/core/seed-foods.js     banque alimentaire initiale (~95 aliments génériques)
js/core/store.js          état applicatif, localStorage, export/import
js/core/derive.js         batch cooking, liste de courses, budget, suggestions
js/core/similarity.js     détection d'aliments similaires (avertissement uniquement)
js/core/sync.js           Supabase : auth + envoi/récupération atomiques
js/core/off.js            recherche Open Food Facts (code-barres, nom/marque)
js/core/off-category.js   suggestion de catégorie Nutriplan depuis une fiche Open Food Facts
js/core/barcode-scanner.js lecture de codes-barres par caméra (démarrage/arrêt du flux vidéo)
js/views/barcode-panel.js panneau scanner partagé (caméra/flash/choix d'objectif) — utilisé par
                          foods.js, editor.js et recipes.js, jamais dupliqué entre les trois
js/views/food-picker.js  filtrage d'aliments (texte + catégorie/favoris/récents) et chips de
                          filtre partagés entre la recherche d'ingrédients de l'éditeur de repas
                          et celle de l'éditeur de recettes — même capacités de filtrage partout
js/views/*.js             une vue par écran (dont recipes.js, preparations.js) + l'éditeur de
                          repas partagé (editor.js) + les dialogues de confirmation réutilisables
                          (confirm-unsaved.js, confirm-similar.js, confirm-action.js — toute
                          action destructrice/irréversible passe par ce dernier, plus de
                          `confirm()` natif nulle part dans l'application)
supabase/schema.sql       schéma PostgreSQL + RLS par compte + fonction transactionnelle
cloudflare-worker/        proxy CORS pour Open Food Facts (voir §7, recherche par nom/marque)
tests/engine.test.mjs     moteur nutritionnel, batch, courses, recettes/préparations (aucune dépendance)
tests/volume.test.mjs     analyse du volume d'un repas (aucune dépendance)
tests/sync.test.mjs       schéma + transaction + RLS, sur un PostgreSQL local
tests/autosync.test.mjs   synchronisation automatique (client Supabase simulé, aucune dépendance)
tests/off.test.mjs        recherche Open Food Facts (aucune dépendance)
tests/off-category.test.mjs  suggestion de catégorie depuis une fiche Open Food Facts (aucune dépendance)
tests/barcode-scanner.test.mjs  lecture de codes-barres par caméra (aucune dépendance)
tests/ui.test.mjs         parcours complet de l'interface (jsdom)
```

Séparation stricte : `core/nutrition.js` et `core/derive.js` ne touchent jamais au DOM et ne
connaissent ni le stockage ni le réseau. Ce sont des fonctions pures, directement testables.

`package.json`/`package-lock.json` n'existent que pour l'outillage de test (`jsdom`, requis par
`tests/ui.test.mjs`) : l'application déployée elle-même n'a toujours aucune dépendance ni étape de
build — `node_modules/` reste ignoré par git, seul `npm ci` le recrée.

## 2. Modèle de données

État applicatif (et fichier d'export JSON) :

```
foods[]            id, name, category, brand, kcal, protein, carbs, fat, fiber,
                   referenceState, cookedFactor, unitName, gramsPerUnit, fractionable,
                   unitEntry, price, packageWeight, batchAllowed, shelfLifeDays,
                   requiresCooking, favorite,
                   cookingMethod, cookingTemp, cookingTime, prepTime, equipment, instructions,
                   — Open Food Facts (§7, purement informatifs, jamais utilisés par le moteur
                   nutritionnel ci-dessus) : barcode (chaîne, jamais un nombre — préserve un zéro
                   initial), satFat, sugars, salt, sodium, nutriScore, novaGroup, ecoScore,
                   ingredientsText, allergensText, imageUrl, imageThumbUrl, offUrl, offQuantity,
                   offFetchedAt — tous `null` par défaut, jamais 0 ni '' pour une valeur absente
recipes[]          id, name, kind(weight|portion), baseGrams, items[] (recette, cf. items[] ci-dessous),
                   batchAllowed, shelfLifeDays, cookingMethod, cookingTemp, cookingTime, prepTime,
                   equipment, instructions
preparations[]     id, recipeId, label, preparedQuantity, createdAt, recipeSnapshot (copie figée
                   de la recette au moment de la création — jamais mise à jour si la recette
                   change ensuite), remainingAtReset (stock figé au dernier reset de cycle,
                   null = jamais reseté), lastResetAt (fenêtre de comptage des pertes),
                   losses[] ({id, qty, at} — jamais effacé, historique de « Jeter les restes »)
settings           targets{thomas|julie}{day|breakfast|lunch|snack_afternoon|dinner|snack_evening}
                   tolerance, cycle{startWeekday,duration}, budget, batch{enabled,maxDays}, autoAdjust
meals[]            id, dayIndex, mealType(lunch|dinner), name, nameAuto (true = `name` régénéré
                   depuis la composition à chaque modification ; false = nom saisi, jamais écrasé),
                   sameComposition, items[]
breakfasts[]       id, name, sameComposition, uses{thomas,julie}, items[]
snacks[]           id, name, sameComposition, targetSlot, items[],
                   uses{thomas:{afternoon,evening}, julie:{afternoon,evening}}
items[]            id, foodId|null, recipeId|null (référence directe à une recette, sans
                   préparation), preparationId|null (utilisation ferme d'une préparation en stock,
                   avec zeroWaste optionnel), free{name,quantity}|null, state,
                   qty{thomas,julie}, locked{thomas,julie}
shopping.purchased {foodId: bool}        ← simple case "acheté", aucun stock
batch.overrides    {"session:foodId": grammes préparés} ou {"session:recipe:recipeId": grammes}
                   pour une recette préparée en batch (cf. §4, écran Batch cooking)
dismissedDuplicates[]  clés de groupes de « doublons possibles » écartés par l'utilisateur
                   (« pas un doublon », §4 écran Aliments) — chaîne = identifiants triés de tous
                   les membres du groupe joints par "|" (similarity.js::duplicateGroupKey())
```

Côté PostgreSQL, la même chose est normalisée dans `supabase/schema.sql` — 15 tables au total :
`foods`, `recipes`, `recipe_items`, `preparations`, `preparation_losses`, `targets`, `settings`,
`meals`, `meal_items`, `breakfast_options`, `breakfast_items`, `snack_options`, `snack_items`,
`shopping_items`, `batch_items` (liste authoritative : `TABLES` dans `js/core/sync.js`). Un
ingrédient donne une ligne par personne (colonne `person`), conformément au schéma demandé.

Toutes les valeurs nutritionnelles sont stockées **pour 100 g**, dans l'état de référence de
l'aliment. Tous les calculs internes sont en grammes.

## 3. Logique de calcul et d'ajustement

**États.** Chaque aliment déclare l'**état des valeurs nutritionnelles** saisies pour 100 g
(cru / brut, cuit, égoutté, prêt à consommer). Dans un repas, chaque ingrédient déclare l'état
réellement pesé, affiché à côté de la quantité. Quand les deux diffèrent, la conversion utilise le
rendement après cuisson (200 g cuits ÷ 2,50 = 80 g crus). Aucun coefficient n'est inventé pour les
états « égoutté » et « prêt à consommer » ni quand le rendement n'est pas renseigné : dans ce cas
les macros de l'ingrédient ne sont pas calculées (« — kcal · — P · — G · — L »), il est exclu du
total du repas, et l'éditeur affiche « Conversion impossible » avec la marche à suivre. Deux états
différents ne sont jamais supposés équivalents.

**Macros.** Les grammes saisis sont d'abord ramenés à l'état de référence de l'aliment
(coefficient `cookedFactor`, ex. pâtes 100 g crus → 240 g cuits), puis multipliés par les valeurs
pour 100 g. La cuisson change le poids, jamais les macros.

**Ajustement continu — architecture C (V1.4).** À chaque ajout, suppression, changement de
quantité, d'état ou de verrou, `adjustQuantities()` est relancé pour chaque personne. Il n'y a plus
d'ancrage sur la quantité de départ (mécanisme `anchor` de V1.3, supprimé : il créait un point fixe
mathématique où un légume fortement ancré ne bougeait quasiment jamais). Chaque aliment déverrouillé
a désormais une **référence de portion**, un point de départ pour des proportions réalistes —
**jamais une cible nutritionnelle** :

```
réf = clamp( √(réf_cat × E_cat × 100 / densité) , réf_cat/3 , réf_cat×3 )
```

`réf_cat` est la portion type de la catégorie (`def` dans `CATEGORY_PROFILE`, déjà existante),
`E_cat` l'énergie type d'une portion de cette catégorie (nouveau), `densité` les kcal pour 100 g de
l'aliment dans son état de référence. C'est la moyenne géométrique entre une référence en masse
(chaque aliment de la catégorie : même poids) et une référence iso-énergétique (chaque aliment :
même apport calorique) — elle seule distingue correctement un aliment dense (avocat) d'un aliment
peu dense (courgette) de la même catégorie, sans traiter aucune catégorie comme un cas particulier.
Le clamp ne borne que les densités extrêmes (whey, huile).

Le coût minimisé, par personne :

```
coût = Σ_macro  W · ρ_C( (valeur − cible) / cible )  +  β · [ Σᵢ (uᵢ − ū)²  +  γ · n · ū² ]

  W : kcal 0,35 · P 1,4 · C 1 · L 1
  ρ_C(d) = C · (1 − exp(−d²/2C))     perte bornée (Welsch), C = 0,08
  uᵢ = ln(qᵢ / réfᵢ)                 β = 0,006 · γ = 3
```

Le premier terme rapproche les 4 macros de leurs cibles avec une perte **bornée** : au-delà d'un
certain écart, elle « accepte » de manquer la cible plutôt que de produire une composition absurde
(essayé avec une perte de Huber : elle envoie une macro structurellement inatteignable à sa borne
maximale, car son gradient ne décroît jamais). Le second terme est une **pénalité de disproportion**,
fondée sur des variations relatives aux références (jamais des grammes bruts) : elle pénalise un
aliment qui s'écarte des autres (dispersion) et un repas globalement gonflé ou rétréci (échelle) —
jamais une interdiction absolue.

**Minimisation.** Descente par coordonnées en espace logarithmique ; chaque coordonnée est résolue
par une grille de 48 points puis une recherche en section dorée autour de chaque vallée détectée (le
coût 1D n'est pas garanti unimodal — mesuré). Multi-départ (quantité actuelle, référence, quantité
mise à l'échelle du besoin calorique) : le résultat de coût le plus bas est retenu.

La quantité finale est arrondie : pas de la catégorie pour les aliments fractionnables, unités
entières pour les autres (jamais 1,37 œuf). Aucune logique de pas par aliment dans l'optimiseur —
`roundQuantity()` s'en charge seul, après coup.

**Unités.** Pour tout aliment non fractionnable possédant un poids par unité, la quantité stockée
est toujours un multiple entier de ce poids — que tu saisisses en unités (3 tranches) ou en grammes
(25 g deviennent 22 g pour une tranche de 11 g). La règle est générique et s'applique partout :
planning, petits-déjeuners, collations, ajustement automatique, batch, courses. Le bouton
« Saisie : … » sur la ligne d'ingrédient bascule entre unités et grammes ; les calculs internes
restent en grammes dans les deux cas. Les boutons + et − du champ utilisent le poids d'une unité
comme pas (13 → 26 → 39 → 52 pour une tranche de 13 g), jamais 1 g.

| Catégorie | Bornes | réf_cat (`def`) | E_cat |
|---|---|---|---|
| Protéine | 50–250 g | 150 | 164 |
| Féculent | 20–400 g | 90 | 266 |
| Légumineuse | 40–300 g | 150 | 207 |
| Légume | 60–320 g | 200 | 65 |
| Fruit | 30–260 g | 120 | 78 |
| Produit laitier | 40–500 g | 150 | 112 |
| Matière grasse | 2–45 g | 10 | 90 |
| Noix & graines (id `oleagineux`) | 5–80 g | 20 | 148 |
| Autre | 5–300 g | 60 | 100 |

Les catégories ne sont ni une classification nutritionnelle ni une taxonomie : elles ne donnent
qu'un ordre de grandeur de proportion réaliste dans un repas.

Garanties de l'algorithme :
- une quantité 🔒 verrouillée n'est **jamais** modifiée ;
- une quantité que tu viens de saisir est traitée comme fixe pendant le recalcul (« épinglée ») ;
- aucun aliment n'est jamais ajouté ni supprimé automatiquement ;
- aucun plafond de masse spécifique à une catégorie (la référence en joue déjà le rôle, en plus
  souple, car négociable contre la nutrition au lieu de l'interdire) ;
- si la cible est inatteignable, le repas est conservé tel quel, les écarts sont affichés et une
  piste est proposée (« manque protéine maigre… ») — rien n'est déformé pour atteindre les chiffres.

Le bouton **« Ajuster maintenant »** force un ajustement explicite même quand le réglage
« Ajustement automatique » est décoché — seul l'ajustement déclenché automatiquement (ajout,
saisie, duplication…) reste soumis à ce réglage.

**Tolérance.** ±5 % par défaut (modifiable). Vert = dans la cible, orange = proche, rouge = éloigné.

**Volume du repas (V1.4).** Un repas peut atteindre ses objectifs nutritionnels tout en
représentant une quantité de nourriture très importante à consommer en une seule fois. C'est un
problème **distinct** du problème nutritionnel : `js/core/meal-volume.js` est une couche
strictement séparée de l'optimiseur — purement informative, elle ne modifie jamais une quantité, une
macro, ni l'optimiseur, et ne bloque jamais la validation d'un repas. La supprimer (avec son import
dans l'éditeur) laisse le moteur nutritionnel strictement identique.

La masse d'assiette est la somme des ingrédients dans l'état **réellement présent dans l'assiette**
(pas la somme brute des quantités saisies, qui n'est pas une grandeur physique quand les états
diffèrent) : un ingrédient pesé cru contribue `quantité × cookedFactor`, un ingrédient déjà pesé
cuit / égoutté / prêt contribue sa quantité telle quelle. Un ingrédient pesé cru sans `cookedFactor`
renseigné n'invente aucun facteur : il est exclu du total, qui est alors signalé comme une
estimation partielle.

```
≤ 600 g              aucun avertissement
> 600 g et ≤ 750 g    « Repas volumineux »
> 750 g et ≤ 900 g    « Repas très volumineux »
> 900 g               « Repas extrêmement volumineux »
```

Ces seuils sont des constantes internes (pas de réglage utilisateur en V1.4). L'avertissement
n'apparaît que dans l'éditeur de repas, jamais dans le planning.

## 4. Écrans

| Écran | Contenu |
|---|---|
| Planning | cycle de N jours, déjeuner + dîner par jour, macros des deux personnes visibles sur chaque carte, duplication (nom et `nameAuto` copiés ensemble), « Vider ce repas » (remet le repas à l'état vraiment vide, `nameAuto` repasse à `true`), bouton « Optimiser le cycle » (suggestions uniquement) |
| Aliments | banque complète, recherche, favoris, création/modification/suppression — la suppression est bloquée si l'aliment est encore référencé dans une recette (composition live ou `recipeSnapshot` figé d'une préparation existante), avec un avertissement (non bloquant) s'il est seulement utilisé dans des repas/catalogues ; section dépliable « Doublons possibles » (même détection que la popup de création, `findSimilarFoods`/`findDuplicateGroups`) proposant pour chaque groupe un choix explicite de l'aliment à conserver puis une confirmation bloquante avant toute fusion — jamais de fusion automatique sur la seule similarité de nom — ou, pour un faux positif, de l'écarter définitivement (« Pas un doublon », réversible depuis « Doublons ignorés ») sans toucher aux aliments |
| Recettes | composition à partir de la banque alimentaire, recherche d'ingrédients avec filtres Tous/Favoris/Récents/catégorie (combinables avec la recherche texte, mêmes capacités que l'éditeur de repas — `js/views/food-picker.js`), type `weight` (poids continu, échelle `baseGrams`) ou `portion` (unité indivisible), consignes de cuisson/conservation, `batchAllowed` ; la suppression est bloquée tant qu'une préparation existe pour cette recette, ou qu'elle est encore référencée directement (sans préparation) dans un repas ou un catalogue |
| Préparations et distribution | matérialisation d'une recette en stock réel (quantité préparée, figée dans `recipeSnapshot`), répartition éditable vers les repas, mode zéro reste, jet total ou partiel du reliquat (historique des pertes jamais effacé), suppression définitive d'une préparation (avec avertissement si du stock reste, bloquée tant que des affectations existent) ; une préparation épuisée (stock à 0) est masquée de la liste active sans jamais être supprimée des données ; accessible aussi depuis Batch cooking (bouton « Créer une préparation » sur une recette à préparer — voir ci-dessous), qui ne fait qu'ouvrir ce formulaire préremplie avec la recette et la quantité prévisionnelle, jamais une création automatique |
| Petits-déjeuners | catalogue indépendant, sans jour ni date ; compteur d'utilisations **par personne**, avec contrôle de couverture du cycle |
| Collations | **catalogue unique** : une collation a une composition unique, 16 h et Soir ne sont que des affectations de consommation (compteurs par personne et par créneau) |
| Batch cooking | classement fondé sur deux propriétés explicites de l'aliment — `batchAllowed` puis `requiresCooking`, jamais sur l'état de référence — et plan opératoire par session : **à préparer en batch** (méthode, température, durée, rendement, quantités crues et cuites, consignes, et un champ **« Cuit obtenu »** où noter le poids réellement pesé après cuisson — mesure ponctuelle de cette séance, jamais appliquée seule au rendement enregistré de la fiche aliment ; si l'écart dépasse 15 %, un bouton propose explicitement de mettre à jour ce rendement, avec confirmation), **recettes à préparer en batch** (détail des ingrédients à l'échelle de la quantité réellement préparée, répartition prévue vers les gamelles de la session, et un bouton **« Créer une préparation »** qui ouvre l'écran Préparations avec la recette et la quantité prévisionnelle préremplies — clairement identifiée comme telle, jamais confondue avec une quantité réellement cuisinée ; un signalement non bloquant prévient si une préparation de cette recette est déjà disponible, sans jamais empêcher une nouvelle préparation légitime), **à cuire le jour même**, **à assembler le jour même**, puis le détail de chaque gamelle personne par personne — avec, pour un composant en surplus (préparé ou mesuré au-delà du besoin), une suggestion de service augmenté au prorata de la part déjà prévue de chaque gamelle (`+X g (surplus à servir)`) ; affichage seul, le planning (`meal.items`) n'est jamais modifié, et un déficit n'est jamais répercuté par une réduction silencieuse |
| Courses | tout le cycle (déjeuners, dîners et options de catalogue utilisées) : besoin vs quantité à acheter, surplus, prix, cases à cocher, budget ; les aliments sans prix sont listés par leur nom et cliquables pour ouvrir leur fiche |
| Paramètres | objectifs, cycle, budget, batch, export/import JSON, sauvegarde locale automatique et restauration, réinitialisation du cycle, compte |

Le bouton **Imprimer** (en haut à droite) permet de choisir les sections : planning, batch,
courses, détails nutritionnels, catalogues.

### Export PDF : décision de ne pas ajouter une fonction dédiée

L'impression (`js/views/print.js` + `css/print.css`) construit déjà un document A4 propre et
paginé (titres évitant une coupure de page, lignes de tableau non coupées, en-têtes répétés),
dans un conteneur `#print` dédié masquant tout le reste de l'interface. Or la boîte de dialogue
d'impression de tous les navigateurs courants (desktop et mobile, Chrome/Edge/Firefox/Safari)
propose nativement une destination « Enregistrer au format PDF », qui produit exactement ce même
document en PDF, sans aucun code supplémentaire.

Ajouter une bibliothèque JS de génération PDF (ex. jsPDF) dupliquerait cette mise en forme avec un
rendu presque certainement moins fidèle (polices, tableaux, sauts de page à refaire entièrement
dans l'API du générateur plutôt qu'en CSS), pour un gain nul puisque le résultat — un PDF du même
contenu — est déjà obtenu via le navigateur. Nutriplan étant un site statique sans serveur
(GitHub Pages), une génération PDF côté serveur n'est pas non plus une option sans service externe
payant. Décision : pas de fonction d'export PDF dédiée ; l'impression existante couvre déjà ce
besoin.

### Clavier et performance : revue ciblée (P4), état actuel

Échap ferme déjà les deux gros formulaires (fiche aliment, fiche recette) ainsi que leurs
sous-panneaux (calcul de rendement, doublon détecté, modifications non sauvegardées). Un écouteur
Échap global a été ajouté à la confirmation bloquante générique (`confirm-action.js`, utilisée par
les écrans Aliments, Recettes, Petits-déjeuners/Collations, Préparations, Planning et Paramètres) :
elle se ferme désormais aussi au clavier, sans déclencher l'action. Restent sans fermeture au
clavier, volontairement non traités dans ce lot pour ne pas se précipiter sur plusieurs machines à
états distinctes avec des sous-paniers imbriqués (risque de régression largement supérieur au gain) :
le tiroir de composition d'un repas/petit-déjeuner/collation (`views/editor.js`) et les panneaux
propres à l'écran Préparations (création, jet des restes, suppression, assistant de répartition).
Un clic reste toujours possible pour les fermer ; une revue dédiée pourrait leur ajouter Échap plus
tard en suivant le même principe (fermer le sous-panneau le plus interne avant le conteneur
principal), sans urgence identifiée.

La détection de doublons de l'écran Aliments (`findDuplicateGroups()`, O(n²)) est maintenant mise en
cache côté vue (`getDuplicateGroups()`, `views/foods.js`) : mesurée à plusieurs centaines de
millisecondes dès quelques centaines d'aliments, elle ne tournait auparavant qu'à chaque frappe dans
la recherche ou chaque clic de filtre — sans aucun rapport avec les doublons — ce qui aurait gelé
l'interface sur une banque alimentaire conséquente. Elle ne se recalcule désormais que si la banque
a réellement changé.

## 5. Mise en service

### 5.1 Fonctionnement immédiat (local, sans compte)

Ouvre `index.html` via un petit serveur statique (les modules ES ne se chargent pas en `file://`) :

```bash
python3 -m http.server 8080     # puis http://localhost:8080
```

Tout fonctionne : banque alimentaire, repas, batch, courses, impression, export/import JSON.
Les données sont dans le `localStorage` du navigateur.

### 5.2 GitHub Pages

1. Crée un dépôt et pousse le contenu de ce dossier à la racine.
2. Settings → Pages → Source : `Deploy from a branch`, branche `main`, dossier `/ (root)`.
3. L'application est servie sur `https://<utilisateur>.github.io/<dépôt>/`.

Aucune étape de build : ce sont des fichiers statiques.

### 5.3 Supabase (synchronisation entre appareils)

1. Crée un projet sur supabase.com.
2. SQL Editor → New query → colle **tout** `supabase/schema.sql` → Run.
   (Ce script crée aussi la fonction `nutriplan_replace_all`, indispensable à l'envoi.)
3. Authentication → Providers → Email : activé. (Pratique : désactive « Confirm email » pour
   créer le compte partagé sans validation.)
4. Project Settings → API : copie `Project URL` et la clé `anon public`.
5. Renseigne-les dans **`js/config.js`** :

```js
export const SUPABASE_URL = 'https://xxxxxxxx.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOi...';
```

6. Recharge l'application → Paramètres → Compte : crée le compte partagé, connecte-toi.
   Le premier envoi pousse ta base locale vers Supabase.

La clé `anon` est publique par nature : la sécurité vient de l'authentification et des policies
RLS. Chaque ligne porte un `user_id` (`auth.uid()` par défaut) et n'est lisible ou modifiable que
par le compte propriétaire — un autre utilisateur authentifié de ce projet Supabase ne voit rien.
Un compte Supabase = un espace de données ; Thomas et Julie partagent les identifiants, donc les
données. Aucune notion de workspace ou de membre.

**Envoi atomique.** L'état complet part en un seul appel à `nutriplan_replace_all(payload jsonb)`,
exécutée dans une transaction PostgreSQL : si une insertion échoue, tout est annulé et la base
reste dans son état précédent — jamais à moitié vide. La fonction renvoie le nombre de lignes
écrites par table ; l'envoi n'est considéré réussi qu'après vérification de ces compteurs côté
client. En cas d'échec, les données locales restent la référence, la mention « Échec de
synchronisation » s'affiche dans la barre latérale et les modifications restent en attente.

**Récupération automatique.** Au démarrage, au retour sur l'onglet et au retour de connexion,
l'application interroge `settings.updated_at` — une seule ligne, une seule colonne — et ne
télécharge la base que si cet horodatage a changé depuis la dernière fois que cet appareil l'a vue.
Une modification locale en attente part toujours **avant** toute récupération, donc elle ne peut
jamais être écrasée. « Récupérer du cloud » reste disponible comme forçage manuel, mais n'est plus
nécessaire en usage normal.

Avant de remplacer l'état local par celui du cloud, l'application en conserve
une copie : Paramètres → Compte → « Restaurer la sauvegarde locale » permet de revenir en arrière.

### 5.4 Hors ligne

Toute modification est écrite dans le `localStorage` immédiatement. Si le réseau est absent,
l'application continue de fonctionner et marque les données « à synchroniser » ; l'envoi repart
automatiquement au retour de la connexion (ou via Paramètres → Envoyer vers le cloud).
Comme Thomas et Julie utilisent rarement l'application en même temps sur deux appareils, la
synchronisation reste volontairement un remplacement complet, jamais une fusion champ par champ.
Un seul garde-fou existe : avant d'envoyer, l'application vérifie que cet appareil a bien vu le
dernier état du cloud ; si un autre appareil a synchronisé entre-temps sans que celui-ci l'ait
récupéré, l'envoi est bloqué (message explicite, rien n'est perdu ni écrasé) plutôt que de
remplacer silencieusement les données de l'autre appareil. Paramètres → Compte → « Envoyer vers
le cloud » propose alors de forcer l'envoi si tu es sûr de vouloir remplacer la version distante.

## 6. Catalogues et couverture du cycle

Les petits-déjeuners et les collations ne sont jamais rattachés à une date. On déclare seulement
combien de fois chaque option est utilisée dans le cycle, séparément pour Thomas et Julie — et,
pour les collations, séparément à 16 h et le soir. La même collation peut donc être consommée
3 fois à 16 h et 2 fois le soir sans avoir deux définitions.

L'application compare ces totaux au nombre théorique (un par jour de cycle et par personne) :

```
Thomas  6 / 6 ✓
Julie   5 / 6 ⚠️   il manque 1 option
Julie   7 / 6 ℹ️   1 option supplémentaire est planifiée
```

Rien n'est jamais choisi, ajouté ni corrigé automatiquement. Un bouton « Forcer quand même »
permet d'assumer un cycle volontairement incomplet ; l'avertissement reste affiché.

Les besoins sont ensuite calculés par personne avant agrégation — quantité de Thomas × ses
utilisations + quantité de Julie × les siennes — puis passent dans le système de courses existant
(conditionnements, surplus, prix, budget, case « acheté »). Une collation a un « objectif de
référence » (16 h ou Soir) qui sert uniquement de repère pour les macros et l'ajustement ±5 %.

## 7. Fiche aliment

« Nécessite une cuisson » est une case à cocher de la fiche, indépendante de l'état de référence :
un aliment cru peut se consommer tel quel, un aliment prêt à consommer peut demander une cuisson.
C'est elle, et elle seule, qui distingue « à cuire le jour même » de « à assembler le jour même »
lorsque l'aliment n'est pas batchable. Sur une base créée avant son introduction, la migration
SQL reprend une seule fois l'ancien classement pour les lignes jamais renseignées (colonne NULL),
puis n'y touche plus : rejouer `schema.sql` ne recalcule rien.

Chaque aliment porte ses propres paramètres de préparation : méthode de cuisson, température,
durée, temps de préparation, matériel, consignes libres, la durée maximale de conservation après
préparation (en jours, vide si inconnue) et le **rendement après cuisson**.

Le rendement est un coefficient : **poids cuit ÷ poids cru**. 2,00 signifie que 100 g crus donnent
200 g cuits ; 0,75 que 100 g crus donnent 75 g cuits. Il se saisit directement, ou se calcule via
« Calculer le rendement » : on entre un poids cru et un poids cuit réellement pesés, l'application
affiche le coefficient et l'équivalence pour 100 g, puis « Utiliser ce rendement » le reporte dans
la fiche. Les poids vides, négatifs, non numériques ou nuls sont refusés avec un message ; aucune
division par zéro n'est possible.

Quand la durée de conservation d'un composant est plus courte que la période couverte par une
session de batch, le plan affiche une alerte. Rien n'est retiré, le planning n'est pas modifié et
aucune solution n'est inventée. Le plan de batch reprend ces informations telles quelles — aucune méthode, aucune
association et aucune habitude alimentaire n'est codée dans l'application. Les valeurs livrées avec
la banque initiale sont des données par défaut, modifiables ou supprimables.

À la création d'un aliment, une **popup de confirmation bloquante** signale les produits déjà
présents qui lui ressemblent (nom proche, même marque, même poids par unité, valeurs voisines),
avec leurs macros pour 100 g face à celles de l'élément en cours de création : « Annuler » ne crée
rien, « Créer quand même » poursuit. C'est le seul mécanisme utilisé pour ce cas — aucun toast ni
message en bas de fenêtre en parallèle. Le même contrôle tourne après un import JSON et liste les doublons
possibles. Rien n'est jamais fusionné ni supprimé automatiquement à ces deux occasions (création, import).

Un second mécanisme, indépendant, permet une fusion volontaire : sur l'écran Aliments, la section
« Doublons possibles » (repliée par défaut) reprend la même détection pour regrouper les aliments
existants qui se ressemblent. Pour chaque groupe, on choisit lequel conserver, puis une confirmation
bloquante rappelle ce qui va être redirigé (recettes, repas, catalogues, courses, batch) avant toute
fusion réelle — là encore, jamais automatique sur la seule similarité de nom. L'aliment conservé
garde intégralement ses propres valeurs nutritionnelles et métadonnées ; seules les références aux
aliments fusionnés sont redirigées vers lui, puis ceux-ci sont supprimés. Le `recipeSnapshot` déjà
figé d'une préparation existante n'est jamais réécrit par une fusion, pour la même raison que pour
la suppression : il garde l'historique exact de ce qui a été réellement préparé.

**« Pas un doublon »** : à côté du bouton de fusion, chaque groupe propose aussi d'être écarté
définitivement — pour un faux positif (deux produits réellement différents que l'algorithme
rapproche à tort). Contrairement à la fusion, cette action **ne touche à aucun aliment** (rien
supprimé, rien fusionné) : elle supprime seulement l'avertissement lui-même, pour CE groupe précis.
La décision est persistée (`state.dismissedDuplicates`, synchronisée comme le reste des
réglages — colonne `settings.dismissed_duplicates`) et **réversible** : une section repliée
« Doublons ignorés » liste les groupes écartés avec un bouton « Reconsidérer » par groupe, qui les
fait réapparaître. La clé retenue par groupe est la liste triée des identifiants de TOUS ses
membres (`similarity.js::duplicateGroupKey()`) : si la composition exacte du groupe change (un
aliment supplémentaire vient s'y greffer, une modification de nom change les scores), le groupe
peut réapparaître sous une nouvelle composition — décision assumée, un changement de composition
mérite un nouvel avis plutôt que de risquer de masquer silencieusement un vrai doublon impliquant
le nouveau venu.

**Visibilité du panneau** (retour utilisateur) : le bouton « Voir/Masquer les doublons… » reste
toujours disponible tant qu'il y a quoi que ce soit à montrer — groupes actifs **ou** groupes
écartés — pour ne jamais laisser le panneau bloqué ouvert sans moyen de le refermer (ce qui arrivait
si le dernier groupe actif était écarté depuis le panneau lui-même, sans le refermer d'abord). Une
fois tous les groupes actifs écartés, le panneau perd aussi son habillage d'avertissement (fond/titre
« Doublons possibles ») : il n'y a plus rien d'actionnable d'urgent, seulement un rappel neutre des
groupes écartés avec leur bouton « Reconsidérer ».

### Recherche Open Food Facts (préremplissage à la création)

Sur un **nouvel** aliment uniquement (pas en modification), le bouton « Rechercher sur Open Food
Facts » ouvre un panneau de recherche à deux entrées indépendantes et combinables :

- **par code-barres** : saisie (ou, un jour, un lecteur/une caméra — non implémenté ici, mais
  `js/views/foods.js` expose `openFoodFormWithBarcode()` et l'événement
  `nutriplan:off-barcode` (`{ detail: { barcode } }`, écouté dans `app.js` comme
  `nutriplan:open-food`) comme point d'entrée tout prêt pour un futur scanner) ;
- **par nom et/ou marque** : recherche texte temporisée (500 ms après la dernière frappe), jamais
  une requête par caractère tapé.

Résultat : une liste de produits (vignette, nom, marque, quantité, macros pour 100 g, Nutri-Score
quand disponible). **Aucune création automatique** : il faut cliquer explicitement sur « Utiliser ce
produit » pour préremplir le formulaire — qui reste entièrement modifiable avant l'enregistrement
final, comme une saisie manuelle. Si le formulaire contenait déjà une saisie réelle, une confirmation
bloquante est demandée avant de la remplacer — jamais sur un formulaire fraîchement ouvert et encore
vierge (`readForm()`, `js/views/foods.js`, conserve `null` pour un champ texte jamais rempli dont la
valeur par défaut est `null` — barcode, Nutri-Score, Eco-Score, ingrédients, allergènes —, même
principe déjà appliqué aux champs numériques, pour que la comparaison « formulaire modifié ? » ne
confonde jamais une valeur jamais saisie avec une chaîne vide explicitement entrée).

**Doublon par code-barres** : si le produit trouvé correspond déjà à un aliment de la banque (même
code-barres — critère fort, pas une simple ressemblance de nom), la recherche ne propose jamais de
créer un second aliment : elle ouvre directement la fiche existante (« Utiliser quand même » reste
possible pour le cas rare d'un code-barres partagé par erreur entre deux produits réellement
différents sur Open Food Facts). Le même contrôle s'applique à l'enregistrement manuel : un
code-barres identique à un aliment déjà présent déclenche la même popup bloquante que pour une
ressemblance de nom.

**Données récupérées** (toujours modifiables, jamais une valeur devinée pour un champ absent de la
fiche OFF — `null` reste `null`, jamais remplacé par 0) : nom (version française privilégiée quand
disponible), marque (la première si plusieurs), code-barres, kcal/protéines/glucides/lipides/fibres
pour 100 g, poids du conditionnement (seulement pour un format simple et non ambigu du type
« 500 g »/« 1 kg »/« 1 L » — un multi-conditionnement comme « 4 x 125 g » reste affiché en texte
plutôt que deviné), et, en section complémentaire repliable : graisses saturées, sucres, sel et
sodium (jamais l'un déduit de l'autre), Nutri-Score, groupe NOVA, Eco-Score, liste des ingrédients,
allergènes et traces, URL de la fiche OFF et date de récupération (traçabilité). **La catégorie
Nutriplan** est suggérée automatiquement quand la correspondance est fiable (voir sous-section
dédiée ci-dessous) — jamais inventée sinon, et toujours modifiable. L'énergie n'est jamais
recalculée depuis l'énergie en kJ : seul le champ kcal direct d'OFF est utilisé, par prudence sur
l'unité.

**Endpoints utilisés** (`js/core/off.js`, module unique encapsulant les deux) :
- fiche produit par code-barres : `GET world.openfoodfacts.org/api/v2/product/{code}.json` (API
  v2, encore officiellement supportée). Une v3 existe mais son schéma de réponse exact n'a pas pu
  être vérifié depuis cet environnement de développement (accès réseau à `world.openfoodfacts.org`
  et à la documentation OFF bloqués dans ce bac à sable) — v2 reste documentée, stable, et c'est
  elle qui est utilisée ; à reconsidérer si v3 peut être vérifiée en direct.
- recherche texte : `GET search.openfoodfacts.org/search?q=…` (Search-a-licious) — **un endpoint
  distinct** de la fiche produit (OFF ne propose pas de recherche texte sur le même endpoint).
  **Historique de cette décision** : la première version utilisait l'endpoint historique
  `cgi/search.pl`, choisi par prudence car son schéma de réponse (`count`/`products`) est bien
  documenté alors que celui de Search-a-licious, alors en bêta, ne pouvait pas être vérifié depuis
  cet environnement de développement (accès réseau bloqué). **En usage réel, cet endpoint
  historique s'est révélé renvoyer systématiquement une erreur 503** — très probablement
  déprioritisé côté infrastructure OFF maintenant que Search-a-licious existe. Un 503 sans en-tête
  CORS est rapporté par le navigateur comme une erreur CORS, ce qui en a masqué la cause réelle
  jusqu'à inspection de l'onglet Réseau. Basculé vers Search-a-licious en conséquence, malgré un
  schéma de réponse toujours non confirmé avec certitude : la lecture de la réponse
  (`parseSearchResponse()`, `js/core/off.js`) reste volontairement tolérante (plusieurs noms de clé
  possibles pour la liste de résultats et pour le total) afin de s'adapter sans planter l'écran de
  recherche si le schéma exact diffère légèrement de l'hypothèse retenue — à vérifier en usage réel
  et à ajuster si le format réel s'avère différent.

**Licence et attribution** : les données Open Food Facts sont sous licence ouverte **ODbL**
(attribution requise), affichée dans le panneau de recherche avec un lien vers le projet. Aucune
donnée n'est redistribuée au-delà d'un usage personnel de préremplissage.

### Lecture de codes-barres par caméra

Dans le panneau « Rechercher sur Open Food Facts », un bouton **« 📷 Scanner un code-barres »**
apparaît à côté du champ de saisie manuelle — uniquement si le navigateur expose l'API caméra
(`navigator.mediaDevices.getUserMedia`) dans un contexte sécurisé (`isSecureContext`) ; sinon le
bouton n'est simplement pas proposé, et la recherche par code-barres manuel ou par nom/marque reste
entièrement utilisable, exactement comme avant. Aucune duplication : la caméra ne fait QUE produire
un code-barres (texte) qui est transmis tel quel à `runBarcodeSearch()`, le même point d'entrée déjà
utilisé par la saisie manuelle — tout le reste (recherche OFF, préremplissage, détection de doublon,
suggestion de catégorie) est strictement le code existant, inchangé.

**Bibliothèque retenue : [`@zxing/browser`](https://github.com/zxing-js/browser)** (+ sa dépendance
`@zxing/library`), chargées en différé depuis esm.sh — même convention que
`@supabase/supabase-js` (`js/core/sync.js`) : aucune dépendance de build, les deux bibliothèques ne
sont téléchargées que si l'utilisateur clique sur « Scanner ». Comparées avant de choisir :
- **API native `BarcodeDetector`** (Shape Detection API) : écartée comme moteur principal — non
  disponible sur Safari iOS/iPadOS (désactivée par défaut sur toutes les versions actuelles d'après
  les tableaux de compatibilité à jour), rédhibitoire pour une application qui doit fonctionner sur
  iPhone/iPad. Un double moteur (natif si dispo, JS sinon) doublerait la surface de test pour un
  gain limité aux seuls Chrome/Edge desktop et Android.
- **html5-qrcode** : wrapper au-dessus du même moteur ZXing-js, mais développement arrêté depuis
  avril 2023.
- **Quagga2** (fork maintenu de QuaggaJS) : alternative sérieuse et activement maintenue (licence
  MIT), mais plusieurs retours font état de faux positifs sur des EAN et de soucis sur des codes
  abîmés ou mal imprimés — risque direct pour des emballages alimentaires réels.
- **@zxing/browser** : port direct du décodeur ZXing (référence du secteur), licence **MIT**
  (`@zxing/library` : Apache-2.0). Publications vérifiées sur le registre npm au moment de
  l'implémentation : `@zxing/browser@0.2.1` (juillet 2026), `@zxing/library@0.23.0` (avril 2026) —
  toujours activement publié. Fournit nativement l'énumération des caméras
  (`listVideoInputDevices()`), le démarrage/arrêt propre d'un flux
  (`decodeFromVideoDevice()`/`IScannerControls.stop()`, qui coupe explicitement toutes les pistes
  vidéo), et un repli automatique sur la caméra arrière (`facingMode: 'environment'`) quand aucun
  identifiant de caméra n'est précisé — aucune logique à deviner côté Nutriplan pour ce choix par
  défaut.

**Formats pris en charge** : `BrowserMultiFormatOneDReader` restreint volontairement le décodage aux
formats 1D (jamais aux formats 2D type QR/Data Matrix, hors sujet pour un code-barres alimentaire),
avec une restriction supplémentaire aux formats réellement utilisés sur un emballage alimentaire
courant — **EAN-13, EAN-8, UPC-A, UPC-E, Code 128** (`js/core/barcode-scanner.js`, table
`RELEVANT_FORMAT_NAMES`, facile à étendre). Le code-barres décodé (`Result.getText()`) est toujours
traité comme une **chaîne de caractères**, jamais repassé par `Number()` — même convention que
`normalizeBarcode()` (`js/core/off.js`) : un zéro initial n'est jamais perdu.

**Choix de la caméra avant/arrière** : une fois un premier flux obtenu (seul moment où le navigateur
expose des libellés de caméra fiables), la liste des caméras disponibles est rafraîchie
(`listCameras()`) et un sélecteur apparaît **seulement s'il y a plus d'une caméra** — jamais un choix
qui ne peut pas réellement s'appliquer. Changer de caméra arrête explicitement l'ancien flux
(`controls.stop()`) **avant** d'en ouvrir un nouveau — jamais deux flux actifs en même temps — en
réutilisant le même élément `<video>` (jamais recréé), pour ne provoquer aucun scintillement.

**Simplification sur mobile (iPhone notamment)** : constaté en usage réel — iOS/Safari expose
**chaque objectif physique arrière** comme une caméra séparée (grand angle, ultra grand angle,
téléobjectif) PLUS des périphériques virtuels combinant plusieurs objectifs (« Triple caméra
arrière », « Double caméra arrière »…) pour le changement de focale automatique en zoomant, comme
l'app Appareil photo native. Un iPhone récent peut ainsi annoncer 6 à 8 caméras pour 2 utilisateurs
réels (avant/arrière) — une liste brute n'était pas utilisable. `simplifyCameraChoices()`
(`js/views/barcode-panel.js`) réduit donc le choix à **une seule caméra arrière + une seule caméra avant** :
côté arrière, le périphérique **virtuel multi-objectifs est préféré quand il existe** (« Triple » puis
« Double »/« Dual », repli sur le premier sinon) — c'est lui qui donne le changement d'objectif
automatique, pas une caméra figée sur un seul objectif. Un appareil sans notion avant/arrière
reconnaissable (webcams d'ordinateur) n'est jamais réduit arbitrairement : la liste reste telle
quelle, avec un repli sur un nom numéroté (« Caméra 2 »…) pour un libellé non reconnu.
`cameraLabel()`/`simplifyCameraChoices()` reconnaissent les libellés en français ET en anglais
(`arriere`/`back`/`rear`/`environment`, `avant`/`front`/`user`/`face` — accents retirés avant
comparaison).

**Flash/torche** : un bouton apparaît pendant la lecture **seulement si la caméra active le permet**
(`IScannerControls.hasTorch()`/`setTorch()`, @zxing/browser — aucune nouvelle dépendance), jamais
activé automatiquement. Réinitialisé (éteint) à chaque démarrage ou changement de caméra — jamais un
état de flash reporté d'une caméra à l'autre.

**Mise au point** : une fois le flux démarré, `js/core/barcode-scanner.js` consulte les capacités de
la caméra active (`MediaTrackCapabilities.focusMode`) et demande explicitement une mise au point
**continue** (`focusMode: 'continuous'`) si elle est annoncée — sans cette demande, certains
navigateurs démarrent une caméra pourtant capable d'autofocus en mode fixe. **Limite matérielle,
pas logicielle** : beaucoup de caméras AVANT (webcam d'ordinateur, caméra selfie de téléphone
calibrée pour la visioconférence à bout de bras) n'ont tout simplement pas de moteur de mise au
point — aucun logiciel ne peut l'activer si le matériel ne le permet pas. La caméra arrière, prévue
pour la photo, en dispose presque toujours ; elle reste le choix par défaut et le plus fiable pour
scanner un emballage. Repli entièrement silencieux dans tous les autres cas (capacité absente,
méthode non exposée par le navigateur, `applyConstraints()` refusé) : ne bloque jamais le démarrage
de la lecture.

**Cycle de vie et confidentialité** : le décodage se fait entièrement sur l'appareil (lecture d'une
image de `<canvas>` en mémoire) — aucune image ni flux vidéo n'est jamais envoyé à un serveur, seul
le texte décodé quitte `js/core/barcode-scanner.js`. Toutes les pistes vidéo sont explicitement
arrêtées : à la fermeture du scanner (bouton, clic extérieur, Échap), après une détection réussie
(avant même de lancer la recherche OFF), lors d'un changement de caméra, et lors d'un changement
d'écran dans l'application (`stopActiveScanner()`, `js/views/barcode-panel.js`, appelé depuis
`js/app.js` — une `MediaStream` ne s'arrête jamais toute seule parce que son `<video>` disparaît du
DOM). Une seule
détection est traitée par lecture (garde anti-répétition `settled`) : la caméra est coupée *avant*
de transmettre le code à la recherche OFF, qui ne crée elle-même jamais d'aliment automatiquement —
l'utilisateur garde la main jusqu'à l'enregistrement final, exactement comme pour une recherche
manuelle.

**Erreurs gérées** (`js/core/barcode-scanner.js`, messages sans jargon, repli toujours proposé vers
la saisie manuelle) : permission refusée (`NotAllowedError`/`SecurityError`), aucune caméra
(`NotFoundError`), caméra déjà utilisée par une autre application ou inaccessible
(`NotReadableError`), caméra devenue indisponible (`OverconstrainedError`), et le cas générique d'un
navigateur/contexte ne permettant pas l'accès vidéo. Une « frame sans code lisible » (l'écrasante
majorité des images pendant une lecture) n'est **jamais** traitée comme une erreur — reconnue via
`Exception.getKind()` (ZXing), pas `instanceof` : ce module charge `@zxing/library` et
`@zxing/browser` comme deux imports ESM séparés, et s'appuyer sur un identifiant textuel stable
plutôt que sur l'identité de classe évite toute fragilité liée à la façon dont ces deux modules sont
résolus côté CDN.

**Prérequis navigateur** : contexte sécurisé (HTTPS — GitHub Pages l'est par construction — ou
`localhost` en développement), permission caméra explicite (jamais de démarrage sans action de
l'utilisateur, jamais en arrière-plan).

**Limites connues** : la liste de formats et la table de libellés avant/arrière
(`js/core/barcode-scanner.js`, `js/views/barcode-panel.js`) sont volontairement restreintes et faciles à
étendre plutôt qu'exhaustives ; le décodage réel par caméra physique n'a pu
être vérifié que par un navigateur réel avec caméra simulée (Playwright, drapeaux Chromium
`--use-fake-device-for-media-stream`) — l'accès à `esm.sh` étant bloqué dans cet environnement de
développement, les bibliothèques ZXing elles-mêmes y ont été remplacées par un module minimal
reproduisant leur API (vérifiée contre leur code source réel) : le flux caméra réel, le rendu vidéo
et l'arrêt des pistes ont ainsi pu être vérifiés en conditions réelles, mais pas la fidélité de
décodage d'un vrai code-barres imprimé — à confirmer par l'utilisateur sur un appareil réel.

### Recherche d'un aliment existant par code-barres (repas et recettes)

Le scanner lui-même (`js/views/barcode-panel.js`) est un composant **partagé** : extrait de l'écran
Aliments (seul consommateur jusqu'ici) pour être réutilisé, sans aucune duplication de la mécanique
caméra/flash/choix d'objectif, par deux nouveaux points d'entrée : l'ajout d'un ingrédient à un repas,
un petit-déjeuner ou une collation (`js/views/editor.js`) et la composition d'une recette
(`js/views/recipes.js`). Le panneau se superpose à tout le reste de l'écran (`document.body`),
indépendamment de l'endroit qui l'a ouvert, et un seul scanner peut être actif à la fois.

**Ce que la détection recherche diffère volontairement selon l'écran** : sur Aliments, un code-barres
scanné alimente la recherche Open Food Facts existante (préremplissage d'une fiche). Sur un repas ou
une recette, il interroge d'abord le **catalogue Nutriplan déjà enregistré**
(`store.js::foodByBarcode()`) — jamais Open Food Facts directement, pour ne jamais confondre un
résultat OFF avec un aliment déjà créé localement :
- **trouvé** : la fiche (nom, marque, macros) s'affiche avec un bouton « Ajouter », qui réutilise
  exactement le même chemin qu'un résultat de la recherche par nom (`onAddFood()`/
  `wireIngredientAddButtons()`) — aucune logique d'ajout dupliquée, aucun doublon créé.
- **absent du catalogue** : une **pop-up de confirmation bloquante** (`confirm-action.js`, le même
  composant que les autres confirmations de l'application, jamais un `confirm()` natif) s'ouvre
  **directement** — sans palier intermédiaire à cliquer en plus — expliquant qu'aucun aliment ne
  correspond et ce que la bascule va faire. « Annuler » referme la pop-up sans aucun effet ; seul
  « Créer l'aliment » bascule vers l'écran Aliments avec ce code-barres déjà renseigné dans la
  recherche Open Food Facts (événement `nutriplan:off-barcode`, déjà prévu à cet effet dans
  `js/app.js` avant ce chantier mais resté sans émetteur jusqu'ici). Rien n'est créé par cette seule
  bascule — l'utilisateur garde la main jusqu'à l'enregistrement final du formulaire aliment.
- **code illisible** (décodé mais sans aucun chiffre exploitable) : message distinct, avec un moyen de
  réessayer — jamais confondu avec une absence de résultat catalogue.
- **erreur caméra** (permission refusée, aucune caméra, etc.) : gérée par le panneau scanner
  lui-même, en amont de cette recherche — qui ne démarre donc jamais sur une détection qui n'a pas eu
  lieu.

**Contexte préservé lors de la bascule vers la création d'aliment** : la composition en cours n'est
jamais perdue, mais le mécanisme diffère selon l'écran, par construction de chacun —
- Un repas/petit-déjeuner/collation (`editor.js`) écrit chaque ajout directement dans l'état
  partagé au moment même du clic (`update()`), donc avant même qu'un scan ne soit tenté : fermer le
  tiroir d'édition pour laisser place à l'écran Aliments ne perd rien, l'utilisateur rouvre
  simplement ce même repas depuis Planning pour y revenir.
- Une recette en cours de création (`recipes.js`) vit dans un brouillon non enregistré
  (`formDraft`) tant que « Enregistrer » n'a pas été cliqué — rien n'est perdu ici non plus : ce
  brouillon reste en mémoire pendant la bascule (jamais réinitialisé par la seule navigation) et
  l'écran Recettes le rouvre automatiquement, tel quel, dès qu'on y revient.

### Suggestion automatique de catégorie

Module dédié et testé séparément : `js/core/off-category.js` (pur, sans dépendance à l'UI,
déterministe — mêmes données en entrée, même résultat à chaque appel). Appelé depuis
`mapOffProductToFoodDraft()` (`js/core/off.js`) à chaque fiche OFF récupérée (code-barres ou
recherche texte), AVANT toute sélection par l'utilisateur — la catégorie suggérée est donc déjà
visible sur la fiche produit, en tag, avant même de cliquer sur « Utiliser ce produit ».

**Principe directeur : ne jamais inventer.** Soit la correspondance est fiable et nette, soit la
fonction ne renvoie rien — le champ `category` est alors absent du brouillon et le formulaire garde
sa valeur actuelle (par défaut « Autre », ou le choix déjà fait par l'utilisateur). « Autre »
n'est donc **jamais** suggérée explicitement : elle reste la valeur par défaut du formulaire,
jamais une déduction du module.

**Deux signaux, dans cet ordre de priorité strict :**
1. **`categories_tags`** (taxonomie structurée OFF) — signal primaire. OFF ajoute automatiquement
   à ce champ, pour un produit donné, le tag le plus spécifique **et tous ses ancêtres** (vérifié
   dans le code source de la taxonomie OFF, `openfoodfacts-server/taxonomies/food/categories.txt` —
   ex. un produit classé « Beurres salés » reçoit aussi les tags ancêtres « Produits laitiers »,
   « Matières grasses », « Pâtes à tartiner »). Une table de correspondance dédiée
   (`OFF_TAG_TO_CATEGORY`, indexée par identifiant de taxonomie STABLE — ex. `meats`, `cheeses` —
   plutôt que par libellé traduit, qui change de forme selon la langue) couvre ~35 identifiants
   répartis sur les 8 catégories Nutriplan. Il suffit qu'UN SEUL tag de `categories_tags` soit une
   clé connue pour obtenir une correspondance — ce qui couvre aussi bien un tag déjà général qu'un
   tag très spécifique dont seul un ancêtre est répertorié (remontée automatique dans la
   hiérarchie, sans avoir à répliquer toute la taxonomie OFF).
2. **Le nom du produit** (mots-clés) — signal de repli, UNIQUEMENT si (1) n'a strictement rien
   donné (aucun tag connu, champ absent, ou produit mal renseigné). Un nom évocateur ne l'emporte
   **jamais** sur une catégorie OFF reconnue, même contradictoire (ex. « Fromage de chèvre aux
   noix » avec `categories_tags: ['en:cheeses']` → laitier, le mot « noix » du nom est ignoré).

**La marque n'est jamais utilisée seule** comme signal (pas assez discriminante : une même marque
vend des produits de toutes catégories). **Les ingrédients ne sont pas exploités** : la composition
d'un produit n'indique pas de façon fiable SA PROPRE catégorie (un yaourt aux fruits contient du
lait ET du fruit, ça n'aide pas à trancher) — décision délibérée pour éviter une complexité
disproportionnée par rapport au gain réel.

**Ambiguïté — jamais de certitude artificielle.** Si les tags (ou, en repli, les mots-clés du nom)
atteignent DEUX catégories Nutriplan différentes, aucune suggestion n'est faite (ex. « Beurres
salés » : « Produits laitiers » + « Matières grasses » → ambigu, aucune suggestion). Même principe
pour un libellé composite du nom : « Pommes de terre » ne doit jamais être réduit à « Pomme » (le
mot-clé le plus spécifique, englobant, l'emporte sur le mot-clé qu'il contient).

**Exclusions délibérées documentées dans le code** (pour ne pas être « redécouvertes » par erreur) :
tags racines trop généraux (`plant-based-foods` et dérivés — couvrent légumes, fruits, légumineuses,
noix et céréales à la fois, aucune valeur discriminante) ; `seeds` (« Graines » — couvre aussi bien
des graines oléagineuses que céréalières, pas de correspondance fiable à un seul groupe) ; les
boissons et desserts végétaux de type « alternative laitière » (nutritionnellement très différents
d'un produit laitier réel, jamais classés « laitier »). Faux-ami vérifié dans le fichier source de
la taxonomie OFF : la catégorie anglaise `en:legumes` correspond au français **« Légumineuses »**
(légumes secs), jamais à « Légumes » au sens courant — les deux sont correctement distingués dans
la table.

**Respect du choix utilisateur** : la catégorie suggérée n'est qu'une valeur de préremplissage du
formulaire, au même titre que le nom ou les kcal — elle passe par le même mécanisme de confirmation
bloquante que tout le reste d'un brouillon OFF si le formulaire contenait déjà une saisie réelle
(aucun traitement spécial nécessaire, aucun nouveau champ persistant ajouté). Reste modifiable à
tout moment avant et après l'enregistrement. Le bouton de recherche OFF n'existe que pour un
**nouvel** aliment (jamais en modification) : la catégorie d'un aliment déjà enregistré n'est donc
jamais retouchée par ce mécanisme.

**Tests** : `tests/off-category.test.mjs` (33 vérifications unitaires du module — correspondance
directe, remontée vers un ancêtre, tags multiples cohérents/ambigus, tag inconnu, absence de tag,
produit mal renseigné, casse/accents/préfixe de langue, libellés composites, faux positif
« boeuf »/« oeuf », catégories internes proches, indices contradictoires nom/tag, déterminisme,
auto-cohérence de la table) + scénarios bout en bout dans `tests/ui.test.mjs` (suggestion affichée
avant sélection, préremplissage, modification manuelle conservée à l'enregistrement, aucune
incidence en modification d'un aliment existant).

### Proxy CORS (requis pour la recherche par nom/marque)

**Constat en usage réel** (grorenar.github.io) : `search.openfoodfacts.org` ne renvoie pas
d'en-tête `Access-Control-Allow-Origin` pour une requête venant d'un site tiers. La requête aboutit
bien côté serveur (200 OK, avec de vraies données) mais le navigateur **bloque la réponse** avant
qu'elle n'atteigne le code de l'application — rapporté, de façon trompeuse, comme une erreur CORS
générique. Nutriplan étant un site statique pur (GitHub Pages, sans serveur), rien côté client ne
peut contourner cette politique : il faut un relais qui fasse la requête lui-même (serveur à
serveur, jamais soumis au CORS du navigateur) puis ajoute l'en-tête manquant.

`cloudflare-worker/off-proxy.js` est ce relais — minimal (une soixantaine de lignes), sans aucune
donnée stockée ni clé API requise (Open Food Facts est un service public en lecture), ne
proxie que les deux routes connues (fiche produit par code-barres, recherche) et rejette tout le
reste. Il fait au passage ce que le navigateur interdit côté client : positionner l'en-tête
`User-Agent` personnalisé qu'Open Food Facts recommande pour identifier l'application appelante.

**Déploiement (gratuit, ~5 minutes, aucune installation locale) :**
1. Crée un compte sur [dash.cloudflare.com](https://dash.cloudflare.com) si besoin (offre gratuite
   suffisante : 100 000 requêtes/jour).
2. Dans le tableau de bord : **Workers & Pages** → **Create** → **Create Worker**. Donne-lui un nom
   (ex. `nutriplan-off-proxy`) et déploie-le tel quel une première fois.
3. Ouvre **Edit code**, remplace tout le contenu par celui de `cloudflare-worker/off-proxy.js` (de
   ce dépôt), puis **Deploy**.
4. Note l'URL donnée par Cloudflare (ex.
   `https://nutriplan-off-proxy.<ton-compte>.workers.dev`).
5. Colle cette URL dans `js/config.js`, champ `OFF_PROXY_URL`, puis commit/push comme d'habitude.
6. Si le site est servi depuis un domaine différent de `grorenar.github.io`, ajoute ce domaine à
   `ALLOWED_ORIGINS` en haut de `cloudflare-worker/off-proxy.js` avant de redéployer (étape 3).

Tant que `OFF_PROXY_URL` reste vide, l'application appelle Open Food Facts directement : ça
fonctionne pour la fiche produit par code-barres (`world.openfoodfacts.org`, CORS correct à ce
jour) mais pas pour la recherche par nom/marque.

**Limitations connues, documentées plutôt que contournées :**
- Aucune clé API n'est nécessaire (lecture publique) et aucun secret n'est exposé, y compris dans
  le proxy (aucune donnée utilisateur n'y transite ni n'y est stockée — il relaie une requête
  publique vers un service public).
- La recherche texte est temporisée côté interface et la recherche par code-barres reste un geste
  explicite (bouton ou Entrée) — en usage réel (deux personnes), très en dessous des limites
  publiées par OFF (15 requêtes/min/IP pour la fiche produit, 10/min/IP pour la recherche).
- Aucune mise en cache durable des résultats OFF (ni côté application, ni dans le proxy) : chaque
  recherche interroge le service à nouveau, volontairement — les données d'un produit peuvent
  changer, et rien ne justifierait ici la complexité d'une stratégie d'invalidation pour un usage
  aussi ponctuel.
- Le schéma de réponse exact de Search-a-licious n'a toujours pas pu être vérifié avec certitude
  depuis cet environnement de développement (accès réseau bloqué, y compris vers le proxy une fois
  déployé) : l'analyse de la réponse reste volontairement tolérante (§ ci-dessus) ; à ajuster si le
  format réel observé en usage diffère de l'hypothèse retenue.

## 8. Tests

```bash
npm ci                # une seule fois (installe jsdom, nécessaire à tests/ui.test.mjs)
npm test              # les 7 suites ci-dessous, dans cet ordre, en une commande
```

Équivalent détaillé, ou pour lancer une suite isolément :

```bash
npm run test:engine           # node tests/engine.test.mjs           — moteur, batch, courses, unités, cru/cuit, recettes/préparations — sans dépendance
npm run test:volume           # node tests/volume.test.mjs           — analyse du volume d'un repas — sans dépendance
npm run test:autosync         # node tests/autosync.test.mjs         — synchronisation automatique, client Supabase simulé — sans dépendance
npm run test:off              # node tests/off.test.mjs              — service Open Food Facts, `fetch` entièrement simulé — sans dépendance, sans réseau
npm run test:off-category     # node tests/off-category.test.mjs     — suggestion de catégorie OFF -> Nutriplan — module pur, sans dépendance
npm run test:barcode-scanner  # node tests/barcode-scanner.test.mjs  — lecture caméra, bibliothèque ZXing et caméra entièrement simulées
npm run test:ui               # node tests/ui.test.mjs               — parcours réel de l'interface (jsdom)
```

`tests/ui.test.mjs` démarre l'application entière (`js/app.js`) : comme `js/config.js` contient
volontairement les vraies clés du projet Supabase (nécessaire à l'app déployée, aucune étape de
build pour en injecter d'autres), le test force explicitement un mode « non configuré » dès son
démarrage (`sync.__forceUnconfigured(true)`, réservé aux tests) — sans ce point d'injection, chaque
exécution du test tenterait de vraies requêtes réseau vers `esm.sh` puis vers le projet Supabase
réel (jamais destructif en soi, `auth.getUser()` seul, mais jamais souhaitable non plus pour une
suite de tests). Les autres suites qui touchent la synchronisation (`autosync.test.mjs`,
`sync.test.mjs`) injectent directement leur propre client factice (`__setTestClient()`), donc n'en
ont pas besoin.

`npm test` n'inclut volontairement **pas** `tests/sync.test.mjs` : cette suite a besoin d'un service
PostgreSQL local (voir ci-dessous), pas toujours disponible, alors que les 7 autres ne dépendent de
rien d'externe et doivent donc rester exécutables partout, y compris en intégration continue.

Le test de synchronisation vérifie le schéma, la transaction et les policies RLS sur un
PostgreSQL **local** (jamais sur ta base Supabase) : il crée une base jetable, émule `auth.uid()`
et applique `supabase/schema.sql`.

```bash
apt-get install -y postgresql && service postgresql start   # une seule fois par environnement
npm run test:sync       # équivalent à : node tests/sync.test.mjs
```

Le test pilote `psql` via `su postgres` : il doit donc être lancé en root (comme ci-dessus), ou avec
`sudo` sinon (`sudo env "PATH=$PATH" npm run test:sync`) — sans privilège root, `su` exigerait un mot
de passe que l'utilisateur système `postgres` n'a pas par défaut.

### Tests navigateur (Playwright) : décision de ne pas les intégrer pour l'instant

Playwright a servi, ponctuellement et en dehors du dépôt, à vérifier des correctifs touchant le
rendu réel (ex. le rejeu d'une animation d'entrée de tiroir, un bouton non câblé) avant d'en écrire
l'équivalent dans `tests/ui.test.mjs`. À chaque fois, le même défaut s'est révélé vérifiable en
jsdom sans navigateur réel : `tests/ui.test.mjs` compare déjà l'identité DOM d'un panneau avant/après
une interaction (`$('.drawer__panel') === panneauAvant`, ex. ligne « le panneau n'est PAS recréé… »)
pour détecter une reconstruction intempestive — la cause concrète des bugs de rejeu d'animation
rencontrés — sans avoir besoin d'un véritable moteur de rendu CSS. La seule chose qu'un navigateur
réel vérifie et que jsdom ne peut pas, c'est le rejeu d'une animation CSS elle-même
(`element.getAnimations()`), qui est un défaut cosmétique, jamais une perte de donnée ni une
référence orpheline.

Au regard de l'usage réel (application strictement privative, utilisée quelques fois par semaine
par deux personnes) et du coût d'une suite Playwright versionnée — un second runtime de test,
~300 Mo de binaires Chromium à télécharger et maintenir à jour, un job CI plus lent et plus sujet
aux flakiness liées au rendu — ce coût n'est aujourd'hui pas justifié par un bénéfice que
`tests/ui.test.mjs` n'apporte pas déjà. Décision : ne pas verser Playwright au dépôt pour l'instant.

Ce qui justifierait de revenir sur cette décision : un bug réel qui échapperait structurellement à
jsdom (rendu CSS, comportement tactile mobile réel, timing d'animation ayant un effet fonctionnel
et pas seulement visuel) et qui se reproduirait plus d'une fois. En attendant, une vérification
ponctuelle au navigateur réel reste possible à la main (Playwright installé globalement, hors
dépôt) sans que cela justifie de l'ajouter en dépendance versionnée ni en CI.

Le scanner de codes-barres par caméra (§7) entre dans ce cas : jsdom n'implémente aucune API
WebRTC, donc `tests/barcode-scanner.test.mjs` et les scénarios caméra de `tests/ui.test.mjs`
simulent entièrement la bibliothèque ZXing et les périphériques (comme pour tout le reste). Une
vérification ponctuelle, hors dépôt, a confirmé en navigateur réel (Chromium, drapeaux
`--use-fake-device-for-media-stream`/`--use-fake-ui-for-media-stream`) le cycle de vie RÉEL du flux
— `getUserMedia()`, affichage vidéo, arrêt effectif des pistes à la fermeture — et a d'ailleurs
révélé une fragilité corrigée depuis (classification des exceptions ZXing par `getKind()` plutôt que
par `instanceof`, cf. §7). Elle n'a en revanche pas pu couvrir le décodage d'un vrai code-barres
imprimé (`esm.sh` injoignable depuis cet environnement de développement) — à confirmer par
l'utilisateur sur un appareil réel.

## 9. Sauvegarde

Paramètres → Données → **Exporter en JSON** produit un fichier complet (banque, recettes,
préparations, objectifs, planning, catalogues, paramètres). **Importer un JSON** le restaure
intégralement, après confirmation (l'import remplace l'état courant) et un rapport des doublons
potentiels détectés (même mécanisme que la création d'un aliment, §7).

**Sauvegarde locale automatique.** Avant que toute récupération depuis le cloud (§5.3) ne remplace
l'état local, l'application en conserve une copie dans le `localStorage` de l'appareil. Paramètres
→ Compte → « Restaurer la sauvegarde locale » revient à cet état précédent, après confirmation.

## 10. Données livrées

La banque initiale contient des aliments courants avec des valeurs **génériques** : protéines,
féculents, légumineuses, légumes, fruits, produits laitiers, matières grasses, noix & graines, pains et wraps.
Elles ne prétendent correspondre à aucune marque. Pour un produit précis (whey, pain croustillant,
fromage tartinable, skyr d'une marque donnée…), crée l'aliment et recopie les valeurs de
l'emballage. Les prix et conditionnements sont eux aussi indicatifs et modifiables.

Aucune habitude alimentaire n'est codée en dur : aucune association obligatoire, aucun aliment
imposé. L'application fournit les outils, tu construis les repas.
