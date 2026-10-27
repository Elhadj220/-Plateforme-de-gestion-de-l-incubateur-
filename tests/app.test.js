/**
 * Tests automatisés (node:test) : sécurité, droits d'accès et parcours complet d'un projet.
 * Lancement : npm test
 * Les tests utilisent une base temporaire et le modèle de secours de l'IA (aucune clé requise).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dossierTest = fs.mkdtempSync(path.join(os.tmpdir(), 'incubisep-test-'));
process.env.DB_PATH = path.join(dossierTest, 'test.db');
process.env.UPLOAD_DIR = path.join(dossierTest, 'uploads');
process.env.GEMINI_API_KEY = '';
process.env.NODE_ENV = 'test';

const db = require('../src/db');
const { seed } = require('../src/db/seed');
const P = require('../src/services/projets');
const { analyserJalons } = require('../src/services/ia');
const { markdownVersHtml } = require('../src/lib/texte');

let serveur;
let base;

before(async () => {
  const log = console.log;
  console.log = () => {};
  db.initSchema();
  seed();
  console.log = log;
  const app = require('../src/app');
  await new Promise((resolve) => { serveur = app.listen(0, resolve); });
  base = `http://127.0.0.1:${serveur.address().port}`;
});

after(() => {
  serveur?.close();
  try { db.db.close(); } catch { /* déjà fermée */ }
  fs.rmSync(dossierTest, { recursive: true, force: true });
});

/** Client HTTP minimal qui conserve les cookies de session et lit le jeton CSRF. */
function client() {
  const cookies = new Map();
  let csrf = '';
  const requete = async (methode, url, corps, entetes = {}) => {
    const res = await fetch(base + url, {
      method: methode,
      redirect: 'manual',
      headers: { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...entetes },
      body: corps,
    });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      cookies.set(kv.slice(0, i), kv.slice(i + 1));
    }
    const type = res.headers.get('content-type') || '';
    const texte = type.includes('text/html') ? await res.text() : '';
    const m = texte.match(/name="_csrf" value="([0-9a-f]+)"/);
    if (m) csrf = m[1];
    return { status: res.status, texte, type, location: res.headers.get('location'), res };
  };
  return {
    get: (url) => requete('GET', url),
    post: async (url, donnees = {}, avecJeton = true) => {
      if (avecJeton && !csrf) await requete('GET', '/connexion');
      const corps = new URLSearchParams({ ...(avecJeton ? { _csrf: csrf } : {}), ...donnees });
      return requete('POST', url, corps, { 'content-type': 'application/x-www-form-urlencoded' });
    },
    deposer: async (url, champs, nomFichier, contenu) => {
      const fd = new FormData();
      fd.append('_csrf', csrf);
      Object.entries(champs).forEach(([k, v]) => fd.append(k, v));
      fd.append('fichier', new Blob([contenu]), nomFichier);
      return requete('POST', url, fd);
    },
    async connexion(email, mdp = 'Demo2026!') {
      await requete('GET', '/connexion');
      const r = await this.post('/connexion', { email, mot_de_passe: mdp });
      // La session est régénérée à la connexion : on récupère le nouveau jeton CSRF
      if (r.status === 302) await requete('GET', '/profil');
      return r;
    },
  };
}

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');

/* ------------------------------------------------------------------ */
/* Tests unitaires                                                     */
/* ------------------------------------------------------------------ */

test('calcul du score pondéré sur 100', () => {
  const criteres = [{ id: 1, poids: 60 }, { id: 2, poids: 40 }];
  assert.equal(P.calculerScore(criteres, { 1: 5, 2: 5 }), 100);
  assert.equal(P.calculerScore(criteres, { 1: 0, 2: 0 }), 0);
  assert.equal(P.calculerScore(criteres, { 1: 5, 2: 0 }), 60);
  assert.equal(P.calculerScore(criteres, { 1: 3, 2: 4 }), 68);
});

test('la réponse JSON de l\'IA est validée et nettoyée', () => {
  const r = analyserJalons('```json\n[{"titre":"Prototype","description":"Vidéo","date_echeance":"2030-01-15"},{"titre":""},{"x":1}]\n```', '2030-01-01');
  assert.equal(r.length, 1);
  assert.equal(r[0].titre, 'Prototype');
  const dateInvalide = analyserJalons('[{"titre":"A","date_echeance":"2020-01-01"}]', '2030-01-01');
  assert.equal(dateInvalide[0].date_echeance, '2030-01-31');
  assert.deepEqual(analyserJalons('pas du json', '2030-01-01'), []);
});

test('le rendu Markdown échappe le HTML (protection XSS)', () => {
  const html = markdownVersHtml('## Titre <script>alert(1)</script>\n- **gras** <img src=x onerror=alert(1)>');
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('<strong>gras</strong>'));
});

/* ------------------------------------------------------------------ */
/* Sécurité et droits d'accès                                          */
/* ------------------------------------------------------------------ */

test('pages publiques accessibles, pages privées protégées', async () => {
  const c = client();
  for (const url of ['/', '/connexion', '/inscription', '/ia-et-donnees', '/sante', '/static/css/app.css', '/static/js/app.js', '/static/vendor/chart.umd.min.js', '/static/img/logo.svg']) {
    assert.equal((await c.get(url)).status, 200, url);
  }
  const r = await c.get('/projets');
  assert.equal(r.status, 302);
  assert.equal(r.location, '/connexion');
  assert.equal((await c.get('/page-inexistante')).status, 404);
});

test('en-têtes de sécurité présents', async () => {
  const r = await client().get('/');
  assert.ok(r.res.headers.get('content-security-policy').includes("script-src 'self'"));
  assert.equal(r.res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.res.headers.get('x-powered-by'), null);
});

test('connexion : refus avec un mauvais mot de passe, puis blocage après 5 essais', async () => {
  const c = client();
  const r = await c.connexion('n.sene@demo.sn', 'mauvais');
  assert.equal(r.status, 401);
  for (let i = 0; i < 4; i += 1) await c.connexion('n.sene@demo.sn', 'mauvais');
  const bloque = await c.connexion('n.sene@demo.sn', 'Demo2026!');
  assert.equal(bloque.status, 429);
});

test('requête sans jeton CSRF refusée', async () => {
  const c = client();
  await c.connexion('porteur@demo.sn');
  const r = await c.post('/projets/nouveau', { titre: 'Projet pirate', domaine: 'TIC, numérique, IA et données' }, false);
  assert.equal(r.status, 403);
});

test('chaque rôle accède à ses pages et pas à celles des autres', async () => {
  const pages = {
    'coordination@demo.sn': ['/tableau-de-bord', '/projets', '/coordination/tableau-de-bord', '/coordination/qualite', '/alertes',
      '/comptes-rendus', '/admin/utilisateurs', '/admin/cohortes', '/admin/grille', '/admin/journal-ia', '/admin/journal', '/profil'],
    'comite@demo.sn': ['/tableau-de-bord', '/projets', '/profil'],
    'mentor@demo.sn': ['/tableau-de-bord', '/projets', '/alertes', '/comptes-rendus', '/profil'],
    'porteur@demo.sn': ['/tableau-de-bord', '/projets', '/projets/nouveau', '/alertes', '/profil'],
  };
  const interdites = {
    'comite@demo.sn': ['/admin/utilisateurs', '/coordination/tableau-de-bord', '/alertes'],
    'mentor@demo.sn': ['/admin/utilisateurs', '/coordination/export.xlsx', '/projets/nouveau'],
    'porteur@demo.sn': ['/admin/utilisateurs', '/coordination/tableau-de-bord', '/comptes-rendus'],
  };
  for (const [email, urls] of Object.entries(pages)) {
    const c = client();
    const r = await c.connexion(email);
    assert.equal(r.location, '/tableau-de-bord', email);
    for (const url of urls) {
      const p = await c.get(url);
      assert.equal(p.status, 200, `${email} ${url}`);
      assert.ok(!p.texte.includes('Erreur interne'), `${email} ${url}`);
    }
    for (const url of interdites[email] || []) assert.equal((await c.get(url)).status, 403, `${email} ${url}`);
  }
});

test('toutes les fiches projet s\'affichent pour le coordonnateur', async () => {
  const c = client();
  await c.connexion('coordination@demo.sn');
  for (const { id } of db.all('SELECT id FROM projets')) {
    for (const onglet of ['', '?onglet=suivi']) {
      const r = await c.get(`/projets/${id}${onglet}`);
      assert.equal(r.status, 200, `projet ${id}`);
    }
  }
});

test('un porteur ne peut pas consulter le projet d\'un autre porteur ni ses documents', async () => {
  const c = client();
  await c.connexion('porteur@demo.sn');
  const autre = db.get("SELECT p.id FROM projets p JOIN utilisateurs u ON u.id = p.porteur_id WHERE u.email <> 'porteur@demo.sn' LIMIT 1");
  assert.equal((await c.get(`/projets/${autre.id}`)).status, 403);
  const doc = db.get('SELECT id FROM documents WHERE projet_id = ?', autre.id);
  if (doc) assert.equal((await c.get(`/documents/${doc.id}`)).status, 403);
});

/* ------------------------------------------------------------------ */
/* Parcours complet                                                    */
/* ------------------------------------------------------------------ */

test('parcours complet : dossier → évaluation → décision → incubation → suivi', async () => {
  const porteur = client();
  await porteur.connexion('porteur2@demo.sn');
  const projet = db.get("SELECT p.* FROM projets p JOIN utilisateurs u ON u.id = p.porteur_id WHERE u.email = 'porteur2@demo.sn'");
  assert.equal(projet.statut, 'brouillon');

  // 1. Soumission refusée car dossier incomplet
  await porteur.post(`/projets/${projet.id}/soumettre`);
  assert.equal(db.get('SELECT statut FROM projets WHERE id = ?', projet.id).statut, 'brouillon');

  // 2. Complétion des champs
  const r1 = await porteur.post(`/projets/${projet.id}/modifier`, {
    titre: projet.titre, domaine: projet.domaine, resume: projet.resume, stade: 'prototype', taille_equipe: '4', besoin_financement: '7000000',
    probleme: 'Les pannes immobilisent l\'irrigation.', solution: 'Un atelier mobile.', marche_cible: 'Maraîchers de Diamniadio.', modele_economique: 'Contrats.',
  });
  assert.equal(r1.status, 302);

  // 3. Dépôts : un faux PDF est refusé, les vrais sont acceptés
  await porteur.get(`/projets/${projet.id}`);
  await porteur.deposer(`/projets/${projet.id}/documents`, { type_doc: 'cv' }, 'faux.pdf', Buffer.from('ceci n\'est pas un pdf'));
  assert.equal(db.get('SELECT COUNT(*) AS n FROM documents WHERE projet_id = ?', projet.id).n, 0);
  for (const t of ['piece_identite', 'cv', 'fiche_projet']) {
    await porteur.get(`/projets/${projet.id}`);
    await porteur.deposer(`/projets/${projet.id}/documents`, { type_doc: t }, `${t}.pdf`, PDF);
  }
  assert.equal(db.get('SELECT COUNT(*) AS n FROM documents WHERE projet_id = ?', projet.id).n, 3);
  assert.ok(P.completude(db.get('SELECT * FROM projets WHERE id = ?', projet.id)).complet);

  // 4. Soumission (accusé de réception)
  await porteur.get(`/projets/${projet.id}`);
  await porteur.post(`/projets/${projet.id}/soumettre`);
  assert.equal(db.get('SELECT statut FROM projets WHERE id = ?', projet.id).statut, 'soumis');
  assert.ok((await porteur.get(`/projets/${projet.id}`)).texte.includes('Accusé de réception'));

  // 5. Évaluation par un membre du comité (+ pré-analyse IA en mode secours)
  const comite = client();
  await comite.connexion('comite@demo.sn');
  await comite.get(`/projets/${projet.id}/evaluation`);
  await comite.post(`/projets/${projet.id}/analyse-ia`);
  assert.ok(db.get('SELECT analyse_ia FROM projets WHERE id = ?', projet.id).analyse_ia.includes('## Synthèse'));
  const notes = Object.fromEntries(db.all('SELECT id FROM criteres').map((c) => [`note_${c.id}`, '4']));
  await comite.post(`/projets/${projet.id}/evaluation`, { ...notes, recommandation: 'favorable', commentaire: 'Projet solide, besoin réel et équipe expérimentée en maintenance.' });
  const ev = db.get('SELECT * FROM evaluations WHERE projet_id = ?', projet.id);
  assert.equal(ev.score, 80);
  assert.equal(db.get('SELECT statut FROM projets WHERE id = ?', projet.id).statut, 'en_evaluation');

  // 6. Décision motivée et affectation du mentor
  const coordo = client();
  await coordo.connexion('coordination@demo.sn');
  await coordo.get(`/projets/${projet.id}`);
  await coordo.post(`/projets/${projet.id}/decision`, { decision: 'retenu', motivation: 'trop court' });
  assert.equal(db.get('SELECT statut FROM projets WHERE id = ?', projet.id).statut, 'en_evaluation');
  const cohorte = db.get('SELECT id FROM cohortes ORDER BY date_debut DESC LIMIT 1');
  await coordo.post(`/projets/${projet.id}/decision`, { decision: 'retenu', cohorte_id: String(cohorte.id), motivation: 'Projet retenu : besoin avéré, équipe compétente et prototype crédible.' });
  assert.equal(db.get('SELECT statut FROM projets WHERE id = ?', projet.id).statut, 'retenu');
  const mentor = db.get("SELECT id FROM utilisateurs WHERE email = 'mentor@demo.sn'");
  await coordo.post(`/projets/${projet.id}/mentor`, { mentor_id: String(mentor.id) });
  assert.equal(db.get('SELECT statut FROM projets WHERE id = ?', projet.id).statut, 'en_incubation');

  // 7. Le mentor fixe un objectif, demande des jalons à l'IA et en retient deux
  const m = client();
  await m.connexion('mentor@demo.sn');
  await m.get(`/projets/${projet.id}`);
  await m.post(`/projets/${projet.id}/objectifs`, { libelle: 'Signer 10 contrats d\'entretien', indicateur: 'Contrats signés', cible: '10' });
  const sugg = await m.post(`/projets/${projet.id}/jalons/suggestion-ia`);
  assert.equal(sugg.status, 200);
  assert.ok(sugg.texte.includes('Jalons proposés'));
  const champs = { nombre: '6' };
  for (let i = 0; i < 6; i += 1) {
    const val = (n) => (sugg.texte.match(new RegExp(`name="${n}_${i}"[^>]*value="([^"]*)"`)) || [])[1];
    Object.assign(champs, { [`titre_${i}`]: val('titre'), [`date_${i}`]: val('date'), [`description_${i}`]: val('description') });
    if (i < 2) champs[`garder_${i}`] = '1';
  }
  await m.post(`/projets/${projet.id}/jalons/lot`, champs);
  const jalons = db.all('SELECT * FROM jalons WHERE projet_id = ?', projet.id);
  assert.equal(jalons.length, 2);

  // 8. Le porteur dépose une preuve et soumet le jalon ; le mentor le valide
  const j = jalons[0];
  await porteur.get(`/projets/${projet.id}`);
  await porteur.post(`/jalons/${j.id}/statut`, { action: 'soumettre' });
  assert.notEqual(db.get('SELECT statut FROM jalons WHERE id = ?', j.id).statut, 'soumis'); // pas de preuve
  await porteur.deposer(`/jalons/${j.id}/preuves`, { commentaire: 'Rapport' }, 'rapport.pdf', PDF);
  await porteur.get(`/projets/${projet.id}`);
  await porteur.post(`/jalons/${j.id}/statut`, { action: 'soumettre' });
  assert.equal(db.get('SELECT statut FROM jalons WHERE id = ?', j.id).statut, 'soumis');
  await porteur.post(`/jalons/${j.id}/statut`, { action: 'valider' });
  assert.equal(db.get('SELECT statut FROM jalons WHERE id = ?', j.id).statut, 'soumis'); // le porteur ne peut pas valider
  await m.get(`/projets/${projet.id}`);
  await m.post(`/jalons/${j.id}/statut`, { action: 'valider' });
  assert.equal(db.get('SELECT statut FROM jalons WHERE id = ?', j.id).statut, 'valide');

  // 9. Compte rendu : brouillon IA, enregistrement, validation, PDF
  const gen = await m.post(`/projets/${projet.id}/comptes-rendus/generer`, { type_cr: 'suivi', notes: 'Séance du jour : prototype présenté.' });
  assert.equal(gen.status, 200);
  const contenu = gen.texte.match(/<textarea id="contenu"[^>]*>([\s\S]*?)<\/textarea>/)[1].replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  const save = await m.post(`/projets/${projet.id}/comptes-rendus`, { type_cr: 'suivi', titre: 'Rapport de suivi n°1', contenu, genere_par_ia: '1' });
  const crId = Number(save.location.split('/').pop());
  assert.equal(db.get('SELECT genere_par_ia, statut FROM comptes_rendus WHERE id = ?', crId).statut, 'brouillon');
  assert.equal((await porteur.get(`/comptes-rendus/${crId}`)).status, 403); // brouillon invisible pour le porteur
  await m.get(`/comptes-rendus/${crId}`);
  await m.post(`/comptes-rendus/${crId}/valider`);
  assert.equal(db.get('SELECT statut FROM comptes_rendus WHERE id = ?', crId).statut, 'valide');
  assert.equal((await porteur.get(`/comptes-rendus/${crId}`)).status, 200);
  const pdf = await m.get(`/comptes-rendus/${crId}/pdf`);
  assert.equal(pdf.type, 'application/pdf');
  assert.ok(db.get('SELECT COUNT(*) AS n FROM journal_ia WHERE projet_id = ?', projet.id).n >= 3);

  // 10. Sortie d'incubation : suivis à 3 et 6 mois planifiés
  await coordo.get(`/projets/${projet.id}`);
  await coordo.post(`/projets/${projet.id}/sortie`);
  assert.equal(db.get('SELECT statut FROM projets WHERE id = ?', projet.id).statut, 'termine');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM suivis WHERE projet_id = ?', projet.id).n, 2);
});

test('exports PDF et Excel du tableau de bord et de la fiche projet', async () => {
  const c = client();
  await c.connexion('coordination@demo.sn');
  const xlsx = await c.get('/coordination/export.xlsx?domaine=' + encodeURIComponent('TIC, numérique, IA et données'));
  assert.equal(xlsx.status, 200);
  assert.ok(xlsx.type.includes('spreadsheetml'));
  const buf = Buffer.from(await xlsx.res.arrayBuffer());
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
  const pdf = await c.get('/coordination/export.pdf');
  assert.equal(pdf.type, 'application/pdf');
  assert.equal(Buffer.from(await pdf.res.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  const id = db.get("SELECT id FROM projets WHERE statut = 'en_incubation' LIMIT 1").id;
  const fiche = await c.get(`/projets/${id}/fiche.pdf`);
  assert.equal(fiche.type, 'application/pdf');
});

test('inscription d\'un nouveau porteur avec validation des champs', async () => {
  const c = client();
  await c.get('/inscription');
  const ko = await c.post('/inscription', { prenom: 'Test', nom: 'Porteur', email: 'pas-un-email', mot_de_passe: 'court', confirmation: 'court' });
  assert.equal(ko.status, 422);
  assert.ok(ko.texte.includes('Adresse e-mail invalide'));
  const ok = await c.post('/inscription', { prenom: 'Test', nom: 'Porteur', email: 'test.porteur@exemple.sn', mot_de_passe: 'Motdepasse1', confirmation: 'Motdepasse1', consentement: '1' });
  assert.equal(ok.status, 302);
  const u = db.get("SELECT * FROM utilisateurs WHERE email = 'test.porteur@exemple.sn'");
  assert.equal(u.role, 'porteur');
  assert.ok(u.mot_de_passe.startsWith('$2'));
});
