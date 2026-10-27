/**
 * Accueil public, connexion, inscription des porteurs, déconnexion, profil et page d'information sur l'IA.
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { regles: r, valider } = require('../lib/validation');
const s = require('../middleware/securite');

const router = express.Router();

// Empreinte factice : la vérification prend le même temps, que le compte existe ou non.
const EMPREINTE_FICTIVE = bcrypt.hashSync('compte-inexistant', 10);

router.get('/', (req, res) => {
  if (req.user) return res.redirect('/tableau-de-bord');
  const chiffres = db.get(
    `SELECT SUM(statut IN ('en_incubation','termine')) AS incubes,
            SUM(statut <> 'brouillon') AS candidatures,
            (SELECT COUNT(*) FROM cohortes) AS cohortes
       FROM projets`,
  );
  return res.render('accueil', { titre: 'Accueil', chiffres });
});

router.get('/connexion', (req, res) => {
  if (req.user) return res.redirect('/tableau-de-bord');
  return res.render('auth/connexion', { titre: 'Connexion', email: '' });
});

router.post('/connexion', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const motDePasse = String(req.body.mot_de_passe || '');
  if (s.connexionBloquee(req)) {
    return res.status(429).render('auth/connexion', { titre: 'Connexion', email, erreur: 'Trop de tentatives. Réessayez dans 15 minutes.' });
  }
  const u = db.get('SELECT * FROM utilisateurs WHERE email = ?', email);
  const ok = await bcrypt.compare(motDePasse, u?.mot_de_passe || EMPREINTE_FICTIVE);
  if (!u || !ok || !u.actif) {
    s.echecConnexion(req);
    const erreur = u && ok && !u.actif ? 'Ce compte est désactivé. Contactez le coordonnateur du CIAT.' : 'E-mail ou mot de passe incorrect.';
    return res.status(401).render('auth/connexion', { titre: 'Connexion', email, erreur });
  }
  s.reussiteConnexion(req);
  const retour = req.session.retour;
  // Nouvelle session (prévention de la fixation de session)
  req.session = { userId: u.id };
  db.run("UPDATE utilisateurs SET derniere_connexion = datetime('now') WHERE id = ?", u.id);
  return res.redirect(retour && retour.startsWith('/') && !retour.startsWith('//') ? retour : '/tableau-de-bord');
});

router.get('/inscription', (req, res) => {
  if (req.user) return res.redirect('/tableau-de-bord');
  return res.render('auth/inscription', { titre: 'Créer un compte porteur', v: {}, erreurs: {} });
});

const schemaInscription = {
  prenom: [r.requis, r.max(60)],
  nom: [r.requis, r.max(60)],
  email: [r.requis, r.email, r.max(120)],
  telephone: [r.telephone],
  genre: [r.parmi(['F', 'M'])],
  structure: [r.max(120)],
  mot_de_passe: [r.requis, r.motDePasse],
};

router.post('/inscription', async (req, res) => {
  const { valeurs: v, erreurs } = valider(req.body, schemaInscription);
  if (!erreurs.mot_de_passe && req.body.mot_de_passe !== req.body.confirmation) erreurs.confirmation = 'Les mots de passe ne correspondent pas.';
  if (!req.body.consentement) erreurs.consentement = 'Vous devez accepter le traitement de vos données pour créer un compte.';
  if (!erreurs.email && db.get('SELECT 1 AS x FROM utilisateurs WHERE email = ?', v.email)) erreurs.email = 'Un compte existe déjà avec cette adresse.';
  if (Object.keys(erreurs).length) {
    delete v.mot_de_passe;
    return res.status(422).render('auth/inscription', { titre: 'Créer un compte porteur', v, erreurs });
  }
  const hash = await bcrypt.hash(v.mot_de_passe, 10);
  const { id } = db.run(
    `INSERT INTO utilisateurs (prenom, nom, email, mot_de_passe, role, genre, telephone, structure)
     VALUES (?, ?, ?, ?, 'porteur', ?, ?, ?)`,
    v.prenom, v.nom, v.email.toLowerCase(), hash, v.genre, v.telephone, v.structure,
  );
  req.session = { userId: id };
  s.flash(req, 'succes', 'Votre compte a été créé. Vous pouvez maintenant déposer votre dossier de candidature.');
  return res.redirect('/tableau-de-bord');
});

router.post('/deconnexion', (req, res) => {
  req.session = null;
  res.redirect('/connexion');
});

/* ---------- Profil ---------- */

router.get('/profil', s.exigerConnexion, (req, res) => {
  const v = db.get('SELECT * FROM utilisateurs WHERE id = ?', req.user.id);
  res.render('auth/profil', { titre: 'Mon profil', v, erreurs: {} });
});

router.post('/profil', s.exigerConnexion, (req, res) => {
  const { valeurs: v, erreurs } = valider(req.body, {
    prenom: [r.requis, r.max(60)], nom: [r.requis, r.max(60)], telephone: [r.telephone],
    genre: [r.parmi(['F', 'M'])], structure: [r.max(120)], expertise: [r.max(200)],
  });
  if (Object.keys(erreurs).length) {
    return res.status(422).render('auth/profil', { titre: 'Mon profil', v: { ...v, email: req.user.email, role: req.user.role }, erreurs });
  }
  db.run('UPDATE utilisateurs SET prenom = ?, nom = ?, telephone = ?, genre = ?, structure = ?, expertise = ? WHERE id = ?',
    v.prenom, v.nom, v.telephone, v.genre, v.structure, v.expertise, req.user.id);
  s.flash(req, 'succes', 'Profil mis à jour.');
  return res.redirect('/profil');
});

router.post('/profil/mot-de-passe', s.exigerConnexion, async (req, res) => {
  const u = db.get('SELECT mot_de_passe FROM utilisateurs WHERE id = ?', req.user.id);
  const nouveau = String(req.body.nouveau || '');
  if (!(await bcrypt.compare(String(req.body.actuel || ''), u.mot_de_passe))) {
    s.flash(req, 'erreur', 'Mot de passe actuel incorrect.');
  } else if (r.motDePasse(nouveau) || !nouveau) {
    s.flash(req, 'erreur', `Nouveau mot de passe refusé : ${r.motDePasse(nouveau) || 'champ vide.'}`);
  } else if (nouveau !== req.body.confirmation) {
    s.flash(req, 'erreur', 'La confirmation ne correspond pas au nouveau mot de passe.');
  } else {
    db.run('UPDATE utilisateurs SET mot_de_passe = ? WHERE id = ?', await bcrypt.hash(nouveau, 10), req.user.id);
    s.flash(req, 'succes', 'Mot de passe modifié.');
  }
  res.redirect('/profil');
});

router.get('/ia-et-donnees', (req, res) => res.render('ia-et-donnees', { titre: "Usage de l'IA et protection des données" }));

module.exports = router;
