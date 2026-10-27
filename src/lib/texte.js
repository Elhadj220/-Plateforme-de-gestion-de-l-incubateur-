/**
 * Mise en forme sûre de texte : échappement HTML et rendu d'un Markdown restreint
 * (titres #, ##, ###, listes - ou *, gras **...**). Utilisé pour afficher les comptes rendus.
 */

function echapper(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const gras = (s) => s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

/** Analyse le texte en blocs typés, réutilisés par le rendu HTML et par l'export PDF. */
function blocs(texte) {
  const resultat = [];
  for (const brute of String(texte ?? '').replace(/\r\n/g, '\n').split('\n')) {
    const ligne = brute.trimEnd();
    let m;
    if (!ligne.trim()) resultat.push({ type: 'vide' });
    else if ((m = ligne.match(/^(#{1,3})\s+(.*)$/))) resultat.push({ type: `h${m[1].length}`, texte: m[2] });
    else if ((m = ligne.match(/^\s*[-*•]\s+(.*)$/))) resultat.push({ type: 'puce', texte: m[1] });
    else if ((m = ligne.match(/^\s*(\d+)[.)]\s+(.*)$/))) resultat.push({ type: 'numero', numero: m[1], texte: m[2] });
    else resultat.push({ type: 'p', texte: ligne });
  }
  return resultat;
}

/** Rendu HTML : le texte est échappé avant toute transformation. */
function markdownVersHtml(texte) {
  const html = [];
  let liste = null;
  const fermer = () => { if (liste) { html.push(`</${liste}>`); liste = null; } };
  for (const b of blocs(texte)) {
    const contenu = b.texte !== undefined ? gras(echapper(b.texte)) : '';
    if (b.type === 'puce' || b.type === 'numero') {
      const tag = b.type === 'puce' ? 'ul' : 'ol';
      if (liste !== tag) { fermer(); html.push(`<${tag}>`); liste = tag; }
      html.push(`<li>${contenu}</li>`);
      continue;
    }
    fermer();
    if (b.type === 'h1') html.push(`<h3>${contenu}</h3>`);
    else if (b.type === 'h2') html.push(`<h4>${contenu}</h4>`);
    else if (b.type === 'h3') html.push(`<h5>${contenu}</h5>`);
    else if (b.type === 'p') html.push(`<p>${contenu}</p>`);
  }
  fermer();
  return html.join('\n');
}

/** Retire la syntaxe Markdown (pour PDF ou aperçu court). */
function sansMarkdown(s) {
  return String(s ?? '').replace(/\*\*(.+?)\*\*/g, '$1');
}

function tronquer(s, n) {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

function formatMontant(n) {
  if (n === null || n === undefined || n === '') return '—';
  return `${Number(n).toLocaleString('fr-FR').replace(/ | /g, ' ')} FCFA`;
}

module.exports = { echapper, blocs, markdownVersHtml, sansMarkdown, tronquer, formatMontant };
