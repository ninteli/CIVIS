// Palette de couleurs harmonieuses, lisibles sur theme clair et sombre
// Saturation moderee (~50-70%), luminance moyenne
const PALETTE = {
  bleu: 0x32aed8,
  vert: 0x4ba86b,
  orange: 0xd68b3f,
  rouge: 0xd63f4e,
  violet: 0x8a63d2,
  jaunevert: 0xc9d426,
  rose: 0xd665a5,
  cyan: 0x3fb8c1,
};

// Association mot-cle -> couleur de la palette
const ROLE_NAME_HINTS = [
  { keywords: ['admin', 'fondateur', 'owner', 'staff', 'moderateur', 'modo'], color: 'rouge' },
  { keywords: ['moderateur', 'modo', 'helper', 'support'], color: 'vert' },
  { keywords: ['vip', 'premium', 'donateur', 'booster'], color: 'violet' },
  { keywords: ['bot', 'automate'], color: 'cyan' },
  { keywords: ['membre', 'member', 'user'], color: 'bleu' },
  { keywords: ['event', 'jeu', 'fun'], color: 'jaunevert' },
  { keywords: ['annonce', 'info', 'communication'], color: 'orange' },
  { keywords: ['createur', 'artiste', 'dev'], color: 'rose' },
];

function pickHarmoniousColor(roleName) {
  const lower = String(roleName || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // 1. Cherche un mot-cle correspondant
  for (const rule of ROLE_NAME_HINTS) {
    if (rule.keywords.some((k) => lower.includes(k))) {
      return PALETTE[rule.color];
    }
  }

  // 2. Sinon : couleur pseudo-aleatoire deterministe selon le nom
  const keys = Object.keys(PALETTE);
  let hash = 0;
  for (let i = 0; i < lower.length; i++) {
    hash = (hash * 31 + lower.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % keys.length;
  return PALETTE[keys[idx]];
}

// Couleurs nommees (avec accents supportes)
const NAMED_COLORS = {
  red: 0xff0000, rouge: 0xff0000,
  blue: 0x0000ff, bleu: 0x0000ff,
  green: 0x00ff00, vert: 0x00ff00,
  yellow: 0xffff00, jaune: 0xffff00,
  orange: 0xffa500,
  purple: 0x800080, violet: 0x800080, pourpre: 0x800080,
  pink: 0xffc0cb, rose: 0xffc0cb,
  cyan: 0x00ffff, turquoise: 0x40e0d0,
  black: 0x000000, noir: 0x000000,
  white: 0xffffff, blanc: 0xffffff,
  gray: 0x808080, grey: 0x808080, gris: 0x808080,
  brown: 0x8b4513, marron: 0x8b4513,
  gold: 0xffd700, or: 0xffd700,
  argent: 0xc0c0c0, silver: 0xc0c0c0,

  'vert-pomme': 0x8db600,
  'vert-fonce': 0x006400,
  'vert-clair': 0x90ee90,
  'vert-emeraude': 0x50c878,
  'vert-menthe': 0x98ff98,
  'vert-olive': 0x808000,
  'vert-sapin': 0x0b6623,
  'vert-foret': 0x228b22,
  'vert-lime': 0x32cd32,

  'bleu-ciel': 0x87ceeb,
  'bleu-marine': 0x000080,
  'bleu-nuit': 0x191970,
  'bleu-turquoise': 0x40e0d0,
  'bleu-azur': 0x007fff,
  'bleu-roi': 0x4169e1,
  'bleu-canard': 0x008b8b,
  'bleu-pastel': 0xaec6cf,

  'rouge-fonce': 0x8b0000,
  'rouge-bordeaux': 0x800020,
  'rouge-cerise': 0xde3163,
  'rouge-corail': 0xff4040,

  'rose-bonbon': 0xff69b4,
  'rose-pale': 0xffdae9,
  fuchsia: 0xff00ff, magenta: 0xff00ff,

  'violet-clair': 0xdda0dd,
  lavande: 0xe6e6fa,
  indigo: 0x4b0082,

  'jaune-dore': 0xffd700,
  'orange-fonce': 0xff8c00,
  'orange-clair': 0xffa07a,
  corail: 0xff7f50,
  peche: 0xffdab9,
  saumon: 0xfa8072,

  beige: 0xf5f5dc, sable: 0xf4a460, chocolat: 0xd2691e,
  'gris-clair': 0xd3d3d3, 'gris-fonce': 0xa9a9a9,
  ivoire: 0xfffff0,
};

function parseNamedColor(str) {
  const s = String(str).trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '-');

  if (NAMED_COLORS[s] !== undefined) return NAMED_COLORS[s];

  // Hex 6 chiffres
  const hex6 = s.match(/^#?([0-9a-f]{6})$/);
  if (hex6) return parseInt(hex6[1], 16);

  // Hex 3 chiffres
  const hex3 = s.match(/^#?([0-9a-f]{3})$/);
  if (hex3) {
    const h = hex3[1];
    return parseInt(h[0] + h[0] + h[1] + h[1] + h[2] + h[2], 16);
  }

  return null;
}

// Cherche une couleur mentionnee EXPLICITEMENT dans le texte utilisateur
// Retourne null si rien trouve
function findExplicitColorInText(text) {
  if (!text) return null;

  const lower = text.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // 1. Hex explicite
  const hex = lower.match(/#([0-9a-f]{6}|[0-9a-f]{3})\b/);
  if (hex) {
    const c = parseNamedColor(hex[0]);
    if (c !== null) return c;
  }

  // 2. Noms de couleurs (avec tirets pour les composes)
  // On teste les noms les plus longs d'abord (vert-pomme avant vert)
  const names = Object.keys(NAMED_COLORS).sort((a, b) => b.length - a.length);
  for (const name of names) {
    // match mot entier pour eviter "vert" dans "converty"
    const pattern = new RegExp('(^|[^a-z])' + name + '($|[^a-z])', 'i');
    if (pattern.test(lower)) {
      return NAMED_COLORS[name];
    }
  }

  return null;
}

// FONCTION PRINCIPALE : decide quelle couleur appliquer
// - explicitColor : couleur trouvee dans le texte utilisateur (priorite max)
// - llmColor : couleur proposee par le LLM (a ignorer si pas explicitement demandee)
// - roleName : nom du role (pour palette auto si pas de couleur)
function resolveColor(explicitColor, llmColor, roleName) {
  // 1. Si l'utilisateur a demande une couleur -> on l'applique
  if (explicitColor !== null && explicitColor !== undefined) return explicitColor;

  // 2. Si le LLM propose une couleur ET que l'utilisateur l'avait demandee
  // (on ne peut pas savoir, donc on IGNORE le LLM si pas de couleur explicite)
  // -> fallback palette

  // 3. Sinon : palette harmonieuse basee sur le nom du role
  return pickHarmoniousColor(roleName);
}

module.exports = {
  PALETTE,
  pickHarmoniousColor,
  parseNamedColor,
  findExplicitColorInText,
  resolveColor,
};
