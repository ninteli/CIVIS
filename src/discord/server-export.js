const {
  ChannelType,
  PermissionsBitField,
  OverwriteType,
  GuildVerificationLevel,
  GuildExplicitContentFilter,
  GuildDefaultMessageNotifications,
  GuildMFALevel,
  GuildPremiumTier,
  GuildScheduledEventStatus,
  GuildScheduledEventEntityType,
  StickerFormatType,
  AutoModerationRuleTriggerType,
  AutoModerationActionType,
  WebhookType,
} = require('discord.js');
const { getChannelTypeLabel, isSpoilerChannel } = require('../agent/channel-types');
const { isGuildOwner, hasPermission } = require('../agent/permissions');
const { buildAiJsonGuideMarkdown } = require('./plan-import');

const VERIFICATION_LABELS = {
  [GuildVerificationLevel.None]: 'Aucun (`None`)',
  [GuildVerificationLevel.Low]: 'Faible (`Low`)',
  [GuildVerificationLevel.Medium]: 'Moyen (`Medium`)',
  [GuildVerificationLevel.High]: 'Élevé (`High`)',
  [GuildVerificationLevel.VeryHigh]: 'Très élevé (`VeryHigh`)',
};

const EXPLICIT_FILTER_LABELS = {
  [GuildExplicitContentFilter.Disabled]: 'Désactivé (`Disabled`)',
  [GuildExplicitContentFilter.MembersWithoutRoles]: 'Membres sans rôle (`MembersWithoutRoles`)',
  [GuildExplicitContentFilter.AllMembers]: 'Tous les membres (`AllMembers`)',
};

const NOTIFICATIONS_LABELS = {
  [GuildDefaultMessageNotifications.AllMessages]: 'Tous les messages (`AllMessages`)',
  [GuildDefaultMessageNotifications.OnlyMentions]: 'Mentions uniquement (`OnlyMentions`)',
};

const MFA_LABELS = {
  [GuildMFALevel.None]: 'Désactivée (`None`)',
  [GuildMFALevel.Elevated]: 'Activée (`Elevated`)',
};

const PREMIUM_TIER_LABELS = {
  [GuildPremiumTier.None]: 'Aucun (Niveau 0)',
  [GuildPremiumTier.Tier1]: 'Niveau 1',
  [GuildPremiumTier.Tier2]: 'Niveau 2',
  [GuildPremiumTier.Tier3]: 'Niveau 3',
};

const EVENT_STATUS_LABELS = {
  [GuildScheduledEventStatus.Scheduled]: 'Planifié (`Scheduled`)',
  [GuildScheduledEventStatus.Active]: 'En cours (`Active`)',
  [GuildScheduledEventStatus.Completed]: 'Terminé (`Completed`)',
  [GuildScheduledEventStatus.Canceled]: 'Annulé (`Canceled`)',
};

const STICKER_FORMAT_LABELS = {
  [StickerFormatType.PNG]: 'PNG',
  [StickerFormatType.APNG]: 'APNG',
  [StickerFormatType.Lottie]: 'Lottie',
  [StickerFormatType.GIF]: 'GIF',
};

const AUTOMOD_TRIGGER_LABELS = {
  [AutoModerationRuleTriggerType.Keyword]: 'Mots-clés (`Keyword`)',
  [AutoModerationRuleTriggerType.Spam]: 'Spam (`Spam`)',
  [AutoModerationRuleTriggerType.KeywordPreset]: 'Liste prédéfinie (`KeywordPreset`)',
  [AutoModerationRuleTriggerType.MentionSpam]: 'Spam de mentions (`MentionSpam`)',
  [AutoModerationRuleTriggerType.MemberProfile]: 'Profil membre (`MemberProfile`)',
};

const AUTOMOD_ACTION_LABELS = {
  [AutoModerationActionType.BlockMessage]: 'Bloquer le message',
  [AutoModerationActionType.SendAlertMessage]: 'Alerte salon',
  [AutoModerationActionType.Timeout]: 'Exclusion temporaire (Timeout)',
  [AutoModerationActionType.BlockMemberInteraction]: 'Bloquer interactions membre',
};

const WEBHOOK_TYPE_LABELS = {
  [WebhookType.Incoming]: 'Incoming',
  [WebhookType.ChannelFollower]: 'ChannelFollower',
  [WebhookType.Application]: 'Application',
};

const THREAD_CHANNEL_TYPES = new Set([
  ChannelType.AnnouncementThread,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
]);

function isThreadChannelType(type) {
  return THREAD_CHANNEL_TYPES.has(type);
}

function getExtendedChannelTypeLabel(type) {
  if (type === ChannelType.GuildMedia) return 'media';
  if (type === ChannelType.GuildDirectory) return 'annuaire';
  if (type === ChannelType.AnnouncementThread) return 'Thread annonce';
  if (type === ChannelType.PublicThread) return 'Thread public';
  if (type === ChannelType.PrivateThread) return 'Thread privé';
  return getChannelTypeLabel(type);
}

function escapeMdCell(value) {
  const str = String(value ?? '').trim();
  if (!str) return '—';
  return str.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function formatIsoDate(value) {
  if (!value) return '—';
  try {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toISOString();
  } catch {
    return '—';
  }
}

function sanitizeExportFilename(guildName, now = new Date()) {
  const slug =
    String(guildName || 'serveur')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) || 'serveur';

  const d = now instanceof Date ? now : new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    '-' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes());

  return `export-${slug}-${stamp}.md`;
}

function resolveMemberAccess(guild, member) {
  const owner = isGuildOwner(guild, member);
  const isAdmin = owner || hasPermission(member, 'Administrator');
  const canManageGuild = isAdmin || hasPermission(member, 'ManageGuild');
  const canManageWebhooks = canManageGuild || hasPermission(member, 'ManageWebhooks');
  const canBanMembers = isAdmin || hasPermission(member, 'BanMembers');

  return {
    isOwner: owner,
    isAdminOrOwner: isAdmin,
    canViewInvites: canManageGuild,
    canViewWebhooks: canManageWebhooks,
    canViewAutoMod: canManageGuild,
    canViewBans: canBanMembers,
    canViewCivisConfig: canManageGuild,
  };
}

function canMemberViewChannel(channel, member, guild) {
  if (!channel) return false;
  if (!member) return false;
  if (isGuildOwner(guild, member) || hasPermission(member, 'Administrator')) {
    return true;
  }
  if (typeof channel.permissionsFor === 'function') {
    const perms = channel.permissionsFor(member);
    if (perms && typeof perms.has === 'function') {
      return perms.has(PermissionsBitField.Flags.ViewChannel);
    }
  }
  return false;
}

function botHasPerm(guild, permName) {
  const me = guild?.members?.me;
  if (!me) return false;
  return hasPermission(me, 'Administrator') || hasPermission(me, permName);
}

function toArray(collectionOrIterable) {
  if (!collectionOrIterable) return [];
  if (Array.isArray(collectionOrIterable)) return collectionOrIterable;
  if (typeof collectionOrIterable.values === 'function') {
    return Array.from(collectionOrIterable.values());
  }
  return [];
}

async function safeFetch(fn, fallback = null) {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, data: fallback, error: err?.message || String(err) };
  }
}

function extractPermissionNames(bitfieldLike) {
  if (!bitfieldLike) return [];
  if (typeof bitfieldLike.toArray === 'function') {
    return bitfieldLike.toArray();
  }
  try {
    return new PermissionsBitField(bitfieldLike).toArray();
  } catch {
    return [];
  }
}

function extractOverwrites(channel, guild) {
  const rawList = toArray(channel?.permissionOverwrites?.cache);
  const result = [];
  for (const ow of rawList) {
    const allow = extractPermissionNames(ow.allow);
    const deny = extractPermissionNames(ow.deny);
    if (allow.length === 0 && deny.length === 0) continue;

    const isRole = ow.type === OverwriteType.Role || ow.type === 0 || ow.type === 'role';
    let targetLabel;
    if (isRole) {
      const role = guild?.roles?.cache?.get?.(ow.id);
      const roleName = role ? role.name : `Rôle ${ow.id}`;
      targetLabel = roleName === '@everyone' ? 'Rôle `@everyone`' : `Rôle \`${roleName}\``;
    } else {
      const cachedMember = guild?.members?.cache?.get?.(ow.id);
      const userLabel = cachedMember?.user?.username || cachedMember?.displayName || null;
      targetLabel = userLabel ? `Membre \`${userLabel}\` (\`${ow.id}\`)` : `Membre \`${ow.id}\``;
    }

    result.push({
      id: ow.id,
      type: isRole ? 'role' : 'member',
      targetLabel,
      allow,
      deny,
    });
  }
  return result;
}

function sortChannelsInGroup(channels) {
  const voiceRank = (type) =>
    type === ChannelType.GuildVoice || type === ChannelType.GuildStageVoice ? 1 : 0;
  return [...channels].sort((a, b) => {
    const vr = voiceRank(a.type) - voiceRank(b.type);
    if (vr !== 0) return vr;
    const posA = typeof a.rawPosition === 'number' ? a.rawPosition : a.position ?? 0;
    const posB = typeof b.rawPosition === 'number' ? b.rawPosition : b.position ?? 0;
    if (posA !== posB) return posA - posB;
    return String(a.id || '').localeCompare(String(b.id || ''));
  });
}

function serializeChannel(channel, guild) {
  const overwrites = extractOverwrites(channel, guild);
  const tags = Array.isArray(channel.availableTags)
    ? channel.availableTags.map((t) => t?.name).filter(Boolean)
    : [];

  return {
    id: channel.id,
    name: channel.name,
    type: channel.type,
    typeLabel: getExtendedChannelTypeLabel(channel.type),
    position: typeof channel.rawPosition === 'number' ? channel.rawPosition : channel.position ?? 0,
    parentId: channel.parentId || null,
    topic: channel.topic || null,
    nsfw: Boolean(channel.nsfw),
    rateLimitPerUser: Number(channel.rateLimitPerUser) || 0,
    spoiler: isSpoilerChannel(channel),
    permissionsLocked: channel.permissionsLocked === true,
    bitrate: typeof channel.bitrate === 'number' ? channel.bitrate : null,
    userLimit: typeof channel.userLimit === 'number' ? channel.userLimit : null,
    rtcRegion: channel.rtcRegion || null,
    tags,
    overwrites,
  };
}

function formatSpecialChannelRef(channel, member, guild) {
  if (!channel) return null;
  if (!canMemberViewChannel(channel, member, guild)) return null;
  const prefix =
    channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice
      ? ''
      : '#';
  return `${prefix}${channel.name} (\`${channel.id}\`)`;
}

async function collectServerData({
  guild,
  member,
  client,
  actionLogs = null,
  auditSuggestions = null,
  now = new Date(),
}) {
  const access = resolveMemberAccess(guild, member);
  const requesterUser = member?.user || null;

  // 1. Proprietaire
  let ownerDisplay = guild.ownerId ? `\`${guild.ownerId}\`` : 'Inconnu';
  if (typeof guild.fetchOwner === 'function') {
    const ownerRes = await safeFetch(() => guild.fetchOwner());
    if (ownerRes.ok && ownerRes.data) {
      const o = ownerRes.data;
      const oName = o.user?.username || o.displayName;
      ownerDisplay = oName ? `\`${oName}\` (\`${o.id || guild.ownerId}\`)` : ownerDisplay;
    }
  } else if (guild.ownerId && guild.members?.cache?.get?.(guild.ownerId)) {
    const o = guild.members.cache.get(guild.ownerId);
    const oName = o.user?.username || o.displayName;
    if (oName) ownerDisplay = `\`${oName}\` (\`${guild.ownerId}\`)`;
  }

  // Vanity URL (si disponible)
  let vanity = null;
  if (guild.vanityURLCode) {
    vanity = {
      code: guild.vanityURLCode,
      uses: typeof guild.vanityURLUses === 'number' ? guild.vanityURLUses : null,
    };
  }

  const general = {
    name: guild.name || 'Serveur sans nom',
    id: guild.id || '—',
    ownerDisplay,
    createdAt: formatIsoDate(guild.createdAt || (guild.createdTimestamp ? new Date(guild.createdTimestamp) : null)),
    description: guild.description || null,
    preferredLocale: guild.preferredLocale || '—',
    memberCount: typeof guild.memberCount === 'number' ? guild.memberCount : null,
    premiumTier: PREMIUM_TIER_LABELS[guild.premiumTier] || String(guild.premiumTier ?? '—'),
    premiumSubscriptionCount: Number(guild.premiumSubscriptionCount) || 0,
    verificationLevel: VERIFICATION_LABELS[guild.verificationLevel] || String(guild.verificationLevel ?? '—'),
    explicitContentFilter:
      EXPLICIT_FILTER_LABELS[guild.explicitContentFilter] || String(guild.explicitContentFilter ?? '—'),
    defaultMessageNotifications:
      NOTIFICATIONS_LABELS[guild.defaultMessageNotifications] ||
      String(guild.defaultMessageNotifications ?? '—'),
    mfaLevel: MFA_LABELS[guild.mfaLevel] || String(guild.mfaLevel ?? '—'),
    vanity,
    features: Array.isArray(guild.features) ? [...guild.features] : [],
    iconUrl: typeof guild.iconURL === 'function' ? guild.iconURL({ size: 512 }) : null,
    bannerUrl: typeof guild.bannerURL === 'function' ? guild.bannerURL({ size: 512 }) : null,
    splashUrl: typeof guild.splashURL === 'function' ? guild.splashURL({ size: 512 }) : null,
    specialChannels: {
      system: formatSpecialChannelRef(guild.systemChannel, member, guild),
      rules: formatSpecialChannelRef(guild.rulesChannel, member, guild),
      publicUpdates: formatSpecialChannelRef(guild.publicUpdatesChannel, member, guild),
      afk: formatSpecialChannelRef(guild.afkChannel, member, guild),
      afkTimeout: guild.afkChannel && canMemberViewChannel(guild.afkChannel, member, guild)
        ? guild.afkTimeout || 0
        : null,
    },
  };

  // 2. Roles
  const roles = toArray(guild.roles?.cache)
    .sort((a, b) => (b.position ?? 0) - (a.position ?? 0))
    .map((r) => {
      const perms = extractPermissionNames(r.permissions);
      let managedLabel = 'Non';
      if (r.managed) {
        if (r.tags?.botId) managedLabel = 'Oui (bot)';
        else if (r.tags?.premiumSubscriberRole) managedLabel = 'Oui (boost)';
        else if (r.tags?.integrationId) managedLabel = 'Oui (intégration)';
        else managedLabel = 'Oui';
      }
      return {
        id: r.id,
        name: r.name,
        position: r.position ?? 0,
        hexColor: r.hexColor && r.hexColor !== '#000000' ? r.hexColor.toUpperCase() : null,
        hoist: Boolean(r.hoist),
        mentionable: Boolean(r.mentionable),
        managedLabel,
        permissions: perms,
      };
    });

  // 3. Categories & salons (strictement filtres selon ViewChannel du membre)
  const allChannels = toArray(guild.channels?.cache);
  const allCategories = allChannels
    .filter((c) => c.type === ChannelType.GuildCategory)
    .sort((a, b) => {
      const posA = typeof a.rawPosition === 'number' ? a.rawPosition : a.position ?? 0;
      const posB = typeof b.rawPosition === 'number' ? b.rawPosition : b.position ?? 0;
      return posA - posB;
    });

  const visibleNonCategoryChannels = allChannels.filter(
    (c) =>
      c.type !== ChannelType.GuildCategory &&
      !isThreadChannelType(c.type) &&
      canMemberViewChannel(c, member, guild)
  );

  const visibleByParent = new Map();
  const uncategorized = [];
  for (const ch of visibleNonCategoryChannels) {
    if (ch.parentId) {
      if (!visibleByParent.has(ch.parentId)) visibleByParent.set(ch.parentId, []);
      visibleByParent.get(ch.parentId).push(ch);
    } else {
      uncategorized.push(ch);
    }
  }

  const categories = [];
  for (const cat of allCategories) {
    const children = visibleByParent.get(cat.id) || [];
    const catVisible = canMemberViewChannel(cat, member, guild);
    // Ne jamais fuiter une categorie privee sans aucun salon visible
    if (!catVisible && children.length === 0) continue;
    categories.push({
      id: cat.id,
      name: cat.name,
      position: typeof cat.rawPosition === 'number' ? cat.rawPosition : cat.position ?? 0,
      overwrites: catVisible ? extractOverwrites(cat, guild) : [],
      channels: sortChannelsInGroup(children).map((c) => serializeChannel(c, guild)),
    });
  }

  const uncategorizedSerialized = sortChannelsInGroup(uncategorized).map((c) =>
    serializeChannel(c, guild)
  );

  // 4. Threads actifs (filtres aux parents visibles et au thread visible)
  let activeThreads = [];
  if (typeof guild.channels?.fetchActiveThreads === 'function') {
    const tRes = await safeFetch(() => guild.channels.fetchActiveThreads());
    if (tRes.ok && tRes.data?.threads) {
      activeThreads = toArray(tRes.data.threads);
    }
  } else {
    activeThreads = allChannels.filter((c) => isThreadChannelType(c.type) && !c.archived);
  }

  const visibleThreads = activeThreads
    .filter((t) => {
      const parent = t.parent || (t.parentId ? guild.channels?.cache?.get?.(t.parentId) : null);
      if (parent && !canMemberViewChannel(parent, member, guild)) return false;
      return canMemberViewChannel(t, member, guild);
    })
    .map((t) => {
      const parent = t.parent || (t.parentId ? guild.channels?.cache?.get?.(t.parentId) : null);
      return {
        id: t.id,
        name: t.name,
        parentName: parent ? `#${parent.name}` : t.parentId ? `\`${t.parentId}\`` : '—',
        typeLabel: getExtendedChannelTypeLabel(t.type),
        locked: Boolean(t.locked),
        autoArchiveDuration: t.autoArchiveDuration || null,
        messageCount: typeof t.messageCount === 'number' ? t.messageCount : null,
        memberCount: typeof t.memberCount === 'number' ? t.memberCount : null,
      };
    });

  // 5. Ressources (emojis, stickers, evenements planifies)
  let emojisRaw = toArray(guild.emojis?.cache);
  if (typeof guild.emojis?.fetch === 'function') {
    const res = await safeFetch(() => guild.emojis.fetch());
    if (res.ok && res.data) emojisRaw = toArray(res.data);
  }
  const emojis = emojisRaw.map((e) => ({
    id: e.id,
    name: e.name,
    animated: Boolean(e.animated),
    available: e.available !== false,
  }));

  let stickersRaw = toArray(guild.stickers?.cache);
  if (typeof guild.stickers?.fetch === 'function') {
    const res = await safeFetch(() => guild.stickers.fetch());
    if (res.ok && res.data) stickersRaw = toArray(res.data);
  }
  const stickers = stickersRaw.map((s) => ({
    id: s.id,
    name: s.name,
    format: STICKER_FORMAT_LABELS[s.format] || String(s.format ?? '—'),
    description: s.description || null,
  }));

  let eventsRaw = toArray(guild.scheduledEvents?.cache);
  if (typeof guild.scheduledEvents?.fetch === 'function') {
    const res = await safeFetch(() => guild.scheduledEvents.fetch());
    if (res.ok && res.data) eventsRaw = toArray(res.data);
  }
  const scheduledEvents = eventsRaw
    .filter((ev) => {
      // Si l'evenement est lie a un salon prive, ne pas le fuiter a un membre qui ne peut pas le voir
      if (ev.channelId) {
        const ch = ev.channel || guild.channels?.cache?.get?.(ev.channelId);
        if (ch && !canMemberViewChannel(ch, member, guild)) return false;
      }
      return true;
    })
    .map((ev) => {
      let location = '—';
      if (ev.entityType === GuildScheduledEventEntityType.External) {
        location = ev.entityMetadata?.location || 'Externe';
      } else if (ev.channel) {
        location = ev.channel.name;
      } else if (ev.channelId) {
        const ch = guild.channels?.cache?.get?.(ev.channelId);
        location = ch ? ch.name : `\`${ev.channelId}\``;
      }
      return {
        id: ev.id,
        name: ev.name,
        status: EVENT_STATUS_LABELS[ev.status] || String(ev.status ?? '—'),
        scheduledStartAt: formatIsoDate(ev.scheduledStartAt || ev.scheduledStartTimestamp),
        location,
        userCount: typeof ev.userCount === 'number' ? ev.userCount : null,
        description: ev.description || null,
      };
    });

  // 6. Moderation & Integrations (uniquement si le membre a la permission correspondante)
  const moderation = {
    automod: null,
    invites: null,
    webhooks: null,
    bans: null,
  };

  if (access.canViewAutoMod) {
    if (!botHasPerm(guild, 'ManageGuild')) {
      moderation.automod = { unavailableReason: 'Permission bot `ManageGuild` manquante.' };
    } else if (typeof guild.autoModerationRules?.fetch === 'function') {
      const res = await safeFetch(() => guild.autoModerationRules.fetch());
      if (res.ok) {
        const rules = toArray(res.data).map((rule) => {
          const actions = (Array.isArray(rule.actions) ? rule.actions : []).map((a) => {
            const base = AUTOMOD_ACTION_LABELS[a.type] || `Action(${a.type})`;
            if (a.type === AutoModerationActionType.SendAlertMessage && a.metadata?.channelId) {
              const alertCh = guild.channels?.cache?.get?.(a.metadata.channelId);
              if (alertCh && canMemberViewChannel(alertCh, member, guild)) {
                return `${base} (#${alertCh.name})`;
              }
            }
            return base;
          });
          return {
            id: rule.id,
            name: rule.name,
            enabled: Boolean(rule.enabled),
            trigger: AUTOMOD_TRIGGER_LABELS[rule.triggerType] || String(rule.triggerType ?? '—'),
            actions,
          };
        });
        moderation.automod = { items: rules };
      } else {
        moderation.automod = { unavailableReason: `Impossible de récupérer AutoMod (${res.error}).` };
      }
    } else {
      moderation.automod = { items: [] };
    }
  }

  if (access.canViewInvites) {
    if (!botHasPerm(guild, 'ManageGuild')) {
      moderation.invites = { unavailableReason: 'Permission bot `ManageGuild` manquante.' };
    } else if (typeof guild.invites?.fetch === 'function') {
      const res = await safeFetch(() => guild.invites.fetch());
      if (res.ok) {
        const items = toArray(res.data)
          .filter((inv) => {
            if (!inv.channel) return true;
            return canMemberViewChannel(inv.channel, member, guild);
          })
          .map((inv) => ({
            code: inv.code,
            channelName: inv.channel ? `#${inv.channel.name}` : '—',
            inviter: inv.inviter?.username || '—',
            uses: typeof inv.uses === 'number' ? inv.uses : 0,
            maxUses: inv.maxUses ? String(inv.maxUses) : '∞',
            expiresAt: inv.expiresAt ? formatIsoDate(inv.expiresAt) : 'Jamais',
          }));
        moderation.invites = { items };
      } else {
        moderation.invites = { unavailableReason: `Impossible de récupérer les invitations (${res.error}).` };
      }
    } else {
      moderation.invites = { items: [] };
    }
  }

  if (access.canViewWebhooks) {
    if (!botHasPerm(guild, 'ManageWebhooks')) {
      moderation.webhooks = { unavailableReason: 'Permission bot `ManageWebhooks` manquante.' };
    } else if (typeof guild.fetchWebhooks === 'function') {
      const res = await safeFetch(() => guild.fetchWebhooks());
      if (res.ok) {
        const items = toArray(res.data)
          .filter((wh) => {
            if (!wh.channelId) return true;
            const ch = guild.channels?.cache?.get?.(wh.channelId);
            return !ch || canMemberViewChannel(ch, member, guild);
          })
          .map((wh) => {
            const ch = wh.channelId ? guild.channels?.cache?.get?.(wh.channelId) : null;
            // Securite : ne JAMAIS copier wh.token ni wh.url
            return {
              id: wh.id,
              name: wh.name || 'Sans nom',
              channelName: ch ? `#${ch.name}` : wh.channelId ? `\`${wh.channelId}\`` : '—',
              type: WEBHOOK_TYPE_LABELS[wh.type] || String(wh.type ?? '—'),
            };
          });
        moderation.webhooks = { items };
      } else {
        moderation.webhooks = { unavailableReason: `Impossible de récupérer les webhooks (${res.error}).` };
      }
    } else {
      moderation.webhooks = { items: [] };
    }
  }

  if (access.canViewBans) {
    if (!botHasPerm(guild, 'BanMembers')) {
      moderation.bans = { unavailableReason: 'Permission bot `BanMembers` manquante.' };
    } else if (typeof guild.bans?.fetch === 'function') {
      const res = await safeFetch(() => guild.bans.fetch());
      if (res.ok) {
        const count =
          typeof res.data?.size === 'number'
            ? res.data.size
            : Array.isArray(res.data)
              ? res.data.length
              : 0;
        moderation.bans = { count };
      } else {
        moderation.bans = { unavailableReason: `Impossible de récupérer les bannissements (${res.error}).` };
      }
    } else {
      moderation.bans = { count: 0 };
    }
  }

  // 7. Configuration CIVIS (uniquement si ManageGuild / Admin)
  let civisConfig = null;
  if (access.canViewCivisConfig) {
    let logsInfo = null;
    if (actionLogs && typeof actionLogs.getGuildLogStatus === 'function') {
      const st = actionLogs.getGuildLogStatus(guild.id);
      const ch = st.channelId ? guild.channels?.cache?.get?.(st.channelId) : null;
      logsInfo = {
        enabled: st.enabled !== false && st.mode !== 'off',
        mode: st.mode || 'auto',
        channelDisplay: ch ? `#${ch.name} (\`${ch.id}\`)` : st.channelId ? `\`${st.channelId}\`` : null,
        maskedWebhookUrl: st.maskedWebhookUrl || null,
      };
    }

    let suggestionsInfo = null;
    if (auditSuggestions && typeof auditSuggestions.getGuildConfig === 'function') {
      const cfg = auditSuggestions.getGuildConfig(guild.id);
      const ch = cfg.channelId ? guild.channels?.cache?.get?.(cfg.channelId) : null;
      suggestionsInfo = {
        enabled: cfg.enabled !== false,
        mode: cfg.mode || 'auto',
        channelDisplay: ch ? `#${ch.name} (\`${ch.id}\`)` : cfg.channelId ? `\`${cfg.channelId}\`` : null,
        cooldownSec: cfg.cooldownSec,
      };
    }

    civisConfig = { logs: logsInfo, suggestions: suggestionsInfo };
  }

  const totalVisibleChannels =
    uncategorizedSerialized.length +
    categories.reduce((sum, cat) => sum + cat.channels.length, 0);

  return {
    exportedAt: formatIsoDate(now),
    requester: {
      id: requesterUser?.id || member?.id || '—',
      name: requesterUser?.username || member?.displayName || 'Inconnu',
    },
    botName: client?.user?.username || 'CIVIS',
    access,
    general,
    roles,
    categories,
    uncategorized: uncategorizedSerialized,
    threads: visibleThreads,
    resources: {
      emojis,
      stickers,
      scheduledEvents,
    },
    moderation,
    civisConfig,
    stats: {
      rolesCount: roles.length,
      categoriesCount: categories.length,
      channelsCount: totalVisibleChannels,
      threadsCount: visibleThreads.length,
      emojisCount: emojis.length,
      stickersCount: stickers.length,
      eventsCount: scheduledEvents.length,
      hasModerationSection: Boolean(
        moderation.automod || moderation.invites || moderation.webhooks || moderation.bans
      ),
      hasCivisSection: Boolean(civisConfig),
    },
  };
}

function renderChannelBullet(ch) {
  const lines = [];
  const prefix =
    ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice ? '' : '#';
  lines.push(`- **${prefix}${ch.name}** (\`${ch.typeLabel}\`, ID : \`${ch.id}\`)`);

  if (ch.topic) {
    lines.push(`  - **Sujet** : ${ch.topic.replace(/\r?\n/g, ' ')}`);
  }

  const opts = [];
  if (ch.nsfw) opts.push('NSFW');
  if (ch.rateLimitPerUser > 0) opts.push(`Slowmode \`${ch.rateLimitPerUser}s\``);
  if (ch.spoiler) opts.push('Spoiler');
  if (ch.permissionsLocked) opts.push('Synchronisé avec la catégorie');
  if (opts.length > 0) {
    lines.push(`  - **Options** : ${opts.join(', ')}`);
  }

  if (ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice) {
    const audioParts = [];
    if (ch.bitrate) audioParts.push(`Bitrate \`${Math.round(ch.bitrate / 1000)} kbps\``);
    audioParts.push(`Limite \`${ch.userLimit > 0 ? ch.userLimit + ' membres' : 'illimitée'}\``);
    audioParts.push(`Région \`${ch.rtcRegion || 'auto'}\``);
    lines.push(`  - **Audio** : ${audioParts.join(', ')}`);
  }

  if (ch.tags.length > 0) {
    lines.push(`  - **Tags** : ${ch.tags.map((t) => `\`${t}\``).join(', ')}`);
  }

  if (ch.overwrites.length > 0) {
    lines.push('  - **Permissions spécifiques (overwrites)** :');
    for (const ow of ch.overwrites) {
      const parts = [];
      if (ow.allow.length > 0) {
        parts.push('✅ ' + ow.allow.map((p) => `\`${p}\``).join(', '));
      }
      if (ow.deny.length > 0) {
        parts.push('❌ ' + ow.deny.map((p) => `\`${p}\``).join(', '));
      }
      lines.push(`    - ${ow.targetLabel} : ${parts.join(' | ')}`);
    }
  }

  return lines.join('\n');
}

function renderServerMarkdown(data, { includeAiGuide = true } = {}) {
  const {
    exportedAt,
    requester,
    botName,
    access,
    general,
    roles,
    categories,
    uncategorized,
    threads,
    resources,
    moderation,
    civisConfig,
    stats,
  } = data;

  const scopeLabel = access.isAdminOrOwner
    ? 'Complet (Administrateur)'
    : 'Filtré selon vos permissions';

  const lines = [];
  lines.push(`# Export du serveur Discord — ${general.name}`);
  lines.push('');
  lines.push(`- **Généré le** : \`${exportedAt}\``);
  lines.push(`- **Demandé par** : \`${requester.name}\` (\`${requester.id}\`)`);
  lines.push(`- **Périmètre** : ${scopeLabel}`);
  lines.push(`- **Bot** : ${botName}`);
  lines.push('');

  // Sommaire
  let nextSectionNum = 6;
  const modSectionNum = stats.hasModerationSection ? nextSectionNum++ : null;
  const civisSectionNum = stats.hasCivisSection ? nextSectionNum++ : null;
  const aiGuideSectionNum = includeAiGuide ? nextSectionNum++ : null;

  lines.push('## Sommaire');
  lines.push('');
  lines.push('1. [Informations générales](#1-informations-générales)');
  lines.push('2. [Rôles](#2-rôles)');
  lines.push('3. [Catégories, salons & permissions](#3-catégories-salons--permissions)');
  lines.push('4. [Fils de discussion actifs (Threads)](#4-fils-de-discussion-actifs-threads)');
  lines.push('5. [Ressources du serveur](#5-ressources-du-serveur)');
  if (modSectionNum) {
    lines.push(`${modSectionNum}. [Modération & Intégrations](#${modSectionNum}-modération--intégrations)`);
  }
  if (civisSectionNum) {
    lines.push(`${civisSectionNum}. [Configuration CIVIS](#${civisSectionNum}-configuration-civis)`);
  }
  if (aiGuideSectionNum) {
    lines.push(
      `${aiGuideSectionNum}. [Guide pour IA externe (Format JSON CIVIS)](#${aiGuideSectionNum}-guide-pour-ia-externe-format-json-civis)`
    );
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // Section 1 : Informations generales
  lines.push('## 1. Informations générales');
  lines.push('');
  lines.push('| Propriété | Valeur |');
  lines.push('| --- | --- |');
  lines.push(`| Nom | ${escapeMdCell(general.name)} |`);
  lines.push(`| ID | \`${general.id}\` |`);
  lines.push(`| Propriétaire | ${escapeMdCell(general.ownerDisplay)} |`);
  lines.push(`| Créé le | \`${general.createdAt}\` |`);
  lines.push(`| Description | ${escapeMdCell(general.description || '*(aucune)*')} |`);
  lines.push(`| Langue préférée | \`${general.preferredLocale}\` |`);
  lines.push(
    `| Membres (total) | ${general.memberCount !== null ? String(general.memberCount) : '—'} |`
  );
  lines.push(
    `| Niveau de boost | ${general.premiumTier} (${general.premiumSubscriptionCount} boost(s)) |`
  );
  lines.push(`| Niveau de vérification | ${general.verificationLevel} |`);
  lines.push(`| Filtre de contenu explicite | ${general.explicitContentFilter} |`);
  lines.push(`| Notifications par défaut | ${general.defaultMessageNotifications} |`);
  lines.push(`| Double authentification (MFA modération) | ${general.mfaLevel} |`);
  if (general.vanity) {
    const usesText = general.vanity.uses !== null ? ` (${general.vanity.uses} utilisations)` : '';
    lines.push(`| URL personnalisée (Vanity) | \`discord.gg/${general.vanity.code}\`${usesText} |`);
  }
  lines.push('');

  const sp = general.specialChannels;
  lines.push('### Salons spéciaux');
  lines.push('');
  lines.push(`- **Salon système** : ${sp.system || '*(aucun ou non accessible)*'}`);
  lines.push(`- **Salon des règles** : ${sp.rules || '*(aucun ou non accessible)*'}`);
  lines.push(`- **Mises à jour communauté** : ${sp.publicUpdates || '*(aucun ou non accessible)*'}`);
  lines.push(
    `- **Salon AFK** : ${
      sp.afk ? `${sp.afk}${sp.afkTimeout ? ` (délai : ${sp.afkTimeout}s)` : ''}` : '*(aucun ou non accessible)*'
    }`
  );
  lines.push('');

  lines.push('### Fonctionnalités Discord activées');
  lines.push('');
  lines.push(
    general.features.length > 0
      ? general.features.map((f) => `\`${f}\``).join(', ')
      : '*(aucune)*'
  );
  lines.push('');

  lines.push('### Médias');
  lines.push('');
  lines.push(`- **Icône** : ${general.iconUrl || '*(aucune)*'}`);
  lines.push(`- **Bannière** : ${general.bannerUrl || '*(aucune)*'}`);
  lines.push(`- **Splash d'invitation** : ${general.splashUrl || '*(aucune)*'}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // Section 2 : Roles
  lines.push(`## 2. Rôles (${roles.length})`);
  lines.push('');
  if (roles.length === 0) {
    lines.push('*(Aucun rôle trouvé)*');
  } else {
    lines.push(
      '| Pos. | Rôle | ID | Couleur | Affiché séparément | Mentionnable | Géré (bot/boost) | Permissions |'
    );
    lines.push('| ---: | --- | --- | --- | :---: | :---: | :---: | --- |');
    for (const r of roles) {
      const roleLabel = r.name === '@everyone' ? '`@everyone`' : escapeMdCell(r.name);
      const colorLabel = r.hexColor ? `\`${r.hexColor}\`` : '*(aucune)*';
      const permsText = r.permissions.includes('Administrator')
        ? '`Administrator`'
        : r.permissions.length > 0
          ? r.permissions.map((p) => `\`${p}\``).join(', ')
          : '*(aucune)*';
      lines.push(
        `| ${r.position} | ${roleLabel} | \`${r.id}\` | ${colorLabel} | ${r.hoist ? 'Oui' : 'Non'} | ${r.mentionable ? 'Oui' : 'Non'} | ${r.managedLabel} | ${escapeMdCell(permsText)} |`
      );
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // Section 3 : Categories & salons
  lines.push('## 3. Catégories, salons & permissions');
  lines.push('');
  lines.push(
    `> **Résumé** : ${stats.categoriesCount} catégorie(s), ${stats.channelsCount} salon(s) visible(s).`
  );
  lines.push('');

  if (uncategorized.length > 0) {
    lines.push('### Salons hors catégorie');
    lines.push('');
    for (const ch of uncategorized) {
      lines.push(renderChannelBullet(ch));
    }
    lines.push('');
  }

  for (const cat of categories) {
    lines.push(`### Catégorie : ${cat.name} (\`${cat.id}\`)`);
    lines.push('');
    if (cat.overwrites.length > 0) {
      lines.push('- **Permissions de la catégorie** :');
      for (const ow of cat.overwrites) {
        const parts = [];
        if (ow.allow.length > 0) parts.push('✅ ' + ow.allow.map((p) => `\`${p}\``).join(', '));
        if (ow.deny.length > 0) parts.push('❌ ' + ow.deny.map((p) => `\`${p}\``).join(', '));
        lines.push(`  - ${ow.targetLabel} : ${parts.join(' | ')}`);
      }
    }
    if (cat.channels.length === 0) {
      lines.push('*(Aucun salon visible dans cette catégorie)*');
    } else {
      for (const ch of cat.channels) {
        lines.push(renderChannelBullet(ch));
      }
    }
    lines.push('');
  }

  if (uncategorized.length === 0 && categories.length === 0) {
    lines.push('*(Aucun salon visible)*');
    lines.push('');
  }

  lines.push('---');
  lines.push('');

  // Section 4 : Threads actifs
  lines.push(`## 4. Fils de discussion actifs (Threads) (${threads.length})`);
  lines.push('');
  if (threads.length === 0) {
    lines.push('*(Aucun fil de discussion actif visible)*');
  } else {
    lines.push('| Nom | ID | Salon parent | Type | Verrouillé | Auto-archive | Messages | Membres |');
    lines.push('| --- | --- | --- | --- | :---: | --- | ---: | ---: |');
    for (const t of threads) {
      const archive = t.autoArchiveDuration ? `${t.autoArchiveDuration} min` : '—';
      lines.push(
        `| ${escapeMdCell(t.name)} | \`${t.id}\` | ${escapeMdCell(t.parentName)} | ${escapeMdCell(t.typeLabel)} | ${t.locked ? 'Oui' : 'Non'} | ${archive} | ${t.messageCount ?? '—'} | ${t.memberCount ?? '—'} |`
      );
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // Section 5 : Ressources
  lines.push('## 5. Ressources du serveur');
  lines.push('');

  lines.push(`### Emojis personnalisés (${resources.emojis.length})`);
  lines.push('');
  if (resources.emojis.length === 0) {
    lines.push('*(Aucun emoji personnalisé)*');
  } else {
    lines.push('| Nom | ID | Animé | Disponible |');
    lines.push('| --- | --- | :---: | :---: |');
    for (const e of resources.emojis) {
      lines.push(
        `| \`:${escapeMdCell(e.name)}:\` | \`${e.id}\` | ${e.animated ? 'Oui' : 'Non'} | ${e.available ? 'Oui' : 'Non'} |`
      );
    }
  }
  lines.push('');

  lines.push(`### Stickers (${resources.stickers.length})`);
  lines.push('');
  if (resources.stickers.length === 0) {
    lines.push('*(Aucun sticker personnalisé)*');
  } else {
    lines.push('| Nom | ID | Format | Description |');
    lines.push('| --- | --- | --- | --- |');
    for (const s of resources.stickers) {
      lines.push(
        `| \`${escapeMdCell(s.name)}\` | \`${s.id}\` | ${escapeMdCell(s.format)} | ${escapeMdCell(s.description || '—')} |`
      );
    }
  }
  lines.push('');

  lines.push(`### Événements planifiés (${resources.scheduledEvents.length})`);
  lines.push('');
  if (resources.scheduledEvents.length === 0) {
    lines.push('*(Aucun événement planifié)*');
  } else {
    for (const ev of resources.scheduledEvents) {
      lines.push(`- **${ev.name}** (ID : \`${ev.id}\`)`);
      lines.push(`  - **Statut** : ${ev.status}`);
      lines.push(`  - **Début** : \`${ev.scheduledStartAt}\``);
      lines.push(`  - **Lieu** : ${ev.location}`);
      if (ev.userCount !== null) {
        lines.push(`  - **Intéressés** : ${ev.userCount}`);
      }
      if (ev.description) {
        lines.push(`  - **Description** : ${ev.description.replace(/\r?\n/g, ' ')}`);
      }
    }
  }
  lines.push('');

  // Section 6 : Moderation & Integrations
  if (stats.hasModerationSection) {
    lines.push('---');
    lines.push('');
    lines.push('## 6. Modération & Intégrations');
    lines.push('');

    if (moderation.automod) {
      if (moderation.automod.unavailableReason) {
        lines.push('### Règles AutoMod');
        lines.push('');
        lines.push(`> ${moderation.automod.unavailableReason}`);
      } else {
        const items = moderation.automod.items || [];
        lines.push(`### Règles AutoMod (${items.length})`);
        lines.push('');
        if (items.length === 0) {
          lines.push('*(Aucune règle AutoMod configurée)*');
        } else {
          lines.push('| Nom | ID | Active | Déclencheur | Actions |');
          lines.push('| --- | --- | :---: | --- | --- |');
          for (const rule of items) {
            lines.push(
              `| ${escapeMdCell(rule.name)} | \`${rule.id}\` | ${rule.enabled ? 'Oui' : 'Non'} | ${escapeMdCell(rule.trigger)} | ${escapeMdCell(rule.actions.join(', ') || '—')} |`
            );
          }
        }
      }
      lines.push('');
    }

    if (moderation.invites) {
      if (moderation.invites.unavailableReason) {
        lines.push('### Invitations actives');
        lines.push('');
        lines.push(`> ${moderation.invites.unavailableReason}`);
      } else {
        const items = moderation.invites.items || [];
        lines.push(`### Invitations actives (${items.length})`);
        lines.push('');
        if (items.length === 0) {
          lines.push('*(Aucune invitation active)*');
        } else {
          lines.push('| Code | Salon | Créateur | Utilisations | Expire le |');
          lines.push('| --- | --- | --- | --- | --- |');
          for (const inv of items) {
            lines.push(
              `| \`${escapeMdCell(inv.code)}\` | ${escapeMdCell(inv.channelName)} | ${escapeMdCell(inv.inviter)} | \`${inv.uses} / ${inv.maxUses}\` | ${escapeMdCell(inv.expiresAt)} |`
            );
          }
        }
      }
      lines.push('');
    }

    if (moderation.webhooks) {
      if (moderation.webhooks.unavailableReason) {
        lines.push('### Webhooks');
        lines.push('');
        lines.push(`> ${moderation.webhooks.unavailableReason}`);
      } else {
        const items = moderation.webhooks.items || [];
        lines.push(`### Webhooks (${items.length})`);
        lines.push('');
        lines.push('> *Par sécurité, aucun token ni URL secrète de webhook n\'est exporté.*');
        lines.push('');
        if (items.length === 0) {
          lines.push('*(Aucun webhook visible)*');
        } else {
          lines.push('| Nom | ID | Salon | Type |');
          lines.push('| --- | --- | --- | --- |');
          for (const wh of items) {
            lines.push(
              `| ${escapeMdCell(wh.name)} | \`${wh.id}\` | ${escapeMdCell(wh.channelName)} | ${escapeMdCell(wh.type)} |`
            );
          }
        }
      }
      lines.push('');
    }

    if (moderation.bans) {
      lines.push('### Bannissements');
      lines.push('');
      if (moderation.bans.unavailableReason) {
        lines.push(`> ${moderation.bans.unavailableReason}`);
      } else {
        lines.push(`- **Nombre total de bannissements** : \`${moderation.bans.count}\``);
      }
      lines.push('');
    }
  }

  // Section 7 : Configuration CIVIS
  if (stats.hasCivisSection && civisConfig) {
    const sectionNum = stats.hasModerationSection ? 7 : 6;
    lines.push('---');
    lines.push('');
    lines.push(`## ${sectionNum}. Configuration CIVIS`);
    lines.push('');
    if (civisConfig.logs) {
      const l = civisConfig.logs;
      let logDetail;
      if (!l.enabled) {
        logDetail = 'Désactivé (`/logs off`)';
      } else if (l.mode === 'webhook') {
        logDetail = `Actif — Webhook personnalisé chiffré (\`${l.maskedWebhookUrl || 'masqué'}\`)`;
      } else if (l.mode === 'channel') {
        logDetail = `Actif — Salon configuré (${l.channelDisplay || 'inconnu'})`;
      } else {
        logDetail = 'Actif — Détection automatique (`#logs`)';
      }
      lines.push(`- **Logs (\`/logs\`)** : ${logDetail}`);
    }
    if (civisConfig.suggestions) {
      const s = civisConfig.suggestions;
      const sugDetail = !s.enabled
        ? 'Désactivées (`/suggestions off`)'
        : s.channelDisplay
          ? `Actives — Salon configuré (${s.channelDisplay}), cooldown \`${s.cooldownSec}s\``
          : `Actives — Aucun salon configuré, cooldown \`${s.cooldownSec}s\``;
      lines.push(`- **Suggestions proactives (\`/suggestions\`)** : ${sugDetail}`);
    }
    lines.push('');
  }

  // Section finale : Guide pour IA externe (Format JSON CIVIS)
  if (aiGuideSectionNum) {
    lines.push('---');
    lines.push('');
    lines.push(`## ${aiGuideSectionNum}. Guide pour IA externe (Format JSON CIVIS)`);
    lines.push('');
    lines.push(buildAiJsonGuideMarkdown());
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}

async function buildServerExport({
  guild,
  member,
  client,
  actionLogs = null,
  auditSuggestions = null,
  includeAiGuide = true,
  now = new Date(),
}) {
  const data = await collectServerData({
    guild,
    member,
    client,
    actionLogs,
    auditSuggestions,
    now,
  });
  const markdown = renderServerMarkdown(data, { includeAiGuide });
  const filename = sanitizeExportFilename(guild?.name, now);

  return {
    filename,
    markdown,
    bytes: Buffer.byteLength(markdown, 'utf8'),
    stats: data.stats,
    access: data.access,
    data,
  };
}

module.exports = {
  resolveMemberAccess,
  canMemberViewChannel,
  sanitizeExportFilename,
  escapeMdCell,
  collectServerData,
  renderServerMarkdown,
  buildServerExport,
};
