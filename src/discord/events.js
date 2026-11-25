const { Events } = require('discord.js');
const debug = require('../agent/debug');
const brain = require('../agent/brain');
const rateLimit = require('../agent/rate-limit');
const auditSuggestions = require('./audit-suggestions');
const {
  buildNoticePayload,
  buildChatReplyPayload,
} = require('./format');

function cleanMessage(content, clientUser) {
  let cleaned = content;
  if (clientUser) {
    cleaned = cleaned.replace(new RegExp('<@!?' + clientUser.id + '>', 'g'), '');
  }
  cleaned = cleaned.replace(/^[\s,;:!?.]+/, '');
  cleaned = cleaned.replace(/\s+/g, ' ');
  return cleaned.trim();
}

module.exports = (client) => {
  client.once('clientReady', () => {
    console.log('[events] Connecte en tant que ' + client.user.tag);
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
          description: err.message,
        })
      );
    } finally {
      rateLimit.release(message.author.id);
    }
  });
};
