const { Events, ActivityType } = require('discord.js');
const debug = require('../agent/debug');
const brain = require('../agent/brain');
const rateLimit = require('../agent/rate-limit');
const antiNuke = require('../agent/anti-nuke');
const { isGuildOwner } = require('../agent/permissions');
const versionManager = require('../version');
const auditSuggestions = require('./audit-suggestions');
const {
  buildNoticePayload,
  buildChatReplyPayload,
  sanitizePublicError,
} = require('./format');

function applyVersionPresence(client, version = versionManager.getCurrentVersion()) {
  if (!client || !client.user || typeof client.user.setPresence !== 'function') {
    return null;
  }
  const statusText = versionManager.formatStatusText(version);
  client.user.setPresence({
    status: 'online',
    activities: [
      {
        name: statusText,
        state: statusText,
        type: ActivityType.Custom,
      },
    ],
  });
  return statusText;
}

function cleanMessage(content, clientUser) {
  let cleaned = content;
  if (clientUser) {
    cleaned = cleaned.replace(new RegExp('<@!?' + clientUser.id + '>', 'g'), '');
  }
  cleaned = cleaned.replace(/^[\s,;:!?.]+/, '');
  cleaned = cleaned.replace(/\s+/g, ' ');
  return cleaned.trim();
}

function registerEvents(client) {
  client.once('clientReady', () => {
    const version = versionManager.getCurrentVersion();
    const statusText = applyVersionPresence(client, version);
    console.log(
      '[events] Connecte en tant que ' +
        client.user.tag +
        ' (' +
        (statusText || 'v' + version) +
        ')'
    );
  });

  client.on(Events.GuildAuditLogEntryCreate, (auditLogEntry, guild) => {
    Promise.resolve(auditSuggestions.handleAuditLogEntry(auditLogEntry, guild, client)).catch(
      (err) => {
        console.error('[events] Erreur audit log suggestion :', err);
      }
    );
  });

  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!message.guild) return;
    if (!message.mentions.has(client.user)) return;

    if (!isGuildOwner(message.guild, message.member || message.author)) {
      const lock = antiNuke.checkUserLockout(message.guild.id, message.author.id);
      if (lock.locked) {
        const mins = Math.floor(lock.remainingSec / 60);
        const secs = lock.remainingSec % 60;
        const timeLabel = mins > 0 ? `${mins} min ${secs}s` : `${secs}s`;
        return message.reply(
          buildNoticePayload({
            type: 'error',
            title: '🚨 Acces bloque par l anti-nuke',
            description:
              `Toute intervention envers CIVIS est bloquee pour toi pendant encore **${timeLabel}**.\n` +
              `• **Motif** : ${lock.reason}`,
          })
        );
      }
    }

    const userText = cleanMessage(message.content, client.user);
    if (!userText) {
      return message.reply(
        buildNoticePayload({
          type: 'primary',
          title: '🦊 CIVIS',
          description:
            'Oui ? Tu voulais me dire quelque chose ?\n> Utilise `/ask`, `/agent` ou `/plan`, ou pose directement ta question en me mentionnant.',
        })
      );
    }

    const limit = rateLimit.acquire(message.author.id);
    if (!limit.ok) {
      return message.reply(
        buildNoticePayload({
          type: 'warning',
          title: '⏳ Un instant...',
          description: limit.message,
        })
      );
    }

    try {
      await message.channel.sendTyping();

      const result = await brain.processMessage({
        userText,
        channelId: message.channel.id,
        authorName: message.member?.displayName || message.author.username,
        authorId: message.author.id,
        guild: message.guild,
        member: message.member,
        client,
      });

      await message.reply(
        buildChatReplyPayload({
          content: result.content,
          usedTool: result.usedTool,
          toolArgs: result.toolArgs,
          stats: result.stats,
          question: userText,
          isDebug: debug.isEnabled(message.channel.id),
          mode: 'chat',
        })
      );
    } catch (err) {
      console.error('[events] Erreur :', err);
      await message.reply(
        buildNoticePayload({
          type: 'error',
          title: '❌ Erreur',
          description: sanitizePublicError(
            err,
            'Une erreur interne est survenue (service IA temporairement indisponible).'
          ),
        })
      );
    } finally {
      rateLimit.release(message.author.id);
    }
  });
}

registerEvents.applyVersionPresence = applyVersionPresence;

module.exports = registerEvents;
