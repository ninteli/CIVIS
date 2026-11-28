const crypto = require('crypto');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const memory = require('../agent/memory');
const antiNuke = require('../agent/anti-nuke');
const { executeTool, archiveChannel, archiveRole } = require('../agent/tool-executor');
const { checkMemberAuthorization, isGuildOwner } = require('../agent/permissions');
const {
  COLORS,
  buildV2Card,
  buildV2Message,
  formatDiscordTimestamp,
} = require('./ui-v2');
const {
  SAFE_ALLOWED_MENTIONS,
  buildFallbackNotice,
  buildNoticePayload,
} = require('./format');
const actionLogs = require('./action-logs');

const APPROVAL_TIMEOUT_MS = 120_000;
const CUSTOM_ID_PREFIX = 'approval:';

const pendingApprovals = new Map();

function hasPendingForUserInChannel(channelId, requesterId) {
  for (const entry of pendingApprovals.values()) {
    if (!entry.inProgress && entry.channelId === channelId && entry.requesterId === requesterId) {
      return true;
    }
  }
  return false;
}

function buildButtonsRow(requestId, disabled = false, kind = 'permission') {
  let approveLabel = 'Valider';
  let approveEmoji = '✅';
  let approveStyle = ButtonStyle.Success;
  let rejectLabel = 'Refuser';
  let rejectEmoji = '❌';
  let rejectStyle = ButtonStyle.Danger;

  if (kind === 'confirm_delete') {
    approveLabel = 'Confirmer la suppression';
    approveEmoji = '🗑️';
    approveStyle = ButtonStyle.Danger;
    rejectLabel = 'Annuler';
    rejectEmoji = '↩️';
    rejectStyle = ButtonStyle.Secondary;
  } else if (kind === 'permission_delete') {
    approveLabel = 'Valider la suppression';
    approveEmoji = '🗑️';
    approveStyle = ButtonStyle.Danger;
    rejectLabel = 'Refuser';
    rejectEmoji = '❌';
    rejectStyle = ButtonStyle.Secondary;
  }

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(CUSTOM_ID_PREFIX + 'approve:' + requestId)
      .setLabel(approveLabel)
      .setEmoji(approveEmoji)
      .setStyle(approveStyle)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(CUSTOM_ID_PREFIX + 'reject:' + requestId)
      .setLabel(rejectLabel)
      .setEmoji(rejectEmoji)
      .setStyle(rejectStyle)
      .setDisabled(disabled)
  );
}

function buildPendingCard({ requesterId, approval, stats, isDebug, timeoutMs, notice, row }) {
  const isConfirmDelete = approval.kind === 'confirm_delete';
  const isPermissionDelete = approval.kind === 'permission_delete';
  const isDelete = isConfirmDelete || isPermissionDelete;

  let title = '🔐 CIVIS — Validation requise';
  let description =
    '<@' +
    requesterId +
    '> demande une action mais n a pas les permissions requises.\n' +
    '> Un membre autorise peut valider ou refuser ci-dessous.';

  if (isConfirmDelete) {
    title = '🗑️ CIVIS — Confirmation de suppression';
    description =
      '<@' +
      requesterId +
      '> demande une suppression definitive.\n> Confirme ou annule cette action ci-dessous.';
  } else if (isPermissionDelete) {
    title = '🚨 CIVIS — Validation de suppression requise';
    description =
      '<@' +
      requesterId +
      '> demande une suppression definitive mais n a pas les permissions requises.\n' +
      '> Un membre autorise peut valider la suppression ou refuser ci-dessous.';
  }

  const sections = [
    description,
    { heading: '📌 Action', body: approval.title },
  ];

  if (approval.summaryLines && approval.summaryLines.length > 0) {
    sections.push({
      heading: '📋 Details',
      body: approval.summaryLines.join('\n').slice(0, 1024),
    });
  }

  sections.push({
    heading: isConfirmDelete ? '🛡️ Permission requise' : '🔑 Autorisation requise',
    body: isConfirmDelete
      ? approval.requiredPermissionLabel
      : approval.reason || approval.requiredPermissionLabel,
  });

  if (isDebug && stats) {
    sections.push({
      heading: '🧪 Debug',
      body: 'Outil : `' + approval.toolName + '` • `' + (stats.elapsedMs || 0) + ' ms`',
    });
  }

  const seconds = Math.round(timeoutMs / 1000);
  let footerText;
  if (isConfirmDelete) {
    if (approval.onTimeoutAction === 'archive_channel') {
      footerText =
        '⏱️ Expire dans ' + seconds + 's — Sans reponse, le salon sera archive et masque.';
    } else if (approval.onTimeoutAction === 'archive_role') {
      footerText =
        '⏱️ Expire dans ' +
        seconds +
        's — Sans reponse, le role sera mis en quarantaine ([Archivé]).';
    } else {
      footerText = '⏱️ Expire dans ' + seconds + 's — Sans reponse, la demande sera ignoree.';
    }
  } else if (isPermissionDelete) {
    footerText =
      '⏱️ Expire dans ' +
      seconds +
      's — Seul un membre autorise peut valider (sinon demande ignoree).';
  } else {
    footerText = '⏱️ Expire dans ' + seconds + 's — Seul un membre autorise peut valider.';
  }

  return buildV2Card({
    color: isDelete ? COLORS.DANGER : COLORS.WARNING,
    title,
    sections,
    footer: `${footerText} • ${formatDiscordTimestamp(Date.now(), 't')}`,
    notice: notice || null,
    actionRows: row ? [row] : [],
  });
}

async function createApprovalRequest({
  interaction,
  channel,
  guild,
  requester,
  approval,
  stats,
  isDebug,
  timeoutMs,
}) {
  if (hasPendingForUserInChannel(channel.id, requester.id)) {
    await interaction.editReply(
      buildNoticePayload({
        type: 'warning',
        title: '⏳ Demande deja en attente',
        description:
          'Tu as deja une demande en attente de validation dans ce salon. Annule-la ou attends son traitement avant d en faire une nouvelle.',
      })
    );
    return null;
  }

  const effectiveTimeoutMs =
    timeoutMs !== undefined ? timeoutMs : approval.timeoutMs || APPROVAL_TIMEOUT_MS;
  const requestId = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const row = buildButtonsRow(requestId, false, approval.kind);
  const notice = buildFallbackNotice(stats).trim() || null;
  const card = buildPendingCard({
    requesterId: requester.id,
    approval,
    stats,
    isDebug,
    timeoutMs: effectiveTimeoutMs,
    notice,
    row,
  });

  const sentMessage = await interaction.editReply(
    buildV2Message(card, { allowedMentions: SAFE_ALLOWED_MENTIONS })
  );

  const entry = {
    requestId,
    guildId: guild.id,
    channelId: channel.id,
    requesterId: requester.id,
    approval,
    stats: stats || null,
    message: sentMessage,
    interaction,
    timer: null,
    inProgress: false,
  };

  const timer = setTimeout(async () => {
    const current = pendingApprovals.get(requestId);
    if (!current || current.inProgress) return;
    pendingApprovals.delete(requestId);

    const disabledRow = buildButtonsRow(requestId, true, approval.kind);
    let timeoutCard;

    if (approval.onTimeoutAction === 'archive_channel' && approval.targetChannelId) {
      let archiveRes;
      try {
        const targetCh = guild?.channels?.cache?.get?.(approval.targetChannelId) || null;
        const prot = targetCh
          ? antiNuke.checkProtectedChannel(targetCh, guild, { actionLogs, member: null })
          : { protected: false };
        if (prot.protected) {
          archiveRes = { ok: false, error: '🛡️ Archivage interdit : ' + prot.reason };
        } else {
          archiveRes = await archiveChannel(guild, approval.targetChannelId);
        }
      } catch (err) {
        archiveRes = { ok: false, error: err.message };
      }

      if (archiveRes.ok) {
        if (requester?.id && !isGuildOwner(guild, { id: requester.id })) {
          const burst = antiNuke.recordBurstActivity(
            guild,
            { id: requester.id },
            { toolName: 'archive_channel' }
          );
          if (burst.blocked) {
            await actionLogs.logSecurityAlert({
              guild,
              client: interaction?.client || null,
              actorId: requester.id,
              channelId: channel.id,
              title: '🚨 Anti-Rafale declenche (auto-archivage)',
              reason: burst.reason,
              details: `Outil : archive_channel (${approval.title})`,
              lockedMinutes: 10,
            });
          }
        }
        timeoutCard = buildV2Card({
          color: COLORS.NEUTRAL,
          title: '📦 CIVIS — Salon archive',
          sections: [
            'Aucune confirmation recue dans le delai pour la demande de <@' +
              requester.id +
              '>.',
            { heading: '📌 Action', body: approval.title },
            { heading: '✅ Resultat', body: archiveRes.result.slice(0, 1024) },
          ],
          footer: `🦊 CIVIS • ${formatDiscordTimestamp(Date.now(), 't')}`,
          actionRows: [disabledRow],
        });

        memory.addActionMessage(channel.id, requester.id, {
          role: 'assistant',
          content: archiveRes.result,
        });

        await actionLogs.logAction({
          guild,
          client: interaction?.client || null,
          trigger: 'approval_timeout',
          ok: true,
          toolName: 'archive_channel',
          args: {
            channel_id: approval.targetChannelId,
            original_tool: approval.toolName,
            original_args: approval.args,
          },
          result: archiveRes.result,
          requesterId: requester.id,
          executorId: null,
          channelId: channel.id,
          userText: approval.userText || '',
          stats: current.stats || null,
          requestId,
        });
      } else {
        timeoutCard = buildV2Card({
          color: COLORS.DANGER,
          title: '❌ CIVIS — Echec de l archivage',
          sections: [
            'Delai expire, mais impossible d archiver le salon.',
            { heading: '📌 Action', body: approval.title },
            {
              heading: '❌ Erreur',
              body: (archiveRes.error || 'Erreur inconnue').slice(0, 1024),
            },
          ],
          footer: `🦊 CIVIS • ${formatDiscordTimestamp(Date.now(), 't')}`,
          actionRows: [disabledRow],
        });

        await actionLogs.logAction({
          guild,
          client: interaction?.client || null,
          trigger: 'approval_timeout',
          ok: false,
          toolName: 'archive_channel',
          args: {
            channel_id: approval.targetChannelId,
            original_tool: approval.toolName,
            original_args: approval.args,
          },
          error: archiveRes.error || 'Erreur inconnue',
          requesterId: requester.id,
          executorId: null,
          channelId: channel.id,
          userText: approval.userText || '',
          stats: current.stats || null,
          requestId,
        });
      }
    } else if (approval.onTimeoutAction === 'archive_role' && approval.targetRoleId) {
      let archiveRes;
      try {
        archiveRes = await archiveRole(guild, approval.targetRoleId);
      } catch (err) {
        archiveRes = { ok: false, error: err.message };
      }

      if (archiveRes.ok) {
        if (requester?.id && !isGuildOwner(guild, { id: requester.id })) {
          const burst = antiNuke.recordBurstActivity(
            guild,
            { id: requester.id },
            { toolName: 'archive_role' }
          );
          if (burst.blocked) {
            await actionLogs.logSecurityAlert({
              guild,
              client: interaction?.client || null,
              actorId: requester.id,
              channelId: channel.id,
              title: '🚨 Anti-Rafale declenche (auto-archivage)',
              reason: burst.reason,
              details: `Outil : archive_role (${approval.title})`,
              lockedMinutes: 10,
            });
          }
        }
        timeoutCard = buildV2Card({
          color: COLORS.NEUTRAL,
          title: '📦 CIVIS — Role archive',
          sections: [
            'Aucune confirmation recue dans le delai pour la demande de <@' +
              requester.id +
              '>.',
            { heading: '📌 Action', body: approval.title },
            { heading: '✅ Resultat', body: archiveRes.result.slice(0, 1024) },
          ],
          footer: `🦊 CIVIS • ${formatDiscordTimestamp(Date.now(), 't')}`,
          actionRows: [disabledRow],
        });

        memory.addActionMessage(channel.id, requester.id, {
          role: 'assistant',
          content: archiveRes.result,
        });

        await actionLogs.logAction({
          guild,
          client: interaction?.client || null,
          trigger: 'approval_timeout',
          ok: true,
          toolName: 'archive_role',
          args: {
            role_id: approval.targetRoleId,
            original_tool: approval.toolName,
            original_args: approval.args,
          },
          result: archiveRes.result,
          requesterId: requester.id,
          executorId: null,
          channelId: channel.id,
          userText: approval.userText || '',
          stats: current.stats || null,
          requestId,
        });
      } else {
        timeoutCard = buildV2Card({
          color: COLORS.DANGER,
          title: '❌ CIVIS — Echec de l archivage',
          sections: [
            'Delai expire, mais impossible de mettre le role en quarantaine.',
            { heading: '📌 Action', body: approval.title },
            {
              heading: '❌ Erreur',
              body: (archiveRes.error || 'Erreur inconnue').slice(0, 1024),
            },
          ],
          footer: `🦊 CIVIS • ${formatDiscordTimestamp(Date.now(), 't')}`,
          actionRows: [disabledRow],
        });

        await actionLogs.logAction({
          guild,
          client: interaction?.client || null,
          trigger: 'approval_timeout',
          ok: false,
          toolName: 'archive_role',
          args: {
            role_id: approval.targetRoleId,
            original_tool: approval.toolName,
            original_args: approval.args,
          },
          error: archiveRes.error || 'Erreur inconnue',
          requesterId: requester.id,
          executorId: null,
          channelId: channel.id,
          userText: approval.userText || '',
          stats: current.stats || null,
          requestId,
        });
      }
    } else {
      timeoutCard = buildV2Card({
        color: COLORS.NEUTRAL,
        title: '⌛ CIVIS — Demande expiree',
        sections: [
          'Demande de <@' + requester.id + '> expiree sans confirmation.',
          { heading: '📌 Action', body: approval.title },
        ],
        footer: `🦊 CIVIS • ${formatDiscordTimestamp(Date.now(), 't')}`,
        actionRows: [disabledRow],
      });
    }

    const timeoutPayload = buildV2Message(timeoutCard, {
      allowedMentions: SAFE_ALLOWED_MENTIONS,
    });
    try {
      if (sentMessage && typeof sentMessage.edit === 'function') {
        await sentMessage.edit(timeoutPayload);
      } else {
        await interaction.editReply(timeoutPayload);
      }
    } catch (err) {
      console.error('[approvals] Erreur expiration message :', err.message);
    }
  }, effectiveTimeoutMs);

  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  entry.timer = timer;
  pendingApprovals.set(requestId, entry);

  return requestId;
}

async function handleApprovalButton(interaction) {
  if (!interaction.customId || !interaction.customId.startsWith(CUSTOM_ID_PREFIX)) {
    return false;
  }

  const parts = interaction.customId.split(':');
  if (parts.length !== 3 || (parts[1] !== 'approve' && parts[1] !== 'reject') || !parts[2]) {
    return false;
  }

  const action = parts[1];
  const requestId = parts[2];
  const pending = pendingApprovals.get(requestId);

  if (!pending) {
    await interaction.reply(
      buildNoticePayload({
        type: 'warning',
        title: '⌛ Demande expiree',
        description: 'Cette demande de validation a expire ou a deja ete traitee.',
        ephemeral: true,
      })
    );
    return true;
  }

  if (!interaction.guild || interaction.guild.id !== pending.guildId) {
    await interaction.reply(
      buildNoticePayload({
        type: 'error',
        title: '❌ Serveur invalide',
        description: 'Cette demande n appartient pas a ce serveur.',
        ephemeral: true,
      })
    );
    return true;
  }

  if (pending.inProgress) {
    await interaction.reply(
      buildNoticePayload({
        type: 'warning',
        title: '⏳ Traitement en cours',
        description: 'Cette demande est deja en cours de traitement.',
        ephemeral: true,
      })
    );
    return true;
  }

  let member = interaction.member;
  if ((!member || !member.roles?.highest) && interaction.guild.members?.fetch) {
    try {
      member = await interaction.guild.members.fetch(interaction.user.id);
    } catch {
      member = interaction.member;
    }
  }

  if (pending.inProgress) {
    await interaction.reply(
      buildNoticePayload({
        type: 'warning',
        title: '⏳ Traitement en cours',
        description: 'Cette demande est deja en cours de traitement.',
        ephemeral: true,
      })
    );
    return true;
  }

  const targetRole = pending.approval.targetRoleId
    ? interaction.guild.roles.cache.get(pending.approval.targetRoleId) || null
    : null;
  const targetChannel = pending.approval.targetChannelId
    ? interaction.guild.channels.cache.get(pending.approval.targetChannelId) || null
    : null;

  const auth = checkMemberAuthorization({
    guild: interaction.guild,
    member,
    requiredPermission: pending.approval.requiredPermission,
    requiredPermissions: pending.approval.requiredPermissions,
    targetChannel,
    targetRole,
    requestedPermFlags: pending.approval.requestedPermFlags,
  });

  if (action === 'reject') {
    const isRequester = interaction.user.id === pending.requesterId;
    if (!isRequester && !auth.authorized) {
      await interaction.reply(
        buildNoticePayload({
          type: 'error',
          title: '🔒 Action non autorisee',
          description:
            'Seul le demandeur ou un membre autorise (' +
            pending.approval.requiredPermissionLabel +
            ') peut refuser cette demande.',
          ephemeral: true,
        })
      );
      return true;
    }

    pending.inProgress = true;
    clearTimeout(pending.timer);
    pendingApprovals.delete(requestId);

    const isConfirmDelete = pending.approval.kind === 'confirm_delete';
    const isPermissionDelete = pending.approval.kind === 'permission_delete';
    const isSelfCancel = isRequester && !auth.authorized;

    let cardColor;
    let cardTitle;
    let cardDesc;
    let memoryNote;
    if (isConfirmDelete) {
      cardColor = COLORS.NEUTRAL;
      cardTitle = '↩️ CIVIS — Suppression annulee';
      cardDesc = 'Suppression annulee par <@' + interaction.user.id + '>.';
      memoryNote = '[Suppression annulee : ' + pending.approval.title + ']';
    } else if (isPermissionDelete) {
      cardColor = isSelfCancel ? COLORS.NEUTRAL : COLORS.DANGER;
      cardTitle = isSelfCancel
        ? '↩️ CIVIS — Suppression annulee'
        : '❌ CIVIS — Suppression refusee';
      cardDesc = isSelfCancel
        ? 'Suppression annulee par <@' + interaction.user.id + '>.'
        : 'Demande de suppression de <@' +
          pending.requesterId +
          '> refusee par <@' +
          interaction.user.id +
          '>.';
      memoryNote =
        (isSelfCancel ? '[Suppression annulee : ' : '[Suppression refusee : ') +
        pending.approval.title +
        ']';
    } else {
      cardColor = isSelfCancel ? COLORS.NEUTRAL : COLORS.DANGER;
      cardTitle = isSelfCancel
        ? '↩️ CIVIS — Demande annulee'
        : '❌ CIVIS — Demande refusee';
      cardDesc = isSelfCancel
        ? 'Demande annulee par <@' + interaction.user.id + '>.'
        : 'Demande de <@' +
          pending.requesterId +
          '> refusee par <@' +
          interaction.user.id +
          '>.';
      memoryNote =
        (isSelfCancel ? '[Demande annulee : ' : '[Demande refusee : ') +
        pending.approval.title +
        ']';
    }

    const disabledRow = buildButtonsRow(requestId, true, pending.approval.kind);
    const card = buildV2Card({
      color: cardColor,
      title: cardTitle,
      sections: [cardDesc, { heading: '📌 Action', body: pending.approval.title }],
      footer: `🦊 CIVIS • ${formatDiscordTimestamp(Date.now(), 't')}`,
      actionRows: [disabledRow],
    });

    await interaction.update(
      buildV2Message(card, { allowedMentions: SAFE_ALLOWED_MENTIONS })
    );

    memory.addActionMessage(pending.channelId, pending.requesterId, {
      role: 'assistant',
      content: memoryNote,
    });

    return true;
  }

  if (!auth.authorized) {
    await interaction.reply(
      buildNoticePayload({
        type: 'error',
        title: '🔒 Action non autorisee',
        description: 'Tu ne peux pas valider cette action. ' + auth.reason,
        ephemeral: true,
      })
    );
    return true;
  }

  if (!isGuildOwner(interaction.guild, member)) {
    const lock = antiNuke.checkUserLockout(interaction.guild.id, interaction.user.id);
    if (lock.locked) {
      const mins = Math.floor(lock.remainingSec / 60);
      const secs = lock.remainingSec % 60;
      const timeLabel = mins > 0 ? `${mins} min ${secs}s` : `${secs}s`;
      await interaction.reply(
        buildNoticePayload({
          type: 'error',
          title: '🚨 Acces bloque par l anti-nuke',
          description:
            `Toute intervention envers CIVIS est bloquee pour toi pendant encore **${timeLabel}**.\n` +
            `• **Motif** : ${lock.reason}`,
          ephemeral: true,
        })
      );
      return true;
    }
  }

  pending.inProgress = true;
  clearTimeout(pending.timer);

  try {
    await interaction.deferUpdate();

    const disabledRow = buildButtonsRow(requestId, true, pending.approval.kind);

    if (!isGuildOwner(interaction.guild, member)) {
      const burst = antiNuke.recordBurstActivity(interaction.guild, member, {
        toolName: pending.approval.toolName,
      });
      if (burst.blocked) {
        await actionLogs.logSecurityAlert({
          guild: interaction.guild,
          client: interaction.client,
          actorId: interaction.user.id,
          channelId: pending.channelId,
          title: '🚨 Anti-Rafale declenche (validation bouton)',
          reason: burst.reason,
          details: `Outil bloque : ${pending.approval.toolName} (${pending.approval.title})`,
          lockedMinutes: 10,
        });
        const blockedCard = buildV2Card({
          color: COLORS.DANGER,
          title: '🚨 CIVIS — Action bloquee par l anti-nuke',
          sections: [
            `Action de <@${interaction.user.id}> bloquee automatiquement pendant **10 minutes**.`,
            { heading: '📌 Action', body: pending.approval.title },
            { heading: '🛡️ Motif', body: burst.reason.slice(0, 1024) },
          ],
          footer: `🦊 CIVIS • Anti-Nuke • ${formatDiscordTimestamp(Date.now(), 't')}`,
          actionRows: [disabledRow],
        });
        try {
          await interaction.editReply(
            buildV2Message(blockedCard, { allowedMentions: SAFE_ALLOWED_MENTIONS })
          );
        } catch (err) {
          console.error('[approvals] Erreur mise a jour carte anti-nuke :', err.message);
        }
        await actionLogs.logAction({
          guild: interaction.guild,
          client: interaction.client,
          trigger: 'approval',
          ok: false,
          toolName: pending.approval.toolName,
          args: pending.approval.args,
          error: burst.reason,
          requesterId: pending.requesterId,
          executorId: interaction.user.id,
          channelId: pending.channelId,
          userText: pending.approval.userText || '',
          stats: pending.stats || null,
          requestId,
        });
        return true;
      }
    }

    const deletingCurrentChannel =
      pending.approval.toolName === 'delete_channel' &&
      pending.approval.targetChannelId === pending.channelId;

    if (deletingCurrentChannel) {
      try {
        const progressCard = buildV2Card({
          color: COLORS.DANGER,
          title: '🗑️ CIVIS — Suppression en cours',
          sections: [
            'Suppression du salon en cours...',
            { heading: '📌 Action', body: pending.approval.title },
          ],
          footer: `🦊 CIVIS • ${formatDiscordTimestamp(Date.now(), 't')}`,
          actionRows: [disabledRow],
        });
        await interaction.editReply(
          buildV2Message(progressCard, { allowedMentions: SAFE_ALLOWED_MENTIONS })
        );
      } catch {
        // Ignore if message cannot be edited before channel deletion
      }
    }

    const execResult = await executeTool(pending.approval.toolName, pending.approval.args, {
      guild: interaction.guild,
      member,
      client: interaction.client,
      mode: pending.approval.mode,
      userText: pending.approval.userText,
      confirmed: true,
    });

    if (execResult.ok && execResult.deletedChannelId === pending.channelId) {
      memory.addActionMessage(pending.channelId, pending.requesterId, {
        role: 'assistant',
        content: execResult.result,
      });
      await actionLogs.logAction({
        guild: interaction.guild,
        client: interaction.client,
        trigger: 'approval',
        ok: true,
        toolName: pending.approval.toolName,
        args: pending.approval.args,
        result: execResult.result,
        requesterId: pending.requesterId,
        executorId: interaction.user.id,
        channelId: pending.channelId,
        userText: pending.approval.userText || '',
        stats: pending.stats || null,
        requestId,
      });
      return true;
    }

    let finalCard;
    if (execResult.ok) {
      finalCard = buildV2Card({
        color: COLORS.SUCCESS,
        title: '✅ CIVIS — Action validee',
        sections: [
          'Demandee par <@' +
            pending.requesterId +
            '> • Validee par <@' +
            interaction.user.id +
            '>.',
          { heading: '📌 Action', body: pending.approval.title },
          { heading: '✅ Resultat', body: execResult.result.slice(0, 1024) },
        ],
        footer: `🦊 CIVIS • ${formatDiscordTimestamp(Date.now(), 't')}`,
        actionRows: [disabledRow],
      });

      memory.addActionMessage(pending.channelId, pending.requesterId, {
        role: 'assistant',
        content: execResult.result,
      });
    } else {
      const errMsg =
        execResult.error || execResult.approval?.reason || 'Erreur inconnue';
      finalCard = buildV2Card({
        color: COLORS.DANGER,
        title: '❌ CIVIS — Echec de l execution',
        sections: [
          'Validee par <@' + interaction.user.id + '>, mais l execution a echoue.',
          { heading: '📌 Action', body: pending.approval.title },
          { heading: '❌ Erreur', body: errMsg.slice(0, 1024) },
        ],
        footer: `🦊 CIVIS • ${formatDiscordTimestamp(Date.now(), 't')}`,
        actionRows: [disabledRow],
      });
    }

    try {
      await interaction.editReply(
        buildV2Message(finalCard, { allowedMentions: SAFE_ALLOWED_MENTIONS })
      );
    } catch (err) {
      console.error('[approvals] Erreur mise a jour reponse :', err.message);
    }

    await actionLogs.logAction({
      guild: interaction.guild,
      client: interaction.client,
      trigger: 'approval',
      ok: Boolean(execResult.ok),
      toolName: pending.approval.toolName,
      args: pending.approval.args,
      result: execResult.ok ? execResult.result : null,
      error: execResult.ok
        ? null
        : execResult.error || execResult.approval?.reason || 'Erreur inconnue',
      requesterId: pending.requesterId,
      executorId: interaction.user.id,
      channelId: pending.channelId,
      userText: pending.approval.userText || '',
      stats: pending.stats || null,
      requestId,
    });
  } finally {
    pendingApprovals.delete(requestId);
  }

  return true;
}

function clearAllPending() {
  for (const entry of pendingApprovals.values()) {
    clearTimeout(entry.timer);
  }
  pendingApprovals.clear();
}

module.exports = {
  APPROVAL_TIMEOUT_MS,
  createApprovalRequest,
  handleApprovalButton,
  clearAllPending,
};
