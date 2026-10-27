# Incub'ISEP — Plateforme de gestion de l'incubateur du CIAT

Application web de gestion du parcours complet d'un projet incubé au **CIAT de l'ISEP Amadou Trawaré de Diamniadio** : de la candidature au suivi six mois après la sortie de l'incubateur.

> Projet 2 de l'évaluation pratique du cours d'IA générative : « Plateforme de gestion de l'incubateur ».

## Fonctionnalités

| Besoin du sujet | Réalisation |
|---|---|
| Compte du porteur et gestion du profil | Inscription avec consentement, connexion, profil, changement de mot de passe |
| Dépôt du dossier, contrôle de complétude, documents | Formulaire structuré, pièces obligatoires, jauge de complétude, soumission bloquée si incomplet, accusé de réception |
| Grille d'évaluation, comité, décision motivée | Grille pondérée (6 critères, score /100), avis indépendants, décision motivée (retenu / ajourné / refusé) |
| Mentor et objectifs | Affectation selon la charge des mentors, objectifs avec indicateur et cible |
| Calendrier, jalons, preuves, commentaires, alertes de retard | Jalons avec cycle « à faire → en cours → soumis → validé / à reprendre », preuves déposées, fil d'échanges, alertes et badge de retard |
| Tableau de bord du coordonnateur, suivi à 3 et 6 mois | Indicateurs, filtres (cohorte, domaine, période), graphiques, contrôle qualité, suivis post-incubation planifiés automatiquement |
| Comptes rendus, export PDF ou Excel | Comptes rendus (rédigés ou générés par IA puis validés), PDF des comptes rendus, fiches projet et tableau de bord, classeur Excel |

### IA générative (Google Gemini)

1. **Pré-analyse des dossiers** pour le comité (synthèse, forces, vigilances, questions) — sans note ni décision.
2. **Brouillons de comptes rendus** (suivi, mentorat, PV du comité, sortie) à partir des données du projet.
3. **Proposition de jalons** au format JSON, validée et corrigée par le mentor avant enregistrement.

Garde-fous : aucune donnée d'identification envoyée (pseudonymisation), consigne de ne rien inventer, relecture humaine obligatoire, traçabilité de chaque appel (`/admin/journal-ia`), repli automatique sur un modèle de secours déterministe si l'API est indisponible.

## Stack technique

- **Node.js ≥ 22.13** et **Express 4** (rendu serveur avec EJS)
- **SQLite** via le module natif `node:sqlite` (aucune compilation, aucun serveur de base de données)
- Sécurité : `helmet` (CSP stricte), sessions signées `cookie-session`, mots de passe `bcryptjs`, jeton CSRF, limitation des tentatives de connexion, contrôle de la signature binaire des fichiers
- Exports : `pdfkit` (PDF) et `exceljs` (Excel) ; graphiques : `Chart.js`

## Installation locale

```bash
cd application
npm install
copy .env.example .env      # Windows (cp sous Linux/macOS) puis renseigner GEMINI_API_KEY
npm start                   # http://localhost:3000
```

Au premier démarrage, la base est créée et le **jeu de données de démonstration** est chargé automatiquement.
Pour le réinitialiser : `npm run seed`. Pour lancer les tests automatisés : `npm test`.

La clé Gemini est gratuite sur <https://aistudio.google.com/apikey>. Sans clé, l'application reste entièrement fonctionnelle : les fonctions d'IA produisent un brouillon structuré de secours, clairement signalé.

## Comptes de démonstration

Mot de passe commun : **`Demo2026!`**

| Rôle | E-mail | Ce qu'on peut montrer |
|---|---|---|
| Coordonnatrice | `coordination@demo.sn` | Décisions, affectation des mentors, analyses, exports, administration |
| Membre du comité | `comite@demo.sn` | Dossiers à évaluer, grille, pré-analyse IA |
| Mentor | `mentor@demo.sn` | Jalons, validation, suggestion IA de jalons, comptes rendus |
| Porteuse (projet incubé) | `porteur@demo.sn` | Suivi, preuves, retards |
| Porteur (brouillon) | `porteur2@demo.sn` | Complétion et soumission d'un dossier |

Toutes les personnes et tous les projets du jeu de données sont **fictifs**. Les dates sont calculées par rapport au jour du chargement : la démonstration présente toujours des retards et des suivis à réaliser.

## Arborescence

```
application/
├── server.js                 Point d'entrée (initialisation de la base puis démarrage)
├── src/
│   ├── app.js                Configuration Express, sécurité, routes, erreurs
│   ├── config.js             Variables d'environnement
│   ├── referentiel.js        Libellés, statuts, domaines, règles de complétude
│   ├── db/                   schema.sql, accès SQLite, jeu de démonstration (seed)
│   ├── lib/                  Dates, validation des formulaires, mise en forme sûre
│   ├── middleware/           Authentification, rôles, CSRF, messages, anti-force brute
│   ├── routes/               auth, tableau, projets, evaluation, suivi, comptes-rendus, admin
│   └── services/             Règles métier, IA (Gemini), indicateurs, exports, fichiers
├── views/                    Gabarits EJS
├── public/                   CSS, JavaScript, logos
└── tests/                    Tests automatisés (node:test)
```

## Déploiement (Render, offre gratuite)

1. Publier le dossier `application/` sur un dépôt GitHub.
2. Sur <https://render.com> : **New → Blueprint**, choisir le dépôt (le fichier `render.yaml` est détecté).
3. Renseigner `GEMINI_API_KEY` dans les variables d'environnement ; `SESSION_SECRET` est généré automatiquement.
4. Le lien public est de la forme `https://incub-isep.onrender.com`.

Limite connue de l'offre gratuite : le disque n'est pas persistant (la base revient au jeu de démonstration à chaque redéploiement ou mise en veille prolongée). Pour une exploitation réelle, ajouter un disque persistant Render et définir `DB_PATH` / `UPLOAD_DIR` dessus, ou utiliser l'image Docker fournie avec un volume.

Docker : `docker build -t incub-isep . && docker run -p 3000:3000 -e SESSION_SECRET=... -e GEMINI_API_KEY=... -v incub-data:/app/data incub-isep`

## Variables d'environnement

| Variable | Rôle | Défaut |
|---|---|---|
| `NODE_ENV` | `production` masque les détails des erreurs (les cookies sont marqués Secure dès que la connexion est en HTTPS) | `development` |
| `PORT` | Port HTTP | `3000` |
| `SESSION_SECRET` | Secret de signature des sessions (≥ 32 caractères, obligatoire en production) | valeur de développement |
| `GEMINI_API_KEY` | Clé de l'API Google Gemini | vide (modèle de secours) |
| `GEMINI_MODEL` | Modèle principal | `gemini-3.5-flash` |
| `GEMINI_MODELES_REMPLACEMENT` | Modèles essayés si le principal est surchargé (503), limité (429) ou indisponible | `gemini-3.8-flash,gemini-flash-latest` |
| `DB_PATH`, `UPLOAD_DIR` | Emplacements de la base et des fichiers déposés | `data/` |
