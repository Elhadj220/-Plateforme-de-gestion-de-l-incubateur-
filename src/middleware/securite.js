/**
 * Middlewares de sécurité et de session : authentification, rôles, CSRF, messages flash,
 * limitation des tentatives de connexion.
 */
const crypto = require('node:crypto');
const db = require('../db');

/** Charge l'utilisateur connecté (si la session est valide et le compte actif). */
function chargerUtilisateur(req, res, next) {
  req.user = null;
  if (req.session?.userId) {
    const u = db.get('SELECT id, prenom, nom, email, role, genre, actif FROM utilisateurs WHERE id = ?', req.session.userId);
    if (u && u.actif) req.user = u;
    else delete req.session.userId;
  }
  res.locals.user = req.user;
  next();
}

function exigerConnexion(req, res, next) {
  if (req.user) return next();
  if (req.method === 'GET') req.session.retour = req.originalUrl;
  flash(req, 'info', 'Veuillez vous connecter pour accéder à cette page.');
  return res.redirect('/connexion');
}

/** Autorise uniquement les rôles listés. */
function exigerRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return exigerConnexion(req, res, next);
    if (roles.includes(req.user.role)) return next();
    return refuser(res);
  };
}

function refuser(res) {
  return res.status(403).render('erreur', {
    titre: 'Accès refusé',
    message: 'Vous n\'avez pas les droits nécessaires pour accéder à cette ressource.',
  });
}

/* ---------- Protection CSRF (jeton synchronisé stocké en session) ---------- */

function jetonCsrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrf = req.session.csrf;
  next();
}

function jetonValide(req) {
  const recu = req.body?._csrf || req.get('x-csrf-token') || '';
  const attendu = req.session?.csrf || '';
  if (!recu || recu.length !== attendu.length) return false;
  return crypto.timingSafeEqual(Buffer.from(recu), Buffer.from(attendu));
}

/**
 * Vérifie le jeton sur toutes les requêtes modifiantes.
 * Les formulaires multipart (dépôt de fichiers) sont vérifiés après lecture du corps,
 * via verifierCsrfApresDepot.
 */
function verifierCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.is('multipart/form-data')) return next();
  if (jetonValide(req)) return next();
  return res.status(403).render('erreur', {
    titre: 'Session expirée',
    message: 'Le formulaire a expiré ou n\'est pas valide. Rechargez la page puis réessayez.',
  });
}

function verifierCsrfApresDepot(req, res, next) {
  if (jetonValide(req)) return next();
  return res.status(403).render('erreur', {
    titre: 'Session expirée',
    message: 'Le formulaire a expiré ou n\'est pas valide. Rechargez la page puis réessayez.',
  });
}

/* ---------- Messages flash ---------- */

function flash(req, type, message) {
  req.session.flash = [...(req.session.flash || []), { type, message }];
}

function messagesFlash(req, res, next) {
  res.locals.flash = req.session?.flash || [];
  if (req.session?.flash) delete req.session.flash;
  next();
}

/* ---------- Limitation des tentatives de connexion ---------- */

const tentatives = new Map();
const FENETRE_MS = 15 * 60 * 1000;
const MAX_TENTATIVES = 5;

function cleTentative(req) {
  return `${req.ip}|${String(req.body?.email || '').toLowerCase()}`;
}

function connexionBloquee(req) {
  const t = tentatives.get(cleTentative(req));
  if (!t) return false;
  if (Date.now() - t.debut > FENETRE_MS) { tentatives.delete(cleTentative(req)); return false; }
  return t.nombre >= MAX_TENTATIVES;
}

function echecConnexion(req) {
  const cle = cleTentative(req);
  const t = tentatives.get(cle);
  if (!t || Date.now() - t.debut > FENETRE_MS) tentatives.set(cle, { debut: Date.now(), nombre: 1 });
  else t.nombre += 1;
}

function reussiteConnexion(req) {
  tentatives.delete(cleTentative(req));
}

module.exports = {
  chargerUtilisateur, exigerConnexion, exigerRole, refuser, jetonCsrf, verifierCsrf, verifierCsrfApresDepot,
  flash, messagesFlash, connexionBloquee, echecConnexion, reussiteConnexion,
};
