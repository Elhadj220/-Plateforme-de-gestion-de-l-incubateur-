/**
 * Point d'entrée : initialise la base (et les données de démonstration si elle est vide), puis démarre le serveur.
 */
const db = require('./src/db');
const config = require('./src/config');

db.initSchema();
if (db.isEmpty()) {
  console.log('Base vide : chargement du jeu de données de démonstration…');
  require('./src/db/seed').seed();
}

const app = require('./src/app');

const serveur = app.listen(config.port, () => {
  console.log(`Incub'ISEP démarré sur http://localhost:${config.port}`);
  console.log(config.gemini.apiKey
    ? `IA générative : Google Gemini (${config.gemini.model})`
    : 'IA générative : aucune clé GEMINI_API_KEY, le modèle de secours sera utilisé.');
});

serveur.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Le port ${config.port} est déjà utilisé par un autre programme.`);
    console.error('Choisissez un autre port dans le fichier .env (exemple : PORT=3001), puis relancez « npm start ».');
    process.exit(1);
  }
  throw err;
});
