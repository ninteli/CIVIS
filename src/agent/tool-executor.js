const {
  ChannelType,
  ChannelFlags,
  ChannelFlagsBitField,
  PermissionsBitField,
} = require('discord.js');
const { resolveColor, findExplicitColorInText } = require('./colors');
const {
  normalizeKey,
  isManagedChannelType,
  supportsTextProperties,
  isVoiceLikeChannelType,
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

const DELETE_CONFIRM_TIMEOUT_MS = 30_000;
const ARCHIVED_ROLE_PREFIX = '[Archivé] ';

const normalizeText = normalizeKey;

function findRoleByName(guild, roleName) {
  const clean = String(roleName || '').trim();
  if (!clean || !guild?.roles?.cache) return null;
  const lower = clean.toLowerCase();
  const normalized = normalizeText(clean);
  return (
    guild.roles.cache.find((r) => r.name.toLowerCase() === lower) ||
    guild.roles.cache.find((r) => normalizeText(r.name) === normalized) ||
    null
  );
}

function findManagedChannelByName(guild, channelName) {
  const clean = String(channelName || '').trim().replace(/^#/, '');
  if (!clean || !guild?.channels?.cache) return null;
  const lower = clean.toLowerCase();
  const sanitized = sanitizeChannelName(clean);
  const normalized = normalizeText(clean);
  const candidates = Array.from(guild.channels.cache.values()).filter((c) =>
    isManagedChannelType(c.type)
  );
  return (
    candidates.find((c) => c.name.toLowerCase() === lower) ||
    (sanitized && candidates.find((c) => c.name.toLowerCase() === sanitized)) ||
    candidates.find((c) => normalizeText(c.name) === normalized) ||
    (sanitized && candidates.find((c) => sanitizeChannelName(c.name) === sanitized)) ||
    null
  );
}

function formatHexColor(num) {
  return '#' + num.toString(16).padStart(6, '0').toUpperCase();
}

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

function authorizeAction({
  toolName,
  args,
  userText,
  mode,
  guild,
  member,
  requiredPermission,
  requiredPermissions,
  targetChannel,
  targetRole,
  requestedPermFlags,
  allowManagedRoles = false,
  title,
  summaryLines,
}) {
  const reqPerms = normalizeRequiredPerms(requiredPermission, requiredPermissions);

  const botCheck = checkBotPermissions({
    guild,
    requiredPermissions: reqPerms,
    targetChannel,
    targetRole,
    requestedPermFlags,
    allowManagedRoles,
  });
  if (!botCheck.ok) {
    return { ok: false, error: botCheck.error };
  }

  const memberCheck = checkMemberAuthorization({
    guild,
    member,
    requiredPermissions: reqPerms,
    targetChannel,
    targetRole,
    requestedPermFlags,
  });
  if (!memberCheck.authorized) {
    return {
      ok: false,
      needsApproval: true,
      approval: {
        toolName,
        args,
        userText,
        mode,
        title,
        summaryLines,
        requiredPermission: reqPerms[0] || requiredPermission || null,
        requiredPermissions: reqPerms,
        requiredPermissionLabel: reqPerms.map(getPermissionLabel).join(', '),
        targetChannelId: targetChannel ? targetChannel.id : null,
        targetRoleId: targetRole ? targetRole.id : null,
        requestedPermFlags: requestedPermFlags || [],
        reason: memberCheck.reason,
      },
    };
  }

  return { ok: true };
}

async function executeTool(
  toolName,
  args,
  { guild, member, client, mode, userText, confirmed = false, fetchFn }
) {
  mode = mode || 'chat';
  args = args && typeof args === 'object' ? args : {};

  if (!guild) {
    return { ok: false, error: 'Cette action doit etre effectuee dans un serveur Discord.' };
  }

  const { readTools, actionTools } = require('./tools');
  const allowed = mode === 'agent' ? actionTools : readTools;
  const allowedNames = allowed.map((t) => t.name);

  if (!allowedNames.includes(toolName)) {
    return {
      ok: false,
      error: 'Outil "' + toolName + '" non autorise en mode ' + mode + '.',
    };
  }

  try {
    switch (toolName) {
      case 'list_channels':
        return await listChannels(guild, member);
      case 'list_roles':
        return await listRoles(guild);
      case 'create_channel':
        return await createChannel(args, guild, member, { mode, userText });
      case 'create_role':
        return await createRole(args, guild, member, { mode, userText });
      case 'modify_channel':
        return await modifyChannel(args, guild, member, { mode, userText });
      case 'modify_role_display':
        return await modifyRoleDisplay(args, guild, member, { mode, userText });
      case 'modify_role_perm':
        return await modifyRolePerm(args, guild, member, { mode, userText });
      case 'delete_channel':
        return await deleteChannel(args, guild, member, { mode, userText, confirmed });
      case 'delete_role':
        return await deleteRole(args, guild, member, { mode, userText, confirmed });
      case 'archive_channel':
        return await archiveChannelTool(args, guild, member, { mode, userText });
      case 'archive_role':
        return await archiveRoleTool(args, guild, member, { mode, userText });
      case 'create_category':
        return await createCategory(args, guild, member, { mode, userText });
      case 'set_channel_permissions':
        return await setChannelPermissions(args, guild, member, { mode, userText });
      case 'search_app_directory':
        return await searchAppDirectory(args, { fetchFn });
      default:
        return { ok: false, error: 'Outil inconnu : ' + toolName };
    }
  } catch (err) {
    console.error('[tool-executor] Erreur ' + toolName + ' :', err);
    return { ok: false, error: err.message };
  }
}

function canMemberViewChannel(channel, member, guild) {
  if (!member) return true;
  if (isGuildOwner(guild, member) || member.permissions?.has?.(PermissionsBitField.Flags.Administrator)) {
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

async function listChannels(guild, member = null) {
  const channels = guild.channels.cache
    .filter((c) => isManagedChannelType(c.type) && canMemberViewChannel(c, member, guild))
    .map((c) => {
      const type = getChannelTypeLabel(c.type);
      const cat = c.parent ? c.parent.name : 'sans categorie';
      const opts = [];
      if (c.rateLimitPerUser > 0) opts.push('cooldown ' + c.rateLimitPerUser + 's');
      if (isSpoilerChannel(c)) opts.push('spoiler');
      if (c.nsfw) opts.push('NSFW');
      return (
        '#' +
        c.name +
        ' (' +
        type +
        ', categorie: ' +
        cat +
        (opts.length ? ', ' + opts.join(', ') : '') +
        ', id: ' +
        c.id +
        ')'
      );
    })
    .sort()
    .join('\n');

  return {
    ok: true,
    result: 'Salons du serveur "' + guild.name + '" :\n' + (channels || '(aucun)'),
  };
}

async function listRoles(guild) {
  const roles = guild.roles.cache
    .filter((r) => r.name !== '@everyone')
    .map((r) => {
      const color = r.hexColor === '#000000' ? 'sans couleur' : r.hexColor;
      return r.name + ' (couleur: ' + color + ', id: ' + r.id + ')';
    })
    .join('\n');

  return {
    ok: true,
    result: 'Roles du serveur "' + guild.name + '" :\n' + (roles || '(aucun)'),
  };
}

async function createChannel(args, guild, member, { mode, userText }) {
  const rawName = (args.name || '').toString().trim();
  if (!rawName) {
    return { ok: false, error: 'Il manque le nom du salon.' };
  }

  const typeRes = resolveChannelTypeInput(args.type);
  if (!typeRes.ok) {
    return { ok: false, error: typeRes.error };
  }

  const channelType = typeRes.type;
  const typeLabel = typeRes.label;
  const cleanName = isVoiceLikeChannelType(channelType)
    ? rawName.replace(/^#/, '').trim().slice(0, 100)
    : sanitizeChannelName(rawName);
  if (!cleanName) {
    return { ok: false, error: 'Le nom du salon est invalide.' };
  }

  let parentId = null;
  if (args.category && String(args.category).trim()) {
    const explicitCat = findCategoryByName(guild, args.category);
    parentId = explicitCat ? explicitCat.id : findCategoryId(guild, args.category_hint, cleanName);
  } else {
    parentId = findCategoryId(guild, args.category_hint, cleanName);
  }
  const parentChannel = parentId ? guild.channels.cache.get(parentId) || null : null;

  const options = {
    name: cleanName,
    type: channelType,
  };

  if (parentId) options.parent = parentId;

  const summaryLines = [
    'Type : ' + typeLabel,
    'Categorie : ' + (parentChannel ? parentChannel.name : 'racine'),
  ];

  const cooldown = parseCooldownArg(args);
  if (cooldown > 0) {
    options.rateLimitPerUser = cooldown;
    summaryLines.push('Cooldown : ' + cooldown + 's');
  }

  const nsfw = parseOptionalBoolean(args.nsfw);
  if (nsfw === true) {
    options.nsfw = true;
    summaryLines.push('NSFW : active');
  }

  const spoiler = parseOptionalBoolean(args.spoiler);
  if (spoiler === true) {
    if (supportsTextProperties(channelType)) {
      summaryLines.push('Salon de spoiler : active');
    } else {
      summaryLines.push('Salon de spoiler : non supporte pour ' + typeLabel + ' (ignore)');
    }
  }

  if (
    supportsTextProperties(channelType) &&
    args.topic !== undefined &&
    String(args.topic).trim() !== ''
  ) {
    const topic = String(args.topic).trim().slice(0, 1024);
    options.topic = topic;
    summaryLines.push('Sujet : ' + topic);
  }

  const auth = authorizeAction({
    toolName: 'create_channel',
    args,
    userText,
    mode,
    guild,
    member,
    requiredPermission: 'ManageChannels',
    targetChannel: parentChannel,
    title: 'Creer le salon #' + cleanName,
    summaryLines,
  });
  if (!auth.ok) return auth;

  let channel;
  try {
    channel = await guild.channels.create(options);
  } catch (err) {
    if (
      channelType === ChannelType.GuildAnnouncement ||
      channelType === ChannelType.GuildForum ||
      channelType === ChannelType.GuildStageVoice
    ) {
      return {
        ok: false,
        error:
          'Impossible de creer un salon de type "' +
          typeLabel +
          '" : ' +
          err.message +
          ' (ce type necessite souvent le mode Communaute active sur le serveur).',
      };
    }
    throw err;
  }

  const catName = channel.parent ? channel.parent.name : 'racine';
  const details = [];
  if (options.rateLimitPerUser) details.push('cooldown ' + options.rateLimitPerUser + 's');
  if (options.nsfw) details.push('NSFW active');
  if (options.topic) details.push('sujet: "' + options.topic + '"');

  if (spoiler === true) {
    if (supportsTextProperties(channelType)) {
      try {
        const nextFlags = new ChannelFlagsBitField(channel.flags || 0).add(
          ChannelFlags.IsSpoilerChannel
        );
        await channel.edit({ flags: nextFlags });
        details.push('salon de spoiler');
      } catch (err) {
        details.push('spoiler non applique (' + err.message + ')');
      }
    } else {
      details.push('salon de spoiler non supporte sur un salon ' + typeLabel);
    }
  }

  return {
    ok: true,
    result:
      'Salon cree avec succes.\n' +
      'Nom : #' + channel.name + '\n' +
      'Type : ' + typeLabel + '\n' +
      'Categorie : ' + catName + '\n' +
      (details.length ? 'Options : ' + details.join(', ') : 'Options : aucune'),
  };
}

async function createRole(args, guild, member, { mode, userText }) {
  const name = (args.name || '').toString().trim();
  if (!name) {
    return { ok: false, error: 'Il manque le nom du role.' };
  }

  const cleanRoleName = name.slice(0, 100);
  const options = { name: cleanRoleName };
  const summaryLines = [];

  const explicitColor = findExplicitColorInText(userText);
  const finalColor = resolveColor(explicitColor, args.color, cleanRoleName);
  if (finalColor !== null && finalColor !== undefined) {
    options.colors = { primaryColor: finalColor };
    summaryLines.push('Couleur : ' + formatHexColor(finalColor));
  }

  const hoist = parseOptionalBoolean(args.hoist);
  if (hoist === true) {
    options.hoist = true;
    summaryLines.push('Affiche separement : oui');
  }
  const mentionable = parseOptionalBoolean(args.mentionable);
  if (mentionable === true) {
    options.mentionable = true;
    summaryLines.push('Mentionnable : oui');
  }

  const auth = authorizeAction({
    toolName: 'create_role',
    args,
    userText,
    mode,
    guild,
    member,
    requiredPermission: 'ManageRoles',
    title: 'Creer le role "' + cleanRoleName + '"',
    summaryLines,
  });
  if (!auth.ok) return auth;

  const role = await guild.roles.create(options);

  const details = [];
  if (role.hexColor !== '#000000') details.push('couleur ' + role.hexColor);
  if (role.hoist) details.push('affiche separement');
  if (role.mentionable) details.push('mentionnable');

  return {
    ok: true,
    result:
      'Role cree avec succes.\n' +
      'Nom : ' + role.name + '\n' +
      'ID : ' + role.id + '\n' +
      (details.length ? 'Options : ' + details.join(', ') : 'Options : aucune'),
  };
}

async function modifyChannel(args, guild, member, { mode, userText }) {
  const channelName = (args.channel || '').toString().trim().replace(/^#/, '');
  if (!channelName) {
    return { ok: false, error: 'Il manque le nom du salon a modifier.' };
  }

  const channel = findManagedChannelByName(guild, channelName);
  if (!channel) {
    return { ok: false, error: 'Salon introuvable : #' + channelName };
  }

  const updates = {};
  const summaryLines = [];

  if (args.new_name) {
    const cleanName = isVoiceLikeChannelType(channel.type)
      ? String(args.new_name).replace(/^#/, '').trim().slice(0, 100)
      : sanitizeChannelName(args.new_name);
    if (cleanName) {
      updates.name = cleanName;
      summaryLines.push('Nouveau nom : #' + cleanName);
    }
  }

  if (args.type !== undefined && String(args.type).trim() !== '') {
    const typeRes = resolveChannelTypeInput(args.type);
    if (!typeRes.ok) {
      return { ok: false, error: typeRes.error };
    }
    const targetConvertible =
      typeRes.type === ChannelType.GuildText ||
      typeRes.type === ChannelType.GuildAnnouncement;
    const sourceConvertible =
      channel.type === ChannelType.GuildText ||
      channel.type === ChannelType.GuildAnnouncement;
    if (!targetConvertible || !sourceConvertible) {
      return {
        ok: false,
        error: 'Discord permet uniquement de convertir le type entre texte et annonce.',
      };
    }
    updates.type = typeRes.type;
    summaryLines.push('Type : ' + typeRes.label);
  }

  if (args.category !== undefined && String(args.category).trim() !== '') {
    const targetCat = findCategoryByName(guild, args.category);
    if (!targetCat) {
      return { ok: false, error: 'Categorie introuvable : ' + args.category };
    }
    updates.parent = targetCat.id;
    summaryLines.push('Categorie : ' + targetCat.name);
  }

  const cooldown = parseCooldownArg(args);
  if (cooldown !== undefined) {
    updates.rateLimitPerUser = cooldown;
    summaryLines.push('Cooldown : ' + (cooldown === 0 ? 'desactive' : cooldown + 's'));
  }

  const nsfw = parseOptionalBoolean(args.nsfw);
  if (nsfw !== undefined) {
    updates.nsfw = nsfw;
    summaryLines.push('NSFW : ' + (nsfw ? 'active' : 'desactive'));
  }

  const spoiler = parseOptionalBoolean(args.spoiler);
  if (spoiler !== undefined) {
    if (!supportsTextProperties(channel.type)) {
      return {
        ok: false,
        error:
          'L option salon de spoiler est disponible uniquement sur les salons texte, annonce et forum.',
      };
    }
    const nextFlags = new ChannelFlagsBitField(channel.flags || 0);
    if (spoiler) {
      nextFlags.add(ChannelFlags.IsSpoilerChannel);
    } else {
      nextFlags.remove(ChannelFlags.IsSpoilerChannel);
    }
    updates.flags = nextFlags;
    summaryLines.push('Salon de spoiler : ' + (spoiler ? 'active' : 'desactive'));
  }

  if (args.topic !== undefined && supportsTextProperties(channel.type)) {
    const topic = String(args.topic).slice(0, 1024);
    updates.topic = topic;
    summaryLines.push('Sujet : ' + (topic || '(vide)'));
  }

  if (Object.keys(updates).length === 0) {
    return { ok: false, error: 'Aucune modification demandee.' };
  }

  const auth = authorizeAction({
    toolName: 'modify_channel',
    args,
    userText,
    mode,
    guild,
    member,
    requiredPermission: 'ManageChannels',
    targetChannel: channel,
    title: 'Modifier le salon #' + channel.name,
    summaryLines,
  });
  if (!auth.ok) return auth;

  await channel.edit(updates);

  return {
    ok: true,
    result:
      'Salon #' +
      channel.name +
      ' modifie avec succes.\nModifications : ' +
      summaryLines.join(', '),
  };
}

async function modifyRoleDisplay(args, guild, member, { mode, userText }) {
  const roleName = (args.role || '').toString().trim();
  if (!roleName) {
    return { ok: false, error: 'Il manque le nom du role a modifier.' };
  }

  const role = findRoleByName(guild, roleName);
  if (!role) {
    return { ok: false, error: 'Role introuvable : ' + roleName };
  }

  const updates = {};
  const summaryLines = [];

  if (args.new_name) {
    const cleanNewName = String(args.new_name).trim().slice(0, 100);
    if (cleanNewName) {
      updates.name = cleanNewName;
      summaryLines.push('Nouveau nom : ' + cleanNewName);
    }
  }

  const explicitColor = findExplicitColorInText(userText);
  if (args.color || explicitColor !== null) {
    const finalColor = resolveColor(explicitColor, args.color, roleName);
    if (finalColor !== null && finalColor !== undefined) {
      updates.colors = { primaryColor: finalColor };
      summaryLines.push('Couleur : ' + formatHexColor(finalColor));
    }
  }

  const hoist = parseOptionalBoolean(args.hoist);
  if (hoist !== undefined) {
    updates.hoist = hoist;
    summaryLines.push('Affiche separement : ' + (hoist ? 'oui' : 'non'));
  }

  const mentionable = parseOptionalBoolean(args.mentionable);
  if (mentionable !== undefined) {
    updates.mentionable = mentionable;
    summaryLines.push('Mentionnable : ' + (mentionable ? 'oui' : 'non'));
  }

  if (Object.keys(updates).length === 0) {
    return { ok: false, error: 'Aucune modification demandee.' };
  }

  const auth = authorizeAction({
    toolName: 'modify_role_display',
    args,
    userText,
    mode,
    guild,
    member,
    requiredPermission: 'ManageRoles',
    targetRole: role,
    title: 'Modifier l apparence du role "' + role.name + '"',
    summaryLines,
  });
  if (!auth.ok) return auth;

  await role.edit(updates);

  return {
    ok: true,
    result:
      'Role "' +
      role.name +
      '" (apparence) modifie avec succes.\nModifications : ' +
      summaryLines.join(', '),
  };
}

async function modifyRolePerm(args, guild, member, { mode, userText }) {
  const roleName = (args.role || '').toString().trim();
  if (!roleName) {
    return { ok: false, error: 'Il manque le nom du role a modifier.' };
  }

  const role = findRoleByName(guild, roleName);
  if (!role) {
    return { ok: false, error: 'Role introuvable : ' + roleName };
  }

  const addFlags = [...new Set(parsePermissionFlags(args.add))];
  const removeFlags = [...new Set(parsePermissionFlags(args.remove))];

  if (addFlags.length === 0 && removeFlags.length === 0) {
    return {
      ok: false,
      error:
        'Aucune permission valide fournie. Utilise les noms exacts (ex: ManageMessages, KickMembers).',
    };
  }

  const requestedPermFlags = [...new Set([...addFlags, ...removeFlags])];
  const summaryLines = [];
  if (addFlags.length) summaryLines.push('Ajouter : ' + addFlags.join(', '));
  if (removeFlags.length) summaryLines.push('Retirer : ' + removeFlags.join(', '));

  const auth = authorizeAction({
    toolName: 'modify_role_perm',
    args,
    userText,
    mode,
    guild,
    member,
    requiredPermission: 'ManageRoles',
    targetRole: role,
    requestedPermFlags,
    title: 'Modifier les permissions du role "' + role.name + '"',
    summaryLines,
  });
  if (!auth.ok) return auth;

  const nextPermissions = new PermissionsBitField(role.permissions);
  if (addFlags.length) nextPermissions.add(addFlags);
  if (removeFlags.length) nextPermissions.remove(removeFlags);

  await role.edit({ permissions: nextPermissions });

  const changes = [];
  if (addFlags.length) changes.push('ajoutees: ' + addFlags.join(', '));
  if (removeFlags.length) changes.push('retirees: ' + removeFlags.join(', '));

  return {
    ok: true,
    result: 'Permissions du role "' + role.name + '" modifiees.\n' + changes.join('\n'),
  };
}

async function deleteChannel(args, guild, member, { mode, userText, confirmed = false }) {
  const channelName = (args.channel || '').toString().trim().replace(/^#/, '');
  if (!channelName) {
    return { ok: false, error: 'Il manque le nom du salon a supprimer.' };
  }

  const channel = findManagedChannelByName(guild, channelName);

  if (!channel) {
    return { ok: false, error: 'Salon introuvable : #' + channelName };
  }

  const botCheck = checkBotPermissions({
    guild,
    requiredPermission: 'ManageChannels',
    targetChannel: channel,
  });
  if (!botCheck.ok) {
    return { ok: false, error: botCheck.error };
  }

  const memberCheck = checkMemberAuthorization({
    guild,
    member,
    requiredPermission: 'ManageChannels',
    targetChannel: channel,
  });
  const typeLabel = getChannelTypeLabel(channel.type);
  if (!memberCheck.authorized) {
    if (confirmed) {
      return { ok: false, error: memberCheck.reason };
    }
    return {
      ok: false,
      needsApproval: true,
      approval: {
        kind: 'permission_delete',
        toolName: 'delete_channel',
        args: { ...args, channel: channel.name },
        userText,
        mode,
        title: 'Supprimer le salon #' + channel.name,
        summaryLines: [
          'Salon : #' + channel.name + ' (' + typeLabel + ')',
          'Categorie actuelle : ' + (channel.parent ? channel.parent.name : 'racine'),
          'Sans validation par un membre autorise, la demande expirera sans modifier le salon.',
        ],
        requiredPermission: 'ManageChannels',
        requiredPermissionLabel: getPermissionLabel('ManageChannels'),
        targetChannelId: channel.id,
        targetRoleId: null,
        requestedPermFlags: [],
        reason: memberCheck.reason,
        onTimeoutAction: 'ignore',
      },
    };
  }

  if (!confirmed) {
    return {
      ok: false,
      needsApproval: true,
      approval: {
        kind: 'confirm_delete',
        toolName: 'delete_channel',
        args: { ...args, channel: channel.name },
        userText,
        mode,
        title: 'Supprimer le salon #' + channel.name,
        summaryLines: [
          'Salon : #' + channel.name + ' (' + typeLabel + ')',
          'Categorie actuelle : ' + (channel.parent ? channel.parent.name : 'racine'),
          'Sans confirmation dans 30s, le salon sera deplace dans la categorie "archivée" et masque pour tout le monde.',
        ],
        requiredPermission: 'ManageChannels',
        requiredPermissionLabel: getPermissionLabel('ManageChannels'),
        targetChannelId: channel.id,
        targetRoleId: null,
        requestedPermFlags: [],
        reason: 'Confirmation obligatoire avant suppression definitive.',
        timeoutMs: DELETE_CONFIRM_TIMEOUT_MS,
        onTimeoutAction: 'archive_channel',
      },
    };
  }

  const deletedName = channel.name;
  const deletedId = channel.id;
  await channel.delete('Suppression confirmee via CIVIS');

  return {
    ok: true,
    result: 'Salon #' + deletedName + ' supprime avec succes.',
    deletedChannelId: deletedId,
  };
}

async function deleteRole(args, guild, member, { mode, userText, confirmed = false }) {
  const roleName = (args.role || '').toString().trim();
  if (!roleName) {
    return { ok: false, error: 'Il manque le nom du role a supprimer.' };
  }

  const role = findRoleByName(guild, roleName);
  if (!role) {
    return { ok: false, error: 'Role introuvable : ' + roleName };
  }

  const botCheck = checkBotPermissions({
    guild,
    requiredPermission: 'ManageRoles',
    targetRole: role,
  });
  if (!botCheck.ok) {
    return { ok: false, error: botCheck.error };
  }

  const memberCheck = checkMemberAuthorization({
    guild,
    member,
    requiredPermission: 'ManageRoles',
    targetRole: role,
  });
  if (!memberCheck.authorized) {
    if (confirmed) {
      return { ok: false, error: memberCheck.reason };
    }
    return {
      ok: false,
      needsApproval: true,
      approval: {
        kind: 'permission_delete',
        toolName: 'delete_role',
        args: { ...args, role: role.name },
        userText,
        mode,
        title: 'Supprimer le role "' + role.name + '"',
        summaryLines: [
          'Role : ' + role.name,
          'Couleur : ' + (role.hexColor === '#000000' ? 'aucune' : role.hexColor),
          'Sans validation par un membre autorise, la demande expirera sans modifier le role.',
        ],
        requiredPermission: 'ManageRoles',
        requiredPermissionLabel: getPermissionLabel('ManageRoles'),
        targetChannelId: null,
        targetRoleId: role.id,
        requestedPermFlags: [],
        reason: memberCheck.reason,
        onTimeoutAction: 'ignore',
      },
    };
  }

  if (!confirmed) {
    return {
      ok: false,
      needsApproval: true,
      approval: {
        kind: 'confirm_delete',
        toolName: 'delete_role',
        args: { ...args, role: role.name },
        userText,
        mode,
        title: 'Supprimer le role "' + role.name + '"',
        summaryLines: [
          'Role : ' + role.name,
          'Couleur : ' + (role.hexColor === '#000000' ? 'aucune' : role.hexColor),
          'Sans confirmation dans 30s, le role sera mis en quarantaine ([Archivé], permissions retirees, non affiche separement, non mentionnable).',
        ],
        requiredPermission: 'ManageRoles',
        requiredPermissionLabel: getPermissionLabel('ManageRoles'),
        targetChannelId: null,
        targetRoleId: role.id,
        requestedPermFlags: [],
        reason: 'Confirmation obligatoire avant suppression definitive.',
        timeoutMs: DELETE_CONFIRM_TIMEOUT_MS,
        onTimeoutAction: 'archive_role',
      },
    };
  }

  const deletedName = role.name;
  await role.delete('Suppression confirmee via CIVIS');

  return {
    ok: true,
    result: 'Role "' + deletedName + '" supprime avec succes.',
  };
}

async function archiveChannelTool(args, guild, member, { mode, userText }) {
  const channelName = (args.channel || '').toString().trim().replace(/^#/, '');
  if (!channelName) {
    return { ok: false, error: 'Il manque le nom du salon a archiver.' };
  }

  const channel = findManagedChannelByName(guild, channelName);

  if (!channel) {
    return { ok: false, error: 'Salon introuvable : #' + channelName };
  }

  const auth = authorizeAction({
    toolName: 'archive_channel',
    args: { ...args, channel: channel.name },
    userText,
    mode,
    guild,
    member,
    requiredPermission: 'ManageChannels',
    targetChannel: channel,
    title: 'Archiver le salon #' + channel.name,
    summaryLines: [
      'Salon : #' + channel.name,
      'Action : deplacer dans la categorie "archivée" et masquer pour tout le monde',
    ],
  });
  if (!auth.ok) return auth;

  return await archiveChannel(guild, channel.id);
}

async function archiveRoleTool(args, guild, member, { mode, userText }) {
  const roleName = (args.role || '').toString().trim();
  if (!roleName) {
    return { ok: false, error: 'Il manque le nom du role a archiver.' };
  }

  const role = findRoleByName(guild, roleName);
  if (!role) {
    return { ok: false, error: 'Role introuvable : ' + roleName };
  }

  const auth = authorizeAction({
    toolName: 'archive_role',
    args: { ...args, role: role.name },
    userText,
    mode,
    guild,
    member,
    requiredPermission: 'ManageRoles',
    targetRole: role,
    title: 'Archiver le role "' + role.name + '"',
    summaryLines: [
      'Role : ' + role.name,
      'Action : renommer [Archivé], retirer les permissions, desactiver hoist et mentionable',
    ],
  });
  if (!auth.ok) return auth;

  return await archiveRole(guild, role.id);
}

async function archiveChannel(guild, channelId) {
  const channel = guild?.channels?.cache?.get(channelId);
  if (!channel) {
    return { ok: false, error: 'Le salon a archiver est introuvable.' };
  }

  const botCheck = checkBotPermissions({
    guild,
    requiredPermission: 'ManageChannels',
    targetChannel: channel,
  });
  if (!botCheck.ok) {
    return { ok: false, error: botCheck.error };
  }

  const me = guild.members.me;
  const canEditOverwrites = Boolean(
    me?.permissions?.has(PermissionsBitField.Flags.Administrator) ||
      me?.permissions?.has(PermissionsBitField.Flags.ManageRoles)
  );

  const hiddenOverwrites = [
    { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
    {
      id: me.id,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.ManageChannels,
      ],
    },
  ];

  const categories = guild.channels.cache.filter(
    (c) => c.type === ChannelType.GuildCategory
  );
  let archiveCategory =
    categories.find((c) => normalizeText(c.name) === 'archivee') ||
    categories.find((c) =>
      ['archivees', 'archive', 'archives'].includes(normalizeText(c.name))
    );

  if (!archiveCategory) {
    const catOptions = {
      name: 'archivée',
      type: ChannelType.GuildCategory,
    };
    if (canEditOverwrites) {
      catOptions.permissionOverwrites = hiddenOverwrites;
    }
    archiveCategory = await guild.channels.create(catOptions);
  }

  const editPayload = { parent: archiveCategory.id };
  if (canEditOverwrites) {
    editPayload.permissionOverwrites = hiddenOverwrites;
  }
  await channel.edit(editPayload);

  return {
    ok: true,
    hidden: canEditOverwrites,
    categoryName: archiveCategory.name,
    result: canEditOverwrites
      ? 'Salon #' +
        channel.name +
        ' deplace dans la categorie "' +
        archiveCategory.name +
        '" et masque pour tout le monde.'
      : 'Salon #' +
        channel.name +
        ' deplace dans la categorie "' +
        archiveCategory.name +
        '" (permission ManageRoles manquante sur le bot pour masquer la visibilite).',
  };
}

async function archiveRole(guild, roleId) {
  const role = guild?.roles?.cache?.get(roleId);
  if (!role) {
    return { ok: false, error: 'Le role a archiver est introuvable.' };
  }

  const botCheck = checkBotPermissions({
    guild,
    requiredPermission: 'ManageRoles',
    targetRole: role,
  });
  if (!botCheck.ok) {
    return { ok: false, error: botCheck.error };
  }

  const archivedName = role.name.startsWith(ARCHIVED_ROLE_PREFIX)
    ? role.name.slice(0, 100)
    : (ARCHIVED_ROLE_PREFIX + role.name).slice(0, 100);

  const me = guild.members.me;
  const botIsAdmin = Boolean(me?.permissions?.has(PermissionsBitField.Flags.Administrator));

  let nextPermissions;
  const unremovablePerms = [];

  if (botIsAdmin) {
    nextPermissions = new PermissionsBitField(0n);
  } else {
    const currentFlags = role.permissions.toArray();
    const removable = [];
    for (const flag of currentFlags) {
      if (me?.permissions?.has(PermissionsBitField.Flags[flag])) {
        removable.push(flag);
      } else {
        unremovablePerms.push(flag);
      }
    }
    nextPermissions = new PermissionsBitField(role.permissions);
    if (removable.length > 0) {
      nextPermissions.remove(removable);
    }
  }

  await role.edit({
    name: archivedName,
    permissions: nextPermissions,
    hoist: false,
    mentionable: false,
  });

  return {
    ok: true,
    archivedName,
    unremovablePerms,
    result:
      unremovablePerms.length > 0
        ? 'Role mis en quarantaine sous "' +
          archivedName +
          '" (affichage et mention desactives ; permissions non retirables faute de droits du bot : ' +
          unremovablePerms.join(', ') +
          ').'
        : 'Role mis en quarantaine sous "' +
          archivedName +
          '" (permissions retirees, non affiche separement, non mentionnable).',
  };
}

async function createCategory(args, guild, member, { mode, userText }) {
  const rawName = (args.name || '').toString().trim();
  if (!rawName) {
    return { ok: false, error: 'Il manque le nom de la categorie.' };
  }

  const cleanName = rawName.slice(0, 100);
  const auth = authorizeAction({
    toolName: 'create_category',
    args: { ...args, name: cleanName },
    userText,
    mode,
    guild,
    member,
    requiredPermission: 'ManageChannels',
    title: 'Creer la categorie "' + cleanName + '"',
    summaryLines: ['Nom : ' + cleanName],
  });
  if (!auth.ok) return auth;

  const existing = guild.channels.cache.find(
    (c) =>
      c.type === ChannelType.GuildCategory &&
      normalizeText(c.name) === normalizeText(cleanName)
  );
  if (existing) {
    return {
      ok: true,
      reused: true,
      categoryId: existing.id,
      result: 'Categorie "' + existing.name + '" deja existante (reutilisee).',
    };
  }

  const cat = await guild.channels.create({
    name: cleanName,
    type: ChannelType.GuildCategory,
  });

  return {
    ok: true,
    categoryId: cat.id,
    result: 'Categorie "' + cat.name + '" creee avec succes.',
  };
}

async function applyChannelPermissionOverwrite(
  targetChan,
  { targetRoleId, overwriteObj, protectBotAccess, botId }
) {
  if (protectBotAccess && botId) {
    await targetChan.permissionOverwrites.edit(botId, {
      ViewChannel: true,
      ManageChannels: true,
    });
  }
  await targetChan.permissionOverwrites.edit(targetRoleId, overwriteObj);
}

async function setChannelPermissions(args, guild, member, { mode, userText }) {
  const rawChannelVal =
    args.channel !== undefined && String(args.channel).trim() !== ''
      ? String(args.channel).trim()
      : args.category !== undefined && String(args.category).trim() !== ''
        ? String(args.category).trim()
        : '';

  const hasHashPrefix = rawChannelVal.startsWith('#');
  const channelName = rawChannelVal.replace(/^#/, '').trim();
  if (!channelName) {
    return { ok: false, error: 'Il manque le nom du salon ou de la categorie.' };
  }

  let targetType = null;
  if (!args.channel && args.category) {
    targetType = 'category';
  } else if (args.target_type) {
    const normType = normalizeText(args.target_type);
    if (normType === 'category' || normType === 'categorie') {
      targetType = 'category';
    } else if (normType === 'channel' || normType === 'salon') {
      targetType = 'channel';
    }
  }

  const sanitized = sanitizeChannelName(channelName);
  const normalizedTarget = normalizeText(channelName);
  const matchesTargetName = (c) =>
    c.name.toLowerCase() === channelName.toLowerCase() ||
    (sanitized && c.name.toLowerCase() === sanitized) ||
    normalizeText(c.name) === normalizedTarget;

  const matchedCategory = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && matchesTargetName(c)
  );
  const matchedChannel = findManagedChannelByName(guild, channelName);

  let channel = null;
  if (targetType === 'category') {
    if (!matchedCategory) {
      return { ok: false, error: 'Categorie introuvable : ' + channelName };
    }
    channel = matchedCategory;
  } else if (targetType === 'channel') {
    if (!matchedChannel) {
      return { ok: false, error: 'Salon introuvable : #' + channelName };
    }
    channel = matchedChannel;
  } else if (matchedCategory && matchedChannel) {
    if (hasHashPrefix) {
      channel = matchedChannel;
    } else if (matchedCategory.name === channelName && matchedChannel.name !== channelName) {
      channel = matchedCategory;
    } else if (/\bcategor(?:ie|y)\b/.test(normalizeText(userText || ''))) {
      channel = matchedCategory;
    } else {
      channel = matchedChannel;
    }
  } else {
    channel = matchedCategory || matchedChannel || null;
  }

  if (!channel) {
    return { ok: false, error: 'Salon ou categorie introuvable : ' + channelName };
  }

  const roleName = (args.role || '').toString().trim();
  if (!roleName) {
    return { ok: false, error: 'Il manque le nom du role cible.' };
  }

  const normalizedRole = normalizeText(roleName);
  let targetRole = null;
  let targetRoleId;
  let roleLabel;
  if (normalizedRole === '@everyone' || normalizedRole === 'everyone') {
    targetRoleId = guild.id;
    roleLabel = '@everyone';
  } else {
    const role = findRoleByName(guild, roleName);
    if (!role) {
      return { ok: false, error: 'Role introuvable : ' + roleName };
    }
    targetRole = role;
    targetRoleId = role.id;
    roleLabel = role.name;
  }

  const allowFlags = [...new Set(parsePermissionFlags(args.allow))];
  const denyFlags = [...new Set(parsePermissionFlags(args.deny))];
  const resetFlags = [...new Set(parsePermissionFlags(args.reset))];

  if (allowFlags.length === 0 && denyFlags.length === 0 && resetFlags.length === 0) {
    return {
      ok: false,
      error:
        'Aucune permission valide fournie (ex: ViewChannel, SendMessages, Connect).',
    };
  }

  const isCategory = channel.type === ChannelType.GuildCategory;
  const syncChildren = isCategory && args.sync_children !== false;
  const childChannels = isCategory
    ? Array.from(guild.channels.cache.values()).filter(
        (c) => c.parentId === channel.id && isManagedChannelType(c.type)
      )
    : [];

  const requestedPermFlags = [...new Set([...allowFlags, ...denyFlags, ...resetFlags])];
  const channelLabel = isCategory
    ? 'la categorie "' + channel.name + '"'
    : '#' + channel.name;

  const summaryLines = ['Cible : ' + channelLabel, 'Role : ' + roleLabel];
  if (isCategory) {
    if (syncChildren && childChannels.length > 0) {
      summaryLines.push('Synchronisation : ' + childChannels.length + ' salon(s) de la categorie');
    } else if (!syncChildren) {
      summaryLines.push('Synchronisation : categorie seule');
    }
  }
  if (allowFlags.length) summaryLines.push('Autoriser : ' + allowFlags.join(', '));
  if (denyFlags.length) summaryLines.push('Refuser : ' + denyFlags.join(', '));
  if (resetFlags.length) summaryLines.push('Reinitialiser : ' + resetFlags.join(', '));

  const normalizedArgs = {
    ...args,
    channel: channel.name,
    target_type: isCategory ? 'category' : 'channel',
    role: roleLabel,
  };
  delete normalizedArgs.category;

  const auth = authorizeAction({
    toolName: 'set_channel_permissions',
    args: normalizedArgs,
    userText,
    mode,
    guild,
    member,
    requiredPermissions: ['ManageChannels', 'ManageRoles'],
    targetChannel: channel,
    targetRole,
    requestedPermFlags,
    allowManagedRoles: true,
    title: 'Modifier les permissions de ' + channelLabel + ' pour ' + roleLabel,
    summaryLines,
  });
  if (!auth.ok) return auth;

  const overwriteObj = {};
  for (const flag of resetFlags) overwriteObj[flag] = null;
  for (const flag of allowFlags) overwriteObj[flag] = true;
  for (const flag of denyFlags) overwriteObj[flag] = false;

  const me = guild.members.me;
  const protectBotAccess = Boolean(
    targetRoleId === guild.id &&
      denyFlags.includes('ViewChannel') &&
      me?.id &&
      !me.permissions.has(PermissionsBitField.Flags.Administrator)
  );

  await applyChannelPermissionOverwrite(channel, {
    targetRoleId,
    overwriteObj,
    protectBotAccess,
    botId: me?.id,
  });

  let syncedCount = 0;
  const skippedChildren = [];

  if (syncChildren && childChannels.length > 0) {
    for (const child of childChannels) {
      if (typeof child.permissionOverwrites?.edit !== 'function') {
        skippedChildren.push('#' + child.name);
        continue;
      }

      const childBotCheck = checkBotPermissions({
        guild,
        requiredPermissions: ['ManageChannels', 'ManageRoles'],
        targetChannel: child,
        targetRole,
        requestedPermFlags,
        allowManagedRoles: true,
      });
      const childMemberCheck = checkMemberAuthorization({
        guild,
        member,
        requiredPermissions: ['ManageChannels', 'ManageRoles'],
        targetChannel: child,
        targetRole,
        requestedPermFlags,
      });

      if (!childBotCheck.ok || !childMemberCheck.authorized) {
        skippedChildren.push('#' + child.name);
        continue;
      }

      try {
        await applyChannelPermissionOverwrite(child, {
          targetRoleId,
          overwriteObj,
          protectBotAccess,
          botId: me?.id,
        });
        syncedCount += 1;
      } catch (err) {
        console.error(
          '[tool-executor] Erreur sync salon #' + child.name + ' :',
          err.message
        );
        skippedChildren.push('#' + child.name);
      }
    }
  }

  const details = [];
  if (allowFlags.length) details.push('autorisees: ' + allowFlags.join(', '));
  if (denyFlags.length) details.push('refusees: ' + denyFlags.join(', '));
  if (resetFlags.length) details.push('reinitialisees: ' + resetFlags.join(', '));

  let syncNote = '';
  if (isCategory) {
    if (syncChildren && childChannels.length > 0) {
      if (syncedCount > 0) {
        syncNote += ' et synchronisees sur ' + syncedCount + ' salon(s)';
      }
      if (skippedChildren.length > 0) {
        syncNote += ' (non synchronises : ' + skippedChildren.join(', ') + ')';
      }
    } else if (!syncChildren) {
      syncNote = ' (categorie seule, salons non synchronises)';
    }
  }

  return {
    ok: true,
    isCategory,
    syncedCount,
    skippedChildren,
    result:
      'Permissions mises a jour sur ' +
      channelLabel +
      ' pour ' +
      roleLabel +
      syncNote +
      ' (' +
      details.join(' ; ') +
      ').',
  };
}

function findCategoryByName(guild, categoryName) {
  const target = normalizeText(categoryName);
  if (!target) return null;

  const categories = guild.channels.cache.filter(
    (c) => c.type === ChannelType.GuildCategory
  );
  if (categories.size === 0) return null;

  return (
    categories.find((c) => normalizeText(c.name) === target) ||
    categories.find((c) => normalizeText(c.name).includes(target)) ||
    null
  );
}

function findCategoryId(guild, hint, channelName) {
  const categories = guild.channels.cache.filter(
    (c) => c.type === ChannelType.GuildCategory
  );

  if (categories.size === 0) return null;

  const lower = (s) => (s || '').toLowerCase();

  const matchAny = (cat, keywords) => {
    const n = lower(cat.name);
    return keywords.some((k) => n.includes(k));
  };

  if (hint === 'important') {
    const found = categories.find((c) =>
      matchAny(c, ['important', 'info', 'annonce', 'regle', 'reglement', 'welcome'])
    );
    if (found) return found.id;
  }

  if (hint === 'discussion') {
    const found = categories.find((c) =>
      matchAny(c, ['discussion', 'general', 'chat', 'communaute', 'salon'])
    );
    if (found) return found.id;
  }

  const nameLower = lower(channelName);
  const autoRules = [
    {
      keywords: ['annonce', 'info', 'regle', 'welcome', 'presentation'],
      cats: ['important', 'info', 'annonce', 'regle'],
    },
    {
      keywords: ['general', 'discussion', 'chat', 'debat'],
      cats: ['discussion', 'general', 'chat'],
    },
    { keywords: ['jeu', 'game', 'gaming'], cats: ['gaming', 'jeu'] },
    { keywords: ['music', 'musique'], cats: ['music', 'musique'] },
  ];

  for (const rule of autoRules) {
    if (rule.keywords.some((k) => nameLower.includes(k))) {
      const found = categories.find((c) => matchAny(c, rule.cats));
      if (found) return found.id;
    }
  }

  return null;
}

const APP_DIRECTORY_SEARCH_URL =
  'https://discord.com/api/v9/application-directory-static/search';

const APP_DIRECTORY_CATEGORIES = [
  { id: 6, keywords: ['jeu', 'jeux', 'game', 'games', 'gaming'] },
  { id: 4, keywords: ['divertissement', 'divertissements', 'entertainment', 'fun', 'musique', 'music'] },
  { id: 8, keywords: ['moderation', 'outil', 'outils', 'tool', 'tools', 'mod', 'admin'] },
  { id: 9, keywords: ['social', 'communaute', 'community'] },
  { id: 10, keywords: ['service', 'services', 'utilitaire', 'utilitaires', 'utility', 'utilities'] },
];

function resolveAppDirectoryCategoryId(category) {
  const raw = String(category || '').trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const num = Number(raw);
    return APP_DIRECTORY_CATEGORIES.some((c) => c.id === num) ? num : null;
  }
  const norm = normalizeText(raw);
  const found = APP_DIRECTORY_CATEGORIES.find((c) =>
    c.keywords.some((k) => norm === k || norm.includes(k))
  );
  return found ? found.id : null;
}

function formatAppDirectoryCount(count) {
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return null;
  return String(Math.round(count)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' serveurs';
}

async function searchAppDirectory(args, { fetchFn } = {}) {
  const query = String(args?.query || '').trim();
  if (!query) {
    return {
      ok: false,
      error: 'Parametre "query" manquant pour la recherche dans l App Directory Discord.',
    };
  }

  let limit = Number.parseInt(args?.limit, 10);
  if (!Number.isFinite(limit)) limit = 5;
  limit = Math.max(1, Math.min(10, limit));

  const categoryId = resolveAppDirectoryCategoryId(args?.category);
  const params = new URLSearchParams({
    query,
    page: '1',
    locale: 'fr',
  });
  if (categoryId !== null) {
    params.set('category_id', String(categoryId));
  }

  const fetchImpl = fetchFn || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return {
      ok: false,
      error: 'Client HTTP indisponible pour interroger l App Directory Discord.',
    };
  }

  const url = APP_DIRECTORY_SEARCH_URL + '?' + params.toString();
  let res;
  try {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeoutId = controller ? setTimeout(() => controller.abort(), 10000) : null;
    try {
      res = await fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        ...(controller ? { signal: controller.signal } : {}),
      });
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  } catch (err) {
    return {
      ok: false,
      error: 'Impossible de contacter l App Directory Discord : ' + err.message,
    };
  }

  if (!res || !res.ok) {
    const status = res ? res.status : 'inconnu';
    return {
      ok: false,
      error: 'Erreur App Directory Discord (HTTP ' + status + ').',
    };
  }

  let payload;
  try {
    payload = await res.json();
  } catch (err) {
    return {
      ok: false,
      error: 'Reponse JSON invalide de l App Directory Discord.',
    };
  }

  const rawResults = Array.isArray(payload?.results) ? payload.results : [];
  const entries = rawResults
    .map((item) => (item && item.data ? item.data : item))
    .filter((app) => app && app.id && app.name)
    .slice(0, limit);

  if (entries.length === 0) {
    return {
      ok: true,
      result:
        'Aucun bot ou application trouve dans l App Directory Discord pour "' + query + '".',
    };
  }

  const totalCount =
    typeof payload?.result_count === 'number' && payload.result_count >= entries.length
      ? payload.result_count
      : entries.length;

  const lines = [
    'Resultats App Directory Discord pour "' +
      query +
      '" (' +
      entries.length +
      ' sur ' +
      totalCount +
      ') :',
  ];

  for (let i = 0; i < entries.length; i += 1) {
    const app = entries[i];
    const meta = [];
    if (app.is_verified) meta.push('Verifie');
    const serverLabel = formatAppDirectoryCount(app.directory_entry?.guild_count);
    if (serverLabel) meta.push(serverLabel);
    if (Array.isArray(app.categories) && app.categories.length > 0 && app.categories[0]?.name) {
      meta.push(app.categories[0].name);
    }

    const rawDesc =
      app.directory_entry?.short_description || app.description || app.summary || '';
    const cleanDesc = String(rawDesc).replace(/\s+/g, ' ').trim();
    const shortDesc =
      cleanDesc.length > 130 ? cleanDesc.slice(0, 127) + '...' : cleanDesc;

    const appUrl = 'https://discord.com/application-directory/' + app.id;
    const entryBlock =
      (i + 1) +
      '. **' +
      app.name +
      '**' +
      (meta.length ? ' (' + meta.join(' | ') + ')' : '') +
      (shortDesc ? ' — ' + shortDesc : '') +
      '\n   ' +
      appUrl;

    if (lines.join('\n').length + entryBlock.length + 1 > 1800) {
      break;
    }
    lines.push(entryBlock);
  }

  return {
    ok: true,
    result: lines.join('\n'),
  };
}

module.exports = {
  executeTool,
  archiveChannel,
  archiveRole,
  findCategoryByName,
  searchAppDirectory,
  resolveAppDirectoryCategoryId,
  DELETE_CONFIRM_TIMEOUT_MS,
};
