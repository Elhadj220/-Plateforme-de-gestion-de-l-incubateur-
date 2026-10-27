/**
 * Construction de l'application Express : sécurité, sessions, vues, routes, gestion des erreurs.
 */
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const cookieSession = require('cookie-session');
const config = require('./config');
const ref = require('./referentiel');
const dates = require('./lib/dates');
const texte = require('./lib/texte');
const securite = require('./middleware/securite');
const { jalonsEnRetard } = require('./services/projets');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.set('trust proxy', 1); // derrière le proxy HTTPS de l'hébergeur
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", 'https://fonts.googleapis.com'],
      styleSrcAttr: ["'unsafe-inline'"], // attributs style ponctuels (largeur des barres de progression)
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: null, // l'hébergeur impose déjà HTTPS ; inutile (et bloquant) en HTTP local
    },
  },
}));

// Variables disponibles dans toutes les vues (définies en premier : la page d'erreur en dépend)
app.use((req, res, next) => {
  Object.assign(res.locals, {
    ref, ...dates, ...texte, chemin: req.path, titre: '', iaActive: !!config.gemini.apiKey, user: null, csrf: '', flash: [], nbAlertes: 0,
  });
  next();
});

// Chart.js n'expose pas son fichier UMD via "exports" : on le sert depuis son dossier dist
const cheminChartJs = path.join(path.dirname(require.resolve('chart.js')), 'chart.umd.min.js');
app.get('/static/vendor/chart.umd.min.js', (req, res) => res.sendFile(cheminChartJs, { maxAge: config.isProd ? '7d' : 0 }));
app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: config.isProd ? '7d' : 0 }));
app.get('/favicon.ico', (req, res) => res.redirect(301, '/static/img/favicon.svg'));

app.use(express.urlencoded({ extended: false, limit: '200kb' }));
app.use(cookieSession({
  name: 'incubisep.sid',
  keys: [config.sessionSecret],
  maxAge: 8 * 60 * 60 * 1000, // 8 heures
  httpOnly: true,
  sameSite: 'lax',
}));
// Cookie « Secure » dès que la requête arrive en HTTPS (directement ou via le proxy de l'hébergeur)
app.use((req, res, next) => {
  req.sessionOptions.secure = req.secure;
  next();
});

app.use(securite.chargerUtilisateur);
app.use(securite.jetonCsrf);
app.use(securite.verifierCsrf);
app.use(securite.messagesFlash);

// Badge d'alertes de retard dans la navigation
app.use((req, res, next) => {
  if (req.user && req.method === 'GET') {
    const u = req.user;
    if (u.role === 'coordonnateur') res.locals.nbAlertes = jalonsEnRetard().length;
    else if (u.role === 'mentor') res.locals.nbAlertes = jalonsEnRetard({ mentorId: u.id }).length;
    else if (u.role === 'porteur') res.locals.nbAlertes = jalonsEnRetard({ porteurId: u.id }).length;
  }
  next();
});

app.use(require('./routes/auth'));
app.use(require('./routes/tableau'));
app.use(require('./routes/projets'));
app.use(require('./routes/evaluation'));
app.use(require('./routes/suivi'));
app.use(require('./routes/comptes-rendus'));
app.use(require('./routes/admin'));

app.get('/sante', (req, res) => res.json({ statut: 'ok' }));

app.use((req, res) => {
  res.status(404).render('erreur', { titre: 'Page introuvable', message: "La page demandée n'existe pas ou a été déplacée." });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`, err);
  if (res.headersSent) return res.end();
  return res.status(500).render('erreur', {
    titre: 'Erreur interne',
    message: config.isProd ? "Une erreur inattendue s'est produite. Réessayez ou contactez l'administrateur." : err.message,
  });
});

module.exports = app;
