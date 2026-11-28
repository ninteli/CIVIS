const { actionTools } = require('../agent/tools');
const {
  MAX_IMPORT_PLAN_STEPS,
  MAX_IMPORT_RAW_PLAN_STEPS,
  validateAndAnalyzePlan,
} = require('../agent/planner');

const MAX_IMPORT_BYTES = 256 * 1024; // 256 Ko
const FETCH_TIMEOUT_MS = 10_000;
const ALLOWED_ATTACHMENT_HOSTS = new Set([
  'cdn.discordapp.com',
  'media.discordapp.net',
]);

function buildAiJsonGuideMarkdown() {
  const lines = [];
  lines.push(
    '> Ce guide permet à une IA externe (Gemini, ChatGPT, Claude, etc.) de générer un script JSON directement importable dans CIVIS via la commande `/import`.'
  );
  lines.push('');
  lines.push('### Structure JSON attendue');
  lines.push('');
  lines.push('```json');
  lines.push('{');
  lines.push('  "summary": "Résumé court en français des modifications à appliquer",');
  lines.push('  "steps": [');
  lines.push('    {');
  lines.push('      "tool": "nom_de_l_outil",');
  lines.push('      "args": { }');
  lines.push('    }');
  lines.push('  ]');
  lines.push('}');
  lines.push('```');
  lines.push('');
  lines.push('### Règles importantes');
  lines.push('');
  lines.push('- **Privilégie toujours les IDs Discord** fournis dans cet export pour cibler un élément déjà existant (`channel`, `category`, `role`), afin d\'éviter toute ambiguïté (homonymes, emojis, renommages).');
  lines.push('- Utilise le **nom uniquement** pour les éléments nouvellement créés dans le même script (qui n\'ont pas encore d\'ID) ou `"@everyone"` (l\'ID de `@everyone` est aussi accepté).');
  lines.push(
    `- Maximum **${MAX_IMPORT_PLAN_STEPS} étapes** consolidées (${MAX_IMPORT_RAW_PLAN_STEPS} brutes avant regroupement automatique des permissions de catégorie).`
  );
  lines.push('- N\'invente aucun outil ni aucun nom de permission Discord (utilise les noms officiels `discord.js` : `ViewChannel`, `SendMessages`, `ReadMessageHistory`, `Connect`, `Speak`, `ManageMessages`, `ManageChannels`, `ManageRoles`, `KickMembers`, `BanMembers`, etc.).');
  lines.push('- Pour modifier les permissions de toute une catégorie, cible la catégorie directement avec `set_channel_permissions` et `"target_type": "category"`.');
  lines.push('- Privilégie `archive_channel` / `archive_role` plutôt que `delete_channel` / `delete_role` sauf demande explicite de suppression définitive.');
  lines.push('- Renvoie uniquement du JSON valide (ou dans un bloc ` ```json ... ``` `), enregistrable en fichier `.json` pour `/import fichier:<fichier.json>`.');
  lines.push('');
  lines.push('### Outils CIVIS disponibles');
  lines.push('');

  for (const tool of actionTools) {
    const paramEntries = Object.entries(tool.parameters || {});
    lines.push(`- **\`${tool.name}\`** : ${tool.description}`);
    if (paramEntries.length > 0) {
      for (const [paramName, paramDesc] of paramEntries) {
        lines.push(`  - \`${paramName}\` : ${paramDesc}`);
      }
    }
  }

  lines.push('');
  lines.push('### Exemple complet de script JSON');
  lines.push('');
  lines.push('```json');
  lines.push(
    JSON.stringify(
      {
        summary: 'Mettre à jour un salon existant (par ID) et créer un espace VIP',
        steps: [
          {
            tool: 'modify_channel',
            args: {
              channel: '100000000000000010',
              slowmode: 5,
              topic: 'Discussions générales des citoyens',
            },
          },
          {
            tool: 'create_role',
            args: { name: 'VIP', color: '#F1C40F', hoist: true, mentionable: false },
          },
          {
            tool: 'create_category',
            args: { name: 'Espace VIP' },
          },
          {
            tool: 'set_channel_permissions',
            args: {
              channel: 'Espace VIP',
              target_type: 'category',
              role: '@everyone',
              deny: ['ViewChannel'],
            },
          },
          {
            tool: 'set_channel_permissions',
            args: {
              channel: 'Espace VIP',
              target_type: 'category',
              role: 'VIP',
              allow: ['ViewChannel', 'SendMessages', 'Connect', 'Speak'],
            },
          },
          {
            tool: 'create_channel',
            args: {
              name: 'vip-lounge',
              type: 'text',
              category: 'Espace VIP',
              topic: 'Salon réservé aux membres VIP',
            },
          },
          {
            tool: 'create_channel',
            args: {
              name: 'Vocal VIP',
              type: 'voice',
              category: 'Espace VIP',
            },
          },
        ],
      },
      null,
      2
    )
  );
  lines.push('```');

  return lines.join('\n');
}

function validateDiscordAttachment(attachment) {
  if (!attachment || typeof attachment !== 'object') {
    return { ok: false, error: 'Piece jointe invalide.' };
  }

  const name = String(attachment.name || '').trim();
  const contentType = String(attachment.contentType || '').toLowerCase();
  const hasAllowedExt = /\.(json|txt)$/i.test(name);
  const hasAllowedMime =
    contentType.includes('application/json') || contentType.startsWith('text/plain');

  if (!hasAllowedExt && !hasAllowedMime) {
    return {
      ok: false,
      error:
        'Format de fichier non supporte (`' +
        (name || 'inconnu') +
        '`). Envoie un fichier `.json` (ou `.txt` contenant du JSON).',
    };
  }

  if (typeof attachment.size === 'number' && attachment.size > MAX_IMPORT_BYTES) {
    return {
      ok: false,
      error:
        'Fichier trop volumineux (' +
        Math.round(attachment.size / 1024) +
        ' Ko). Taille maximale autorisee : ' +
        Math.round(MAX_IMPORT_BYTES / 1024) +
        ' Ko.',
    };
  }

  const rawUrl = String(attachment.url || '').trim();
  if (!rawUrl) {
    return { ok: false, error: 'URL de piece jointe manquante.' };
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, error: 'URL de piece jointe mal formee.' };
  }

  if (parsed.protocol !== 'https:' || !ALLOWED_ATTACHMENT_HOSTS.has(parsed.hostname.toLowerCase())) {
    return {
      ok: false,
      error:
        'Origine de fichier non autorisee : seules les pieces jointes hebergees par Discord (`cdn.discordapp.com`, `media.discordapp.net`) sont acceptees.',
    };
  }

  return { ok: true, url: parsed.toString(), name: name || 'script.json' };
}

async function fetchAttachmentText(attachment, { fetchFn = global.fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const check = validateDiscordAttachment(attachment);
  if (!check.ok) {
    return check;
  }

  if (typeof fetchFn !== 'function') {
    return { ok: false, error: 'Client HTTP indisponible pour telecharger la piece jointe.' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchFn(check.url, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
    });

    if (!res || !res.ok) {
      return {
        ok: false,
        error:
          'Impossible de telecharger la piece jointe (HTTP ' +
          (res ? res.status : 'inconnu') +
          ').',
      };
    }

    const contentLengthHeader = res.headers?.get?.('content-length');
    if (contentLengthHeader) {
      const declaredLen = Number.parseInt(contentLengthHeader, 10);
      if (Number.isFinite(declaredLen) && declaredLen > MAX_IMPORT_BYTES) {
        return {
          ok: false,
          error:
            'Fichier trop volumineux. Taille maximale autorisee : ' +
            Math.round(MAX_IMPORT_BYTES / 1024) +
            ' Ko.',
        };
      }
    }

    const text = await res.text();
    const byteLen = Buffer.byteLength(text, 'utf8');
    if (byteLen > MAX_IMPORT_BYTES) {
      return {
        ok: false,
        error:
          'Fichier trop volumineux (' +
          Math.round(byteLen / 1024) +
          ' Ko). Taille maximale autorisee : ' +
          Math.round(MAX_IMPORT_BYTES / 1024) +
          ' Ko.',
      };
    }

    return { ok: true, text, name: check.name };
  } catch (err) {
    const msg =
      err && err.name === 'AbortError'
        ? 'Delai depasse lors du telechargement de la piece jointe.'
        : 'Erreur lors du telechargement de la piece jointe : ' + (err?.message || String(err));
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

function stripJsonCodeFence(rawText) {
  const trimmed = String(rawText || '').trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function parseImportedPlanJson(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    return { ok: false, error: 'Le script JSON est vide.' };
  }

  const cleaned = stripJsonCodeFence(rawText);

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    return {
      ok: false,
      error: 'Erreur de syntaxe JSON : ' + (err?.message || 'JSON invalide'),
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      error:
        'Le script JSON doit etre un objet au format `{"summary": "...", "steps": [{"tool": "...", "args": {...}}]}`.',
    };
  }

  if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    return {
      ok: false,
      error: 'Le champ `"steps"` doit etre un tableau non vide d etapes.',
    };
  }

  const normalizedSteps = [];
  for (let i = 0; i < parsed.steps.length; i += 1) {
    const rawStep = parsed.steps[i];
    if (!rawStep || typeof rawStep !== 'object' || Array.isArray(rawStep)) {
      return {
        ok: false,
        error: `Etape ${i + 1} invalide : un objet {"tool": "...", "args": {...}} est attendu.`,
      };
    }
    const tool = typeof rawStep.tool === 'string' ? rawStep.tool.trim() : '';
    if (!tool) {
      return {
        ok: false,
        error: `Etape ${i + 1} invalide : champ "tool" manquant ou vide.`,
      };
    }
    if (
      rawStep.args !== undefined &&
      (typeof rawStep.args !== 'object' || rawStep.args === null || Array.isArray(rawStep.args))
    ) {
      return {
        ok: false,
        error: `Etape ${i + 1} (${tool}) invalide : le champ "args" doit etre un objet JSON.`,
      };
    }
    normalizedSteps.push({
      tool,
      args: rawStep.args ? { ...rawStep.args } : {},
    });
  }

  const summary =
    typeof parsed.summary === 'string' && parsed.summary.trim()
      ? parsed.summary.trim().slice(0, 200)
      : 'Plan importe depuis un script JSON';

  return {
    ok: true,
    plan: {
      summary,
      steps: normalizedSteps,
    },
  };
}

async function loadAndValidateImportedPlan({
  attachment = null,
  rawJsonText = null,
  guild,
  member,
  fetchFn = global.fetch,
}) {
  const startedAt = Date.now();
  let textToParse = '';
  let sourceLabel = 'texte JSON';

  if (attachment) {
    const dl = await fetchAttachmentText(attachment, { fetchFn });
    if (!dl.ok) {
      return dl;
    }
    textToParse = dl.text;
    sourceLabel = 'fichier `' + dl.name + '`';
  } else if (typeof rawJsonText === 'string' && rawJsonText.trim()) {
    if (Buffer.byteLength(rawJsonText, 'utf8') > MAX_IMPORT_BYTES) {
      return {
        ok: false,
        error:
          'Script JSON trop volumineux. Taille maximale autorisee : ' +
          Math.round(MAX_IMPORT_BYTES / 1024) +
          ' Ko.',
      };
    }
    textToParse = rawJsonText;
  } else {
    return {
      ok: false,
      error:
        'Aucun script JSON fourni. Joins un fichier `.json` (option `fichier`) ou colle le JSON directement (option `json`).',
    };
  }

  const parsed = parseImportedPlanJson(textToParse);
  if (!parsed.ok) {
    return parsed;
  }

  const analyzed = validateAndAnalyzePlan(parsed.plan, guild, member, {
    maxSteps: MAX_IMPORT_PLAN_STEPS,
    maxRawSteps: MAX_IMPORT_RAW_PLAN_STEPS,
  });

  if (!analyzed.ok) {
    return {
      ok: false,
      error: analyzed.error,
      protectedChannel: Boolean(analyzed.protectedChannel),
      securityAlert: Boolean(analyzed.securityAlert),
    };
  }

  return {
    ok: true,
    plan: analyzed.plan,
    security: analyzed.security,
    sourceLabel,
    stats: {
      source: 'json_import',
      model: 'script-json',
      elapsedMs: Math.max(0, Date.now() - startedAt),
    },
  };
}

module.exports = {
  MAX_IMPORT_BYTES,
  ALLOWED_ATTACHMENT_HOSTS,
  buildAiJsonGuideMarkdown,
  validateDiscordAttachment,
  fetchAttachmentText,
  parseImportedPlanJson,
  loadAndValidateImportedPlan,
};
