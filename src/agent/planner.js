const { ChannelType, PermissionsBitField } = require('discord.js');
const { chat } = require('./llm');
const memory = require('./memory');
const { resolveEffectiveUserConfig, mergeFollowupStats } = require('./brain');
const { actionTools, getToolsPrompt } = require('./tools');
const {
  normalizeKey,
  isManagedChannelType,
  resolveChannelTypeInput,
  getChannelTypeLabel,
  isSpoilerChannel,
  parseOptionalBoolean,
  parseCooldownArg,
} = require('./channel-types');
const {
  getPermissionLabel,
  normalizeRequiredPerms,
  isGuildOwner,
  checkBotPermissions,
  checkMemberAuthorization,
} = require('./permissions');

const MAX_PLAN_STEPS = 15;
const MAX_RAW_PLAN_STEPS = 60;

const normalizeText = normalizeKey;

function sanitizeChannelName(raw) {
  return String(raw || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
}

function parsePermissionFlags(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((p) => String(p).trim())
    .filter((key) => Object.prototype.hasOwnProperty.call(PermissionsBitField.Flags, key));
}

function normalizeRoleKey(roleName) {
  const norm = normalizeText(roleName);
  return norm === 'everyone' || norm === '@everyone' ? '@everyone' : norm;
}

function normalizePermissionStepArgs(rawArgs) {
  const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
    ? { ...rawArgs }
    : {};

  if (!String(args.channel || '').trim() && String(args.category || '').trim()) {
    args.channel = String(args.category).trim();
    args.target_type = 'category';
    delete args.category;
  } else if (args.target_type !== undefined) {
    const normType = normalizeText(args.target_type);
    if (normType === 'category' || normType === 'categorie') {
      args.target_type = 'category';
    } else if (normType === 'channel' || normType === 'salon') {
      args.target_type = 'channel';
    } else {
      delete args.target_type;
    }
  }

  return args;
}

function getPermissionSignature(args) {
  const allow = [...new Set(parsePermissionFlags(args?.allow))].sort();
  const deny = [...new Set(parsePermissionFlags(args?.deny))].sort();
  const reset = [...new Set(parsePermissionFlags(args?.reset))].sort();
  if (allow.length === 0 && deny.length === 0 && reset.length === 0) {
    return null;
  }
  return {
    allow,
    deny,
    reset,
    sig: allow.join(',') + '|' + deny.join(',') + '|' + reset.join(','),
  };
}

function consolidateCategoryPermissions(steps, guild) {
  if (!Array.isArray(steps) || steps.length === 0) return [];

  const workingSteps = steps.map((s) => ({
    tool: s.tool,
    args:
      s.tool === 'set_channel_permissions'
        ? normalizePermissionStepArgs(s.args)
        : s.args && typeof s.args === 'object' && !Array.isArray(s.args)
          ? { ...s.args }
          : {},
  }));

  const categoriesMap = new Map();
  const aliasToRecordIndices = new Map();
  const channelRecords = [];

  const addAlias = (alias, recIndex) => {
    if (!alias) return;
    let set = aliasToRecordIndices.get(alias);
    if (!set) {
      set = new Set();
      aliasToRecordIndices.set(alias, set);
    }
    set.add(recIndex);
  };

  const registerChannel = (name, catKey) => {
    const chanKey = sanitizeChannelName(name) || normalizeText(name);
    if (!chanKey) return;
    const ownerKey = catKey || '__root__';
    let recIndex = channelRecords.findIndex(
      (r) => r.catKey === ownerKey && r.chanKey === chanKey
    );
    if (recIndex === -1) {
      recIndex = channelRecords.length;
      channelRecords.push({ catKey: ownerKey, chanKey });
    }
    addAlias(normalizeText(name), recIndex);
    addAlias(sanitizeChannelName(name), recIndex);
    if (catKey && catKey !== '__root__') {
      const cat = categoriesMap.get(catKey);
      if (cat) {
        cat.channels.add(chanKey);
      }
    }
  };

  if (guild?.channels?.cache) {
    for (const c of guild.channels.cache.values()) {
      if (c.type === ChannelType.GuildCategory) {
        const key = normalizeText(c.name);
        if (key && !categoriesMap.has(key)) {
          categoriesMap.set(key, {
            canonicalName: c.name,
            channels: new Set(),
            mutated: false,
          });
        }
      }
    }
    for (const c of guild.channels.cache.values()) {
      if (isManagedChannelType(c.type)) {
        const parentKey = c.parent ? normalizeText(c.parent.name) : '__root__';
        if (c.parent && !categoriesMap.has(parentKey)) {
          categoriesMap.set(parentKey, {
            canonicalName: c.parent.name,
            channels: new Set(),
            mutated: false,
          });
        }
        registerChannel(c.name, parentKey);
      }
    }
  }

  for (const step of workingSteps) {
    if (step.tool === 'create_category') {
      const rawName = String(step.args?.name || '').trim();
      const key = normalizeText(rawName);
      if (key && !categoriesMap.has(key)) {
        categoriesMap.set(key, {
          canonicalName: rawName,
          channels: new Set(),
          mutated: false,
        });
      }
    }
  }

  const findCategoryKeyByArg = (catArg) => {
    const norm = normalizeText(catArg);
    if (!norm) return null;
    if (categoriesMap.has(norm)) return norm;
    for (const key of categoriesMap.keys()) {
      if (key.includes(norm)) return key;
    }
    return null;
  };

  for (const step of workingSteps) {
    if (step.tool === 'create_channel') {
      const chanName = String(step.args?.name || '').trim();
      const catArg = String(step.args?.category || '').trim();
      const catKey = catArg ? findCategoryKeyByArg(catArg) || normalizeText(catArg) : '__root__';
      if (catArg && !categoriesMap.has(catKey)) {
        categoriesMap.set(catKey, {
          canonicalName: catArg,
          channels: new Set(),
          mutated: false,
        });
      }
      registerChannel(chanName, catKey);
    }
  }

  const resolveChannelOwner = (rawChannel) => {
    const rawStr = String(rawChannel || '').trim();
    const clean = rawStr.replace(/^#/, '');
    if (!clean) return null;
    const keys = [normalizeText(clean), sanitizeChannelName(clean)];
    const hits = new Set();
    for (const k of keys) {
      if (!k) continue;
      const set = aliasToRecordIndices.get(k);
      if (set) {
        for (const idx of set) hits.add(idx);
      }
    }
    if (hits.size !== 1) return null;
    const rec = channelRecords[[...hits][0]];
    if (!rec || !rec.catKey || rec.catKey === '__root__') return null;
    return rec;
  };

  for (const step of workingSteps) {
    if (step.tool === 'modify_channel') {
      const owner = resolveChannelOwner(step.args?.channel);
      if (owner && categoriesMap.has(owner.catKey)) {
        categoriesMap.get(owner.catKey).mutated = true;
      }
      if (step.args?.category) {
        const destCatKey = findCategoryKeyByArg(step.args.category);
        if (destCatKey && categoriesMap.has(destCatKey)) {
          categoriesMap.get(destCatKey).mutated = true;
        }
      }
    } else if (step.tool === 'delete_channel' || step.tool === 'archive_channel') {
      const owner = resolveChannelOwner(step.args?.channel);
      if (owner && categoriesMap.has(owner.catKey)) {
        categoriesMap.get(owner.catKey).mutated = true;
      }
    }
  }

  // Passe 1 : fusionner les set_channel_permissions identiques couvrant tous les salons d'une categorie (>= 2 salons)
  const groups = new Map();
  for (let i = 0; i < workingSteps.length; i += 1) {
    const step = workingSteps[i];
    if (step.tool !== 'set_channel_permissions') continue;
    if (step.args.target_type === 'category') continue;

    const owner = resolveChannelOwner(step.args.channel);
    if (!owner) continue;

    const cat = categoriesMap.get(owner.catKey);
    if (!cat || cat.mutated || cat.channels.size < 2) continue;

    const roleKey = normalizeRoleKey(step.args.role);
    if (!roleKey) continue;

    const permInfo = getPermissionSignature(step.args);
    if (!permInfo) continue;

    const groupKey = owner.catKey + '\0' + roleKey + '\0' + permInfo.sig;
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        catKey: owner.catKey,
        roleKey,
        permInfo,
        indices: [],
        coveredChans: new Set(),
      };
      groups.set(groupKey, group);
    }
    group.indices.push(i);
    group.coveredChans.add(owner.chanKey);
  }

  const replacements = new Map();
  const removals = new Set();

  for (const group of groups.values()) {
    const cat = categoriesMap.get(group.catKey);
    if (!cat || group.coveredChans.size !== cat.channels.size) continue;

    const firstIdx = group.indices[0];
    const lastIdx = group.indices[group.indices.length - 1];
    let hasInterveningConflict = false;

    for (let k = firstIdx; k <= lastIdx; k += 1) {
      const kStep = workingSteps[k];
      if (kStep.tool !== 'set_channel_permissions') continue;
      if (normalizeRoleKey(kStep.args.role) !== group.roleKey) continue;

      const kPerm = getPermissionSignature(kStep.args);
      if (kPerm && kPerm.sig === group.permInfo.sig) continue;

      const touchesSameCategoryDirectly =
        kStep.args.target_type === 'category' &&
        findCategoryKeyByArg(kStep.args.channel) === group.catKey;
      const kOwner = resolveChannelOwner(kStep.args.channel);
      const touchesChildOfSameCategory = Boolean(kOwner && kOwner.catKey === group.catKey);

      if (touchesSameCategoryDirectly || touchesChildOfSameCategory) {
        hasInterveningConflict = true;
        break;
      }
    }

    if (hasInterveningConflict) continue;

    const firstArgs = workingSteps[firstIdx].args;
    const mergedArgs = {
      channel: cat.canonicalName,
      target_type: 'category',
      role: firstArgs.role,
    };
    const allowList = [...new Set(parsePermissionFlags(firstArgs.allow))];
    const denyList = [...new Set(parsePermissionFlags(firstArgs.deny))];
    const resetList = [...new Set(parsePermissionFlags(firstArgs.reset))];
    if (allowList.length > 0) mergedArgs.allow = allowList;
    if (denyList.length > 0) mergedArgs.deny = denyList;
    if (resetList.length > 0) mergedArgs.reset = resetList;

    replacements.set(firstIdx, {
      tool: 'set_channel_permissions',
      args: mergedArgs,
    });
    for (let m = 1; m < group.indices.length; m += 1) {
      removals.add(group.indices[m]);
    }
  }

  const afterPass1 = [];
  for (let i = 0; i < workingSteps.length; i += 1) {
    if (removals.has(i)) continue;
    afterPass1.push(replacements.has(i) ? replacements.get(i) : workingSteps[i]);
  }

  // Passe 2 : supprimer les etapes enfants redondantes identiques apres une etape categorie synchronisee
  const activeCatSync = new Map();
  const chanRoleBlocked = new Set();
  const afterPass2 = [];

  for (const step of afterPass1) {
    if (step.tool === 'modify_channel') {
      const owner = resolveChannelOwner(step.args?.channel);
      if (owner) {
        for (const blocked of [...chanRoleBlocked]) {
          if (blocked.startsWith(owner.catKey + '::' + owner.chanKey + '\0')) {
            chanRoleBlocked.delete(blocked);
          }
        }
        for (const activeKey of [...activeCatSync.keys()]) {
          if (activeKey.startsWith(owner.catKey + '\0')) {
            activeCatSync.delete(activeKey);
          }
        }
      }
      afterPass2.push(step);
      continue;
    }

    if (step.tool !== 'set_channel_permissions') {
      afterPass2.push(step);
      continue;
    }

    const roleKey = normalizeRoleKey(step.args.role);
    const permInfo = getPermissionSignature(step.args);
    if (!roleKey || !permInfo) {
      afterPass2.push(step);
      continue;
    }

    const owner =
      step.args.target_type === 'category' ? null : resolveChannelOwner(step.args.channel);
    const directCatKey =
      step.args.target_type === 'category' || (!owner && step.args.target_type !== 'channel')
        ? findCategoryKeyByArg(step.args.channel)
        : null;

    if (directCatKey) {
      if (step.args.sync_children !== false) {
        activeCatSync.set(directCatKey + '\0' + roleKey, permInfo.sig);
        for (const blocked of [...chanRoleBlocked]) {
          if (blocked.startsWith(directCatKey + '::') && blocked.endsWith('\0' + roleKey)) {
            chanRoleBlocked.delete(blocked);
          }
        }
      }
      afterPass2.push(step);
      continue;
    }

    if (owner) {
      const catSyncSig = activeCatSync.get(owner.catKey + '\0' + roleKey);
      const blockKey = owner.catKey + '::' + owner.chanKey + '\0' + roleKey;
      if (catSyncSig && !chanRoleBlocked.has(blockKey) && catSyncSig === permInfo.sig) {
        continue;
      }
      chanRoleBlocked.add(blockKey);
    }

    afterPass2.push(step);
  }

  return afterPass2;
}

function canMemberViewChannel(channel, member, guild) {
  if (!member) return true;
  if (
    isGuildOwner(guild, member) ||
    member.permissions?.has?.(PermissionsBitField.Flags.Administrator)
  ) {
    return true;
  }
  if (typeof channel?.permissionsFor === 'function') {
    const perms = channel.permissionsFor(member);
    if (perms && typeof perms.has === 'function') {
      return perms.has(PermissionsBitField.Flags.ViewChannel);
    }
  }
  return true;
}

function buildGuildContext(guild, member = null) {
  if (!guild || !guild.channels?.cache || !guild.roles?.cache) {
    return 'Serveur : inconnu';
  }

  const categories = guild.channels.cache
    .filter((c) => c.type === ChannelType.GuildCategory && canMemberViewChannel(c, member, guild))
    .map((c) => c.name)
    .slice(0, 15);

  const channels = guild.channels.cache
    .filter((c) => isManagedChannelType(c.type) && canMemberViewChannel(c, member, guild))
    .map((c) => {
      const t = getChannelTypeLabel(c.type);
      const cat = c.parent ? c.parent.name : 'racine';
      const opts = [];
      if (c.rateLimitPerUser > 0) opts.push('cooldown ' + c.rateLimitPerUser + 's');
      if (isSpoilerChannel(c)) opts.push('spoiler');
      if (c.nsfw) opts.push('NSFW');
      return (
        '#' +
        c.name +
        ' (' +
        t +
        ', ' +
        cat +
        (opts.length ? ', ' + opts.join(', ') : '') +
        ')'
      );
    })
    .slice(0, 30);

  const roles = guild.roles.cache
    .filter((r) => r.name !== '@everyone')
    .map((r) => r.name)
    .slice(0, 25);

  return (
    'Serveur : "' +
    guild.name +
    '"\n' +
    'Categories : ' +
    (categories.length ? categories.join(', ') : '(aucune)') +
    '\n' +
    'Salons : ' +
    (channels.length ? channels.join(', ') : '(aucun)') +
    '\n' +
    'Roles : ' +
    (roles.length ? roles.join(', ') : '(aucun)')
  );
}

function buildPlannerSystemPrompt(guildContext) {
  return (
    'Tu es CIVIS en MODE PLANIFICATEUR pour Discord.\n' +
    'Tu dois decomposer la demande de configuration serveur en une sequence ordonnee d etapes executable automatiquement.\n\n' +
    '## Etat actuel du serveur\n' +
    guildContext +
    '\n\n' +
    '## Outils disponibles\n' +
    getToolsPrompt(actionTools) +
    '\n\n' +
    '## Format de reponse (JSON uniquement, sans texte autour)\n' +
    '{"summary": "Resume court en francais", "steps": [{"tool": "nom_outil", "args": {...}}]}\n\n' +
    '## Regles d ordre et de securite\n' +
    '- Max ' + MAX_PLAN_STEPS + ' etapes.\n' +
    '- Respecte cet ordre de dependances : 1) roles, 2) categories, 3) permissions de categories, 4) salons (avec category si besoin), 5) permissions de salons specifiques.\n' +
    '- IMPORTANT : pour modifier les permissions de toute une categorie (ou d un espace entier contenant plusieurs salons), applique set_channel_permissions directement sur la CATEGORIE avec "target_type": "category" au lieu de repeter les permissions sur chaque salon.\n' +
    '- Reutilise les categories/roles deja existants s ils correspondent.\n' +
    '- Si la demande inclut la recherche de bots ou d applications Discord (App Directory), ajoute une etape search_app_directory.\n' +
    '- N invente aucun outil ni nom de permission Discord.\n\n' +
    '## Exemple\n' +
    'Demande : "Cree un espace Staff prive avec un role Moderateur vert, un salon #staff-chat et un vocal"\n' +
    'Reponse :\n' +
    '{"summary":"Creation de l espace Staff avec role Moderateur et salons prives","steps":[' +
    '{"tool":"create_role","args":{"name":"Moderateur","color":"vert","hoist":true}},' +
    '{"tool":"create_category","args":{"name":"Staff"}},' +
    '{"tool":"set_channel_permissions","args":{"channel":"Staff","target_type":"category","role":"@everyone","deny":["ViewChannel"]}},' +
    '{"tool":"set_channel_permissions","args":{"channel":"Staff","target_type":"category","role":"Moderateur","allow":["ViewChannel","SendMessages","Connect"]}},' +
    '{"tool":"create_channel","args":{"name":"staff-chat","type":"text","category":"Staff"}},' +
    '{"tool":"create_channel","args":{"name":"staff-vocal","type":"voice","category":"Staff"}}' +
    ']}'
  );
}

function tryParsePlan(text) {
  if (typeof text !== 'string') return null;

  const trimmed = text.trim();
  if (!trimmed) return null;

  const cleaned = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const objStart = cleaned.indexOf('{');
  const arrStart = cleaned.indexOf('[');
  let jsonStart = -1;
  let jsonEnd = -1;

  if (objStart !== -1 && (arrStart === -1 || objStart < arrStart)) {
    jsonStart = objStart;
    jsonEnd = cleaned.lastIndexOf('}');
  } else if (arrStart !== -1) {
    jsonStart = arrStart;
    jsonEnd = cleaned.lastIndexOf(']');
  }

  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) return null;

  let parsed;
  try {
    parsed = JSON.parse(cleaned.substring(jsonStart, jsonEnd + 1));
  } catch {
    return null;
  }

  let summary = '';
  let rawSteps = null;

  if (Array.isArray(parsed)) {
    rawSteps = parsed;
    summary = 'Configuration du serveur';
  } else if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.steps)) {
      rawSteps = parsed.steps;
      summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
    } else if (typeof parsed.tool === 'string' && parsed.tool.trim()) {
      rawSteps = [{ tool: parsed.tool, args: parsed.args }];
      summary = 'Action sur le serveur';
    }
  }

  if (!Array.isArray(rawSteps)) return null;

  const steps = [];
  for (const s of rawSteps) {
    if (!s || typeof s !== 'object' || typeof s.tool !== 'string' || !s.tool.trim()) {
      continue;
    }
    const args =
      s.args && typeof s.args === 'object' && !Array.isArray(s.args) ? s.args : {};
    steps.push({ tool: s.tool.trim(), args });
  }

  if (steps.length === 0) return null;

  return {
    summary: summary || 'Configuration du serveur',
    steps,
  };
}

function describePlanStep(step, context = {}) {
  const a = step.args || {};
  switch (step.tool) {
    case 'create_category':
      return 'Creer la categorie "' + (a.name || '?') + '"';
    case 'create_channel': {
      const typeRes = resolveChannelTypeInput(a.type);
      const typeLabel = typeRes.ok ? typeRes.label : String(a.type || 'texte');
      const meta = [typeLabel];
      const cat = a.category || a.category_hint || '';
      if (cat) meta.push('cat: ' + cat);
      const cooldown = parseCooldownArg(a);
      if (cooldown > 0) meta.push('cooldown ' + cooldown + 's');
      if (parseOptionalBoolean(a.spoiler) === true) meta.push('salon de spoiler');
      if (parseOptionalBoolean(a.nsfw) === true) meta.push('NSFW');
      const topic = a.topic !== undefined ? String(a.topic).trim() : '';
      if (topic) {
        meta.push(
          'sujet: "' + (topic.length > 40 ? topic.slice(0, 37) + '...' : topic) + '"'
        );
      }
      return (
        'Creer le salon #' +
        String(a.name || '?').replace(/^#/, '') +
        ' (' +
        meta.join(', ') +
        ')'
      );
    }
    case 'create_role': {
      const meta = [];
      if (a.color) meta.push('couleur ' + a.color);
      if (parseOptionalBoolean(a.hoist) === true) meta.push('affiche separement');
      if (parseOptionalBoolean(a.mentionable) === true) meta.push('mentionnable');
      return (
        'Creer le role "' +
        (a.name || '?') +
        '"' +
        (meta.length ? ' (' + meta.join(', ') + ')' : '')
      );
    }
    case 'modify_channel': {
      const changes = [];
      if (a.new_name) changes.push('-> #' + String(a.new_name).replace(/^#/, ''));
      if (a.type !== undefined && String(a.type).trim() !== '') {
        const typeRes = resolveChannelTypeInput(a.type);
        changes.push('type: ' + (typeRes.ok ? typeRes.label : a.type));
      }
      if (a.category) changes.push('cat: ' + a.category);
      const cooldown = parseCooldownArg(a);
      if (cooldown !== undefined) {
        changes.push(cooldown === 0 ? 'cooldown desactive' : 'cooldown ' + cooldown + 's');
      }
      const spoiler = parseOptionalBoolean(a.spoiler);
      if (spoiler !== undefined) {
        changes.push('salon de spoiler: ' + (spoiler ? 'active' : 'desactive'));
      }
      const nsfw = parseOptionalBoolean(a.nsfw);
      if (nsfw !== undefined) {
        changes.push('NSFW: ' + (nsfw ? 'active' : 'desactive'));
      }
      if (a.topic !== undefined) {
        const t = String(a.topic).trim();
        changes.push(
          t
            ? 'sujet: "' + (t.length > 40 ? t.slice(0, 37) + '...' : t) + '"'
            : 'sujet: (vide)'
        );
      }
      return (
        'Modifier #' +
        String(a.channel || '?').replace(/^#/, '') +
        (changes.length ? ' (' + changes.join(', ') + ')' : '')
      );
    }
    case 'modify_role_display': {
      const changes = [];
      if (a.new_name) changes.push('-> ' + a.new_name);
      if (a.color) changes.push('couleur ' + a.color);
      const hoist = parseOptionalBoolean(a.hoist);
      if (hoist !== undefined) changes.push('affiche separement: ' + (hoist ? 'oui' : 'non'));
      const mentionable = parseOptionalBoolean(a.mentionable);
      if (mentionable !== undefined) {
        changes.push('mentionnable: ' + (mentionable ? 'oui' : 'non'));
      }
      return (
        'Modifier le role "' +
        (a.role || '?') +
        '"' +
        (changes.length ? ' (' + changes.join(', ') + ')' : '')
      );
    }
    case 'modify_role_perm': {
      const parts = [];
      if (Array.isArray(a.add) && a.add.length) parts.push('+' + a.add.join(',+'));
      if (Array.isArray(a.remove) && a.remove.length) parts.push('-' + a.remove.join(',-'));
      return 'Permissions role "' + (a.role || '?') + '" (' + (parts.join(' ') || '?') + ')';
    }
    case 'set_channel_permissions': {
      const parts = [];
      if (Array.isArray(a.allow) && a.allow.length) parts.push('+' + a.allow.join(',+'));
      if (Array.isArray(a.deny) && a.deny.length) parts.push('-' + a.deny.join(',-'));
      if (Array.isArray(a.reset) && a.reset.length) parts.push('~' + a.reset.join(',~'));
      const rawTarget = a.channel || a.category || '?';
      const targetName = String(rawTarget).replace(/^#/, '');
      const isCategory =
        a.target_type === 'category' ||
        (!a.channel && Boolean(a.category)) ||
        Boolean(context.isCategory);
      if (isCategory) {
        return (
          'Permissions categorie "' +
          targetName +
          '" pour ' +
          (a.role || '?') +
          ' (' +
          (parts.join(' ') || '?') +
          ')' +
          (a.sync_children === false ? ' [categorie seule]' : '')
        );
      }
      return (
        'Permissions #' +
        targetName +
        ' pour ' +
        (a.role || '?') +
        ' (' +
        (parts.join(' ') || '?') +
        ')'
      );
    }
    case 'delete_channel':
      return 'Supprimer le salon #' + String(a.channel || '?').replace(/^#/, '');
    case 'delete_role':
      return 'Supprimer le role "' + (a.role || '?') + '"';
    case 'archive_channel':
      return 'Archiver le salon #' + String(a.channel || '?').replace(/^#/, '');
    case 'archive_role':
      return 'Archiver le role "' + (a.role || '?') + '"';
    case 'search_app_directory': {
      const meta = [];
      if (a.category) meta.push('categorie: ' + a.category);
      if (a.limit) meta.push('max ' + a.limit);
      return (
        'Rechercher dans l App Directory Discord : "' +
        (a.query || '?') +
        '"' +
        (meta.length ? ' (' + meta.join(', ') + ')' : '')
      );
    }
    default:
      return step.tool;
  }
}

function validateAndAnalyzePlan(plan, guild, member) {
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
    return {
      ok: false,
      error: 'Le plan genere ne contient aucune etape valide.',
    };
  }

  if (plan.steps.length > MAX_RAW_PLAN_STEPS) {
    return {
      ok: false,
      error:
        'Le plan brut depasse la limite maximale autorisee de ' +
        MAX_RAW_PLAN_STEPS +
        ' etapes (' +
        plan.steps.length +
        ').',
    };
  }

  const consolidatedSteps = consolidateCategoryPermissions(plan.steps, guild);

  if (consolidatedSteps.length > MAX_PLAN_STEPS) {
    return {
      ok: false,
      error:
        'Le plan depasse la limite autorisee de ' +
        MAX_PLAN_STEPS +
        ' etapes (' +
        consolidatedSteps.length +
        ').',
    };
  }

  const existingCatNames = new Set();
  const existingChanNames = new Set();
  if (guild?.channels?.cache) {
    for (const c of guild.channels.cache.values()) {
      const norm = normalizeText(c.name);
      const san = sanitizeChannelName(c.name);
      if (c.type === ChannelType.GuildCategory) {
        if (norm) existingCatNames.add(norm);
        if (san) existingCatNames.add(san);
      } else if (isManagedChannelType(c.type)) {
        if (norm) existingChanNames.add(norm);
        if (san) existingChanNames.add(san);
      }
    }
  }

  const plannedCatNames = new Set();
  const plannedChanNames = new Set();
  for (const s of consolidatedSteps) {
    if (s.tool === 'create_category' && s.args?.name) {
      const norm = normalizeText(s.args.name);
      const san = sanitizeChannelName(s.args.name);
      if (norm) plannedCatNames.add(norm);
      if (san) plannedCatNames.add(san);
    } else if (s.tool === 'create_channel' && s.args?.name) {
      const norm = normalizeText(s.args.name);
      const san = sanitizeChannelName(s.args.name);
      if (norm) plannedChanNames.add(norm);
      if (san) plannedChanNames.add(san);
    }
  }

  const requiredPermsSet = new Set();
  const requestedPermFlagsSet = new Set();
  const managedRestrictedRolesMap = new Map();
  const overwriteTargetRolesMap = new Map();
  const plannedNewRoles = new Set();
  const validatedSteps = [];
  let hasDestructive = false;

  for (let i = 0; i < consolidatedSteps.length; i += 1) {
    const step = consolidatedSteps[i];
    const toolDef = actionTools.find((t) => t.name === step.tool);
    if (!toolDef) {
      return {
        ok: false,
        error: 'Outil inconnu ou non autorise dans le plan : ' + step.tool,
      };
    }

    const args = step.args || {};

    if (
      ['create_category', 'create_channel', 'create_role'].includes(step.tool) &&
      !String(args.name || '').trim()
    ) {
      return {
        ok: false,
        error: 'Etape ' + (i + 1) + ' (' + step.tool + ') : parametre "name" manquant.',
      };
    }

    if (
      ['modify_channel', 'delete_channel', 'archive_channel'].includes(step.tool) &&
      !String(args.channel || '').trim()
    ) {
      return {
        ok: false,
        error: 'Etape ' + (i + 1) + ' (' + step.tool + ') : parametre "channel" manquant.',
      };
    }

    if (
      ['modify_role_display', 'modify_role_perm', 'delete_role', 'archive_role'].includes(
        step.tool
      ) &&
      !String(args.role || '').trim()
    ) {
      return {
        ok: false,
        error: 'Etape ' + (i + 1) + ' (' + step.tool + ') : parametre "role" manquant.',
      };
    }

    if (step.tool === 'search_app_directory') {
      if (!String(args.query || '').trim()) {
        return {
          ok: false,
          error:
            'Etape ' +
            (i + 1) +
            ' (search_app_directory) : parametre "query" manquant.',
        };
      }
      args.query = String(args.query).trim();
      if (args.limit !== undefined) {
        const parsedLimit = Number.parseInt(args.limit, 10);
        if (Number.isFinite(parsedLimit)) {
          args.limit = Math.max(1, Math.min(10, parsedLimit));
        } else {
          delete args.limit;
        }
      }
    }

    if (step.tool === 'create_channel') {
      const typeRes = resolveChannelTypeInput(args.type);
      if (!typeRes.ok) {
        return {
          ok: false,
          error: 'Etape ' + (i + 1) + ' (create_channel) : ' + typeRes.error,
        };
      }
      if (args.type !== undefined) {
        args.type = typeRes.key;
      }
      const cooldown = parseCooldownArg(args);
      if (args.slowmode === undefined && cooldown !== undefined) {
        args.slowmode = cooldown;
      }
      const spoilerVal = parseOptionalBoolean(args.spoiler);
      if (spoilerVal !== undefined) args.spoiler = spoilerVal;
      const nsfwVal = parseOptionalBoolean(args.nsfw);
      if (nsfwVal !== undefined) args.nsfw = nsfwVal;
    }

    if (step.tool === 'modify_channel') {
      const cooldown = parseCooldownArg(args);
      if (args.slowmode === undefined && cooldown !== undefined) {
        args.slowmode = cooldown;
      }
      const spoilerVal = parseOptionalBoolean(args.spoiler);
      if (spoilerVal !== undefined) args.spoiler = spoilerVal;
      const nsfwVal = parseOptionalBoolean(args.nsfw);
      if (nsfwVal !== undefined) args.nsfw = nsfwVal;

      if (args.type !== undefined && String(args.type).trim() !== '') {
        const typeRes = resolveChannelTypeInput(args.type);
        if (!typeRes.ok) {
          return {
            ok: false,
            error: 'Etape ' + (i + 1) + ' (modify_channel) : ' + typeRes.error,
          };
        }
        if (
          typeRes.type !== ChannelType.GuildText &&
          typeRes.type !== ChannelType.GuildAnnouncement
        ) {
          return {
            ok: false,
            error:
              'Etape ' +
              (i + 1) +
              ' (modify_channel) : Discord permet uniquement de convertir le type entre texte et annonce.',
          };
        }
        args.type = typeRes.key;
      }

      const hasAnyChange =
        Boolean(args.new_name && String(args.new_name).trim()) ||
        Boolean(args.type !== undefined && String(args.type).trim() !== '') ||
        Boolean(args.category !== undefined && String(args.category).trim() !== '') ||
        cooldown !== undefined ||
        spoilerVal !== undefined ||
        nsfwVal !== undefined ||
        args.topic !== undefined;

      if (!hasAnyChange) {
        return {
          ok: false,
          error: 'Etape ' + (i + 1) + ' (modify_channel) : aucune modification specifiee.',
        };
      }
    }

    if (step.tool === 'create_role') {
      const hoistVal = parseOptionalBoolean(args.hoist);
      if (hoistVal !== undefined) args.hoist = hoistVal;
      const mentionVal = parseOptionalBoolean(args.mentionable);
      if (mentionVal !== undefined) args.mentionable = mentionVal;
    }

    if (step.tool === 'modify_role_display') {
      const hoistVal = parseOptionalBoolean(args.hoist);
      if (hoistVal !== undefined) args.hoist = hoistVal;
      const mentionVal = parseOptionalBoolean(args.mentionable);
      if (mentionVal !== undefined) args.mentionable = mentionVal;

      const hasAnyRoleChange =
        Boolean(args.new_name && String(args.new_name).trim()) ||
        Boolean(args.color && String(args.color).trim()) ||
        hoistVal !== undefined ||
        mentionVal !== undefined;

      if (!hasAnyRoleChange) {
        return {
          ok: false,
          error:
            'Etape ' + (i + 1) + ' (modify_role_display) : aucune modification specifiee.',
        };
      }
    }

    if (step.tool === 'set_channel_permissions') {
      if (!String(args.channel || '').trim() || !String(args.role || '').trim()) {
        return {
          ok: false,
          error:
            'Etape ' +
            (i + 1) +
            ' (set_channel_permissions) : parametres "channel" et "role" requis.',
        };
      }
      const allow = parsePermissionFlags(args.allow);
      const deny = parsePermissionFlags(args.deny);
      const reset = parsePermissionFlags(args.reset);
      if (allow.length === 0 && deny.length === 0 && reset.length === 0) {
        return {
          ok: false,
          error:
            'Etape ' +
            (i + 1) +
            ' (set_channel_permissions) : aucune permission valide fournie.',
        };
      }
      for (const f of [...allow, ...deny, ...reset]) {
        requestedPermFlagsSet.add(f);
      }

      if (!args.target_type) {
        const rawTarget = String(args.channel).trim();
        if (!rawTarget.startsWith('#')) {
          const norm = normalizeText(rawTarget);
          const san = sanitizeChannelName(rawTarget);
          const matchesCat =
            existingCatNames.has(norm) ||
            (san && existingCatNames.has(san)) ||
            plannedCatNames.has(norm) ||
            (san && plannedCatNames.has(san));
          const matchesChan =
            existingChanNames.has(norm) ||
            (san && existingChanNames.has(san)) ||
            plannedChanNames.has(norm) ||
            (san && plannedChanNames.has(san));
          if (matchesCat && !matchesChan) {
            args.target_type = 'category';
          }
        }
      }
    }

    if (step.tool === 'modify_role_perm') {
      const add = parsePermissionFlags(args.add);
      const remove = parsePermissionFlags(args.remove);
      if (add.length === 0 && remove.length === 0) {
        return {
          ok: false,
          error:
            'Etape ' +
            (i + 1) +
            ' (modify_role_perm) : aucune permission valide fournie.',
        };
      }
      for (const f of [...add, ...remove]) {
        requestedPermFlagsSet.add(f);
      }
    }

    if (step.tool === 'create_role') {
      plannedNewRoles.add(normalizeText(args.name));
    }

    const isManagedRestrictedRoleStep = [
      'modify_role_display',
      'modify_role_perm',
      'delete_role',
      'archive_role',
    ].includes(step.tool);
    if (isManagedRestrictedRoleStep || step.tool === 'set_channel_permissions') {
      const rawRoleName = String(args.role || '').trim();
      const normRole = normalizeText(rawRoleName);
      if (
        normRole &&
        normRole !== '@everyone' &&
        normRole !== 'everyone' &&
        !plannedNewRoles.has(normRole) &&
        guild?.roles?.cache
      ) {
        const existingRole = guild.roles.cache.find(
          (r) =>
            r.name.toLowerCase() === rawRoleName.toLowerCase() ||
            normalizeText(r.name) === normRole
        );
        if (existingRole) {
          if (isManagedRestrictedRoleStep) {
            managedRestrictedRolesMap.set(existingRole.id, existingRole);
          } else {
            overwriteTargetRolesMap.set(existingRole.id, existingRole);
          }
        }
      }
    }

    if (step.tool === 'delete_channel' || step.tool === 'delete_role') {
      hasDestructive = true;
    }

    for (const p of normalizeRequiredPerms(
      toolDef.requiredPermission,
      toolDef.requiredPermissions
    )) {
      requiredPermsSet.add(p);
    }

    const isCategoryTarget =
      step.tool === 'set_channel_permissions' && args.target_type === 'category';
    validatedSteps.push({
      tool: step.tool,
      args,
      label: describePlanStep(step, { isCategory: isCategoryTarget }),
    });
  }

  const requiredPermissions = [...requiredPermsSet];
  const requestedPermFlags = [...requestedPermFlagsSet];
  const managedRestrictedRoles = [...managedRestrictedRolesMap.values()];
  const overwriteTargetRoles = [...overwriteTargetRolesMap.values()];
  const allTargetRolesMap = new Map([
    ...managedRestrictedRolesMap.entries(),
    ...overwriteTargetRolesMap.entries(),
  ]);
  const allTargetRoles = [...allTargetRolesMap.values()];

  const botCheck = checkBotPermissions({
    guild,
    requiredPermissions,
    targetRoles: managedRestrictedRoles,
    requestedPermFlags,
  });
  if (!botCheck.ok) {
    return { ok: false, error: botCheck.error };
  }

  if (overwriteTargetRoles.length > 0) {
    const overwriteBotCheck = checkBotPermissions({
      guild,
      requiredPermissions: [],
      targetRoles: overwriteTargetRoles,
      allowManagedRoles: true,
    });
    if (!overwriteBotCheck.ok) {
      return { ok: false, error: overwriteBotCheck.error };
    }
  }

  const memberCheck = checkMemberAuthorization({
    guild,
    member,
    requiredPermissions,
    targetRoles: allTargetRoles,
    requestedPermFlags,
  });

  return {
    ok: true,
    plan: {
      summary: plan.summary || 'Configuration du serveur',
      steps: validatedSteps,
    },
    security: {
      requiredPermissions,
      requiredPermissionsLabel: requiredPermissions.map(getPermissionLabel).join(', '),
      requestedPermFlags,
      targetRoleIds: allTargetRoles.map((r) => r.id),
      hasDestructive,
      requesterAuthorized: memberCheck.authorized,
      reason: memberCheck.authorized ? null : memberCheck.reason,
    },
  };
}

function checkPlanMemberAuthorization(guild, member, security) {
  const targetRoles = (security.targetRoleIds || [])
    .map((id) => guild?.roles?.cache?.get(id))
    .filter(Boolean);

  return checkMemberAuthorization({
    guild,
    member,
    requiredPermissions: security.requiredPermissions,
    targetRoles,
    requestedPermFlags: security.requestedPermFlags,
  });
}

async function runPlannerLLMAndValidate({
  messages,
  guild,
  member,
  authorId,
  chatFn,
  userConfig,
}) {
  const callLLM = chatFn || chat;
  const resolvedUserConfig = resolveEffectiveUserConfig(authorId, userConfig);
  const useExternalMaxTokens = Boolean(resolvedUserConfig && !resolvedUserConfig.decryptFailed);

  const maxTokens = useExternalMaxTokens ? 2048 : 768;

  const first = await callLLM(messages, {
    maxTokens,
    temperature: 0.1,
    userConfig: resolvedUserConfig,
    localRole: 'agent',
  });

  let totalElapsedMs = first.stats?.elapsedMs || 0;
  let lastStats = first.stats || {};
  let parsed = tryParsePlan(first.content);

  if (!parsed) {
    const retryMessages = messages.concat([
      { role: 'assistant', content: first.content },
      {
        role: 'user',
        content:
          'Reponds UNIQUEMENT par un objet JSON valide {"summary": "...", "steps": [{"tool": "...", "args": {...}}]} sans texte autour.',
      },
    ]);
    const retry = await callLLM(retryMessages, {
      maxTokens,
      temperature: 0,
      userConfig: resolvedUserConfig,
      localRole: 'agent',
    });
    totalElapsedMs += retry.stats?.elapsedMs || 0;
    lastStats = mergeFollowupStats(lastStats, retry.stats, totalElapsedMs);
    parsed = tryParsePlan(retry.content);
  }

  if (!parsed) {
    return {
      ok: false,
      error: 'Impossible de generer un plan d action valide pour cette demande.',
      stats: { ...lastStats, elapsedMs: totalElapsedMs },
    };
  }

  const analyzed = validateAndAnalyzePlan(parsed, guild, member);
  if (!analyzed.ok) {
    return {
      ok: false,
      error: analyzed.error,
      stats: { ...lastStats, elapsedMs: totalElapsedMs },
    };
  }

  return {
    ok: true,
    plan: analyzed.plan,
    security: analyzed.security,
    stats: { ...lastStats, elapsedMs: totalElapsedMs },
  };
}

async function buildValidatedPlan({
  userText,
  guild,
  member,
  authorId,
  channelId,
  chatFn,
  userConfig,
}) {
  const effectiveAuthorId = authorId || member?.id || member?.user?.id || null;
  const guildContext = buildGuildContext(guild, member);
  const systemPrompt = buildPlannerSystemPrompt(guildContext);
  const chatContext = memory.formatActionContextBlock(channelId, effectiveAuthorId, {
    maxMessages: 10,
  });
  const userContent = chatContext
    ? `${chatContext}\n\nDemande actuelle a planifier :\n${userText}`
    : userText;
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];

  return runPlannerLLMAndValidate({
    messages,
    guild,
    member,
    authorId,
    chatFn,
    userConfig,
  });
}

async function reviseValidatedPlan({
  originalUserText,
  currentPlan,
  modificationRequest,
  guild,
  member,
  authorId,
  chatFn,
  userConfig,
}) {
  const cleanModification = String(modificationRequest || '').trim();
  if (!cleanModification) {
    return {
      ok: false,
      error: 'Aucune instruction de modification fournie.',
      stats: {},
    };
  }

  if (!currentPlan || !Array.isArray(currentPlan.steps) || currentPlan.steps.length === 0) {
    return {
      ok: false,
      error: 'Aucun plan courant a modifier.',
      stats: {},
    };
  }

  const guildContext = buildGuildContext(guild, member);
  const systemPrompt = buildPlannerSystemPrompt(guildContext);
  const serializedCurrentPlan = JSON.stringify({
    summary: currentPlan.summary || 'Configuration du serveur',
    steps: currentPlan.steps.map((s) => ({
      tool: s.tool,
      args: s.args && typeof s.args === 'object' ? s.args : {},
    })),
  });

  const messages = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content:
        String(originalUserText || '').trim() ||
        currentPlan.summary ||
        'Configuration du serveur',
    },
    { role: 'assistant', content: serializedCurrentPlan },
    {
      role: 'user',
      content:
        'Modifie ce plan selon les instructions suivantes : ' +
        cleanModification +
        '\nConserve les etapes non concernees par la modification, applique uniquement les changements demandes (ajouts, suppressions ou ajustements), et renvoie le plan COMPLET mis a jour uniquement en JSON valide {"summary": "...", "steps": [{"tool": "...", "args": {...}}]}.',
    },
  ];

  return runPlannerLLMAndValidate({
    messages,
    guild,
    member,
    authorId,
    chatFn,
    userConfig,
  });
}

function buildProactivePlannerSystemPrompt(guildContext) {
  const proactiveTools = actionTools.filter(
    (t) =>
      t.name !== 'delete_channel' &&
      t.name !== 'delete_role' &&
      t.name !== 'search_app_directory'
  );

  return (
    'Tu es CIVIS en MODE ARCHITECTE PROACTIF pour Discord.\n' +
    'Un utilisateur vient d effectuer une modification manuelle sur le serveur (detectee via les Audit Logs Discord).\n' +
    'Propose un plan d actions complementaires utiles pour completer l organisation du serveur.\n\n' +
    '## Etat actuel du serveur\n' +
    guildContext +
    '\n\n' +
    '## Outils disponibles\n' +
    getToolsPrompt(proactiveTools) +
    '\n\n' +
    '## Format de reponse (JSON uniquement, sans texte autour)\n' +
    '- Quand une suite logique existe (creation de role, categorie, salon, permissions) :\n' +
    '  {"suggest": true, "summary": "Resume court en francais", "rationale": "Pourquoi ce plan complete l action manuelle", "steps": [{"tool": "...", "args": {...}}]}\n' +
    '- Uniquement si la modification est mineure (simple renommage ou ajustement isole sans suite) :\n' +
    '  {"suggest": false, "reason": "Raison courte en francais"}\n\n' +
    '## Regles strictes\n' +
    '- Ne repete JAMAIS l action deja faite : ne recree PAS le role, la categorie ou le salon que l utilisateur vient de creer. Propose uniquement les etapes SUIVANTES.\n' +
    '- Exemples de suites utiles :\n' +
    '  * Nouveau role cree -> modifier son apparence (hoist/couleur) ou creer une categorie/salon dedie + permissions de categorie (`target_type: "category"`).\n' +
    '  * Nouvelle categorie creee -> salons de depart (texte, vocal, annonces) + permissions sur la categorie.\n' +
    '  * Nouveau salon cree -> definir sujet (`topic`) / cooldown (`modify_channel`), permissions (`set_channel_permissions`) ou salon vocal/annonce complementaire.\n' +
    '  * Permissions modifiees -> completer pour les autres roles ou synchroniser sur la categorie (`target_type: "category"`).\n' +
    '- Reste cible et concis : 1 a 5 etapes (jamais plus de ' +
    MAX_PLAN_STEPS +
    ' etapes).\n' +
    '- Privilegie les actions constructives et d organisation ; ne propose pas de suppression definitive de salon ou role.\n' +
    '- N invente aucun outil ni nom de permission Discord.\n\n' +
    '## Exemple\n' +
    'Modification : Creation de role : role "VIP"\n' +
    'Reponse :\n' +
    '{"suggest":true,"summary":"Amenager un espace dedie au role VIP","rationale":"Offrir une categorie privee configuree pour les membres VIP","steps":[{"tool":"create_category","args":{"name":"Espace VIP"}},{"tool":"set_channel_permissions","args":{"channel":"Espace VIP","target_type":"category","role":"@everyone","deny":["ViewChannel"]}},{"tool":"set_channel_permissions","args":{"channel":"Espace VIP","target_type":"category","role":"VIP","allow":["ViewChannel","SendMessages"]}},{"tool":"create_channel","args":{"name":"vip-lounge","type":"text","category":"Espace VIP"}}]}'
  );
}

function tryParseProactiveResponse(text) {
  if (typeof text !== 'string') return null;

  const trimmed = text.trim();
  if (!trimmed) return null;

  const cleaned = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const objStart = cleaned.indexOf('{');
  const objEnd = cleaned.lastIndexOf('}');

  if (objStart !== -1 && objEnd > objStart) {
    try {
      const parsed = JSON.parse(cleaned.substring(objStart, objEnd + 1));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        if (parsed.suggest === false) {
          return {
            suggest: false,
            reason:
              String(parsed.reason || '').trim() ||
              'Aucune action complementaire necessaire.',
          };
        }

        if (Array.isArray(parsed.steps)) {
          if (parsed.steps.length === 0) {
            return {
              suggest: false,
              reason: String(parsed.reason || 'Plan vide.').trim(),
            };
          }
          const normalizedSteps = parsed.steps
            .filter((s) => s && typeof s.tool === 'string' && s.tool.trim())
            .map((s) => ({
              tool: s.tool.trim(),
              args: s.args && typeof s.args === 'object' && !Array.isArray(s.args) ? s.args : {},
            }));
          if (normalizedSteps.length === 0) {
            return null;
          }
          return {
            suggest: true,
            summary: String(parsed.summary || '').trim() || 'Plan complementaire propose',
            rationale: String(parsed.rationale || '').trim() || null,
            steps: normalizedSteps,
          };
        }
      }
    } catch {
      // Fall through to generic tryParsePlan fallback
    }
  }

  const fallbackPlan = tryParsePlan(text);
  if (fallbackPlan && Array.isArray(fallbackPlan.steps) && fallbackPlan.steps.length > 0) {
    return {
      suggest: true,
      summary: String(fallbackPlan.summary || '').trim() || 'Plan complementaire propose',
      rationale: null,
      steps: fallbackPlan.steps,
    };
  }

  return null;
}

async function buildProactivePlanFromAudit({
  auditSummary,
  actorName,
  guild,
  member,
  authorId,
  chatFn,
  userConfig,
}) {
  const callLLM = chatFn || chat;
  const resolvedUserConfig = resolveEffectiveUserConfig(authorId, userConfig);
  const useExternalMaxTokens = Boolean(resolvedUserConfig && !resolvedUserConfig.decryptFailed);
  const maxTokens = useExternalMaxTokens ? 1536 : 768;

  const guildContext = buildGuildContext(guild, member);
  const systemPrompt = buildProactivePlannerSystemPrompt(guildContext);
  const userContent =
    (actorName ? 'Auteur de la modification manuelle : ' + actorName + '\n' : '') +
    String(auditSummary || '').trim().slice(0, 1500);

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];

  const first = await callLLM(messages, {
    maxTokens,
    temperature: 0.15,
    userConfig: resolvedUserConfig,
    localRole: 'agent',
  });

  let totalElapsedMs = first.stats?.elapsedMs || 0;
  let lastStats = first.stats || {};
  let parsed = tryParseProactiveResponse(first.content);

  if (!parsed) {
    const retryMessages = messages.concat([
      { role: 'assistant', content: first.content },
      {
        role: 'user',
        content:
          'Reponds UNIQUEMENT par un objet JSON valide {"suggest": true, "summary": "...", "rationale": "...", "steps": [{"tool": "...", "args": {...}}]} ou {"suggest": false, "reason": "..."} sans texte autour.',
      },
    ]);
    const retry = await callLLM(retryMessages, {
      maxTokens,
      temperature: 0,
      userConfig: resolvedUserConfig,
      localRole: 'agent',
    });
    totalElapsedMs += retry.stats?.elapsedMs || 0;
    lastStats = mergeFollowupStats(lastStats, retry.stats, totalElapsedMs);
    parsed = tryParseProactiveResponse(retry.content);
  }

  const finalStats = { ...lastStats, elapsedMs: totalElapsedMs };

  if (!parsed) {
    return {
      ok: false,
      suggest: false,
      error: 'Reponse IA proactive invalide.',
      stats: finalStats,
    };
  }

  if (parsed.suggest === false) {
    return {
      ok: true,
      suggest: false,
      reason: parsed.reason,
      stats: finalStats,
    };
  }

  const analyzed = validateAndAnalyzePlan(
    { summary: parsed.summary, steps: parsed.steps },
    guild,
    member
  );
  if (!analyzed.ok) {
    return {
      ok: false,
      suggest: false,
      error: analyzed.error,
      stats: finalStats,
    };
  }

  return {
    ok: true,
    suggest: true,
    plan: analyzed.plan,
    security: analyzed.security,
    rationale: parsed.rationale,
    stats: finalStats,
  };
}

module.exports = {
  MAX_PLAN_STEPS,
  buildGuildContext,
  buildPlannerSystemPrompt,
  buildProactivePlannerSystemPrompt,
  tryParsePlan,
  tryParseProactiveResponse,
  describePlanStep,
  consolidateCategoryPermissions,
  validateAndAnalyzePlan,
  checkPlanMemberAuthorization,
  buildValidatedPlan,
  reviseValidatedPlan,
  buildProactivePlanFromAudit,
};
