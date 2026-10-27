/* Graphiques du tableau de bord (Chart.js). Les données sont fournies en JSON dans la page. */
(function () {
  'use strict';
  var source = document.getElementById('donnees-graphiques');
  if (!source || !window.Chart) return;
  var d = JSON.parse(source.textContent);

  var BRUN = '#4C311F';
  var CAMEL = '#CA9871';
  var PALETTE = ['#4C311F', '#CA9871', '#8A5A3C', '#E2B992', '#2F7D4F', '#22609E', '#6A4C9C', '#B26A00'];
  Chart.defaults.font.family = "'Inter', 'Segoe UI', system-ui, sans-serif";
  Chart.defaults.color = '#6E5E53';
  Chart.defaults.plugins.legend.labels.boxWidth = 12;
  Chart.defaults.maintainAspectRatio = false;

  var graphiques = {};
  function creer(id, config) {
    var el = document.getElementById(id);
    if (el) graphiques[id] = new Chart(el, config);
  }
  var couper = function (s) { return s.length > 26 ? s.slice(0, 25) + '…' : s; };

  creer('g-statuts', {
    type: 'bar',
    data: {
      labels: d.parStatut.map(function (s) { return s.libelle; }),
      datasets: [{ label: 'Projets', data: d.parStatut.map(function (s) { return s.n; }), backgroundColor: CAMEL, borderRadius: 6 }],
    },
    options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } },
  });

  creer('g-domaines', {
    type: 'bar',
    data: {
      labels: d.parDomaine.map(function (x) { return couper(x.domaine); }),
      datasets: [
        { label: 'Reçus', data: d.parDomaine.map(function (x) { return x.recus || 0; }), backgroundColor: CAMEL, borderRadius: 5 },
        { label: 'Sélectionnés', data: d.parDomaine.map(function (x) { return x.selectionnes || 0; }), backgroundColor: BRUN, borderRadius: 5 },
      ],
    },
    options: { indexAxis: 'y', scales: { x: { beginAtZero: true, ticks: { precision: 0 } } } },
  });

  creer('g-genre', {
    type: 'doughnut',
    data: {
      labels: d.parGenre.map(function (g) { return g.genre === 'F' ? 'Femmes' : g.genre === 'M' ? 'Hommes' : 'Non renseigné'; }),
      datasets: [{ data: d.parGenre.map(function (g) { return g.recus || 0; }), backgroundColor: [CAMEL, BRUN, '#BDB2A8'] }],
    },
    options: { cutout: '62%', plugins: { legend: { position: 'bottom' } } },
  });

  creer('g-cohortes', {
    type: 'bar',
    data: {
      labels: d.parCohorte.map(function (c) { return c.nom; }),
      datasets: [
        { label: 'Projets incubés', data: d.parCohorte.map(function (c) { return c.incubes || 0; }), backgroundColor: BRUN, borderRadius: 5, yAxisID: 'y' },
        { label: 'Score moyen de sélection (/100)', data: d.parCohorte.map(function (c) { return c.score_moyen; }), type: 'line', borderColor: CAMEL, backgroundColor: CAMEL, tension: .3, yAxisID: 'y2' },
      ],
    },
    options: {
      scales: {
        y: { beginAtZero: true, ticks: { precision: 0 }, title: { display: true, text: 'Projets' } },
        y2: { position: 'right', min: 0, max: 100, grid: { drawOnChartArea: false }, title: { display: true, text: 'Score' } },
      },
    },
  });

  creer('g-mois', {
    type: 'bar',
    data: {
      labels: d.parMois.map(function (m) { return m.mois; }),
      datasets: [{ label: 'Dossiers soumis', data: d.parMois.map(function (m) { return m.n; }), backgroundColor: BRUN, borderRadius: 4 }],
    },
    options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } },
  });

  creer('g-avancement', {
    type: 'bar',
    data: {
      labels: d.avancementProjets.map(function (p) { return couper(p.titre); }),
      datasets: [
        { label: 'Jalons validés', data: d.avancementProjets.map(function (p) { return p.valides || 0; }), backgroundColor: '#2F7D4F', borderRadius: 4 },
        { label: 'Jalons en retard', data: d.avancementProjets.map(function (p) { return p.retards || 0; }), backgroundColor: '#B3261E', borderRadius: 4 },
        { label: 'Autres jalons', data: d.avancementProjets.map(function (p) { return p.jalons - (p.valides || 0) - (p.retards || 0); }), backgroundColor: '#E3D6C8', borderRadius: 4 },
      ],
    },
    options: { indexAxis: 'y', scales: { x: { stacked: true, beginAtZero: true, ticks: { precision: 0 } }, y: { stacked: true } } },
  });

  // Export d'un graphique en image PNG
  document.querySelectorAll('[data-export-image]').forEach(function (bouton) {
    bouton.addEventListener('click', function () {
      var id = bouton.getAttribute('data-export-image');
      var g = graphiques[id];
      if (!g) return;
      var canvas = document.createElement('canvas');
      canvas.width = g.canvas.width;
      canvas.height = g.canvas.height;
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(g.canvas, 0, 0);
      var a = document.createElement('a');
      a.href = canvas.toDataURL('image/png');
      a.download = id + '.png';
      a.click();
    });
  });
})();
