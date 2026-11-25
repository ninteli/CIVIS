const { PermissionsBitField } = require('discord.js');

const PERMISSION_LABELS = {
  ManageChannels: 'Gerer les salons',
  ManageRoles: 'Gerer les roles',
  ManageGuild: 'Gerer le serveur',
  Administrator: 'Administrateur',
  ManageMessages: 'Gerer les messages',
  KickMembers: 'Expulser des membres',
  BanMembers: 'Bannir des membres',
  ModerateMembers: 'Exclure temporairement des membres',
  SendMessages: 'Envoyer des messages',
  ViewChannel: 'Voir les salons',
  Connect: 'Se connecter (vocal)',
  Speak: 'Parler (vocal)',
};

function getPermissionLabel(flagName) {
  if (!flagName) return '';
  return PERMISSION_LABELS[flagName]
    ? PERMISSION_LABELS[flagName] + ' (' + flagName + ')'
    : String(flagName);
}

function normalizeRequiredPerms(requiredPermission, requiredPermissions) {
  const result = [];
  const seen = new Set();
  const list = [];
  if (requiredPermission) list.push(requiredPermission);
  if (Array.isArray(requiredPermissions)) list.push(...requiredPermissions);

  for (const item of list) {
    const key = String(item || '').trim();
    if (key && !seen.has(key)) {
      seen.add(key);
      result.push(key);
    }
  }
  return result;
}

function normalizeTargetRoles(targetRole, targetRoles) {
  const result = [];
  const seen = new Set();
  const list = [];
  if (targetRole) list.push(targetRole);
  if (Array.isArray(targetRoles)) list.push(...targetRoles);

  for (const role of list) {
    if (role && !seen.has(role.id || role)) {
      seen.add(role.id || role);
      result.push(role);
    }
  }
  return result;
}

function isGuildOwner(guild, member) {
  return Boolean(
    guild &&
      member &&
      guild.ownerId &&
      (member.id === guild.ownerId || member.user?.id === guild.ownerId)
  );
}

function getHighestRolePosition(member) {
  return typeof member?.roles?.highest?.position === 'number'
    ? member.roles.highest.position
    : -1;
}

function hasPermission(member, permFlag, targetChannel) {
  const bit = PermissionsBitField.Flags[permFlag];
  if (bit === undefined) return false;

  if (targetChannel && typeof targetChannel.permissionsFor === 'function') {
    const perms = targetChannel.permissionsFor(member);
    if (perms) return perms.has(bit);
  }

  return Boolean(member?.permissions?.has(bit));
}

function checkBotPermissions({
  guild,
  requiredPermission,
  requiredPermissions,
  targetChannel,
  targetRole,
  targetRoles,
  requestedPermFlags,
  allowManagedRoles = false,
}) {
  const me = guild?.members?.me;
  if (!me) {
    return {
      ok: false,
      error: 'Impossible de verifier les permissions du bot sur ce serveur.',
    };
  }

  const permsToCheck = normalizeRequiredPerms(requiredPermission, requiredPermissions);
  const missingBotPerms = permsToCheck.filter((p) => !hasPermission(me, p, targetChannel));
  if (missingBotPerms.length > 0) {
    return {
      ok: false,
      error:
        'Le bot n a pas la permission requise : ' +
        missingBotPerms.map(getPermissionLabel).join(', ') +
        '.',
    };
  }

  const rolesToCheck = normalizeTargetRoles(targetRole, targetRoles);
  for (const role of rolesToCheck) {
    if (!allowManagedRoles && role.managed) {
      return {
        ok: false,
        error:
          'Ce role est gere par une integration (bot), impossible de le modifier.',
      };
    }

    if (role.id === guild.id) {
      return {
        ok: false,
        error: 'Impossible de modifier le role @everyone.',
      };
    }

    if (getHighestRolePosition(me) <= role.position) {
      return {
        ok: false,
        error:
          'Le role du bot est trop bas dans la hierarchie pour modifier le role "' +
          role.name +
          '".',
      };
    }
  }

  if (
    Array.isArray(requestedPermFlags) &&
    requestedPermFlags.length > 0 &&
    !me.permissions.has(PermissionsBitField.Flags.Administrator)
  ) {
    const missing = requestedPermFlags.filter(
      (f) => !me.permissions.has(PermissionsBitField.Flags[f])
    );
    if (missing.length > 0) {
      return {
        ok: false,
        error:
          'Le bot ne possede pas les permissions necessaires pour les attribuer/retirer : ' +
          missing.join(', ') +
          '.',
      };
    }
  }

  return { ok: true };
}

function checkMemberAuthorization({
  guild,
  member,
  requiredPermission,
  requiredPermissions,
  targetChannel,
  targetRole,
  targetRoles,
  requestedPermFlags,
}) {
  if (!member) {
    return { authorized: false, reason: 'Membre introuvable.' };
  }

  const owner = isGuildOwner(guild, member);
  const permsToCheck = normalizeRequiredPerms(requiredPermission, requiredPermissions);

  if (!owner && permsToCheck.length > 0) {
    const missing = permsToCheck.filter((p) => !hasPermission(member, p, targetChannel));
    if (missing.length > 0) {
      return {
        authorized: false,
        missingPermission: missing[0],
        missingPermissions: missing,
        reason:
          'Permission(s) requise(s) : ' +
          missing.map(getPermissionLabel).join(', ') +
          '.',
      };
    }
  }

  const rolesToCheck = normalizeTargetRoles(targetRole, targetRoles);
  if (!owner) {
    for (const role of rolesToCheck) {
      if (getHighestRolePosition(member) <= role.position) {
        return {
          authorized: false,
          missingHierarchy: true,
          reason:
            'Ton role le plus haut doit etre au-dessus du role "' +
            role.name +
            '" dans la hierarchie.',
        };
      }
    }
  }

  if (
    Array.isArray(requestedPermFlags) &&
    requestedPermFlags.length > 0 &&
    !owner &&
    !member.permissions.has(PermissionsBitField.Flags.Administrator)
  ) {
    const missing = requestedPermFlags.filter(
      (f) => !member.permissions.has(PermissionsBitField.Flags[f])
    );
    if (missing.length > 0) {
      return {
        authorized: false,
        missingPermFlags: missing,
        reason:
          'Tu ne peux pas modifier des permissions que tu ne possedes pas : ' +
          missing.join(', ') +
          '.',
      };
    }
  }

  return { authorized: true };
}

module.exports = {
  PERMISSION_LABELS,
  getPermissionLabel,
  normalizeRequiredPerms,
  isGuildOwner,
  getHighestRolePosition,
  hasPermission,
  checkBotPermissions,
  checkMemberAuthorization,
};
