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
js/views/*.js             une vue par écran (dont recipes.js, preparations.js) + l'éditeur de
                          repas partagé (editor.js) + les dialogues de confirmation réutilisables
                          (confirm-unsaved.js, confirm-similar.js, confirm-action.js — toute
                          action destructrice/irréversible passe par ce dernier, plus de
                          `confirm()` natif nulle part dans l'application)
supabase/schema.sql       schéma PostgreSQL + RLS par compte + fonction transactionnelle
tests/engine.test.mjs     moteur nutritionnel, batch, courses, recettes/préparations (aucune dépendance)
tests/volume.test.mjs     analyse du volume d'un repas (aucune dépendance)
tests/sync.test.mjs       schéma + transaction + RLS, sur un PostgreSQL local
tests/autosync.test.mjs   synchronisation automatique (client Supabase simulé, aucune dépendance)
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
| Aliments | banque complète, recherche, favoris, création/modification/suppression — la suppression est bloquée si l'aliment est encore référencé dans une recette (composition live ou `recipeSnapshot` figé d'une préparation existante), avec un avertissement (non bloquant) s'il est seulement utilisé dans des repas/catalogues ; section dépliable « Doublons possibles » (même détection que la popup de création, `findSimilarFoods`/`findDuplicateGroups`) proposant pour chaque groupe un choix explicite de l'aliment à conserver puis une confirmation bloquante avant toute fusion — jamais de fusion automatique sur la seule similarité de nom |
| Recettes | composition à partir de la banque alimentaire, type `weight` (poids continu, échelle `baseGrams`) ou `portion` (unité indivisible), consignes de cuisson/conservation, `batchAllowed` ; la suppression est bloquée tant qu'une préparation existe pour cette recette, ou qu'elle est encore référencée directement (sans préparation) dans un repas ou un catalogue |
| Préparations et distribution | matérialisation d'une recette en stock réel (quantité préparée, figée dans `recipeSnapshot`), répartition éditable vers les repas, mode zéro reste, jet total ou partiel du reliquat (historique des pertes jamais effacé), suppression définitive d'une préparation (avec avertissement si du stock reste, bloquée tant que des affectations existent) ; une préparation épuisée (stock à 0) est masquée de la liste active sans jamais être supprimée des données |
| Petits-déjeuners | catalogue indépendant, sans jour ni date ; compteur d'utilisations **par personne**, avec contrôle de couverture du cycle |
| Collations | **catalogue unique** : une collation a une composition unique, 16 h et Soir ne sont que des affectations de consommation (compteurs par personne et par créneau) |
| Batch cooking | classement fondé sur deux propriétés explicites de l'aliment — `batchAllowed` puis `requiresCooking`, jamais sur l'état de référence — et plan opératoire par session : **à préparer en batch** (méthode, température, durée, rendement, quantités crues et cuites, consignes), **recettes à préparer en batch** (détail des ingrédients à l'échelle de la quantité réellement préparée, répartition prévue vers les gamelles de la session), **à cuire le jour même**, **à assembler le jour même**, puis le détail de chaque gamelle personne par personne |
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
bloquante est demandée avant de la remplacer.

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
Nutriplan n'est jamais déduite** des catégories OFF — taxonomie trop large pour une correspondance
fiable, le choix reste toujours manuel. L'énergie n'est jamais recalculée depuis l'énergie en kJ :
seul le champ kcal direct d'OFF est utilisé, par prudence sur l'unité.

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
npm test              # les 5 suites ci-dessous, dans cet ordre, en une commande
```

Équivalent détaillé, ou pour lancer une suite isolément :

```bash
npm run test:engine     # node tests/engine.test.mjs    — moteur, batch, courses, unités, cru/cuit, recettes/préparations — sans dépendance
npm run test:volume     # node tests/volume.test.mjs    — analyse du volume d'un repas — sans dépendance
npm run test:autosync   # node tests/autosync.test.mjs  — synchronisation automatique, client Supabase simulé — sans dépendance
npm run test:off        # node tests/off.test.mjs       — service Open Food Facts, `fetch` entièrement simulé — sans dépendance, sans réseau
npm run test:ui         # node tests/ui.test.mjs        — parcours réel de l'interface (jsdom)
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
PostgreSQL local (voir ci-dessous), pas toujours disponible, alors que les 4 autres ne dépendent de
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
