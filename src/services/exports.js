/**
 * Exports PDF (pdfkit) et Excel (exceljs) aux couleurs de la charte ISEP.
 */
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const { blocs, formatMontant } = require('../lib/texte');
const { formatDate, formatDateHeure, aujourdhui } = require('../lib/dates');
const {
  STATUTS, STADES, STATUTS_JALON, TYPES_CR, DECISIONS, ECHEANCES_SUIVI, STATUTS_ACTIVITE,
} = require('../referentiel');

const BRUN = '#4C311F';
const CAMEL = '#CA9871';
const CREME = '#F7F1EA';
const GRIS = '#5B5B5B';

/**
 * Les polices standard PDF (Helvetica) utilisent l'encodage WinAnsi :
 * on remplace les caractères non représentables pour éviter tout glyphe illisible.
 */
function pdfSafe(s) {
  return String(s ?? '')
    .replace(/[  ]/g, ' ')
    .replace(/[≥]/g, '>=').replace(/[≤]/g, '<=').replace(/[→⇒]/g, '->').replace(/[←]/g, '<-')
    .replace(/[•▪●◦]/g, '-').replace(/[✓✔]/g, 'OK').replace(/[✗✘]/g, 'X')
    .replace(/[‐-‒]/g, '-')
    .replace(/[^\x09\x0a\x0d\x20-\x7e¡-ÿŒœŠšŸŽžƒˆ˜–—‘’‚“”„†‡•…‰‹›€™]/g, '');
}

function nouveauPdf(res, nomFichier, titre) {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 90, bottom: 60, left: 56, right: 56 }, bufferPages: true, info: { Title: titre, Author: 'CIAT - ISEP Amadou Trawaré', Creator: "Incub'ISEP" } });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${nomFichier}"`);
  doc.pipe(res);
  return doc;
}

/** En-tête et pied de page sur toutes les pages (appelé avant doc.end()). */
function finaliserPdf(doc, titre) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    const { width, height } = doc.page;
    const marges = doc.page.margins;
    doc.page.margins = { top: 0, bottom: 0, left: 0, right: 0 }; // évite un saut de page automatique
    doc.save();
    doc.rect(0, 0, width, 62).fill(BRUN);
    doc.rect(0, 62, width, 4).fill(CAMEL);
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(13).text("Incub'ISEP", 56, 18, { lineBreak: false });
    doc.font('Helvetica').fontSize(8.5).fillColor('#EBD9C6')
      .text("CIAT - Incubateur de l'ISEP Amadou Trawaré de Diamniadio", 56, 37, { lineBreak: false });
    doc.font('Helvetica').fontSize(8.5).fillColor('#FFFFFF')
      .text(pdfSafe(titre), width - 56 - 250, 26, { width: 250, align: 'right', lineBreak: false, ellipsis: true });
    doc.moveTo(56, height - 42).lineTo(width - 56, height - 42).lineWidth(0.5).strokeColor('#D9C7B5').stroke();
    doc.fillColor(GRIS).fontSize(8)
      .text(`Document généré le ${formatDate(aujourdhui())} - CIAT / ISEP Amadou Trawaré`, 56, height - 34, { lineBreak: false })
      .text(`Page ${i + 1} / ${range.count}`, width - 56 - 100, height - 34, { width: 100, align: 'right', lineBreak: false });
    doc.restore();
    doc.page.margins = marges;
  }
}

function titrePdf(doc, titre, sousTitre) {
  doc.fillColor(BRUN).font('Helvetica-Bold').fontSize(18).text(pdfSafe(titre));
  if (sousTitre) doc.moveDown(0.2).fillColor(GRIS).font('Helvetica').fontSize(10).text(pdfSafe(sousTitre));
  doc.moveDown(0.6);
  doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).lineWidth(1).strokeColor(CAMEL).stroke();
  doc.moveDown(0.8);
}

function sectionPdf(doc, titre) {
  if (doc.y > doc.page.height - 140) doc.addPage();
  doc.moveDown(0.6).fillColor(BRUN).font('Helvetica-Bold').fontSize(12.5).text(pdfSafe(titre));
  doc.moveDown(0.3);
}

function champPdf(doc, libelle, valeur) {
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#222222').text(`${pdfSafe(libelle)} : `, { continued: true })
    .font('Helvetica').text(pdfSafe(valeur ?? '—') || '—');
  doc.moveDown(0.15);
}

/** Écrit du texte au format Markdown restreint dans le PDF. */
function markdownPdf(doc, texte) {
  const largeur = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  for (const b of blocs(texte)) {
    if (b.type === 'vide') { doc.moveDown(0.4); continue; }
    if (['h1', 'h2', 'h3'].includes(b.type)) {
      if (doc.y > doc.page.height - 130) doc.addPage();
      doc.moveDown(0.4).fillColor(BRUN).font('Helvetica-Bold').fontSize(b.type === 'h3' ? 11 : 12.5).text(pdfSafe(b.texte.replace(/\*\*/g, '')));
      doc.moveDown(0.2);
      continue;
    }
    const prefixe = b.type === 'puce' ? '-  ' : b.type === 'numero' ? `${b.numero}.  ` : '';
    const indent = prefixe ? 14 : 0;
    doc.fillColor('#222222').fontSize(10.5);
    // Alternance normal / gras sur les segments **...**
    const segments = pdfSafe(b.texte).split(/(\*\*.+?\*\*)/g).filter(Boolean);
    const x = doc.page.margins.left + indent;
    if (prefixe) doc.font('Helvetica').text(prefixe, doc.page.margins.left, doc.y, { continued: true, width: largeur });
    segments.forEach((seg, i) => {
      const estGras = /^\*\*.+\*\*$/.test(seg);
      doc.font(estGras ? 'Helvetica-Bold' : 'Helvetica').text(estGras ? seg.slice(2, -2) : seg, prefixe ? undefined : x, undefined, {
        continued: i < segments.length - 1, width: largeur - indent, align: 'left', lineGap: 1.5,
      });
    });
    doc.moveDown(0.2);
  }
}

/** Petit tableau simple (en-tête brun, lignes alternées). */
function tableauPdf(doc, colonnes, lignes) {
  const x0 = doc.page.margins.left;
  const largeur = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const totalPoids = colonnes.reduce((s, c) => s + (c.poids || 1), 0);
  const larg = colonnes.map((c) => ((c.poids || 1) / totalPoids) * largeur);
  const ligne = (valeurs, entete, fond) => {
    doc.font(entete ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
    const hauteurs = valeurs.map((v, i) => doc.heightOfString(pdfSafe(v), { width: larg[i] - 8 }));
    const h = Math.max(...hauteurs) + 8;
    if (doc.y + h > doc.page.height - doc.page.margins.bottom) doc.addPage();
    const y = doc.y;
    if (fond) doc.rect(x0, y, largeur, h).fill(fond);
    let x = x0;
    valeurs.forEach((v, i) => {
      doc.fillColor(entete ? '#FFFFFF' : '#222222').text(pdfSafe(v), x + 4, y + 4, { width: larg[i] - 8 });
      x += larg[i];
    });
    doc.x = x0;
    doc.y = y + h;
  };
  ligne(colonnes.map((c) => c.titre), true, BRUN);
  lignes.forEach((l, i) => ligne(l.map((v) => (v === null || v === undefined ? '—' : String(v))), false, i % 2 ? CREME : null));
  doc.moveDown(0.5);
}

/* ------------------------------------------------------------------ */

function compteRenduPdf(res, cr, projet) {
  const titre = `${TYPES_CR[cr.type_cr]} - ${projet.titre}`;
  const doc = nouveauPdf(res, `compte-rendu-${cr.id}.pdf`, TYPES_CR[cr.type_cr]);
  titrePdf(doc, cr.titre, `${TYPES_CR[cr.type_cr]} - Projet : ${projet.titre}`);
  champPdf(doc, 'Cohorte', projet.cohorte_nom || 'Non affecté');
  champPdf(doc, 'Domaine', projet.domaine);
  champPdf(doc, 'Statut du document', cr.statut === 'valide' ? `Validé${cr.valide_par_nom ? ` par ${cr.valide_par_nom}` : ''}` : 'Brouillon (non validé)');
  champPdf(doc, 'Rédigé le', formatDateHeure(cr.cree_le));
  if (cr.genere_par_ia) {
    doc.moveDown(0.3).fontSize(8.5).fillColor(GRIS).font('Helvetica-Oblique')
      .text("Document initialement rédigé avec l'assistance d'une IA générative, puis relu et corrigé par un membre de l'équipe du CIAT.");
  }
  doc.moveDown(0.6);
  markdownPdf(doc, cr.contenu);
  finaliserPdf(doc, titre);
  doc.end();
}

function ficheProjetPdf(res, { projet, synthese, objectifs, jalons, decision, suivis, avancement }) {
  const doc = nouveauPdf(res, `fiche-projet-${projet.id}.pdf`, 'Fiche projet');
  titrePdf(doc, projet.titre, `${projet.domaine} - ${STATUTS[projet.statut].libelle}`);

  sectionPdf(doc, 'Identification');
  champPdf(doc, 'Porteur', projet.porteur_nom);
  champPdf(doc, 'Cohorte', projet.cohorte_nom || 'Non affecté');
  champPdf(doc, 'Mentor', projet.mentor_nom || 'Non affecté');
  champPdf(doc, "Stade d'avancement", STADES[projet.stade] || '—');
  champPdf(doc, "Taille de l'équipe", projet.taille_equipe);
  champPdf(doc, 'Besoin de financement', formatMontant(projet.besoin_financement));
  champPdf(doc, 'Financement obtenu', formatMontant(projet.financement_obtenu));
  champPdf(doc, 'Date de soumission', formatDate(projet.date_soumission));

  sectionPdf(doc, 'Présentation du projet');
  [['Résumé', projet.resume], ['Problème adressé', projet.probleme], ['Solution proposée', projet.solution],
    ['Marché cible', projet.marche_cible], ['Modèle économique', projet.modele_economique]].forEach(([l, v]) => {
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#222222').text(l);
    doc.font('Helvetica').fontSize(10).text(pdfSafe(v || 'Non renseigné'), { lineGap: 1.5 });
    doc.moveDown(0.4);
  });

  if (synthese.evaluations.length) {
    sectionPdf(doc, 'Évaluation du comité');
    champPdf(doc, 'Score moyen', `${synthese.moyenne} / 100 (${synthese.evaluations.length} évaluation(s))`);
    tableauPdf(doc, [{ titre: 'Critère', poids: 3 }, { titre: 'Poids', poids: 1 }, { titre: 'Note moyenne /5', poids: 1.4 }],
      synthese.parCritere.map((c) => [c.libelle, `${c.poids} %`, c.moyenne]));
  }
  if (decision) {
    sectionPdf(doc, 'Décision');
    champPdf(doc, 'Décision', DECISIONS[decision.decision]);
    champPdf(doc, 'Date', formatDate(decision.decide_le));
    champPdf(doc, 'Motivation', decision.motivation);
  }
  if (objectifs.length) {
    sectionPdf(doc, 'Objectifs');
    tableauPdf(doc, [{ titre: 'Objectif', poids: 3 }, { titre: 'Indicateur', poids: 2 }, { titre: 'Cible', poids: 1.5 }, { titre: 'Atteint', poids: 0.8 }],
      objectifs.map((o) => [o.libelle, o.indicateur, o.cible, o.atteint ? 'Oui' : 'Non']));
  }
  if (jalons.length) {
    sectionPdf(doc, `Jalons (avancement : ${avancement.pourcentage} %)`);
    tableauPdf(doc, [{ titre: 'Jalon', poids: 3 }, { titre: 'Échéance', poids: 1.3 }, { titre: 'Statut', poids: 1.3 }, { titre: 'Réalisé le', poids: 1.3 }],
      jalons.map((j) => [j.titre, formatDate(j.date_echeance), STATUTS_JALON[j.statut].libelle + (j.en_retard ? ' (retard)' : ''), formatDate(j.date_realisation)]));
  }
  if (suivis.length) {
    sectionPdf(doc, 'Suivi post-incubation');
    tableauPdf(doc, [{ titre: 'Échéance' }, { titre: 'Prévu le' }, { titre: 'Réalisé le' }, { titre: 'Activité' }, { titre: "Chiffre d'affaires" }, { titre: 'Emplois' }],
      suivis.map((s) => [ECHEANCES_SUIVI[s.echeance], formatDate(s.date_prevue), formatDate(s.date_realisee),
        STATUTS_ACTIVITE[s.statut_activite] || '—', s.chiffre_affaires != null ? formatMontant(s.chiffre_affaires) : '—', s.emplois_crees ?? '—']));
  }
  finaliserPdf(doc, `Fiche projet - ${projet.titre}`);
  doc.end();
}

function tableauDeBordPdf(res, ind, libelleFiltres) {
  const doc = nouveauPdf(res, `tableau-de-bord-${aujourdhui()}.pdf`, 'Tableau de bord');
  titrePdf(doc, "Tableau de bord de l'incubateur", `Filtres : ${libelleFiltres}`);
  const k = ind.kpi;
  sectionPdf(doc, 'Indicateurs clés');
  tableauPdf(doc, [{ titre: 'Indicateur', poids: 3 }, { titre: 'Valeur', poids: 1.2 }], [
    ['Dossiers reçus (hors brouillons)', k.recus],
    ['Dossiers en attente de décision', k.enAttente],
    ['Projets sélectionnés', k.selectionnes],
    ['Taux de sélection (sur dossiers décidés)', `${k.tauxSelection} %`],
    ['Projets en incubation', k.enIncubation],
    ['Projets sortis d\'incubation', k.termines],
    ['Projets incubés au stade prototype ou plus', k.prototypes],
    ['Financements obtenus par les projets incubés', formatMontant(k.financementTotal)],
    ['Jalons validés (projets en incubation)', `${k.tauxJalonsValides} %`],
    ['Jalons en retard', k.jalonsEnRetard],
    ['Projets ayant au moins un jalon en retard', k.projetsEnRetard],
    ['Suivis post-incubation en retard', k.suivisEnRetard],
    ['Entreprises actives au dernier suivi', `${k.tauxActivite} %`],
    ['Emplois créés déclarés', k.emploisCrees],
  ]);
  sectionPdf(doc, 'Répartition par domaine');
  tableauPdf(doc, [{ titre: 'Domaine', poids: 3 }, { titre: 'Reçus' }, { titre: 'Sélectionnés' }],
    ind.parDomaine.map((d) => [d.domaine, d.recus || 0, d.selectionnes || 0]));
  sectionPdf(doc, 'Comparaison des cohortes');
  tableauPdf(doc, [{ titre: 'Cohorte', poids: 2 }, { titre: 'Projets' }, { titre: 'Incubés' }, { titre: 'Score moyen' }, { titre: 'Financement', poids: 1.6 }],
    ind.parCohorte.map((c) => [c.nom, c.projets, c.incubes || 0, c.score_moyen ?? '—', formatMontant(c.financement)]));
  sectionPdf(doc, 'Répartition par genre du porteur');
  tableauPdf(doc, [{ titre: 'Genre', poids: 2 }, { titre: 'Reçus' }, { titre: 'Sélectionnés' }],
    ind.parGenre.map((g) => [g.genre === 'F' ? 'Femmes' : g.genre === 'M' ? 'Hommes' : 'Non renseigné', g.recus || 0, g.selectionnes || 0]));
  if (ind.avancementProjets.length) {
    sectionPdf(doc, 'Avancement des projets en incubation');
    tableauPdf(doc, [{ titre: 'Projet', poids: 3 }, { titre: 'Mentor', poids: 2 }, { titre: 'Jalons validés', poids: 1.3 }, { titre: 'Retards' }],
      ind.avancementProjets.map((p) => [p.titre, p.mentor_nom || '—', `${p.valides || 0} / ${p.jalons}`, p.retards || 0]));
  }
  finaliserPdf(doc, 'Tableau de bord');
  doc.end();
}

/* ------------------------------------------------------------------ */
/* Excel                                                               */
/* ------------------------------------------------------------------ */

function feuille(wb, nom, colonnes, lignes) {
  const ws = wb.addWorksheet(nom, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = colonnes.map((c) => ({ header: c.titre, key: c.cle, width: c.largeur || 18, style: c.style || {} }));
  ws.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4C311F' } };
    cell.alignment = { vertical: 'middle', wrapText: true };
  });
  ws.getRow(1).height = 28;
  lignes.forEach((l) => ws.addRow(l));
  if (lignes.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: colonnes.length } };
  return ws;
}

async function exportExcel(res, { projets, ind, retards, libelleFiltres }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Incub'ISEP - CIAT";
  wb.created = new Date();
  const montant = { numFmt: '#,##0 "FCFA"' };

  const k = ind.kpi;
  const wsInd = feuille(wb, 'Indicateurs', [{ titre: 'Indicateur', cle: 'i', largeur: 52 }, { titre: 'Valeur', cle: 'v', largeur: 22 }], [
    { i: 'Filtres appliqués', v: libelleFiltres },
    { i: 'Dossiers reçus (hors brouillons)', v: k.recus },
    { i: 'Dossiers en attente de décision', v: k.enAttente },
    { i: 'Projets sélectionnés', v: k.selectionnes },
    { i: 'Taux de sélection (%)', v: k.tauxSelection },
    { i: 'Projets en incubation', v: k.enIncubation },
    { i: "Projets sortis d'incubation", v: k.termines },
    { i: 'Projets incubés au stade prototype ou plus', v: k.prototypes },
    { i: 'Financements obtenus (FCFA)', v: k.financementTotal },
    { i: 'Jalons validés (%)', v: k.tauxJalonsValides },
    { i: 'Jalons en retard', v: k.jalonsEnRetard },
    { i: 'Projets avec au moins un jalon en retard', v: k.projetsEnRetard },
    { i: 'Suivis post-incubation en retard', v: k.suivisEnRetard },
    { i: 'Entreprises actives au suivi (%)', v: k.tauxActivite },
    { i: 'Emplois créés déclarés', v: k.emploisCrees },
  ]);
  wsInd.autoFilter = undefined;

  feuille(wb, 'Projets', [
    { titre: 'N°', cle: 'id', largeur: 6 }, { titre: 'Titre', cle: 'titre', largeur: 40 }, { titre: 'Domaine', cle: 'domaine', largeur: 34 },
    { titre: 'Statut', cle: 'statut', largeur: 18 }, { titre: 'Cohorte', cle: 'cohorte', largeur: 14 }, { titre: 'Porteur', cle: 'porteur', largeur: 24 },
    { titre: 'Genre', cle: 'genre', largeur: 8 }, { titre: 'Mentor', cle: 'mentor', largeur: 24 }, { titre: 'Stade', cle: 'stade', largeur: 18 },
    { titre: 'Score moyen /100', cle: 'score', largeur: 12 }, { titre: 'Besoin de financement', cle: 'besoin', largeur: 20, style: montant },
    { titre: 'Financement obtenu', cle: 'obtenu', largeur: 20, style: montant }, { titre: 'Soumis le', cle: 'soumis', largeur: 14 },
  ], projets.map((p) => ({
    id: p.id, titre: p.titre, domaine: p.domaine, statut: STATUTS[p.statut].libelle, cohorte: p.cohorte_nom || '',
    porteur: p.porteur_nom, genre: p.porteur_genre || '', mentor: p.mentor_nom || '', stade: STADES[p.stade] || '',
    score: p.score_moyen ?? '', besoin: p.besoin_financement ?? '', obtenu: p.financement_obtenu ?? 0, soumis: p.date_soumission ? p.date_soumission.slice(0, 10) : '',
  })));

  feuille(wb, 'Jalons en retard', [
    { titre: 'Projet', cle: 'projet', largeur: 40 }, { titre: 'Jalon', cle: 'jalon', largeur: 40 },
    { titre: 'Échéance', cle: 'echeance', largeur: 14 }, { titre: 'Jours de retard', cle: 'jours', largeur: 14 }, { titre: 'Statut', cle: 'statut', largeur: 18 },
  ], retards.map((j) => ({ projet: j.projet_titre, jalon: j.titre, echeance: j.date_echeance, jours: j.jours_retard, statut: STATUTS_JALON[j.statut].libelle })));

  feuille(wb, 'Par domaine', [{ titre: 'Domaine', cle: 'd', largeur: 44 }, { titre: 'Reçus', cle: 'r' }, { titre: 'Sélectionnés', cle: 's' }],
    ind.parDomaine.map((d) => ({ d: d.domaine, r: d.recus || 0, s: d.selectionnes || 0 })));
  feuille(wb, 'Par cohorte', [{ titre: 'Cohorte', cle: 'c', largeur: 18 }, { titre: 'Projets', cle: 'p' }, { titre: 'Incubés', cle: 'i' },
    { titre: 'Score moyen', cle: 's' }, { titre: 'Financement (FCFA)', cle: 'f', largeur: 22, style: montant }],
  ind.parCohorte.map((c) => ({ c: c.nom, p: c.projets, i: c.incubes || 0, s: c.score_moyen ?? '', f: c.financement })));
  feuille(wb, 'Par genre', [{ titre: 'Genre', cle: 'g' }, { titre: 'Reçus', cle: 'r' }, { titre: 'Sélectionnés', cle: 's' }],
    ind.parGenre.map((g) => ({ g: g.genre === 'F' ? 'Femmes' : g.genre === 'M' ? 'Hommes' : 'Non renseigné', r: g.recus || 0, s: g.selectionnes || 0 })));

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="incubateur-ciat-${aujourdhui()}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}

module.exports = { compteRenduPdf, ficheProjetPdf, tableauDeBordPdf, exportExcel, pdfSafe };
