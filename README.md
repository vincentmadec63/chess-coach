# Chess Coach — analyse locale de tes parties chess.com

Outil 100% local (HTML/CSS/JS, aucune clé API, aucun compte) pour repérer tes erreurs
récurrentes en rapide et progresser plus vite, et pour apprendre les ouvertures.

## Écran Ouvertures

Bouton **Ouvertures** en haut de page. 40 familles (Italienne, Espagnole, Écossaise,
Sicilienne, Française, Caro-Kann, Gambit Dame, Est-Indienne, Anglaise, Philidor, Gambit
Danois, Quatre Cavaliers, Ponziani, Grand Prix, Gambit Budapest, Vieille Indienne, Attaque
Torre, Système Veresov, Gambit Blackmar-Diemer, Défense Nimzowitsch…), chacune avec 1 à 4
variantes nommées, jouables coup par coup sur l'échiquier avec l'idée expliquée à chaque
coup — aussi bien le plan des Blancs que les défenses classiques des Noirs.

- Chaque famille est étiquetée **⚪ Répertoire Blancs** ou **⚫ Défenses Noirs**, avec un
  filtre dédié — et l'échiquier s'oriente automatiquement du bon côté quand tu charges une
  variante (plus besoin de retourner l'échiquier à la main pour étudier une défense).
- **Favoris** : étoile ☆/★ à côté de chaque variante, filtre **★ Favoris** pour retrouver
  d'un clic celles que tu étudies en ce moment. Persisté dans `localStorage`.
- Filtre rapide par premier coup (1.e4 / 1.d4 / flanc), liste de coups cliquable pour
  sauter directement à une position.

Contenu écrit à la main dans `js/openings-data.js` et validé coup par coup avec chess.js
(`tools/validate-openings.js`) pour garantir qu'aucune ligne n'est illégale — relance ce
script après toute modification du fichier de données. C'est un répertoire volontairement
"essentiel" (plus de 1000 coups au total), pas une base de données exhaustive : il couvre
les lignes principales des ouvertures les plus courantes (et pas mal de systèmes annexes
peu théoriques), pas toutes les transpositions et variantes rares.

## Écran Entraînement (puzzles)

Bouton **Entraînement**. Pas de base de puzzles séparée : chaque erreur déjà détectée
dans tes parties analysées (n'importe laquelle, dans n'importe quelle partie en cache)
devient un puzzle — "voici la position juste avant l'erreur, trouve le coup que tu
aurais dû jouer". Deux façons de répondre, comme sur chess.com/lichess : glisse une pièce
sur l'échiquier, ou touche la pièce puis touche la case d'arrivée (plus fiable au doigt).

- **Indice** : bouton 💡 qui te dit juste quelle pièce regarder (case comprise), sans
  révéler ni la destination ni pourquoi — un petit coup de pouce, pas la réponse. Ne
  compte pas comme une tentative, n'affecte ni le niveau ni les points.
- **Niveau adaptatif** : comme sur lichess/chess.com, un rating (départ 1200) s'ajuste
  après chaque tentative selon une formule Elo — résoudre un puzzle plus difficile que
  ton niveau le fait monter davantage, rater un puzzle facile le fait baisser davantage.
  Les puzzles proposés sont toujours tirés au sort parmi les plus proches de ce niveau,
  donc la difficulté suit automatiquement tes progrès.
- **Points** : +10 de base par puzzle réussi, plus un bonus selon la difficulté et ta
  série de réussites en cours (🔥). Rien en cas d'échec, et la série repart à zéro.
- Stats persistées (`localStorage`) : niveau, points, série en cours, meilleure série,
  puzzles résolus/tentés, taux de réussite.
- La difficulté d'un puzzle est dérivée de l'ampleur de l'erreur d'origine (perte en
  centipawns mesurée par Stockfish pendant l'analyse) — pas une classification manuelle.

Sans parties analysées en cache, l'onglet affiche un message t'invitant à en importer
d'abord dans **Analyse de parties**.

## Lancer l'appli

**Double-clique sur `start.bat`.** Il ouvre automatiquement http://localhost:5177 dans ton
navigateur. Utilise toujours ce fichier pour lancer l'appli (jamais `index.html`
directement) — c'est important pour deux raisons :

1. Les Web Workers et `fetch` ne fonctionnent pas fiablement en ouvrant `index.html` en
   `file://`.
2. **Le cache de tes parties analysées est lié à l'adresse exacte
   `http://localhost:5177`.** Si le serveur redémarre sur un port différent (ce qui
   arrive avec `npx serve` tout seul quand le port 5177 est déjà occupé par une instance
   restée ouverte), le navigateur voit une adresse différente et donc un cache vide —
   c'est ce qui causait des ré-analyses complètes de 15 minutes à chaque lancement.
   `start.bat` ferme d'abord toute instance déjà sur le port 5177 avant de démarrer, donc
   l'adresse — et le cache — restent toujours identiques.

Si tu préfères lancer à la main : `npx serve -l 5177 .` puis http://localhost:5177 — mais
dans ce cas, pense à bien fermer proprement le terminal (Ctrl+C) avant de relancer, sinon
tu retomberas sur le même problème de port qui change.

## Utiliser l'appli depuis ton iPhone (l'épingler à l'écran d'accueil)

`start.bat` affiche maintenant, à chaque lancement, une adresse du type
`http://192.168.1.36:5177` — c'est l'adresse de ce PC sur ton réseau Wi-Fi.

1. Lance `start.bat` sur le PC et laisse la fenêtre noire ouverte (le PC doit rester
   allumé et le serveur tourner pour que le téléphone puisse s'y connecter — rien n'est
   hébergé en ligne, tout reste sur ton PC).
2. Sur l'iPhone, connecte-toi au **même réseau Wi-Fi** que le PC.
3. Ouvre Safari (obligatoire pour "Sur l'écran d'accueil" — pas Chrome) et va sur
   l'adresse affichée par `start.bat` (ex: `http://192.168.1.36:5177`).
4. Appuie sur l'icône de partage (le carré avec la flèche vers le haut) → **Sur l'écran
   d'accueil** → **Ajouter**.

Une icône "Chess Coach" apparaît alors sur l'écran d'accueil, qui ouvre l'appli en plein
écran sans la barre d'adresse Safari. Le cache de parties de l'iPhone est indépendant de
celui du PC (chaque appareil a le sien, stocké localement) — c'est normal, pas un bug.

Cette adresse Wi-Fi peut changer si ton routeur réattribue les adresses IP (rare, mais ça
arrive après un redémarrage du routeur) : dans ce cas, relance juste `start.bat` et
reprends la nouvelle adresse affichée.

## Utilisation

1. Entre ton pseudo chess.com (pas de mot de passe).
2. Choisis la cadence (rapide par défaut) et le nombre de parties (5 à 30).
3. Clique sur **Importer mes parties**. Le moteur Stockfish (asm.js, chargé depuis un
   CDN) se charge une seule fois, puis chaque partie est analysée coup par coup.
4. Les résultats s'affichent au fur et à mesure : liste de parties, liste d'erreurs par
   partie (clique une carte pour voir la position sur l'échiquier), et un résumé en haut
   avec tes thèmes d'erreurs les plus fréquents.

## Comment les erreurs sont détectées

Pour chaque position de chaque partie, Stockfish évalue à profondeur ~14 (limité à 4s par
coup). La perte de centipawns entre "avant ton coup" et "après ton coup" détermine la
sévérité :

- **Imprécision** : perte ≥ 0.6 pion
- **Erreur** : perte ≥ 1.2 pion
- **Gaffe** : perte ≥ 2.5 pions (ou un mat forcé raté/subi)

Chaque erreur est ensuite classée par thème avec des heuristiques simples :
pièce laissée en prise, fourchette subie, mat au couloir manqué/subi, erreur en finale,
ou "erreur tactique" par défaut si aucun motif clair n'est détecté.

**Coups théoriques exclus.** Si le coup joué mène à une position qui existe telle quelle
dans la base d'ouvertures (`js/openings-data.js`, ~730 coups validés), il n'est jamais
signalé comme une erreur, même si Stockfish le préfère légèrement à un autre coup — c'est
de la théorie connue, pas une faute. Cette vérification est limitée à ce que couvre le
répertoire (voir la section Ouvertures) : au-delà, une imprécision d'ouverture peut encore
être signalée si elle sort des lignes actuellement dans la base.

## Positions récurrentes

C'est l'onglet **Erreurs récurrentes** (et l'aperçu en haut du résumé) : l'appli regroupe
tes erreurs par position exactement identique (échiquier + trait + roques + prise en
passant, peu importe la partie ou le coup joué pour l'atteindre) et ne garde que celles
où tu t'es trompé **au moins deux fois**. Chaque carte affiche un mini-échiquier de la
position, le nombre de fois où tu t'y es planté, et un badge par occurrence — clique
dessus pour ouvrir cette occurrence précise sur l'échiquier principal avec l'explication
complète. C'est le repérage le plus actionnable de l'appli : une position répétée avec la
même erreur à chaque fois pointe directement vers un trou concret dans ta préparation
(souvent une ligne d'ouverture ou un motif de finale), pas juste une tendance statistique.

## Cache

Chaque partie analysée est enregistrée dans le `localStorage` du navigateur (clé = URL
chess.com de la partie, donc unique). Au prochain import — même après avoir fermé le
serveur et rouvert la page — les parties déjà vues se chargent instantanément au lieu de
repasser par Stockfish ; seules les nouvelles parties sont analysées. Le nombre de
parties en cache s'affiche en haut à droite, avec un bouton **Vider le cache** si tu veux
forcer une ré-analyse complète (utile si tu changes toi-même les seuils/la profondeur
dans `js/analyzer.js`, ce qui invalide automatiquement le cache existant de toute façon).

## Limites à connaître

- L'analyse tourne dans un seul thread du navigateur (asm.js, pas de WASM multi-thread,
  choisi pour la fiabilité de chargement depuis un CDN) : compter grossièrement
  0.5 à 4 secondes par coup, donc plusieurs minutes pour 20-30 parties.
- À profondeur ~14, deux évaluations consécutives peuvent légèrement diverger même sur le
  meilleur coup ("bruit" de recherche) — les seuils ont été calés un peu au-dessus des
  seuils classiques (50/100/200 cp) pour absorber ça, mais une imprécision affichée à la
  marge peut occasionnellement être un faux positif mineur.
- La détection de thème (fourchette, pièce en prise, mat au couloir) est heuristique, pas
  une preuve tactique complète : elle vise à te donner une tendance générale, pas un
  verdict parfait coup par coup.
- Seules les 8 derniers mois d'archives chess.com sont consultés pour retrouver tes
  dernières parties dans la cadence choisie.
