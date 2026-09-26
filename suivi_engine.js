
/* ==========================================================================
   SUIVI DE PAQUETS SANS GRILLE (nouvelle fonctionnalité) — v2
   --------------------------------------------------------------------------
   Contrairement au mode démo ci-dessus (grille fixe de 12 cases, comparées
   à 12 références connues à l'avance), ce bloc ne connaît RIEN du rayon :
   il découvre les paquets visibles à l'écran et les suit d'image en image
   pendant que le téléphone bouge, sans supposer ni grille, ni nombre de
   produits, ni ordre attendu. La reconnaissance de la référence précise
   (quel produit exact) arrive dans une prochaine mission : ici, un contour
   représente seulement "un paquet physique que la caméra suit", pas encore
   "je sais lequel c'est".
   CORRECTION v2 (suite à un test réel sur boîtes) : la version précédente
   affichait 9 contours à l'écran mais avait déjà créé 102 identités, et
   encadrait le meuble, des bouteilles et du vide en "suivi net". Deux
   défauts corrigés :
   1) Le détecteur acceptait n'importe quelle zone plate comme candidat,
      y compris de grandes surfaces de fond (meuble, mur) qui débordent du
      cadre sur plusieurs côtés : on rejette les candidats qui touchent
      2 côtés ou plus de l'image analysée.
   2) Le suivi exigeait un recouvrement de zone strictement positif entre
      la position prévue et la détection pour rattacher un paquet ; un
      mouvement de caméra normal suffisait à faire perdre ce recouvrement
      en une seule mesure (300 ms), donc à fermer puis rouvrir une identité
      à chaque déplacement. La fenêtre de recherche est élargie et amortie.
      Une nouvelle détection ne devient une identité comptée qu'après avoir
      été revue une seconde fois à une position cohérente ("en observation",
      gris pointillé) — un flash isolé (reflet, bruit) ne crée plus d'identité.
   CORRECTION v3 (suite à un second test réel, avec de vrais paquets) : la
   version v2 ne créait plus d'identités fantômes, mais elle ne voyait plus
   les paquets du tout — seul le meuble était détecté (« #2 suivi net » sur
   du bois). Cause trouvée : la détection ne cherchait que des zones plates
   (faible contraste), or un paquet imprimé réel (étiquette, texte, logo)
   est une zone très contrastée d'un bout à l'autre — c'est le meuble, uni,
   qui ressemblait le plus à une "zone plate". La détection cherchait donc
   le contraire de ce qu'il fallait trouver. Deux méthodes de détection sont
   maintenant combinées :
   A) zones PLATES (comme avant) — pour un paquet à fond uni ou peu imprimé.
   B) zones TEXTURÉES — un paquet imprimé est repéré comme une zone dense en
      contraste local, regroupée par petites cellules ; deux cellules
      voisines ne sont fusionnées que si leur couleur moyenne est proche,
      pour éviter de fondre deux paquets adjacents de couleurs différentes
      en un seul candidat. Le seuil "texturé / pas texturé" est recalculé à
      chaque image (méthode d'Otsu) plutôt que fixé à l'avance, pour
      s'adapter à l'éclairage réel plutôt qu'à un réglage figé en atelier.
   Les candidats des deux méthodes passent par les mêmes filtres (taille,
   forme, bords touchés) puis sont dédoublonnés si deux candidats désignent
   manifestement le même paquet.
   Méthode utilisée (aucune bibliothèque, aucun modèle à télécharger) :
   1) DÉTECTION par image : image réduite → contraste local (gradient) →
      zones plates ET zones texturées regroupées par voisinage en candidats
      rectangulaires, filtrés par taille, forme et bords touchés.
   2) SUIVI d'une image à l'autre : chaque candidat est rapproché des
      paquets déjà suivis par position (fenêtre élargie autour de la
      position prévue) ET par apparence (le même hachage dHash + couleur
      moyenne que le mode démo), pour rester attaché au bon paquet
      physique même si le cadrage bouge.
   3) CONFIRMATION : une détection qui ne correspond à rien de connu
      devient "en observation" (grise) et n'est comptée comme identité
      que si elle est revue une seconde fois de suite à une position
      cohérente ; sinon elle est abandonnée sans laisser de trace.
   4) MÉMOIRE courte : un paquet confirmé qui sort du cadre reste en
      mémoire quelques secondes ; s'il revient et que son apparence
      correspond nettement à un seul candidat en mémoire, on lui redonne
      la même identité au lieu de le recompter. En cas d'ambiguïté (deux
      paquets qui se ressemblent trop, ex. deux emballages identiques),
      l'identité n'est jamais devinée : le paquet reçoit un contour
      "ambigu" distinct.
   Limite connue, assumée pour ce palier : deux paquets de couleurs très
   proches, posés bord à bord sans aucun espace visible entre eux, peuvent
   encore être vus comme un seul candidat élargi plutôt que deux candidats
   séparés — un écart visible entre les paquets (comme sur un vrai rayon)
   sépare correctement les candidats. Ce sont des réglages ajustés après
   deux tests réels ; ils restent à affiner après le prochain test.
   ========================================================================== */

const SUIVI_LARGEUR_ANALYSE = 220;   // largeur (px) de l'image réduite utilisée pour la détection : compromis vitesse/précision
const SUIVI_PERIODE_MS      = 300;   // cadence d'analyse du suivi (ms)
const SUIVI_SEUIL_GRADIENT  = 18;    // au-dessus de ce contraste local, un pixel est considéré comme un "bord"
const SUIVI_AIRE_MIN        = 0.006; // un blob plus petit que 0,6 % de l'image analysée est ignoré (bruit)
const SUIVI_AIRE_MAX        = 0.55;  // un blob plus grand que 55 % de l'image est probablement le fond du rayon
const SUIVI_RATIO_MAX       = 4.2;   // un blob trop filiforme (largeur/hauteur ou inverse) est rejeté
const SUIVI_BORDS_MAX       = 1;     // un blob qui touche plus de ce nombre de côtés de l'image est probablement du fond (meuble, mur) et non un paquet
const SUIVI_FUSION_MARGE    = 0.02;  // proximité (fraction de la plus petite dimension analysée) en dessous de laquelle deux zones plates voisines sont fusionnées en un seul candidat (évite qu'un paquet imprimé se fragmente en plusieurs identités)
const SUIVI_FUSION_AIRE_MAX = 0.15;  // une zone déjà plus grande que ça à elle seule n'est pas un simple fragment d'un petit objet : elle ne participe pas à la fusion
const SUIVI_FUSION_DIM_MAX  = 0.5;   // une fusion qui s'étire sur plus de cette fraction de la largeur OU de la hauteur du cadre est refusée, même si son aire totale reste petite (évite un pont via un mince fragment qui relierait deux objets différents)
const SUIVI_CELLULE_TEXTURE = 6;     // taille (px, image réduite) des cellules utilisées pour repérer les zones "texturées" (étiquettes imprimées) plutôt que "plates"
const SUIVI_COULEUR_SEUIL   = 45;    // écart de couleur moyenne au-delà duquel deux cellules texturées voisines ne sont pas regroupées (évite de fusionner deux paquets adjacents de couleurs différentes en un seul candidat)
const SUIVI_DEDOUBLONNAGE_IOU = 0.5; // au-delà de ce recouvrement, un candidat "texture" et un candidat "plat" sont considérés comme le même paquet physique (on ne garde que le plus grand)
const SUIVI_GRACE_FRAMES    = 3;     // nombre d'analyses sans détection avant de passer "incertain" puis "perdu" (paquets déjà confirmés)
const SUIVI_MEMOIRE_MS      = 15000; // durée pendant laquelle un paquet "perdu" reste en mémoire pour une ré-identification
const SUIVI_SEUIL_REID      = 0.78;  // similarité minimale pour redonner une identité à un paquet revenu dans le cadre
const SUIVI_MARGE_REID      = 0.05;  // écart minimal entre le meilleur et le second meilleur candidat pour trancher sans ambiguïté
const SUIVI_SEUIL_APPARIEMENT = 0.30; // score minimal (position + apparence) pour rattacher une détection à un suivi existant
const SUIVI_ELARGISSEMENT   = 0.9;   // agrandissement de la fenêtre de recherche autour de la position prévue (tolère un mouvement de caméra imparfaitement prédit)
const SUIVI_AMORTI_VITESSE  = 0.6;   // amortissement de l'extrapolation de mouvement (évite de sur-réagir à une mesure bruitée)

let suiviTimer = null;
let suiviTracks = [];           // paquets actuellement suivis, en observation ou en grâce (visibles ou tout juste sortis du cadre)
let suiviPerdusRecents = [];    // paquets confirmés puis déclarés "perdus", gardés en mémoire courte pour ré-identification
let suiviProchainId = 1;
let suiviIdsVusUneFois = 0;     // compteur d'identités CONFIRMÉES distinctes créées depuis le début du suivi (preuve : pas de double comptage)
let frameSourceSuivi = null, frameWSuivi = 0, frameHSuivi = 0;

const stageEl = document.getElementById('stage');
const suiviCanvas = document.getElementById('suiviCanvas');
const suiviCtx = suiviCanvas.getContext('2d');
const suiviStatutEl = document.getElementById('suiviStatut');
const legendeSuiviEl = document.getElementById('legendeSuivi');

function suiviReset() {
  suiviTracks = [];
  suiviPerdusRecents = [];
  suiviProchainId = 1;
  suiviIdsVusUneFois = 0;
  suiviCtx.clearRect(0, 0, suiviCanvas.width, suiviCanvas.height);
  suiviStatutEl.textContent = '';
}

// filtre commun (taille, forme, bords touchés) appliqué aux candidats des deux méthodes de détection
function suiviCandidatValide(bb, w, h) {
  const bw = bb.maxX - bb.minX + 1, bh = bb.maxY - bb.minY + 1;
  const aire = (bw * bh) / (w * h);
  const ratio = Math.max(bw / bh, bh / bw);
  if (aire < SUIVI_AIRE_MIN || aire > SUIVI_AIRE_MAX) return false;
  if (ratio > SUIVI_RATIO_MAX) return false;
  // un paquet posé sur un rayon, vu d'assez près pour être identifiable, ne touche normalement pas
  // plus d'un côté du cadre à la fois ; une zone qui touche 2 côtés ou plus (meuble, mur, plan de
  // travail) se prolonge presque toujours hors de l'image et n'est pas un objet isolé.
  let cotesTouches = 0;
  if (bb.minX <= 1) cotesTouches++;
  if (bb.maxX >= w - 2) cotesTouches++;
  if (bb.minY <= 1) cotesTouches++;
  if (bb.maxY >= h - 2) cotesTouches++;
  return cotesTouches <= SUIVI_BORDS_MAX;
}

/* ---- 1a. Détection méthode A : zones PLATES (paquet à fond uni ou peu imprimé) ---- */
function suiviDetecterZonesPlates(gray, bordPlein, w, h) {
  const vu = new Uint8Array(w * h);
  const bruts = [];
  const pileX = new Int32Array(w * h);
  const pileY = new Int32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i0 = y * w + x;
      if (vu[i0] || bordPlein[i0]) continue;
      let sp = 0;
      pileX[sp] = x; pileY[sp] = y; sp++;
      vu[i0] = 1;
      let minX = x, maxX = x, minY = y, maxY = y, n = 0;
      while (sp > 0) {
        sp--;
        const cx = pileX[sp], cy = pileY[sp];
        n++;
        if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
        if (cx + 1 < w) { const ni = cy * w + (cx + 1); if (!vu[ni] && !bordPlein[ni]) { vu[ni] = 1; pileX[sp] = cx + 1; pileY[sp] = cy; sp++; } }
        if (cx - 1 >= 0) { const ni = cy * w + (cx - 1); if (!vu[ni] && !bordPlein[ni]) { vu[ni] = 1; pileX[sp] = cx - 1; pileY[sp] = cy; sp++; } }
        if (cy + 1 < h) { const ni = (cy + 1) * w + cx; if (!vu[ni] && !bordPlein[ni]) { vu[ni] = 1; pileX[sp] = cx; pileY[sp] = cy + 1; sp++; } }
        if (cy - 1 >= 0) { const ni = (cy - 1) * w + cx; if (!vu[ni] && !bordPlein[ni]) { vu[ni] = 1; pileX[sp] = cx; pileY[sp] = cy - 1; sp++; } }
      }
      if (n < 4) continue; // quelques pixels isolés : bruit pur, jamais un objet
      bruts.push({ minX, maxX, minY, maxY });
    }
  }
  return bruts;
}

/* ---- 1b. Détection méthode B : zones TEXTURÉES (paquet imprimé : étiquette, texte, logo) ----
   Un paquet réel est souvent une zone à fort contraste local d'un bout à l'autre (texte, image,
   logo) plutôt qu'une zone plate. On regroupe les petites cellules "texturées" par voisinage, en
   n'autorisant la fusion entre deux cellules voisines que si leur couleur moyenne est proche —
   cela sépare deux paquets adjacents de couleurs différentes plutôt que de tout regrouper en un
   seul grand candidat. Le seuil "texturé" est recalculé à chaque image (méthode d'Otsu) pour
   s'adapter à l'éclairage réel plutôt qu'à un réglage figé à l'avance. */
function suiviDetecterZonesTexturees(grad, d, w, h) {
  const CELL = SUIVI_CELLULE_TEXTURE;
  const cw = Math.ceil(w / CELL), ch = Math.ceil(h / CELL);
  const energie = new Float32Array(cw * ch);
  const colR = new Float32Array(cw * ch), colG = new Float32Array(cw * ch), colB = new Float32Array(cw * ch);
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      let s = 0, n = 0, r = 0, g = 0, b = 0;
      for (let y = cy * CELL; y < Math.min(h, (cy + 1) * CELL); y++) {
        for (let x = cx * CELL; x < Math.min(w, (cx + 1) * CELL); x++) {
          const i = y * w + x; s += grad[i]; n++;
          const pi = i * 4; r += d[pi]; g += d[pi + 1]; b += d[pi + 2];
        }
      }
      const idx = cy * cw + cx;
      energie[idx] = n ? s / n : 0;
      colR[idx] = n ? r / n : 0; colG[idx] = n ? g / n : 0; colB[idx] = n ? b / n : 0;
    }
  }

  // seuil "texturé / plat" recalculé par image (méthode d'Otsu sur l'histogramme des énergies de cellule)
  const vals = Array.from(energie).sort((a, b) => a - b);
  const mn = vals[0], mx = vals[vals.length - 1];
  let seuil = mn;
  if (mx > mn) {
    const bins = 256;
    const hist = new Array(bins).fill(0);
    for (const v of vals) hist[Math.floor((v - mn) / (mx - mn) * (bins - 1))]++;
    const total = vals.length;
    let sum = 0; for (let i = 0; i < bins; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, wF = 0, maxVar = 0, thresh = 0;
    for (let t = 0; t < bins; t++) {
      wB += hist[t]; if (wB === 0) continue;
      wF = total - wB; if (wF === 0) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const varEntre = wB * wF * (mB - mF) * (mB - mF);
      if (varEntre > maxVar) { maxVar = varEntre; thresh = t; }
    }
    seuil = mn + (thresh / (bins - 1)) * (mx - mn);
  }
  const candidat = new Uint8Array(cw * ch);
  for (let i = 0; i < cw * ch; i++) candidat[i] = energie[i] > seuil ? 1 : 0;

  // composantes connexes sur la grille de cellules, avec porte de similarité de couleur
  const vu = new Uint8Array(cw * ch);
  const comps = [];
  const pileX = new Int32Array(cw * ch), pileY = new Int32Array(cw * ch);
  const distCoul = (i, j) => {
    const dr = colR[i] - colR[j], dg = colG[i] - colG[j], db = colB[i] - colB[j];
    return Math.sqrt(dr * dr + dg * dg + db * db);
  };
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      const i0 = cy * cw + cx;
      if (vu[i0] || !candidat[i0]) continue;
      let sp = 0; pileX[sp] = cx; pileY[sp] = cy; sp++; vu[i0] = 1;
      let minX = cx, maxX = cx, minY = cy, maxY = cy, n = 0;
      while (sp > 0) {
        sp--;
        const x = pileX[sp], y = pileY[sp], i1 = y * cw + x;
        n++;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        const voisins = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
        for (const [nx, ny] of voisins) {
          if (nx < 0 || nx >= cw || ny < 0 || ny >= ch) continue;
          const ni = ny * cw + nx;
          if (vu[ni] || !candidat[ni]) continue;
          if (distCoul(i1, ni) > SUIVI_COULEUR_SEUIL) continue; // couleur trop différente : probablement un autre paquet
          vu[ni] = 1; pileX[sp] = nx; pileY[sp] = ny; sp++;
        }
      }
      if (n < 2) continue; // une seule cellule isolée : bruit
      comps.push({ minX: minX * CELL, maxX: Math.min(w - 1, (maxX + 1) * CELL - 1), minY: minY * CELL, maxY: Math.min(h - 1, (maxY + 1) * CELL - 1) });
    }
  }
  return comps;
}

/* ---- 1. Détection : combine les deux méthodes (zones plates + zones texturées) ---- */
function suiviDetecterBlobs(source, srcW, srcH) {
  if (!srcW || !srcH) return [];
  const w = SUIVI_LARGEUR_ANALYSE;
  const h = Math.max(1, Math.round(srcH * (w / srcW)));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  try { ctx.drawImage(source, 0, 0, srcW, srcH, 0, 0, w, h); } catch (e) { return []; }
  let d;
  try { d = ctx.getImageData(0, 0, w, h).data; } catch (e) { return []; }

  const gray = new Float32Array(w * h);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    gray[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  }
  const grad = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = gray[i + 1] - gray[i - 1];
      const gy = gray[i + w] - gray[i - w];
      grad[i] = Math.abs(gx) + Math.abs(gy);
    }
  }
  const bordPlein = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) bordPlein[i] = grad[i] > SUIVI_SEUIL_GRADIENT ? 1 : 0;
  // le pourtour de l'image est toujours traité comme un bord, pour éviter qu'un blob "s'échappe" hors cadre
  for (let x = 0; x < w; x++) { bordPlein[x] = 1; bordPlein[(h - 1) * w + x] = 1; }
  for (let y = 0; y < h; y++) { bordPlein[y * w] = 1; bordPlein[y * w + w - 1] = 1; }

  // fusionne les fragments proches d'une liste de boîtes brutes, en laissant de côté celles déjà
  // assez grandes pour ne pas être un simple fragment (sinon une grande zone "absorberait" tous les
  // petits candidats voisins de sa boîte englobante et transformerait tout le cadre en un candidat).
  const fusionnerAvecGardeFou = (bruts) => {
    const petits = [], grands = [];
    for (const b of bruts) {
      const bw = b.maxX - b.minX + 1, bh = b.maxY - b.minY + 1;
      const aire = (bw * bh) / (w * h);
      if (aire > SUIVI_FUSION_AIRE_MAX) grands.push(b); else petits.push(b);
    }
    return suiviFusionnerBoites(petits, w, h).concat(grands);
  };

  // chaque méthode fusionne d'abord ses propres fragments (un paquet imprimé se fragmente souvent en
  // plusieurs zones plates ou en plusieurs cellules texturées adjacentes)
  const brutsA = fusionnerAvecGardeFou(suiviDetecterZonesPlates(gray, bordPlein, w, h));
  const brutsB = suiviDetecterZonesTexturees(grad, d, w, h); // déjà regroupées par cellules à l'étape précédente

  // puis on fusionne une seconde fois entre les deux méthodes : la zone plate du fond d'un paquet et la
  // zone texturée de son étiquette, juste au-dessus ou en dessous, désignent le même objet physique.
  // Les garde-fous d'aire ET de dimension dans suiviFusionnerBoites empêchent cette seconde passe de
  // "faire le pont" jusqu'à un objet sans rapport (ex. le meuble en dessous, via un mince reflet).
  const candidats = fusionnerAvecGardeFou(brutsA.concat(brutsB)).filter(bb => suiviCandidatValide(bb, w, h));

  // dédoublonnage final : après fusion, deux candidats qui désignent quand même le même paquet
  // (fort recouvrement, ou l'un presque entièrement contenu dans l'autre) ne comptent qu'une fois —
  // on garde le plus grand des deux.
  const aire = (bb) => (bb.maxX - bb.minX + 1) * (bb.maxY - bb.minY + 1);
  const inter = (a, b) => {
    const ix1 = Math.max(a.minX, b.minX), iy1 = Math.max(a.minY, b.minY);
    const ix2 = Math.min(a.maxX, b.maxX), iy2 = Math.min(a.maxY, b.maxY);
    const iw = Math.max(0, ix2 - ix1 + 1), ih = Math.max(0, iy2 - iy1 + 1);
    return iw * ih;
  };
  const memeObjet = (a, b) => {
    const i = inter(a, b);
    if (i <= 0) return false;
    const iou = i / (aire(a) + aire(b) - i);
    if (iou > SUIVI_DEDOUBLONNAGE_IOU) return true;
    const contenu = i / Math.min(aire(a), aire(b));
    return contenu > 0.7; // l'un est presque entièrement à l'intérieur de l'autre : même paquet
  };
  candidats.sort((a, b) => aire(b) - aire(a));
  const gardes = [];
  for (const cnd of candidats) {
    if (gardes.some(g => memeObjet(g, cnd))) continue;
    gardes.push(cnd);
  }

  return gardes.map(bb => ({
    x: bb.minX / w, y: bb.minY / h,
    w: (bb.maxX - bb.minX + 1) / w, h: (bb.maxY - bb.minY + 1) / h,
  }));
}

function suiviFusionnerBoites(bruts, w, h) {
  const marge = Math.max(2, Math.round(Math.min(w, h) * SUIVI_FUSION_MARGE));
  let boites = bruts.map(b => ({ minX: b.minX, maxX: b.maxX, minY: b.minY, maxY: b.maxY }));
  let refait = true;
  while (refait) {
    refait = false;
    for (let i = 0; i < boites.length && !refait; i++) {
      for (let j = i + 1; j < boites.length; j++) {
        const a = boites[i], b = boites[j];
        const proche = (a.minX - marge <= b.maxX) && (b.minX - marge <= a.maxX) &&
                       (a.minY - marge <= b.maxY) && (b.minY - marge <= a.maxY);
        if (!proche) continue;
        const fusionMinX = Math.min(a.minX, b.minX), fusionMaxX = Math.max(a.maxX, b.maxX);
        const fusionMinY = Math.min(a.minY, b.minY), fusionMaxY = Math.max(a.maxY, b.maxY);
        // sur une image réelle, de nombreux petits fragments épars (fond, texte, reflets) peuvent se
        // toucher deux à deux de proche en proche et, par effet de chaîne, finir par couvrir tout le
        // cadre — même si chaque fragment pris seul est petit. On refuse une fusion dont le résultat
        // dépasserait déjà la taille d'un paquet plausible, ce qui arrête la chaîne avant qu'elle ne
        // s'étende à toute l'image, sans empêcher la fusion de deux fragments réellement voisins.
        const aireFusion = ((fusionMaxX - fusionMinX + 1) * (fusionMaxY - fusionMinY + 1)) / (w * h);
        if (aireFusion > SUIVI_FUSION_AIRE_MAX) continue;
        // une fusion peut rester "petite en aire" tout en s'étirant sur une grande partie de la largeur
        // ou de la hauteur du cadre (ex. un mince reflet qui relie un paquet au bord du meuble en
        // dessous) : on la refuse aussi si elle s'étire trop sur un des deux axes.
        if ((fusionMaxX - fusionMinX + 1) / w > SUIVI_FUSION_DIM_MAX) continue;
        if ((fusionMaxY - fusionMinY + 1) / h > SUIVI_FUSION_DIM_MAX) continue;
        boites[i] = { minX: fusionMinX, maxX: fusionMaxX, minY: fusionMinY, maxY: fusionMaxY };
        boites.splice(j, 1);
        refait = true;
        break;
      }
    }
  }
  return boites;
}

function suiviSignatureDeBlob(source, srcW, srcH, blob) {
  const bx = blob.x * srcW, by = blob.y * srcH, bw = blob.w * srcW, bh = blob.h * srcH;
  if (bw < 1 || bh < 1) return null;
  const c = document.createElement('canvas'); c.width = 64; c.height = 64;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  try { ctx.drawImage(source, bx, by, bw, bh, 0, 0, 64, 64); } catch (e) { return null; }
  return computeSignature(c, 64, 64);
}

function suiviIoU(a, b) {
  const ax2 = a.x + a.w, ay2 = a.y + a.h, bx2 = b.x + b.w, by2 = b.y + b.h;
  const ix1 = Math.max(a.x, b.x), iy1 = Math.max(a.y, b.y);
  const ix2 = Math.min(ax2, bx2), iy2 = Math.min(ay2, by2);
  const iw = Math.max(0, ix2 - ix1), ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

// position prévue de la prochaine détection, en amortissant l'extrapolation pour ne pas sur-réagir à une seule mesure bruitée
function suiviBboxPrevu(track) {
  if (!track.prevBbox) return track.bbox;
  const vx = (track.bbox.x - track.prevBbox.x) * SUIVI_AMORTI_VITESSE;
  const vy = (track.bbox.y - track.prevBbox.y) * SUIVI_AMORTI_VITESSE;
  return { x: track.bbox.x + vx, y: track.bbox.y + vy, w: track.bbox.w, h: track.bbox.h };
}

// fenêtre de recherche élargie autour d'une position prévue, pour tolérer un mouvement de caméra
// plus rapide ou moins régulier que ce que la simple extrapolation linéaire prévoit
function suiviBboxElargie(bbox, marge) {
  const cx = bbox.x + bbox.w / 2, cy = bbox.y + bbox.h / 2;
  const w = bbox.w * (1 + marge), h = bbox.h * (1 + marge);
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/* ---- 2. Une passe d'analyse : détecte, apparie aux suivis existants, confirme, gère mémoire et nouvelles identités ---- */
function suiviAnalyseUneFois() {
  if (!frameSourceSuivi || !frameWSuivi || !frameHSuivi) return;

  const brutes = suiviDetecterBlobs(frameSourceSuivi, frameWSuivi, frameHSuivi);
  const detections = [];
  for (const b of brutes) {
    const sig = suiviSignatureDeBlob(frameSourceSuivi, frameWSuivi, frameHSuivi, b);
    if (sig) detections.push({ bbox: b, sig });
  }

  // 2.1 appariement des suivis existants (confirmés ou en observation) avec les détections de cette image,
  //     dans une fenêtre de recherche élargie autour de la position prévue
  const paires = [];
  for (let ti = 0; ti < suiviTracks.length; ti++) {
    const prevu = suiviBboxElargie(suiviBboxPrevu(suiviTracks[ti]), SUIVI_ELARGISSEMENT);
    for (let di = 0; di < detections.length; di++) {
      const iou = suiviIoU(prevu, detections[di].bbox);
      if (iou <= 0) continue;
      const app = similarity(suiviTracks[ti].sig, detections[di].sig);
      paires.push({ ti, di, score: 0.5 * iou + 0.5 * app });
    }
  }
  paires.sort((a, b) => b.score - a.score);
  const pisteAssignee = new Set(), detAssignee = new Set();
  for (const p of paires) {
    if (pisteAssignee.has(p.ti) || detAssignee.has(p.di)) continue;
    if (p.score < SUIVI_SEUIL_APPARIEMENT) continue;
    pisteAssignee.add(p.ti); detAssignee.add(p.di);
    const t = suiviTracks[p.ti], d = detections[p.di];
    t.prevBbox = t.bbox;
    t.bbox = {
      x: t.bbox.x * 0.4 + d.bbox.x * 0.6, y: t.bbox.y * 0.4 + d.bbox.y * 0.6,
      w: t.bbox.w * 0.4 + d.bbox.w * 0.6, h: t.bbox.h * 0.4 + d.bbox.h * 0.6
    };
    t.sig = d.sig;
    t.framesSansDetection = 0;
    if (t.etat === 'observation') {
      // deuxième détection cohérente de suite : on confirme l'identité, seulement maintenant elle compte
      t.etat = 'actif';
      t.id = suiviProchainId++;
      suiviIdsVusUneFois++;
    } else if (t.etat !== 'ambigu') {
      t.etat = 'actif';
    }
  }

  // 2.2 suivis non retrouvés cette fois-ci
  const conserves = [];
  for (let ti = 0; ti < suiviTracks.length; ti++) {
    const t = suiviTracks[ti];
    if (pisteAssignee.has(ti)) { conserves.push(t); continue; }
    if (t.etat === 'observation') {
      // une détection isolée (reflet, bruit, meuble) qui ne se confirme pas est abandonnée sans laisser de trace
      continue;
    }
    t.framesSansDetection = (t.framesSansDetection || 0) + 1;
    t.etat = t.framesSansDetection <= SUIVI_GRACE_FRAMES ? 'incertain' : 'perdu';
    conserves.push(t);
  }
  suiviTracks = conserves;

  // 2.3 les suivis confirmés "perdus" sortent de la liste active et passent en mémoire courte
  const actifs = [];
  for (const t of suiviTracks) {
    if (t.etat === 'perdu') suiviPerdusRecents.push({ id: t.id, sig: t.sig, perduA: Date.now() });
    else actifs.push(t);
  }
  suiviTracks = actifs;

  const maintenant = Date.now();
  suiviPerdusRecents = suiviPerdusRecents.filter(p => maintenant - p.perduA < SUIVI_MEMOIRE_MS);

  // 2.4 détections non appariées : ré-identification depuis la mémoire, ou nouvelle détection "en observation"
  for (let di = 0; di < detections.length; di++) {
    if (detAssignee.has(di)) continue;
    const d = detections[di];
    let meilleur = null, meilleurScore = -1, second = -1;
    for (const p of suiviPerdusRecents) {
      const s = similarity(p.sig, d.sig);
      if (s > meilleurScore) { second = meilleurScore; meilleur = p; meilleurScore = s; }
      else if (s > second) { second = s; }
    }
    if (meilleur && meilleurScore >= SUIVI_SEUIL_REID && (meilleurScore - Math.max(0, second)) >= SUIVI_MARGE_REID) {
      // ré-identification nette : même identité qu'avant, pas de nouveau compte, pas besoin de reconfirmer
      const track = { id: meilleur.id, bbox: d.bbox, prevBbox: null, sig: d.sig, framesSansDetection: 0, etat: 'actif' };
      suiviPerdusRecents = suiviPerdusRecents.filter(p => p !== meilleur);
      suiviTracks.push(track);
    } else if (meilleur && meilleurScore >= SUIVI_SEUIL_REID) {
      // ressemble fortement à plusieurs souvenirs à la fois (ex. deux paquets identiques) : on ne devine pas
      const track = { id: suiviProchainId++, bbox: d.bbox, prevBbox: null, sig: d.sig, framesSansDetection: 0, etat: 'ambigu' };
      suiviIdsVusUneFois++;
      suiviTracks.push(track);
    } else {
      // détection jamais vue : mise "en observation", pas encore comptée comme identité —
      // elle ne le sera que si on la revoit à une position cohérente à la prochaine analyse
      const track = { id: null, bbox: d.bbox, prevBbox: null, sig: d.sig, framesSansDetection: 0, etat: 'observation' };
      suiviTracks.push(track);
    }
  }

  suiviDessiner();
  suiviMettreAJourStatut();
}

/* ---- 3. Rendu : replace chaque contour à l'écran en tenant compte du cadrage "cover" de la vidéo ---- */
function suiviGeometrieCouverture() {
  const rect = stageEl.getBoundingClientRect();
  if (!frameWSuivi || !frameHSuivi || !rect.width || !rect.height) return null;
  const echelle = Math.max(rect.width / frameWSuivi, rect.height / frameHSuivi);
  const dispW = frameWSuivi * echelle, dispH = frameHSuivi * echelle;
  return { rect, echelle, offX: (rect.width - dispW) / 2, offY: (rect.height - dispH) / 2 };
}

function suiviDessiner() {
  const geo = suiviGeometrieCouverture();
  if (!geo) return;
  const dpr = window.devicePixelRatio || 1;
  const cw = Math.round(geo.rect.width * dpr), ch = Math.round(geo.rect.height * dpr);
  if (suiviCanvas.width !== cw || suiviCanvas.height !== ch) { suiviCanvas.width = cw; suiviCanvas.height = ch; }
  suiviCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  suiviCtx.clearRect(0, 0, geo.rect.width, geo.rect.height);

  const dessinerBoite = (bbox, couleur, tirets, label) => {
    const x = bbox.x * frameWSuivi * geo.echelle + geo.offX;
    const y = bbox.y * frameHSuivi * geo.echelle + geo.offY;
    const w = bbox.w * frameWSuivi * geo.echelle;
    const h = bbox.h * frameHSuivi * geo.echelle;
    suiviCtx.lineWidth = 2.5;
    suiviCtx.strokeStyle = couleur;
    suiviCtx.setLineDash(tirets);
    suiviCtx.strokeRect(x, y, w, h);
    suiviCtx.setLineDash([]);
    suiviCtx.font = '700 11px -apple-system, sans-serif';
    const tw = suiviCtx.measureText(label).width;
    suiviCtx.fillStyle = couleur;
    suiviCtx.fillRect(x, Math.max(0, y - 16), tw + 8, 16);
    suiviCtx.fillStyle = '#fff';
    suiviCtx.fillText(label, x + 4, Math.max(11, y - 4));
  };

  for (const t of suiviTracks) {
    if (t.etat === 'actif') dessinerBoite(t.bbox, '#2f6fed', [], `#${t.id}`);
    else if (t.etat === 'incertain') dessinerBoite(t.bbox, '#fb8c00', [6, 4], `#${t.id} ?`);
    else if (t.etat === 'ambigu') dessinerBoite(t.bbox, '#8e44ad', [2, 3], `#${t.id} ambigu`);
    else if (t.etat === 'observation') dessinerBoite(t.bbox, '#9aa0a6', [1, 4], '…');
  }
}

function suiviMettreAJourStatut() {
  const nb = (etat) => suiviTracks.filter(t => t.etat === etat).length;
  const enObservation = nb('observation');
  suiviStatutEl.innerHTML =
    `<b>${suiviTracks.length - enObservation}</b> paquet(s) confirmé(s) à l'écran — ${nb('actif')} net(s), ${nb('incertain')} incertain(s), ${nb('ambigu')} ambigu(s)` +
    (enObservation ? ` · ${enObservation} en observation (pas encore confirmé)` : '') +
    ` · <b>${suiviIdsVusUneFois}</b> identité(s) confirmée(s) créée(s) depuis le début du suivi`;
}

/* ---- 4. Démarrage / arrêt, branché sur la caméra en direct ---- */
function suiviDemarrer() {
  suiviReset();
  frameSourceSuivi = video;
  frameWSuivi = video.videoWidth || frameW;
  frameHSuivi = video.videoHeight || frameH;
  suiviCanvas.style.display = 'block';
  suiviStatutEl.classList.add('visible');
  legendeSuiviEl.classList.add('visible');
  grilleEl.style.display = 'none';
  document.getElementById('statut').textContent = 'Suivi en cours — détail ci-dessous.';
  if (suiviTimer) clearInterval(suiviTimer);
  suiviTimer = setInterval(() => {
    frameWSuivi = video.videoWidth || frameWSuivi;
    frameHSuivi = video.videoHeight || frameHSuivi;
    suiviAnalyseUneFois();
  }, SUIVI_PERIODE_MS);
}

function suiviArreter() {
  if (suiviTimer) clearInterval(suiviTimer);
  suiviTimer = null;
  suiviCanvas.style.display = 'none';
  suiviStatutEl.classList.remove('visible');
  legendeSuiviEl.classList.remove('visible');
  grilleEl.style.display = 'grid';
  suiviCtx.clearRect(0, 0, suiviCanvas.width, suiviCanvas.height);
}

/* ---- 5. Repli photo unique : une seule détection, sans continuité possible (pas de mouvement à suivre) ---- */
function suiviAnalysePhotoUnique(img) {
  suiviReset();
  frameSourceSuivi = img;
  frameWSuivi = img.naturalWidth;
  frameHSuivi = img.naturalHeight;
  suiviCanvas.style.display = 'block';
  suiviStatutEl.classList.add('visible');
  legendeSuiviEl.classList.add('visible');
  grilleEl.style.display = 'none';
  suiviAnalyseUneFois();
  suiviStatutEl.innerHTML += ' · <i>photo unique : aucun suivi de mouvement possible, seulement une détection ponctuelle (rien ne peut donc être "confirmé" par une seconde vue).</i>';
}
