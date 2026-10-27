/* Comportements de l'interface (aucun script en ligne : compatible avec la politique CSP). */
(function () {
  'use strict';

  // Menu de navigation sur téléphone
  var burger = document.querySelector('.burger');
  var nav = document.getElementById('nav-principale');
  if (burger && nav) {
    burger.addEventListener('click', function () {
      var ouvert = nav.classList.toggle('ouvert');
      burger.setAttribute('aria-expanded', ouvert ? 'true' : 'false');
    });
  }

  // Onglets de la fiche projet (sans rechargement, avec mémorisation dans l'URL)
  var onglets = document.querySelectorAll('.onglets a[data-onglet]');
  function activer(nom) {
    var trouve = false;
    onglets.forEach(function (a) {
      var actif = a.getAttribute('data-onglet') === nom;
      if (actif) trouve = true;
      a.classList.toggle('actif', actif);
      a.setAttribute('aria-selected', actif ? 'true' : 'false');
      var p = document.getElementById('panneau-' + a.getAttribute('data-onglet'));
      if (p) p.hidden = !actif;
    });
    return trouve;
  }
  if (onglets.length) {
    onglets.forEach(function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        var nom = a.getAttribute('data-onglet');
        activer(nom);
        var url = new URL(window.location.href);
        url.searchParams.set('onglet', nom);
        url.hash = '';
        history.replaceState(null, '', url);
      });
    });
    var initial = new URL(window.location.href).searchParams.get('onglet') || document.querySelector('.onglets').getAttribute('data-defaut');
    if (!activer(initial)) activer(onglets[0].getAttribute('data-onglet'));
    if (window.location.hash) {
      var cible = document.querySelector(window.location.hash);
      if (cible) setTimeout(function () { cible.scrollIntoView({ block: 'start' }); }, 50);
    }
  }

  // Confirmation des actions sensibles
  document.addEventListener('submit', function (e) {
    var f = e.target;
    var msg = f.getAttribute('data-confirmer');
    if (msg && !window.confirm(msg)) { e.preventDefault(); return; }
    // Indicateur de chargement (appels à l'IA notamment)
    var b = f.querySelector('button[data-chargement]');
    if (b) {
      b.classList.add('charge');
      b.textContent = b.getAttribute('data-chargement');
    }
  });

  // Compteur de caractères
  document.querySelectorAll('textarea[data-compteur]').forEach(function (t) {
    var c = document.createElement('div');
    c.className = 'aide';
    t.after(c);
    var maj = function () {
      var min = Number(t.getAttribute('data-compteur')) || 0;
      c.textContent = t.value.length + ' caractère(s)' + (min ? ' — minimum ' + min : '');
    };
    t.addEventListener('input', maj);
    maj();
  });

  // Affichage du nom du fichier sélectionné
  document.querySelectorAll('input[type=file][data-taille-max]').forEach(function (input) {
    input.addEventListener('change', function () {
      var max = Number(input.getAttribute('data-taille-max')) * 1024 * 1024;
      if (input.files[0] && input.files[0].size > max) {
        window.alert('Le fichier dépasse la taille maximale autorisée (' + input.getAttribute('data-taille-max') + ' Mo).');
        input.value = '';
      }
    });
  });
})();
