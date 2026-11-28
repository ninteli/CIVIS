const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AuditLogEvent, ChannelType, PermissionFlagsBits, PermissionsBitField } = require('discord.js');

const debug = require('../agent/debug');
const planner = require('../agent/planner');
const { normalizeKey, getChannelTypeLabel } = require('../agent/channel-types');
const actionLogs = require('./action-logs');
const plans = require('./plans');

const DEFAULT_DATA_DIR = path.join(__dirname, '..', '..', 'data');
const STORE_FILENAME = 'guild-suggestions.json';

const WATCHED_AUDIT_ACTIONS = new Set([
  AuditLogEvent.ChannelCreate,
  AuditLogEvent.ChannelUpdate,
  AuditLogEvent.ChannelDelete,
  AuditLogEvent.ChannelOverwriteCreate,
  AuditLogEvent.ChannelOverwriteUpdate,
  AuditLogEvent.ChannelOverwriteDelete,
  AuditLogEvent.RoleCreate,
  AuditLogEvent.RoleUpdate,
  AuditLogEvent.RoleDelete,
]);

const DEFAULT_DEBOUNCE_MS = 6000;
const DEFAULT_COOLDOWN_SEC = 45;
const MIN_COOLDOWN_SEC = 10;
const MAX_COOLDOWN_SEC = 3600;
const PROACTIVE_PLAN_TIMEOUT_MS = 300_000;

const NON_TEXT_CHANNEL_TYPES = new Set([
  ChannelType.GuildVoice,
  ChannelType.GuildCategory,
  ChannelType.GuildStageVoice,
  ChannelType.GuildDirectory,
  ChannelType.GuildForum,
  ChannelType.GuildMedia,
  2,
  4,
  13,
  14,
  15,
  16,
]);

function ensurePrivateDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dirPath, 0o700);
  } catch {
    // Best-effort permission hardening.
  }
}

function writeFileAtomic(filePath, content) {
  const dirPath = path.dirname(filePath);
  ensurePrivateDir(dirPath);
  const tmpPath = path.join(
    dirPath,
    `.${path.basename(filePath)}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`
  );
  fs.writeFileSync(tmpPath, content, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(tmpPath, 0o600);
  } catch {
    // Best-effort permission hardening.
  }
  fs.renameSync(tmpPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best-effort permission hardening.
  }
}

function normalizeGuildConfig(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      enabled: false,
      mode: 'channel',
      channelId: null,
      cooldownSec: DEFAULT_COOLDOWN_SEC,
      updatedBy: null,
      updatedAt: null,
    };
  }
  const cooldown = Number.isInteger(raw.cooldownSec)
    ? Math.min(MAX_COOLDOWN_SEC, Math.max(MIN_COOLDOWN_SEC, raw.cooldownSec))
    : DEFAULT_COOLDOWN_SEC;
  const channelId =
    typeof raw.channelId === 'string' && raw.channelId.trim() ? raw.channelId.trim() : null;
  return {
    enabled: Boolean(raw.enabled === true && channelId),
    mode: 'channel',
    channelId,
    cooldownSec: cooldown,
    updatedBy: raw.updatedBy ? String(raw.updatedBy) : null,
    updatedAt: raw.updatedAt || null,
  };
}

function createGuildSuggestionsStore(dataDir = DEFAULT_DATA_DIR) {
  const storePath = path.join(dataDir, STORE_FILENAME);

  function readAll() {
    if (!fs.existsSync(storePath)) {
      return { version: 1, guilds: {} };
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || !parsed.guilds || typeof parsed.guilds !== 'object') {
        return { version: 1, guilds: {} };
      }
      return parsed;
    } catch {
      return { version: 1, guilds: {} };
    }
  }

  function writeAll(data) {
    writeFileAtomic(storePath, JSON.stringify(data, null, 2) + '\n');
  }

  function getGuildConfig(guildId) {
    if (!guildId) return normalizeGuildConfig(null);
    const all = readAll();
    return normalizeGuildConfig(all.guilds[String(guildId)]);
  }

  function updateGuildConfig(guildId, mutator, userId = null) {
    const all = readAll();
    const key = String(guildId);
    const current = normalizeGuildConfig(all.guilds[key]);
    const next = mutator(current);
    const stored = {
      ...normalizeGuildConfig(next),
      updatedBy: userId ? String(userId) : current.updatedBy,
      updatedAt: new Date().toISOString(),
    };
    all.guilds[key] = stored;
    writeAll(all);
    return { ok: true, config: stored };
  }

  function enableSuggestions(guildId, userId = null) {
    const current = getGuildConfig(guildId);
    if (!current.channelId) {
      return {
        ok: false,
        error:
          'Aucun salon de suggestions configure. Utilise d abord `/suggestions set salon:#salon` pour choisir un salon dedie.',
      };
    }
    return updateGuildConfig(guildId, (cur) => ({ ...cur, enabled: true }), userId);
  }

  function disableSuggestions(guildId, userId = null) {
    return updateGuildConfig(guildId, (cur) => ({ ...cur, enabled: false }), userId);
  }

  function setSuggestionChannel(guildId, channelId, userId = null) {
    return updateGuildConfig(
      guildId,
      (cur) => ({
        ...cur,
        enabled: true,
        mode: 'channel',
        channelId: String(channelId),
      }),
      userId
    );
  }

  function setCooldown(guildId, seconds, userId = null) {
    const parsed = Number(seconds);
    if (!Number.isInteger(parsed) || parsed < MIN_COOLDOWN_SEC || parsed > MAX_COOLDOWN_SEC) {
      return {
        ok: false,
        error: `Le cooldown doit etre un entier entre ${MIN_COOLDOWN_SEC} et ${MAX_COOLDOWN_SEC} secondes.`,
      };
    }
    return updateGuildConfig(guildId, (cur) => ({ ...cur, cooldownSec: parsed }), userId);
  }

  function resetGuildConfig(guildId) {
    const all = readAll();
    delete all.guilds[String(guildId)];
    writeAll(all);
    return { ok: true, config: normalizeGuildConfig(null) };
  }

  return {
    getGuildConfig,
    enableSuggestions,
    disableSuggestions,
    setSuggestionChannel,
    setCooldown,
    resetGuildConfig,
  };
}

const defaultStore = createGuildSuggestionsStore(DEFAULT_DATA_DIR);

function sanitizeAuditText(raw, maxLen = 120) {
  return String(raw ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[`<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function findChangeValue(changes, key) {
  if (!Array.isArray(changes)) return null;
  return changes.find((c) => c && c.key === key) || null;
}

function formatChangeDetails(entry, guild) {
  if (!Array.isArray(entry?.changes) || entry.changes.length === 0) return [];
  const details = [];

  for (const ch of entry.changes) {
    if (!ch || !ch.key) continue;
    const key = ch.key;
    if (key === 'name' && (ch.old !== undefined || ch.new !== undefined)) {
      if (ch.old !== undefined && ch.new !== undefined && ch.old !== ch.new) {
        details.push(
          `nom: "${sanitizeAuditText(ch.old, 60)}" -> "${sanitizeAuditText(ch.new, 60)}"`
        );
      }
    } else if (key === 'topic') {
      details.push(
        ch.new ? `sujet defini ("${sanitizeAuditText(ch.new, 60)}")` : 'sujet efface'
      );
    } else if (key === 'rate_limit_per_user') {
      details.push(`cooldown: ${ch.old ?? 0}s -> ${ch.new ?? 0}s`);
    } else if (key === 'nsfw') {
      details.push(`NSFW: ${ch.new ? 'active' : 'desactive'}`);
    } else if (key === 'parent_id') {
      const cat = ch.new ? guild?.channels?.cache?.get?.(ch.new) : null;
      details.push(
        cat
          ? `categorie -> "${sanitizeAuditText(cat.name, 60)}"`
          : ch.new
            ? 'categorie modifiee'
            : 'retire de categorie'
      );
    } else if (key === 'type' && ch.new !== undefined) {
      details.push(`type: ${getChannelTypeLabel(ch.new)}`);
    } else if (key === 'color' && ch.new !== undefined) {
      const hex = '#' + Number(ch.new).toString(16).padStart(6, '0');
      details.push(`couleur -> ${hex}`);
    } else if (key === 'hoist') {
      details.push(`affiche separement: ${ch.new ? 'oui' : 'non'}`);
    } else if (key === 'mentionable') {
      details.push(`mentionnable: ${ch.new ? 'oui' : 'non'}`);
    } else if (key === 'permissions') {
      details.push('permissions globales modifiees');
    } else if (key === 'allow' || key === 'deny') {
      details.push(`${key} mis a jour`);
    }
  }

  return details.slice(0, 4);
}

function getAuditActionLabel(action, isCategory) {
  switch (action) {
    case AuditLogEvent.ChannelCreate:
      return isCategory ? 'Creation de categorie' : 'Creation de salon';
    case AuditLogEvent.ChannelUpdate:
      return isCategory ? 'Modification de categorie' : 'Modification de salon';
    case AuditLogEvent.ChannelDelete:
      return isCategory ? 'Suppression de categorie' : 'Suppression de salon';
    case AuditLogEvent.ChannelOverwriteCreate:
      return isCategory ? 'Ajout permissions sur categorie' : 'Ajout permissions sur salon';
    case AuditLogEvent.ChannelOverwriteUpdate:
      return isCategory
        ? 'Modification permissions sur categorie'
        : 'Modification permissions sur salon';
    case AuditLogEvent.ChannelOverwriteDelete:
      return isCategory
        ? 'Suppression permissions sur categorie'
        : 'Suppression permissions sur salon';
    case AuditLogEvent.RoleCreate:
      return 'Creation de role';
    case AuditLogEvent.RoleUpdate:
      return 'Modification de role';
    case AuditLogEvent.RoleDelete:
      return 'Suppression de role';
    default:
      return 'Modification serveur';
  }
}

function isRoleAction(action) {
  return (
    action === AuditLogEvent.RoleCreate ||
    action === AuditLogEvent.RoleUpdate ||
    action === AuditLogEvent.RoleDelete
  );
}

function describeAuditEntry(entry, guild) {
  const action = entry?.action;
  const targetId = entry?.targetId || entry?.target?.id || null;
  const cachedTarget = isRoleAction(action)
    ? guild?.roles?.cache?.get?.(targetId)
    : guild?.channels?.cache?.get?.(targetId);

  const typeChange = findChangeValue(entry?.changes, 'type');
  const resolvedType =
    entry?.target?.type ??
    cachedTarget?.type ??
    typeChange?.new ??
    typeChange?.old ??
    null;

  const isCategory =
    !isRoleAction(action) &&
    (resolvedType === ChannelType.GuildCategory || resolvedType === 4);

  const nameChange = findChangeValue(entry?.changes, 'name');
  const rawName =
    cachedTarget?.name ||
    entry?.target?.name ||
    nameChange?.new ||
    nameChange?.old ||
    (targetId ? `id:${targetId}` : 'inconnu');
  const targetName = sanitizeAuditText(rawName, 100) || 'inconnu';

  const actionLabel = getAuditActionLabel(action, isCategory);
  const prefix = isRoleAction(action)
    ? `role "${targetName}"`
    : isCategory
      ? `categorie "${targetName}"`
      : `salon #${targetName}${
          resolvedType !== null && resolvedType !== undefined
            ? ` (${getChannelTypeLabel(resolvedType)})`
            : ''
        }`;

  const extras = [];
  if (entry?.extra) {
    const extraId = entry.extra.id || null;
    const extraRole = extraId ? guild?.roles?.cache?.get?.(extraId) : null;
    const extraName = sanitizeAuditText(entry.extra.name || extraRole?.name || extraId, 80);
    if (extraName) {
      extras.push(`cible permission: ${extraName}`);
    }
  }
  const changeDetails = formatChangeDetails(entry, guild);
  const allDetails = [...extras, ...changeDetails];

  const summaryLine =
    `${actionLabel} : ${prefix}` +
    (allDetails.length > 0 ? ` [${allDetails.join(', ')}]` : '');

  return {
    action,
    actionLabel,
    targetId,
    targetName,
    isCategory,
    summaryLine,
    executorId: entry?.executorId || entry?.executor?.id || null,
  };
}

function formatAuditBatchPrompt(events = [], actorName = 'Utilisateur') {
  const safeActorName = sanitizeAuditText(actorName, 64) || 'Utilisateur';
  const uniqueLines = [];
  const seen = new Set();
  for (const ev of events) {
    const line = ev?.summaryLine;
    if (!line || seen.has(line)) continue;
    seen.add(line);
    uniqueLines.push(line);
  }

  const numbered = uniqueLines.map((line, i) => `${i + 1}. ${line}`).join('\n');
  const auditSummary =
    `Modifications manuelles detectees dans les Audit Logs par "${safeActorName}" :\n` +
    `<audit_log_data>\n${numbered}\n</audit_log_data>\n\n` +
    'Analyse ce contexte et propose un plan d actions complementaires uniquement si c est pertinent.';

  let shortTriggerSummary;
  if (uniqueLines.length === 0) {
    shortTriggerSummary = `Modification manuelle par ${safeActorName}`;
  } else if (uniqueLines.length === 1) {
    shortTriggerSummary = `${safeActorName} — ${uniqueLines[0]}`;
  } else {
    const shown = uniqueLines.slice(0, 3).map((l) => `- ${l}`).join('\n');
    const more = uniqueLines.length > 3 ? `\n(+ ${uniqueLines.length - 3} autre(s))` : '';
    shortTriggerSummary = `Modifications manuelles par ${safeActorName} :\n${shown}${more}`;
  }

  return {
    auditSummary,
    shortTriggerSummary: shortTriggerSummary.slice(0, 500),
  };
}

function listGuildChannels(guild) {
  const cache = guild?.channels?.cache;
  if (!cache) return [];
  if (typeof cache.values === 'function') return Array.from(cache.values());
  if (Array.isArray(cache)) return cache;
  return [];
}

function isWritableSuggestionChannel(ch) {
  if (!ch || !ch.id) return false;
  if (typeof ch.isThread === 'function' && ch.isThread()) return false;
  if (ch.type !== undefined && NON_TEXT_CHANNEL_TYPES.has(ch.type)) return false;
  if (typeof ch.send !== 'function') return false;
  if (typeof ch.isTextBased === 'function') {
    return Boolean(ch.isTextBased());
  }
  return (
    ch.type === undefined ||
    ch.type === ChannelType.GuildText ||
    ch.type === ChannelType.GuildAnnouncement ||
    ch.type === 0 ||
    ch.type === 5
  );
}

function hasBotPostPerms(channel, client) {
  if (!channel || typeof channel.permissionsFor !== 'function' || !client?.user) {
    return true;
  }
  try {
    const perms = channel.permissionsFor(client.user);
    if (!perms || typeof perms.has !== 'function') return true;
    return (
      perms.has(PermissionFlagsBits.ViewChannel) &&
      perms.has(PermissionFlagsBits.SendMessages)
    );
  } catch {
    return true;
  }
}

async function resolveChannelById(guild, channelId, client) {
  if (!guild || !channelId) return null;
  let ch = guild.channels?.cache?.get?.(channelId) || null;
  if (!ch && typeof guild.channels?.fetch === 'function') {
    try {
      ch = await guild.channels.fetch(channelId);
    } catch {
      ch = null;
    }
  }
  if (isWritableSuggestionChannel(ch) && hasBotPostPerms(ch, client)) {
    return ch;
  }
  return null;
}

async function resolveSuggestionChannel(
  guild,
  client = null,
  config = null
) {
  if (!guild) return null;
  const effectiveConfig = config || defaultStore.getGuildConfig(guild.id);

  if (!effectiveConfig.channelId) {
    return null;
  }

  return resolveChannelById(guild, effectiveConfig.channelId, client);
}

function createAuditSuggestionsManager({
  store = defaultStore,
  plannerFn = planner.buildProactivePlanFromAudit,
  createPlanFn = plans.createPlanRequest,
  hasPendingProactiveFn = plans.hasPendingProactivePlanForGuild,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  planTimeoutMs = PROACTIVE_PLAN_TIMEOUT_MS,
  debugModule = debug,
} = {}) {
  const pendingBuffers = new Map();
  const lastProposedAt = new Map();
  const inFlightGuilds = new Set();

  async function processGuildBatch(bufKey) {
    const buf = pendingBuffers.get(bufKey);
    if (!buf) {
      return { ok: false, skipped: true, reason: 'no_buffer' };
    }
    pendingBuffers.delete(bufKey);
    clearTimeout(buf.timer);

    const { guild, client, events, executorId, executor } = buf;
    const guildId = guild?.id;
    if (!guild || !guildId || !events || events.length === 0) {
      return { ok: false, skipped: true, reason: 'empty_batch' };
    }

    const config = store.getGuildConfig(guildId);
    if (!config.enabled || !config.channelId) {
      return { ok: false, skipped: true, reason: 'disabled' };
    }

    const prevTs = lastProposedAt.get(guildId) || 0;
    if (prevTs && Date.now() - prevTs < config.cooldownSec * 1000) {
      return { ok: false, skipped: true, reason: 'cooldown' };
    }

    if (inFlightGuilds.has(guildId)) {
      return { ok: false, skipped: true, reason: 'in_flight' };
    }

    if (typeof hasPendingProactiveFn === 'function' && hasPendingProactiveFn(guildId)) {
      return { ok: false, skipped: true, reason: 'pending_proactive_exists' };
    }

    inFlightGuilds.add(guildId);
    try {
      let executorMember = guild.members?.cache?.get?.(executorId) || null;
      if (!executorMember && typeof guild.members?.fetch === 'function') {
        try {
          executorMember = await guild.members.fetch(executorId);
        } catch {
          executorMember = null;
        }
      }

      if (executorMember?.user?.bot) {
        return { ok: false, skipped: true, reason: 'executor_is_bot' };
      }

      const executorUser =
        executorMember?.user || executor || { id: executorId, username: 'Membre' };
      const actorName =
        sanitizeAuditText(
          executorMember?.displayName ||
            executorUser.username ||
            executorUser.tag ||
            'Membre',
          64
        ) || 'Membre';

      const effectiveMember = executorMember || {
        id: executorId,
        user: executorUser,
        permissions: new PermissionsBitField([]),
        roles: { highest: { position: -1 } },
      };

      const targetChannel = await resolveSuggestionChannel(
        guild,
        client,
        config
      );
      if (!targetChannel) {
        console.log(
          '[audit-suggestions] Salon de suggestions introuvable ou inaccessible sur ' +
            guild.name
        );
        return { ok: false, skipped: true, reason: 'no_writable_channel' };
      }

      const { auditSummary, shortTriggerSummary } = formatAuditBatchPrompt(events, actorName);
      console.log(
        '[audit-suggestions] Analyse de ' +
          events.length +
          ' modification(s) sur ' +
          guild.name +
          ' par ' +
          actorName +
          ' -> cible #' +
          targetChannel.name
      );
      const planRes = await plannerFn({
        auditSummary,
        actorName,
        guild,
        member: effectiveMember,
        authorId: executorId,
      });

      if (!planRes || !planRes.ok || !planRes.suggest || !planRes.plan?.steps?.length) {
        const skipReason = planRes?.reason || planRes?.error || 'not_suggested';
        console.log(
          '[audit-suggestions] Aucune suggestion sur ' +
            guild.name +
            ' (' +
            skipReason +
            ')'
        );
        return {
          ok: true,
          suggested: false,
          reason: skipReason,
        };
      }

      const planId = await createPlanFn({
        interaction: null,
        channel: targetChannel,
        guild,
        requester: executorUser,
        requesterMember: effectiveMember,
        plan: planRes.plan,
        security: planRes.security,
        userText: '[Suggestion proactive - Audit Log] ' + shortTriggerSummary,
        stats: planRes.stats,
        isDebug: Boolean(debugModule?.isEnabled?.(targetChannel.id)),
        timeoutMs: planTimeoutMs,
        proactiveTrigger: {
          summary: shortTriggerSummary,
          rationale: planRes.rationale || null,
          events,
        },
      });

      if (!planId) {
        console.log(
          '[audit-suggestions] Creation du plan ignoree sur ' +
            guild.name +
            ' (plan deja en attente)'
        );
        return { ok: true, suggested: false, reason: 'plan_creation_skipped' };
      }

      lastProposedAt.set(guildId, Date.now());
      console.log(
        '[audit-suggestions] Suggestion proactive proposee sur ' +
          guild.name +
          ' (plan ' +
          planId +
          ', salon #' +
          targetChannel.name +
          ')'
      );

      return {
        ok: true,
        suggested: true,
        planId,
        channelId: targetChannel.id,
      };
    } catch (err) {
      console.error('[audit-suggestions] Erreur traitement batch :', err);
      return { ok: false, error: err?.message || String(err) };
    } finally {
      inFlightGuilds.delete(guildId);
    }
  }

  function handleAuditLogEntry(entry, guild, client = null) {
    if (!entry || !guild || !guild.id) return false;
    if (!WATCHED_AUDIT_ACTIONS.has(entry.action)) return false;

    const executorId = entry.executorId || entry.executor?.id || null;
    if (!executorId) return false;

    const botId =
      client?.user?.id || guild.client?.user?.id || guild.members?.me?.id || null;
    if (botId && executorId === botId) return false;
    if (entry.executor?.bot) return false;

    const config = store.getGuildConfig(guild.id);
    if (!config.enabled || !config.channelId) return false;

    const prevTs = lastProposedAt.get(guild.id) || 0;
    if (prevTs && Date.now() - prevTs < config.cooldownSec * 1000) {
      return false;
    }

    if (inFlightGuilds.has(guild.id)) return false;
    if (typeof hasPendingProactiveFn === 'function' && hasPendingProactiveFn(guild.id)) {
      return false;
    }

    const described = describeAuditEntry(entry, guild);
    const bufKey = `${guild.id}:${executorId}`;
    let buf = pendingBuffers.get(bufKey);
    if (!buf) {
      buf = {
        guild,
        client: client || guild.client || null,
        events: [],
        executorId,
        executor: entry.executor || null,
        timer: null,
      };
      pendingBuffers.set(bufKey, buf);
    } else {
      buf.guild = guild;
      buf.client = client || guild.client || buf.client;
      if (entry.executor) buf.executor = entry.executor;
    }

    if (buf.events.length < 10) {
      buf.events.push(described);
    }

    if (buf.timer) {
      clearTimeout(buf.timer);
    }
    buf.timer = setTimeout(() => {
      processGuildBatch(bufKey).catch((err) => {
        console.error('[audit-suggestions] Erreur batch async :', err);
      });
    }, debounceMs);

    if (typeof buf.timer.unref === 'function') {
      buf.timer.unref();
    }

    return true;
  }

  function clearAll() {
    for (const buf of pendingBuffers.values()) {
      clearTimeout(buf.timer);
    }
    pendingBuffers.clear();
    lastProposedAt.clear();
    inFlightGuilds.clear();
  }

  return {
    handleAuditLogEntry,
    processGuildBatch,
    clearAll,
  };
}

const defaultManager = createAuditSuggestionsManager();

module.exports = {
  WATCHED_AUDIT_ACTIONS,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_COOLDOWN_SEC,
  MIN_COOLDOWN_SEC,
  MAX_COOLDOWN_SEC,
  PROACTIVE_PLAN_TIMEOUT_MS,
  createGuildSuggestionsStore,
  getGuildConfig: defaultStore.getGuildConfig,
  enableSuggestions: defaultStore.enableSuggestions,
  disableSuggestions: defaultStore.disableSuggestions,
  setSuggestionChannel: defaultStore.setSuggestionChannel,
  setCooldown: defaultStore.setCooldown,
  resetGuildConfig: defaultStore.resetGuildConfig,
  describeAuditEntry,
  formatAuditBatchPrompt,
  resolveSuggestionChannel,
  createAuditSuggestionsManager,
  handleAuditLogEntry: defaultManager.handleAuditLogEntry,
  clearAll: defaultManager.clearAll,
};
