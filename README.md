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
js/core/seed-foods.js     banque alimentaire initiale (~95 aliments génériques)
js/core/store.js          état applicatif, localStorage, export/import
js/core/derive.js         batch cooking, liste de courses, budget, suggestions
js/core/sync.js           Supabase : auth + envoi/récupération atomiques
js/views/*.js             une vue par écran + l'éditeur de repas partagé
supabase/schema.sql       schéma PostgreSQL + RLS par compte + fonction transactionnelle
tests/engine.test.mjs     moteur nutritionnel, batch, courses (aucune dépendance)
tests/sync.test.mjs       schéma + transaction + RLS, sur un PostgreSQL local
tests/ui.test.mjs         parcours complet de l'interface (jsdom)
```

Séparation stricte : `core/nutrition.js` et `core/derive.js` ne touchent jamais au DOM et ne
connaissent ni le stockage ni le réseau. Ce sont des fonctions pures, directement testables.

## 2. Modèle de données

État applicatif (et fichier d'export JSON) :

```
foods[]            id, name, category, brand, kcal, protein, carbs, fat, fiber,
                   referenceState, cookedFactor, unitName, gramsPerUnit, fractionable,
                   price, packageWeight, batchAllowed, favorite
settings           targets{thomas|julie}{day|breakfast|lunch|snack_afternoon|dinner|snack_evening}
                   tolerance, cycle{startWeekday,duration}, budget, batch{enabled,maxDays}, autoAdjust
meals[]            id, dayIndex, mealType(lunch|dinner), name, sameComposition, items[]
breakfasts[]       id, name, sameComposition, items[]     (catalogue, sans jour ni date)
snacksAfternoon[]  idem
snacksEvening[]    idem
items[]            id, foodId|null, free{name,quantity}|null, state,
                   qty{thomas,julie}, locked{thomas,julie}
shopping.purchased {foodId: bool}        ← simple case "acheté", aucun stock
batch.overrides    {"session:foodId": grammes préparés}
```

Côté PostgreSQL, la même chose est normalisée dans `supabase/schema.sql`
(`foods`, `targets`, `settings`, `meals`, `meal_items`, `breakfast_options`, `breakfast_items`,
`snack_options`, `snack_items`, `shopping_items`, `batch_items`). Un ingrédient donne une ligne
par personne (colonne `person`), conformément au schéma demandé.

Toutes les valeurs nutritionnelles sont stockées **pour 100 g**, dans l'état de référence de
l'aliment. Tous les calculs internes sont en grammes.

## 3. Logique de calcul et d'ajustement

**Macros.** Les grammes saisis sont d'abord ramenés à l'état de référence de l'aliment
(coefficient `cookedFactor`, ex. pâtes 100 g crus → 240 g cuits), puis multipliés par les valeurs
pour 100 g. La cuisson change le poids, jamais les macros.

**Ajustement continu.** À chaque ajout, suppression, changement de quantité, d'état ou de verrou,
`adjustQuantities()` est relancé pour chaque personne. C'est une descente par coordonnées sur un
coût quadratique convexe :

```
coût = Σ_macro  w · ((valeur − cible) / cible)²        w : kcal 0,35 · P 1,4 · C 1 · L 1
```

Trois garde-fous encadrent ce calcul :

1. **Les kcal sont faiblement pondérées** : elles sont largement redondantes avec P/C/L
   (≈ 4P + 4C + 9L). Au même poids que les macros, elles poussaient l'algorithme à gonfler
   protéines et glucides pour compenser des calories manquantes.
2. **Pondération robuste (Huber/IRLS)** : au-delà de 15 % d'écart, l'influence d'une macro cesse
   de croître. Une macro structurellement inatteignable (aucune matière grasse dans le repas) ne
   déforme donc plus les autres : elle est simplement signalée.
3. **Ancrage relatif** propre à la catégorie : l'optimum est d'abord **borné**, puis mélangé à la
   quantité actuelle. Borner avant le mélange est indispensable, sinon un optimum théorique absurde
   (3,5 kg de haricots verts pour atteindre 1050 kcal) tire quand même la quantité vers le haut.

La quantité finale est arrondie : pas de la catégorie pour les aliments fractionnables, unités
entières pour les autres (jamais 1,37 œuf).

| Catégorie | Bornes | Ancrage | Comportement |
|---|---|---|---|
| Protéine | 50–250 g | 0,15 | variable principale |
| Féculent | 20–400 g | 0,05 | variable principale |
| Matière grasse | 2–45 g | 0,12 | variable d'appoint |
| Produit laitier | 40–500 g | 0,15 | variable |
| Oléagineux | 5–80 g | 1,2 | bouge peu |
| Fruit | 30–260 g | 15 | quasi figé |
| Légume | 60–320 g | 40 | **jamais utilisé pour remplir les calories** |
| Autre | 5–300 g | 2,5 | bouge peu |

Garanties de l'algorithme :
- une quantité 🔒 verrouillée n'est **jamais** modifiée ;
- une quantité que tu viens de saisir est traitée comme fixe pendant le recalcul (« épinglée ») ;
- aucun aliment n'est jamais ajouté ni supprimé automatiquement ;
- si la cible est inatteignable, le repas est conservé tel quel, les écarts sont affichés et une
  piste est proposée (« manque protéine maigre… ») — rien n'est déformé pour atteindre les chiffres.

**Tolérance.** ±5 % par défaut (modifiable). Vert = dans la cible, orange = proche, rouge = éloigné.

## 4. Écrans

| Écran | Contenu |
|---|---|
| Planning | cycle de N jours, déjeuner + dîner par jour, macros des deux personnes visibles sur chaque carte, duplication, bouton « Optimiser le cycle » (suggestions uniquement) |
| Aliments | banque complète, recherche, favoris, création/modification/suppression |
| Petits-déjeuners | catalogue indépendant, sans jour ni date |
| Collations | catalogues 16 h et soir |
| Batch cooking | composants agrégés par session de conservation, cru/cuit, quantités préparées modifiables, liste « cuisson du jour » |
| Courses | besoin vs quantité à acheter (conditionnements), surplus, prix, cases à cocher, budget |
| Paramètres | objectifs, cycle, budget, batch, export/import JSON, réinitialisation du cycle, compte |

Le bouton **Imprimer** (en haut à droite) permet de choisir les sections : planning, batch,
courses, détails nutritionnels, catalogues.

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

**Récupération.** Avant de remplacer l'état local par celui du cloud, l'application en conserve
une copie : Paramètres → Compte → « Restaurer la sauvegarde locale » permet de revenir en arrière.

### 5.4 Hors ligne

Toute modification est écrite dans le `localStorage` immédiatement. Si le réseau est absent,
l'application continue de fonctionner et marque les données « à synchroniser » ; l'envoi repart
automatiquement au retour de la connexion (ou via Paramètres → Envoyer vers le cloud).
Comme Thomas et Julie n'utilisent jamais l'application en même temps, la synchronisation est un
remplacement complet : aucune gestion de conflit.

## 6. Tests

```bash
node tests/engine.test.mjs    # moteur, batch, courses, unités, cru/cuit — sans dépendance
npm i jsdom && node tests/ui.test.mjs   # parcours réel de l'interface
```

Le test de synchronisation vérifie le schéma, la transaction et les policies RLS sur un
PostgreSQL **local** (jamais sur ta base Supabase) : il crée une base jetable, émule `auth.uid()`
et applique `supabase/schema.sql`.

```bash
apt-get install -y postgresql && service postgresql start
node tests/sync.test.mjs
```

## 7. Sauvegarde

Paramètres → Données → **Exporter en JSON** produit un fichier complet (banque, objectifs,
planning, catalogues, paramètres). **Importer un JSON** le restaure intégralement.

## 8. Données livrées

La banque initiale contient des aliments courants avec des valeurs **génériques** : protéines,
féculents, légumes, fruits, produits laitiers, matières grasses, oléagineux, pains et wraps.
Elles ne prétendent correspondre à aucune marque. Pour un produit précis (whey, pain croustillant,
fromage tartinable, skyr d'une marque donnée…), crée l'aliment et recopie les valeurs de
l'emballage. Les prix et conditionnements sont eux aussi indicatifs et modifiables.

Aucune habitude alimentaire n'est codée en dur : aucune association obligatoire, aucun aliment
imposé. L'application fournit les outils, tu construis les repas.
