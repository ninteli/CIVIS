const { ChannelType } = require('discord.js');
const { normalizeKey, extractSnowflakeId, isManagedChannelType } = require('./channel-types');
const { isGuildOwner } = require('./permissions');

const LOCKOUT_DURATION_MS = 10 * 60 * 1000; // 10 minutes
const BURST_WINDOW_MS = 2 * 60 * 1000; // Fenetre glissante 2 minutes

// Seuils anti-nuke pour les non-proprietaires
const MAX_PLAN_DELETIONS_NON_OWNER = 2;
const MAX_PLAN_ARCHIVES_NON_OWNER = 3;
const MAX_PLAN_CREATIONS_NON_OWNER = 6;
const MAX_PLAN_MUTATIONS_NON_OWNER = 10;
const MAX_PLAN_DELETION_RATIO = 0.25; // > 25% des salons ou roles existants
const MAX_DUPLICATE_CHANNEL_NAMES = 3; // >= 4 salons de meme nom / prefixe

// Seuils anti-rafale (fenetre glissante 2 min)
const MAX_BURST_DELETIONS = 3;
const MAX_BURST_ARCHIVES = 4;
const MAX_BURST_CREATIONS = 6;
const MAX_BURST_MUTATIONS = 10;
const PRUNE_THRESHOLD = 500;
const MAX_TRACKED_ENTRIES = 2000;

const PROTECTED_TOPIC_MARKERS = [
  'ne touche pas a ca civis',
  'do not touch civis',
];

const PROTECTED_CHANNEL_KEYWORDS = [
  'logs',
  'civis-logs',
  'ninteli-logs',
  'bot-logs',
  'mod-logs',
  'admin-logs',
  'audit-logs',
  'securite',
  'security',
  'anti-raid',
  'antiraid',
  'anti-nuke',
  'antinuke',
  'regles',
  'reglement',
  'rules',
];

const RAID_NAME_PATTERNS = [
  /\braid\s+by\b/i,
  /\braided\s+by\b/i,
  /\bnuked?\s+by\b/i,
  /\bhacked\s+by\b/i,
  /\bowned\s+by\b/i,
  /\bpwned\s+by\b/i,
  /\bfucked\s+by\b/i,
  /\bdetruit\s+par\b/i,
];

const WRITE_TOOLS = new Set([
  'create_channel',
  'create_category',
  'create_role',
  'modify_channel',
  'modify_role_display',
  'modify_role_perm',
  'delete_channel',
  'delete_role',
  'archive_channel',
  'archive_role',
  'set_channel_permissions',
]);

const CREATION_TOOLS = new Set(['create_channel', 'create_category', 'create_role']);
const DELETION_TOOLS = new Set(['delete_channel', 'delete_role']);
const ARCHIVE_TOOLS = new Set(['archive_channel', 'archive_role']);

// Etat en memoire : lockouts (guildId:userId -> { expiresAt, reason, triggeredAt })
const userLockouts = new Map();
// Historique glissant (guildId:userId -> [{ ts, kind }])
const burstHistory = new Map();

function makeUserKey(guildId, userId) {
  return `${String(guildId || '')}:${String(userId || '')}`;
}

function hasProtectedTopicMarker(topic) {
  const norm = normalizeKey(topic || '').replace(/\s+/g, ' ');
  if (!norm) return false;
  return PROTECTED_TOPIC_MARKERS.some((marker) => norm.includes(marker));
}

function isProtectedChannelName(name) {
  const norm = normalizeKey(name || '');
  if (!norm) return false;
  // Extraire les tokens alphabetiques (ex: "🔒・securite" -> "securite", "📜・regles" -> "regles")
  const tokens = norm.split(/[^a-z0-9-]+/).filter(Boolean);
  for (const kw of PROTECTED_CHANNEL_KEYWORDS) {
    if (norm === kw || tokens.includes(kw)) {
      return true;
    }
    if (tokens.some((t) => t === kw || t.endsWith('-' + kw) || t.startsWith(kw + '-'))) {
      return true;
    }
  }
  return false;
}

function checkProtectedChannel(channel, guild, { actionLogs = null, member = null } = {}) {
  if (!channel || !guild) return { protected: false };

  // 1. Salon configure dans /logs
  if (actionLogs && typeof actionLogs.getGuildLogStatus === 'function') {
    try {
      const status = actionLogs.getGuildLogStatus(guild.id);
      if (status?.channelId && status.channelId === channel.id) {
        return {
          protected: true,
          code: 'configured_logs',
          reason: `Le salon #${channel.name} est le salon de logs configure de CIVIS.`,
        };
      }
    } catch {
      // Ignore store read error
    }
  }

  // 2. Salon des regles Discord
  const rulesId = guild.rulesChannelId || guild.rulesChannel?.id || null;
  if (rulesId && rulesId === channel.id) {
    return {
      protected: true,
      code: 'rules_channel',
      reason: `Le salon #${channel.name} est le salon des regles officiel du serveur.`,
    };
  }

  // 3. Salon de mises a jour Discord (Communaute)
  const updatesId = guild.publicUpdatesChannelId || guild.publicUpdatesChannel?.id || null;
  if (updatesId && updatesId === channel.id) {
    return {
      protected: true,
      code: 'public_updates_channel',
      reason: `Le salon #${channel.name} est le salon officiel des mises a jour Discord.`,
    };
  }

  // 4. Description / topic protege
  if (hasProtectedTopicMarker(channel.topic)) {
    return {
      protected: true,
      code: 'protected_topic',
      reason: `Le salon #${channel.name} porte la mention de protection dans sa description ("NE TOUCHE PAS A CA CIVIS" / "DO NOT TOUCH CIVIS").`,
    };
  }

  // 5. Salon vital de logs, regles ou securite (par nom)
  // Desactive pour le proprietaire du serveur (les protections 1 a 4 restent actives pour tous)
  if (!isGuildOwner(guild, member) && isProtectedChannelName(channel.name)) {
    return {
      protected: true,
      code: 'vital_channel_name',
      reason: `Le salon #${channel.name} est identifie comme un salon vital (logs, regles ou securite).`,
    };
  }

  return { protected: false };
}

function matchesRaidNamePattern(name) {
  const str = String(name || '').trim();
  if (!str) return false;
  return RAID_NAME_PATTERNS.some((re) => re.test(str));
}

function resolveChannelInGuild(guild, rawRef) {
  if (!guild?.channels?.cache || !rawRef) return null;
  const clean = String(rawRef).trim().replace(/^#/, '');
  const id = extractSnowflakeId(clean);
  if (id) {
    const byId = guild.channels.cache.get(id);
    return byId && isManagedChannelType(byId.type) ? byId : null;
  }
  const lower = clean.toLowerCase();
  const norm = normalizeKey(clean);
  for (const ch of guild.channels.cache.values()) {
    if (!isManagedChannelType(ch.type)) continue;
    if (ch.name.toLowerCase() === lower || normalizeKey(ch.name) === norm) {
      return ch;
    }
  }
  return null;
}

function inspectPlanForAntiNuke(plan, guild, member, { actionLogs = null } = {}) {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  if (steps.length === 0) {
    return { blocked: false, protectedViolation: null, triggers: [] };
  }

  // 1. Verification absolue des salons vitaux (pour tout le monde, y compris proprietaire)
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const isProtectedCheckTool =
      step.tool === 'delete_channel' ||
      step.tool === 'archive_channel' ||
      step.tool === 'modify_channel' ||
      (step.tool === 'set_channel_permissions' && step.args?.target_type !== 'category');
    if (isProtectedCheckTool) {
      const target = resolveChannelInGuild(guild, step.args?.channel);
      if (target) {
        const prot = checkProtectedChannel(target, guild, { actionLogs, member });
        if (prot.protected) {
          return {
            blocked: true,
            protectedViolation: {
              stepIndex: i,
              channelId: target.id,
              channelName: target.name,
              code: prot.code,
              reason: prot.reason,
            },
            requiresOwnerApproval: false,
            triggers: ['protected_channel'],
            reason: `Etape ${i + 1} (${step.tool}) bloquee : ${prot.reason}`,
          };
        }
      }
    }
  }

  // 2. Le proprietaire du serveur n'est pas restreint par les seuils anti-nuke de masse
  if (isGuildOwner(guild, member)) {
    return { blocked: false, protectedViolation: null, triggers: [] };
  }

  // 3. Analyse anti-nuke pour les non-proprietaires
  let deletions = 0;
  let archives = 0;
  let channelDeletions = 0;
  let roleDeletions = 0;
  let creations = 0;
  let mutations = 0;
  const createdChannelNameCounts = new Map();
  const createdPrefixCounts = new Map();
  const raidNamedTargets = [];

  for (const step of steps) {
    if (WRITE_TOOLS.has(step.tool)) mutations += 1;
    if (DELETION_TOOLS.has(step.tool)) {
      deletions += 1;
      if (step.tool === 'delete_channel') channelDeletions += 1;
      if (step.tool === 'delete_role') roleDeletions += 1;
    }
    if (ARCHIVE_TOOLS.has(step.tool)) {
      archives += 1;
    }
    if (CREATION_TOOLS.has(step.tool)) {
      creations += 1;
    }

    const candidateName =
      step.tool === 'create_channel' || step.tool === 'create_category' || step.tool === 'create_role'
        ? step.args?.name
        : step.tool === 'modify_channel' || step.tool === 'modify_role_display'
          ? step.args?.new_name
          : null;

    if (candidateName) {
      if (matchesRaidNamePattern(candidateName)) {
        raidNamedTargets.push(String(candidateName).trim());
      }
      if (step.tool === 'create_channel') {
        const normName = normalizeKey(candidateName).replace(/\d+$/g, '').replace(/-+$/g, '').trim();
        if (normName) {
          createdChannelNameCounts.set(normName, (createdChannelNameCounts.get(normName) || 0) + 1);
          const prefix = normName.split(/[\s-]+/).slice(0, 2).join('-');
          if (prefix.length >= 4) {
            createdPrefixCounts.set(prefix, (createdPrefixCounts.get(prefix) || 0) + 1);
          }
        }
      }
    }
  }

  const triggers = [];
  const reasons = [];

  if (raidNamedTargets.length > 0) {
    triggers.push('raid_name_pattern');
    reasons.push(
      `Motif de raid detecte dans les noms (${raidNamedTargets.slice(0, 3).map((n) => `"${n}"`).join(', ')})`
    );
  }

  if (deletions > MAX_PLAN_DELETIONS_NON_OWNER) {
    triggers.push('mass_deletion');
    reasons.push(
      `Trop de suppressions dans un meme plan (${deletions} > limite ${MAX_PLAN_DELETIONS_NON_OWNER})`
    );
  }

  if (archives > MAX_PLAN_ARCHIVES_NON_OWNER) {
    triggers.push('mass_archive');
    reasons.push(
      `Trop d archivages dans un meme plan (${archives} > limite ${MAX_PLAN_ARCHIVES_NON_OWNER})`
    );
  } else if (deletions + archives > MAX_PLAN_ARCHIVES_NON_OWNER) {
    triggers.push('mass_archive');
    reasons.push(
      `Trop de suppressions/archivages combines dans un meme plan (${deletions + archives} > limite ${MAX_PLAN_ARCHIVES_NON_OWNER})`
    );
  }

  if (guild?.channels?.cache && channelDeletions > 0) {
    const existingChannels = Array.from(guild.channels.cache.values()).filter((c) =>
      isManagedChannelType(c.type)
    ).length;
    if (existingChannels >= 4 && channelDeletions / existingChannels > MAX_PLAN_DELETION_RATIO) {
      triggers.push('mass_channel_ratio');
      reasons.push(
        `Suppression de ${channelDeletions}/${existingChannels} salons (> ${Math.round(MAX_PLAN_DELETION_RATIO * 100)}%)`
      );
    }
  }

  if (guild?.roles?.cache && roleDeletions > 0) {
    const existingRoles = Array.from(guild.roles.cache.values()).filter(
      (r) => r.id !== guild.id && !r.managed
    ).length;
    if (existingRoles >= 4 && roleDeletions / existingRoles > MAX_PLAN_DELETION_RATIO) {
      triggers.push('mass_role_ratio');
      reasons.push(
        `Suppression de ${roleDeletions}/${existingRoles} roles (> ${Math.round(MAX_PLAN_DELETION_RATIO * 100)}%)`
      );
    }
  }

  const maxDupName = Math.max(0, ...createdChannelNameCounts.values());
  const maxDupPrefix = Math.max(0, ...createdPrefixCounts.values());
  if (maxDupName > MAX_DUPLICATE_CHANNEL_NAMES || maxDupPrefix > MAX_DUPLICATE_CHANNEL_NAMES + 1) {
    triggers.push('spam_channel_names');
    reasons.push('Creation repetitive de salons au nom ou prefixe identique (spam/raid suspecte)');
  }

  if (creations > MAX_PLAN_CREATIONS_NON_OWNER) {
    triggers.push('mass_creation');
    reasons.push(
      `Creation en masse de ${creations} elements (> limite ${MAX_PLAN_CREATIONS_NON_OWNER} pour un non-proprietaire)`
    );
  }

  if (mutations > MAX_PLAN_MUTATIONS_NON_OWNER) {
    triggers.push('mass_mutation');
    reasons.push(
      `Modifications en masse (${mutations} actions > limite ${MAX_PLAN_MUTATIONS_NON_OWNER} pour un non-proprietaire)`
    );
  }

  if (triggers.length > 0) {
    return {
      blocked: true,
      protectedViolation: null,
      requiresOwnerApproval: true,
      triggers,
      reason: reasons.join(' ; '),
    };
  }

  return { blocked: false, protectedViolation: null, triggers: [] };
}

function checkUserLockout(guildId, userId, now = Date.now()) {
  if (!guildId || !userId) return { locked: false };
  const key = makeUserKey(guildId, userId);
  const entry = userLockouts.get(key);
  if (!entry) return { locked: false };

  if (now >= entry.expiresAt) {
    userLockouts.delete(key);
    return { locked: false };
  }

  const remainingMs = entry.expiresAt - now;
  const remainingSec = Math.max(1, Math.ceil(remainingMs / 1000));
  return {
    locked: true,
    remainingMs,
    remainingSec,
    expiresAt: entry.expiresAt,
    reason: entry.reason,
  };
}

function pruneMemory(now = Date.now()) {
  if (userLockouts.size > PRUNE_THRESHOLD) {
    for (const [k, entry] of userLockouts.entries()) {
      if (!entry || now >= entry.expiresAt) {
        userLockouts.delete(k);
      }
    }
    while (userLockouts.size > MAX_TRACKED_ENTRIES) {
      const oldestKey = userLockouts.keys().next().value;
      if (oldestKey === undefined) break;
      userLockouts.delete(oldestKey);
    }
  }
  if (burstHistory.size > PRUNE_THRESHOLD) {
    const cutoff = now - BURST_WINDOW_MS;
    for (const [k, list] of burstHistory.entries()) {
      const fresh = Array.isArray(list) ? list.filter((ev) => ev.ts >= cutoff) : [];
      if (fresh.length === 0) {
        burstHistory.delete(k);
      } else if (fresh.length !== list.length) {
        burstHistory.set(k, fresh);
      }
    }
    while (burstHistory.size > MAX_TRACKED_ENTRIES) {
      const oldestKey = burstHistory.keys().next().value;
      if (oldestKey === undefined) break;
      burstHistory.delete(oldestKey);
    }
  }
}

function triggerLockout(guildId, userId, reason, { durationMs = LOCKOUT_DURATION_MS, now = Date.now() } = {}) {
  if (!guildId || !userId) return null;
  pruneMemory(now);
  const key = makeUserKey(guildId, userId);
  const entry = {
    guildId: String(guildId),
    userId: String(userId),
    triggeredAt: now,
    expiresAt: now + durationMs,
    reason: String(reason || 'Activite suspecte detectee par l anti-nuke.'),
  };
  userLockouts.delete(key);
  userLockouts.set(key, entry);
  return entry;
}

function unlockUser(guildId, userId) {
  if (!guildId || !userId) return false;
  const key = makeUserKey(guildId, userId);
  const existed = userLockouts.delete(key);
  burstHistory.delete(key);
  return existed;
}

function classifyToolKind(toolName) {
  if (DELETION_TOOLS.has(toolName)) return 'deletion';
  if (ARCHIVE_TOOLS.has(toolName)) return 'archive';
  if (CREATION_TOOLS.has(toolName)) return 'creation';
  if (WRITE_TOOLS.has(toolName)) return 'mutation';
  return 'read';
}

function recordBurstActivity(
  guild,
  member,
  { toolName = null, kind = null, count = 1, now = Date.now() } = {}
) {
  if (!guild?.id || !member?.id) return { blocked: false };
  if (isGuildOwner(guild, member)) return { blocked: false };

  const effectiveKind = kind || (toolName ? classifyToolKind(toolName) : 'mutation');
  if (effectiveKind === 'read') return { blocked: false };

  pruneMemory(now);
  const key = makeUserKey(guild.id, member.id);
  const existing = burstHistory.get(key) || [];
  const cutoff = now - BURST_WINDOW_MS;
  const fresh = existing.filter((ev) => ev.ts >= cutoff);

  for (let i = 0; i < count; i += 1) {
    fresh.push({ ts: now, kind: effectiveKind });
  }
  burstHistory.delete(key);
  burstHistory.set(key, fresh);

  let deletions = 0;
  let archives = 0;
  let creations = 0;
  const totalMutations = fresh.length;
  for (const ev of fresh) {
    if (ev.kind === 'deletion') deletions += 1;
    if (ev.kind === 'archive') archives += 1;
    if (ev.kind === 'creation') creations += 1;
  }

  let reason = null;
  if (deletions > MAX_BURST_DELETIONS) {
    reason = `Rafale de suppressions detectee (${deletions} suppressions en 2 min)`;
  } else if (archives > MAX_BURST_ARCHIVES || deletions + archives > MAX_BURST_ARCHIVES) {
    reason = `Rafale d archivages/suppressions detectee (${deletions + archives} actions en 2 min)`;
  } else if (creations > MAX_BURST_CREATIONS) {
    reason = `Rafale de creations detectee (${creations} creations en 2 min)`;
  } else if (totalMutations > MAX_BURST_MUTATIONS) {
    reason = `Rafale de modifications en masse detectee (${totalMutations} actions en 2 min)`;
  }

  if (reason) {
    const lock = triggerLockout(guild.id, member.id, reason, { now });
    return {
      blocked: true,
      locked: true,
      remainingSec: Math.ceil(LOCKOUT_DURATION_MS / 1000),
      expiresAt: lock.expiresAt,
      reason,
    };
  }

  return { blocked: false, counts: { deletions, archives, creations, totalMutations } };
}

function clearAll() {
  userLockouts.clear();
  burstHistory.clear();
}

module.exports = {
  LOCKOUT_DURATION_MS,
  BURST_WINDOW_MS,
  ARCHIVE_TOOLS,
  MAX_PLAN_DELETIONS_NON_OWNER,
  MAX_PLAN_ARCHIVES_NON_OWNER,
  MAX_PLAN_CREATIONS_NON_OWNER,
  MAX_PLAN_MUTATIONS_NON_OWNER,
  MAX_DUPLICATE_CHANNEL_NAMES,
  MAX_BURST_DELETIONS,
  MAX_BURST_ARCHIVES,
  MAX_BURST_CREATIONS,
  MAX_BURST_MUTATIONS,
  PROTECTED_TOPIC_MARKERS,
  hasProtectedTopicMarker,
  isProtectedChannelName,
  checkProtectedChannel,
  matchesRaidNamePattern,
  inspectPlanForAntiNuke,
  checkUserLockout,
  triggerLockout,
  unlockUser,
  recordBurstActivity,
  classifyToolKind,
  clearAll,
};
