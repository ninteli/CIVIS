const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebhookClient, PermissionFlagsBits } = require('discord.js');
const masterKeyLib = require('../agent/master-key');
const {
  COLORS,
  buildV2Card,
  buildV2Message,
  estimateV2Metrics,
  formatDiscordTimestamp,
} = require('./ui-v2');

const DEFAULT_DATA_DIR = path.join(__dirname, '..', '..', 'data');
const STORE_FILENAME = 'guild-logs.json';
const MASTER_KEY_FILENAME = '.master.key';
const KEY_SALT = 'ninteli-guild-logs-v1';
const LOG_WEBHOOK_NAME = 'CIVIS Logs';

const DISCORD_WEBHOOK_RE =
  /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/(\d{17,22})\/([A-Za-z0-9._-]+)\/?$/;

const LOG_CHANNEL_CANDIDATES = [
  'logs',
  'civis-logs',
  'ninteli-logs',
  'bot-logs',
  'mod-logs',
  'admin-logs',
  'log',
];

const NON_TEXT_CHANNEL_TYPES = new Set([2, 4, 13, 14, 15, 16]);

const webhookCache = new Map();

function truncate(text, maxLen = 1024) {
  const str = String(text ?? '').trim();
  if (!str) return '—';
  if (str.length <= maxLen) return str;
  if (maxLen <= 3) return str.slice(0, maxLen);
  return str.slice(0, maxLen - 3) + '...';
}

function formatJsonBlock(value, maxLen = 1024) {
  let raw;
  try {
    raw = JSON.stringify(value ?? {}, null, 2);
  } catch {
    raw = String(value ?? '{}');
  }
  const overhead = '```json\n\n```'.length;
  const innerMax = Math.max(16, maxLen - overhead);
  const body = raw.length <= innerMax ? raw : raw.slice(0, innerMax - 3) + '...';
  return '```json\n' + body + '\n```';
}

function validateDiscordWebhookUrl(rawUrl) {
  if (typeof rawUrl !== 'string') {
    return { ok: false, error: 'URL de webhook invalide : chaine attendue.' };
  }
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { ok: false, error: 'URL de webhook vide.' };
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: 'URL de webhook mal formee.' };
  }

  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    return {
      ok: false,
      error: 'URL de webhook Discord invalide (HTTPS Discord sans parametres requis).',
    };
  }

  const canonical = parsed.origin + parsed.pathname.replace(/\/+$/, '');
  const match = DISCORD_WEBHOOK_RE.exec(canonical);
  if (!match) {
    return {
      ok: false,
      error:
        'Seules les URLs de webhook Discord officielles (https://discord.com/api/webhooks/<id>/<token>) sont acceptees.',
    };
  }

  return {
    ok: true,
    url: canonical,
    webhookId: match[1],
    token: match[2],
  };
}

function maskWebhookUrl(rawUrl) {
  const validation = validateDiscordWebhookUrl(rawUrl);
  if (!validation.ok) return 'url-invalide';
  const parsed = new URL(validation.url);
  const tail = validation.token.slice(-4);
  return `${parsed.origin}/api/webhooks/${validation.webhookId}/••••${tail}`;
}

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

function createGuildLogStore(dataDir = DEFAULT_DATA_DIR, options = {}) {
  const storePath = path.join(dataDir, STORE_FILENAME);
  // Par defaut (tests / stores isoles) la cle reste dans dataDir ;
  // le store de production passe un chemin HORS de data/ (voir defaultStore).
  const masterKeyPath = options.masterKeyPath || path.join(dataDir, MASTER_KEY_FILENAME);
  const legacyMasterKeyPaths = Array.isArray(options.legacyMasterKeyPaths)
    ? options.legacyMasterKeyPaths
    : [];
  let cachedEnvSecret;
  let cachedMasterKey = null;

  function getMasterKey() {
    const envSecret = process.env.KEY_ENCRYPTION_SECRET;
    if (envSecret && envSecret.trim()) {
      if (cachedMasterKey && cachedEnvSecret === envSecret) {
        return cachedMasterKey;
      }
      cachedEnvSecret = envSecret;
      cachedMasterKey = crypto.scryptSync(envSecret.trim(), KEY_SALT, 32);
      return cachedMasterKey;
    }

    if (cachedMasterKey && !cachedEnvSecret) {
      return cachedMasterKey;
    }

    cachedEnvSecret = null;
    cachedMasterKey = masterKeyLib.loadOrCreateFileMasterKey({
      keyPath: masterKeyPath,
      legacyPaths: legacyMasterKeyPaths,
    });
    return cachedMasterKey;
  }

  function buildWebhookAad(guildId) {
    return Buffer.from('civis-guild-log-v2:' + String(guildId || ''), 'utf8');
  }

  function encryptSecret(plainText, aad = null) {
    const key = getMasterKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    if (aad) {
      cipher.setAAD(aad);
    }
    const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      v: aad ? 2 : 1,
      alg: 'aes-256-gcm',
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      data: encrypted.toString('base64'),
    };
  }

  function decryptSecret(payload, aad = null) {
    if (!payload || payload.alg !== 'aes-256-gcm' || !payload.iv || !payload.tag || !payload.data) {
      return null;
    }
    const ivBuf = Buffer.from(payload.iv, 'base64');
    const tagBuf = Buffer.from(payload.tag, 'base64');
    if (ivBuf.length !== 12 || tagBuf.length !== 16) {
      return null;
    }
    const key = getMasterKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, ivBuf, {
      authTagLength: 16,
    });
    if (payload.v === 2) {
      if (!aad) return null;
      decipher.setAAD(aad);
    }
    decipher.setAuthTag(tagBuf);
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(payload.data, 'base64')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  }

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

  function writeAll(store) {
    writeFileAtomic(storePath, JSON.stringify(store, null, 2) + '\n');
  }

  function getRawEntry(guildId) {
    if (!guildId) return null;
    const all = readAll();
    return all.guilds[String(guildId)] || null;
  }

  function setLogChannel(guildId, channelId, userId = null) {
    const all = readAll();
    const entry = {
      enabled: true,
      mode: 'channel',
      channelId: String(channelId),
      webhookUrlEnc: null,
      updatedBy: userId ? String(userId) : null,
      updatedAt: new Date().toISOString(),
    };
    all.guilds[String(guildId)] = entry;
    writeAll(all);
    return { ok: true, config: getGuildLogStatus(guildId) };
  }

  function setWebhookUrl(guildId, rawWebhookUrl, userId = null) {
    const validation = validateDiscordWebhookUrl(rawWebhookUrl);
    if (!validation.ok) {
      return { ok: false, error: validation.error };
    }
    const all = readAll();
    all.guilds[String(guildId)] = {
      enabled: true,
      mode: 'webhook',
      channelId: null,
      webhookUrlEnc: encryptSecret(validation.url, buildWebhookAad(guildId)),
      updatedBy: userId ? String(userId) : null,
      updatedAt: new Date().toISOString(),
    };
    writeAll(all);
    return {
      ok: true,
      maskedUrl: maskWebhookUrl(validation.url),
      config: getGuildLogStatus(guildId),
    };
  }

  function disableLogs(guildId, userId = null) {
    const all = readAll();
    all.guilds[String(guildId)] = {
      enabled: false,
      mode: 'off',
      channelId: null,
      webhookUrlEnc: null,
      updatedBy: userId ? String(userId) : null,
      updatedAt: new Date().toISOString(),
    };
    writeAll(all);
    return { ok: true, config: getGuildLogStatus(guildId) };
  }

  function resetLogs(guildId) {
    const all = readAll();
    delete all.guilds[String(guildId)];
    writeAll(all);
    return { ok: true, config: getGuildLogStatus(guildId) };
  }

  function getGuildLogConfig(guildId) {
    const raw = getRawEntry(guildId);
    if (!raw) {
      return {
        enabled: true,
        mode: 'auto',
        channelId: null,
        webhookUrl: null,
        hasWebhook: false,
        updatedBy: null,
        updatedAt: null,
      };
    }

    let webhookUrl = null;
    let decryptError = false;
    if (raw.webhookUrlEnc) {
      try {
        webhookUrl = decryptSecret(raw.webhookUrlEnc, buildWebhookAad(guildId));
      } catch {
        webhookUrl = null;
        decryptError = true;
      }
    }

    return {
      enabled: raw.enabled !== false && raw.mode !== 'off',
      mode: raw.mode || (webhookUrl ? 'webhook' : raw.channelId ? 'channel' : 'auto'),
      channelId: raw.channelId || null,
      webhookUrl,
      hasWebhook: Boolean(raw.webhookUrlEnc),
      decryptError,
      updatedBy: raw.updatedBy || null,
      updatedAt: raw.updatedAt || null,
    };
  }

  function getGuildLogStatus(guildId) {
    const cfg = getGuildLogConfig(guildId);
    return {
      enabled: cfg.enabled,
      mode: cfg.mode,
      channelId: cfg.channelId,
      hasWebhook: cfg.hasWebhook,
      maskedWebhookUrl: cfg.webhookUrl ? maskWebhookUrl(cfg.webhookUrl) : null,
      decryptError: Boolean(cfg.decryptError),
      updatedBy: cfg.updatedBy,
      updatedAt: cfg.updatedAt,
    };
  }

  return {
    setLogChannel,
    setWebhookUrl,
    disableLogs,
    resetLogs,
    getGuildLogConfig,
    getGuildLogStatus,
  };
}

const defaultStore = createGuildLogStore(
  DEFAULT_DATA_DIR,
  masterKeyLib.defaultKeyOptions(DEFAULT_DATA_DIR)
);

function listGuildChannels(guild) {
  const cache = guild?.channels?.cache;
  if (!cache) return [];
  if (typeof cache.values === 'function') {
    return Array.from(cache.values());
  }
  if (Array.isArray(cache)) return cache;
  return [];
}

function isWritableLogChannel(ch) {
  if (!ch || !ch.id) return false;
  if (typeof ch.isThread === 'function' && ch.isThread()) return false;
  if (ch.type !== undefined && NON_TEXT_CHANNEL_TYPES.has(ch.type)) return false;
  if (typeof ch.isTextBased === 'function') {
    return Boolean(ch.isTextBased());
  }
  return ch.type === undefined || ch.type === 0 || ch.type === 5;
}

function hasBotSendPermission(channel, client) {
  if (!channel || typeof channel.permissionsFor !== 'function' || !client?.user) {
    return true;
  }
  try {
    const perms = channel.permissionsFor(client.user);
    if (!perms || typeof perms.has !== 'function') return true;
    return perms.has(PermissionFlagsBits.ViewChannel) && perms.has(PermissionFlagsBits.SendMessages);
  } catch {
    return true;
  }
}

function findAutoLogChannel(guild, client = null) {
  const channels = listGuildChannels(guild).filter(isWritableLogChannel);
  if (channels.length === 0) return null;

  for (const candidate of LOG_CHANNEL_CANDIDATES) {
    const matches = channels.filter(
      (ch) => typeof ch.name === 'string' && ch.name.toLowerCase() === candidate
    );
    if (matches.length === 0) continue;
    const accessible = matches.find((ch) => hasBotSendPermission(ch, client));
    return accessible || matches[0];
  }

  return null;
}

async function resolveChannelById(guild, channelId) {
  if (!guild || !channelId) return null;
  const cached = guild.channels?.cache?.get?.(channelId);
  if (cached) return isWritableLogChannel(cached) ? cached : null;
  if (typeof guild.channels?.fetch === 'function') {
    try {
      const fetched = await guild.channels.fetch(channelId);
      return isWritableLogChannel(fetched) ? fetched : null;
    } catch {
      return null;
    }
  }
  return null;
}

function clearWebhookCache(channelId = null) {
  if (channelId) {
    webhookCache.delete(String(channelId));
  } else {
    webhookCache.clear();
  }
}

function extractWebhookDescriptor(wh) {
  if (!wh || !wh.id) return null;
  const url =
    wh.url || (wh.token ? `https://discord.com/api/webhooks/${wh.id}/${wh.token}` : null);
  if (!url) return null;
  return {
    id: wh.id,
    token: wh.token || null,
    url,
    name: wh.name || LOG_WEBHOOK_NAME,
  };
}

function canManageChannelWebhooks(channel, client) {
  if (!channel || typeof channel.permissionsFor !== 'function' || !client?.user) {
    return true;
  }
  try {
    const perms = channel.permissionsFor(client.user);
    if (!perms || typeof perms.has !== 'function') return true;
    return perms.has(PermissionFlagsBits.ManageWebhooks);
  } catch {
    return true;
  }
}

async function getOrCreateChannelWebhook(channel, client = null) {
  if (!channel || !channel.id) return null;

  const cached = webhookCache.get(channel.id);
  if (cached) return cached;

  if (!canManageChannelWebhooks(channel, client)) {
    return null;
  }

  if (typeof channel.fetchWebhooks === 'function') {
    try {
      const existing = await channel.fetchWebhooks();
      const list =
        typeof existing?.values === 'function'
          ? Array.from(existing.values())
          : Array.isArray(existing)
            ? existing
            : [];
      const ownedMatch = list.find(
        (wh) =>
          wh &&
          wh.name === LOG_WEBHOOK_NAME &&
          (wh.token || wh.url) &&
          (!client?.user?.id || !wh.owner?.id || wh.owner.id === client.user.id)
      );
      const anyNamed =
        ownedMatch ||
        list.find((wh) => wh && wh.name === LOG_WEBHOOK_NAME && (wh.token || wh.url));
      const desc = extractWebhookDescriptor(anyNamed);
      if (desc) {
        webhookCache.set(channel.id, desc);
        return desc;
      }
    } catch {
      return null;
    }
  }

  if (typeof channel.createWebhook === 'function') {
    try {
      const created = await channel.createWebhook({
        name: LOG_WEBHOOK_NAME,
        reason: 'Logs automatiques des actions et informations IA de CIVIS',
      });
      const desc = extractWebhookDescriptor(created);
      if (desc) {
        webhookCache.set(channel.id, desc);
        return desc;
      }
    } catch {
      return null;
    }
  }

  return null;
}

function isMissingWebhookError(err) {
  if (!err) return false;
  return err.code === 10015 || err.status === 404 || Number(err?.rawError?.code) === 10015;
}

async function sendViaWebhookClient(
  url,
  containers,
  client,
  webhookClientFactory,
  allowedMentions = { parse: [] }
) {
  const factory = webhookClientFactory || ((targetUrl) => new WebhookClient({ url: targetUrl }));
  const whClient = factory(url);
  const avatarURL =
    typeof client?.user?.displayAvatarURL === 'function' ? client.user.displayAvatarURL() : undefined;

  try {
    for (const container of containers) {
      const payload = {
        username: LOG_WEBHOOK_NAME,
        ...buildV2Message(container, {
          allowedMentions,
          withComponents: true,
        }),
        ...(avatarURL ? { avatarURL } : {}),
      };
      await whClient.send(payload);
    }
  } finally {
    if (typeof whClient.destroy === 'function') {
      try {
        whClient.destroy();
      } catch {
        // Ignore cleanup failure.
      }
    }
  }
}

async function sendLogEmbeds({
  guild,
  client = null,
  embeds,
  components,
  allowedMentions = { parse: [] },
  store = defaultStore,
  webhookClientFactory = null,
}) {
  try {
    const list =
      Array.isArray(components) && components.length > 0 ? components : embeds;
    if (!guild || !Array.isArray(list) || list.length === 0) {
      return { ok: false, skipped: true, reason: 'missing_target_or_embeds' };
    }

    const config = store.getGuildLogConfig(guild.id);
    if (!config.enabled || config.mode === 'off') {
      return { ok: false, skipped: true, reason: 'disabled' };
    }

    if (config.mode === 'webhook') {
      if (!config.webhookUrl) {
        return { ok: false, skipped: true, reason: 'webhook_unavailable' };
      }
      const validation = validateDiscordWebhookUrl(config.webhookUrl);
      if (!validation.ok) {
        return { ok: false, skipped: true, reason: 'invalid_webhook_url' };
      }
      await sendViaWebhookClient(
        validation.url,
        list,
        client,
        webhookClientFactory,
        allowedMentions
      );
      return { ok: true, delivery: 'custom_webhook' };
    }

    const targetChannel =
      config.mode === 'channel' && config.channelId
        ? await resolveChannelById(guild, config.channelId)
        : findAutoLogChannel(guild, client);

    if (!targetChannel) {
      return {
        ok: false,
        skipped: true,
        reason: config.mode === 'channel' ? 'configured_channel_missing' : 'no_log_channel',
      };
    }

    let webhookDesc = await getOrCreateChannelWebhook(targetChannel, client);
    if (webhookDesc) {
      try {
        await sendViaWebhookClient(
          webhookDesc.url,
          list,
          client,
          webhookClientFactory,
          allowedMentions
        );
        return { ok: true, delivery: 'channel_webhook', channelId: targetChannel.id };
      } catch (err) {
        if (isMissingWebhookError(err)) {
          clearWebhookCache(targetChannel.id);
          webhookDesc = await getOrCreateChannelWebhook(targetChannel, client);
          if (webhookDesc) {
            try {
              await sendViaWebhookClient(
                webhookDesc.url,
                list,
                client,
                webhookClientFactory,
                allowedMentions
              );
              return { ok: true, delivery: 'channel_webhook_recreated', channelId: targetChannel.id };
            } catch {
              // Fall through to channel.send fallback.
            }
          }
        }
      }
    }

    if (typeof targetChannel.send === 'function' && hasBotSendPermission(targetChannel, client)) {
      for (const container of list) {
        await targetChannel.send(buildV2Message(container, { allowedMentions }));
      }
      return { ok: true, delivery: 'channel_send_fallback', channelId: targetChannel.id };
    }

    return { ok: false, skipped: true, reason: 'no_delivery_method', channelId: targetChannel.id };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

function formatSourceLabel(stats) {
  if (!stats || !stats.source) return 'Inconnue';
  if (stats.source === 'api') {
    return `API externe (${stats.provider || 'personnalisee'})`;
  }
  const rolePart = stats.localRole ? `role: ${stats.localRole}` : 'local';
  const keepPart = stats.keepAlive ? `, keep_alive: ${stats.keepAlive}` : '';
  if (stats.source === 'local_fallback') {
    const fromPart = stats.fallbackProvider ? ` depuis ${stats.fallbackProvider}` : '';
    return `Modele local — fallback${fromPart} [${rolePart}${keepPart}]`;
  }
  return `Modele local [${rolePart}${keepPart}]`;
}

function buildAiInfoText(stats) {
  if (!stats) {
    return 'Aucune donnee IA disponible (action systeme sans appel LLM direct).';
  }

  const lines = [
    `• **Source** : ${formatSourceLabel(stats)}`,
    `• **Modele** : \`${stats.model || 'inconnu'}\``,
  ];

  if (stats.fallbackReason) {
    lines.push(`• **Raison fallback** : ${stats.fallbackReason}`);
  }

  if (Number.isFinite(stats.elapsedMs)) {
    const seconds = (stats.elapsedMs / 1000).toFixed(2);
    lines.push(`• **Latence** : ${stats.elapsedMs} ms (${seconds} s)`);
  }

  if (stats.tokensPerSecond !== null && stats.tokensPerSecond !== undefined) {
    lines.push(`• **Vitesse** : ${stats.tokensPerSecond} tok/s`);
  }

  const hasTokens =
    Number.isFinite(stats.promptTokens) ||
    Number.isFinite(stats.completionTokens) ||
    Number.isFinite(stats.totalTokens);
  if (hasTokens) {
    const prompt = Number.isFinite(stats.promptTokens) ? stats.promptTokens : 0;
    const completion = Number.isFinite(stats.completionTokens) ? stats.completionTokens : 0;
    const total = Number.isFinite(stats.totalTokens) ? stats.totalTokens : prompt + completion;
    lines.push(`• **Tokens** : prompt ${prompt} | completion ${completion} | total ${total}`);
  }

  return truncate(lines.join('\n'), 1024);
}

function formatTriggerLabel(trigger) {
  if (trigger === 'approval') return 'Confirmation bouton';
  if (trigger === 'approval_timeout') return 'Expiration approbation (auto-archivage)';
  return 'Execution directe (/agent)';
}

function buildActionLogEmbed({
  trigger = 'direct',
  ok = true,
  toolName = 'inconnu',
  args = {},
  result = '',
  error = null,
  requesterId = null,
  executorId = null,
  channelId = null,
  userText = '',
  stats = null,
  requestId = null,
  timestamp = Date.now(),
}) {
  const color = !ok
    ? COLORS.DANGER
    : trigger === 'approval_timeout'
      ? COLORS.WARNING
      : COLORS.SUCCESS;

  let title;
  if (!ok) {
    title =
      trigger === 'approval_timeout'
        ? `❌ Echec auto-archivage — ${toolName}`
        : `❌ Echec action — ${toolName}`;
  } else if (trigger === 'approval_timeout') {
    title = `⏳ Archivage automatique — ${toolName}`;
  } else if (trigger === 'approval') {
    title = `✅ Action confirmee — ${toolName}`;
  } else {
    title = `🛠️ Action executee — ${toolName}`;
  }

  const executorDisplay = executorId
    ? `<@${executorId}>`
    : trigger === 'approval_timeout'
      ? 'Systeme (timeout)'
      : requesterId
        ? `<@${requesterId}>`
        : 'Inconnu';

  const metaLines = [
    `• **Outil** : \`${truncate(toolName, 200)}\`  •  **Statut** : ${ok ? '🟢 Succes' : '🔴 Erreur'}`,
    `• **Declencheur** : ${formatTriggerLabel(trigger)}`,
    `• **Demandeur** : ${requesterId ? `<@${requesterId}>` : 'Inconnu'}  •  **Executeur** : ${executorDisplay}`,
    `• **Salon d'origine** : ${channelId ? `<#${channelId}>` : 'Inconnu'}` +
      (requestId ? `  •  **Request ID** : \`${truncate(requestId, 120)}\`` : ''),
  ];

  const sections = [metaLines.join('\n')];

  if (userText) {
    sections.push({
      heading: '💬 Demande utilisateur',
      body: truncate(userText, 1024),
    });
  }

  sections.push({
    heading: '🧾 Parametres (JSON)',
    body: formatJsonBlock(args, 1024),
  });

  const outcomeValue = ok ? result : error || result || 'Erreur inconnue';
  sections.push({
    heading: ok ? '✅ Resultat' : '❌ Erreur',
    body: truncate(outcomeValue, 1024),
  });

  sections.push({
    heading: '🤖 Informations IA',
    body: buildAiInfoText(stats),
  });

  return buildV2Card({
    color,
    title: truncate(title, 256),
    sections,
    footer: `🦊 CIVIS • Logs d'actions • ${formatDiscordTimestamp(timestamp, 'f')}`,
  });
}

function formatPlanStepLogBlock(step, idx, total) {
  const icon = step.ok ? '✅' : '❌';
  const argsCompact = (() => {
    try {
      return JSON.stringify(step.args ?? {});
    } catch {
      return '{}';
    }
  })();
  const lines = [
    `${icon} **Etape ${idx + 1}/${total} — ${step.tool}**`,
    step.label ? `> Action : ${step.label}` : null,
    `> Params : \`${truncate(argsCompact, 250)}\``,
    `> Resultat : ${truncate(step.result || (step.ok ? 'OK' : 'Erreur'), 400)}`,
  ].filter(Boolean);
  return {
    body: truncate(lines.join('\n'), 900),
    divider: false,
  };
}

function buildPlanLogEmbeds({
  planId = 'inconnu',
  plan = { summary: '', steps: [] },
  stepResults = [],
  requesterId = null,
  executorId = null,
  channelId = null,
  userText = '',
  revision = 1,
  lastModification = null,
  lastModifiedBy = null,
  stats = null,
  timestamp = Date.now(),
}) {
  const total = stepResults.length || plan?.steps?.length || 0;
  const okCount = stepResults.filter((s) => s.ok).length;
  const failCount = stepResults.length - okCount;
  const allOk = failCount === 0 && total > 0;
  const color = allOk ? COLORS.SUCCESS : failCount > 0 ? COLORS.WARNING : COLORS.INFO;

  const mainTitle = truncate(
    allOk
      ? `📋 Plan execute — ${okCount}/${total} etape(s) reussie(s)`
      : `⚠️ Plan termine — ${okCount}/${total} reussie(s), ${failCount} erreur(s)`,
    256
  );
  const executorDisplay = executorId
    ? `<@${executorId}>`
    : requesterId
      ? `<@${requesterId}>`
      : 'Inconnu';

  const baseSections = [
    '**' + truncate(plan?.summary || 'Plan sans resume.', 1500) + '**',
    [
      `• **Plan ID** : \`${truncate(planId, 120)}\`  •  **Revision** : \`v${revision || 1}\``,
      `• **Demandeur** : ${requesterId ? `<@${requesterId}>` : 'Inconnu'}  •  **Executeur** : ${executorDisplay}`,
      `• **Salon d'origine** : ${channelId ? `<#${channelId}>` : 'Inconnu'}  •  **Bilan** : ${okCount}/${total} reussie(s)${failCount > 0 ? ` (${failCount} erreur(s))` : ''}`,
    ].join('\n'),
  ];

  if (lastModification) {
    const modActor = lastModifiedBy ? ` par <@${lastModifiedBy}>` : '';
    baseSections.push({
      heading: '✏️ Derniere modification du plan',
      body: truncate(`${lastModification}${modActor}`, 900),
    });
  }

  if (userText) {
    baseSections.push({
      heading: '💬 Demande initiale',
      body: truncate(userText, 900),
    });
  }

  baseSections.push({
    heading: '🤖 Informations IA',
    body: buildAiInfoText(stats),
  });

  const footerText = `🦊 CIVIS • Logs d'actions (Mode Plan) • ${formatDiscordTimestamp(timestamp, 'f')}`;

  if (stepResults.length === 0) {
    return [
      buildV2Card({
        color,
        title: mainTitle,
        sections: baseSections,
        footer: footerText,
      }),
    ];
  }

  const containers = [];
  let isFirstPage = true;
  let currentSections = [...baseSections];
  let currentStepBlocks = [];

  const renderPage = (firstPage, stepBlocks) => {
    const pageTitle = firstPage
      ? mainTitle
      : truncate(`📋 Plan \`${planId}\` — Suite des etapes (${containers.length + 1})`, 256);
    const sections = firstPage
      ? [...currentSections, ...stepBlocks]
      : [...stepBlocks];
    return buildV2Card({
      color,
      title: pageTitle,
      sections,
      footer: footerText,
    });
  };

  for (let i = 0; i < stepResults.length; i += 1) {
    const stepBlock = formatPlanStepLogBlock(stepResults[i], i, total);
    const stepWithDivider =
      currentStepBlocks.length === 0
        ? { ...stepBlock, divider: isFirstPage }
        : { ...stepBlock, divider: false };

    const candidate = renderPage(isFirstPage, [...currentStepBlocks, stepWithDivider]);
    const metrics = estimateV2Metrics(candidate);

    if (
      currentStepBlocks.length > 0 &&
      (metrics.totalChars > 3500 || metrics.totalComponents > 32)
    ) {
      containers.push(renderPage(isFirstPage, currentStepBlocks));
      if (containers.length >= 10) {
        return containers;
      }
      isFirstPage = false;
      currentSections = [];
      currentStepBlocks = [{ ...stepBlock, divider: false }];
    } else {
      currentStepBlocks.push(stepWithDivider);
    }
  }

  if (currentStepBlocks.length > 0 && containers.length < 10) {
    containers.push(renderPage(isFirstPage, currentStepBlocks));
  }

  return containers;
}

function buildPlanLogEmbed(params) {
  return buildPlanLogEmbeds(params)[0];
}

async function logAction(params) {
  const { guild, client = null, store = defaultStore, webhookClientFactory = null } = params || {};
  const card = buildActionLogEmbed(params || {});
  return sendLogEmbeds({
    guild,
    client,
    components: [card],
    store,
    webhookClientFactory,
  });
}

async function logPlanExecution(params) {
  const { guild, client = null, store = defaultStore, webhookClientFactory = null } = params || {};
  const cards = buildPlanLogEmbeds(params || {});
  return sendLogEmbeds({
    guild,
    client,
    components: cards,
    store,
    webhookClientFactory,
  });
}

async function sendTestLog({
  guild,
  client = null,
  requesterId = null,
  originChannelId = null,
  store = defaultStore,
  webhookClientFactory = null,
}) {
  const status = store.getGuildLogStatus(guild?.id);
  const modeDesc = !status.enabled || status.mode === 'off'
    ? 'Desactive (`/logs off`)'
    : status.mode === 'webhook'
      ? `Webhook personnalise (${status.maskedWebhookUrl || 'configure'})`
      : status.mode === 'channel'
        ? `Salon configure (<#${status.channelId}>)`
        : 'Detection automatique (`#logs`)';

  const card = buildV2Card({
    color: COLORS.INFO,
    title: '🧪 Test du systeme de logs CIVIS',
    sections: [
      'Ce message confirme que le webhook / salon de logs de CIVIS recoit correctement les evenements (Components V2).',
      [
        `• **Mode actif** : ${modeDesc}`,
        `• **Declenche par** : ${requesterId ? `<@${requesterId}>` : 'Inconnu'}`,
        `• **Salon d'origine** : ${originChannelId ? `<#${originChannelId}>` : 'Inconnu'}`,
      ].join('\n'),
      {
        heading: '🤖 Informations IA (exemple)',
        body: buildAiInfoText({
          source: 'local',
          localRole: 'agent',
          model: 'qwen2.5:3B',
          keepAlive: '15m',
          elapsedMs: 0,
        }),
      },
    ],
    footer: `🦊 CIVIS • Test Webhook Logs • ${formatDiscordTimestamp(Date.now(), 't')}`,
  });

  return sendLogEmbeds({
    guild,
    client,
    components: [card],
    store,
    webhookClientFactory,
  });
}

async function logSecurityAlert({
  guild,
  client = null,
  actorId = null,
  channelId = null,
  title = '🚨 Alerte Securite Anti-Nuke',
  reason = 'Activite suspecte bloquee.',
  details = null,
  lockedMinutes = null,
  store = defaultStore,
  webhookClientFactory = null,
}) {
  const ownerId = guild?.ownerId || null;
  const ownerMention = ownerId ? `<@${ownerId}>` : '*(proprietaire inconnu)*';

  const metaLines = [
    `• **Proprietaire alerte** : ${ownerMention}`,
    `• **Utilisateur concerne** : ${actorId ? `<@${actorId}> (\`${actorId}\`)` : 'Inconnu'}`,
    `• **Salon d'origine** : ${channelId ? `<#${channelId}>` : 'Inconnu'}`,
  ];
  if (lockedMinutes) {
    metaLines.push(`• **Sanction automatique** : Blocage de toute intervention CIVIS pendant \`${lockedMinutes} min\``);
  }

  const sections = [
    `${ownerMention} — Une tentative suspecte de raid / modification massive a ete bloquee par l'anti-nuke.`,
    metaLines.join('\n'),
    { heading: '🛡️ Motif du blocage', body: truncate(reason, 900) },
  ];
  if (details) {
    sections.push({ heading: '📋 Details', body: truncate(details, 900) });
  }

  const card = buildV2Card({
    color: COLORS.DANGER,
    title: truncate(title, 256),
    sections,
    footer: `🦊 CIVIS • Anti-Nuke • ${formatDiscordTimestamp(Date.now(), 't')}`,
  });

  return sendLogEmbeds({
    guild,
    client,
    components: [card],
    allowedMentions: ownerId ? { users: [ownerId] } : { parse: [] },
    store,
    webhookClientFactory,
  });
}

module.exports = {
  DISCORD_WEBHOOK_RE,
  LOG_CHANNEL_CANDIDATES,
  LOG_WEBHOOK_NAME,
  validateDiscordWebhookUrl,
  maskWebhookUrl,
  createGuildLogStore,
  setLogChannel: defaultStore.setLogChannel,
  setWebhookUrl: defaultStore.setWebhookUrl,
  disableLogs: defaultStore.disableLogs,
  resetLogs: defaultStore.resetLogs,
  getGuildLogConfig: defaultStore.getGuildLogConfig,
  getGuildLogStatus: defaultStore.getGuildLogStatus,
  findAutoLogChannel,
  getOrCreateChannelWebhook,
  clearWebhookCache,
  sendLogEmbeds,
  buildAiInfoText,
  buildActionLogEmbed,
  buildActionLogContainer: buildActionLogEmbed,
  buildPlanLogEmbed,
  buildPlanLogEmbeds,
  buildPlanLogContainers: buildPlanLogEmbeds,
  logAction,
  logPlanExecution,
  logSecurityAlert,
  sendTestLog,
};
