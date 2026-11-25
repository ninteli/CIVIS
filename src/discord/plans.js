const crypto = require('crypto');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const memory = require('../agent/memory');
const { executeTool } = require('../agent/tool-executor');
const {
  checkPlanMemberAuthorization,
  reviseValidatedPlan,
} = require('../agent/planner');
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

const PLAN_TIMEOUT_MS = 120_000;
const PLAN_STEP_DELAY_MS = 350;
const CUSTOM_ID_PREFIX = 'plan:';

const pendingPlans = new Map();

function hasPendingPlanForUser(channelId, requesterId) {
  for (const entry of pendingPlans.values()) {
    if (!entry.inProgress && entry.channelId === channelId && entry.requesterId === requesterId) {
      return true;
    }
  }
  return false;
}

function hasPendingProactivePlanForGuild(guildId) {
  for (const entry of pendingPlans.values()) {
    if (!entry.inProgress && entry.guildId === guildId && Boolean(entry.proactiveTrigger)) {
      return true;
    }
  }
  return false;
}

function buildPlanButtons(
  planId,
  {
    disabled = false,
    requesterAuthorized = false,
    hasDestructive = false,
    isProactive = false,
  } = {}
) {
  const approveLabel = requesterAuthorized ? 'Executer le plan' : 'Valider et executer';
  const approveEmoji = hasDestructive ? '⚠️' : '🚀';
  const approveStyle = hasDestructive
    ? ButtonStyle.Danger
    : requesterAuthorized
      ? ButtonStyle.Success
      : ButtonStyle.Primary;

  const modifyStyle =
    approveStyle === ButtonStyle.Primary ? ButtonStyle.Secondary : ButtonStyle.Primary;

  const rejectLabel = requesterAuthorized ? (isProactive ? 'Ignorer' : 'Annuler') : 'Refuser';
  const rejectStyle = requesterAuthorized ? ButtonStyle.Secondary : ButtonStyle.Danger;

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(CUSTOM_ID_PREFIX + 'execute:' + planId)
      .setLabel(approveLabel)
      .setEmoji(approveEmoji)
      .setStyle(approveStyle)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(CUSTOM_ID_PREFIX + 'modify:' + planId)
      .setLabel('Modifier le plan')
      .setEmoji('✏️')
      .setStyle(modifyStyle)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(CUSTOM_ID_PREFIX + 'cancel:' + planId)
      .setLabel(rejectLabel)
      .setEmoji('🚫')
      .setStyle(rejectStyle)
      .setDisabled(disabled)
  );
}

function buildPlanModifyModal(planId) {
  return new ModalBuilder()
    .setCustomId(CUSTOM_ID_PREFIX + 'revise:' + planId)
    .setTitle('✏️ Modifier le plan')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('instructions')
          .setLabel('Quelles modifications souhaites-tu ?')
          .setPlaceholder(
            'Ex: Ajoute un salon vocal, change la couleur en bleu, retire l etape 3...'
          )
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1000)
      )
    );
}

function formatStepLines(steps, statuses, details) {
  const markers = {
    pending: '⬜',
    running: '⏳',
    ok: '✅',
    error: '❌',
  };

  const lines = steps.map((step, idx) => {
    const status = statuses[idx] || 'pending';
    const marker = markers[status] || '⬜';
    let line = `**${idx + 1}.** ${marker} ${step.label}`;
    if (status === 'error' && details[idx]) {
      line += ' → `' + String(details[idx]).slice(0, 80) + '`';
    }
    return line;
  });

  return lines.join('\n');
}

function buildPlanContainer({
  requesterId,
  plan,
  security,
  statuses,
  details,
  phase,
  executorId,
  stats,
  isDebug,
  timeoutMs,
  revision = 0,
  lastModification = null,
  lastModifiedBy = null,
  pendingModification = null,
  proactiveTrigger = null,
  notice = null,
  actionRows = [],
}) {
  const stepText = formatStepLines(plan.steps, statuses, details);
  let color = COLORS.WARNING;
  let title = '📋 CIVIS — Plan pret a executer';
  let header = '';

  const errorLines = [];
  let okCount = 0;
  for (let i = 0; i < plan.steps.length; i += 1) {
    if (statuses[i] === 'ok') okCount += 1;
    if (statuses[i] === 'error') {
      errorLines.push(
        'Etape ' + (i + 1) + ' (' + plan.steps[i].tool + ') : ' + (details[i] || 'Erreur')
      );
    }
  }

  const versionTag = revision > 0 ? ' (v' + (revision + 1) + ')' : '';

  if (phase === 'pending') {
    if (proactiveTrigger) {
      color = security.hasDestructive ? COLORS.DANGER : COLORS.ACCENT;
      if (security.requesterAuthorized) {
        title = '💡 CIVIS — Suggestion proactive' + versionTag;
        header =
          '**' +
          plan.summary +
          '**\nSuggestion suite a une modification manuelle de <@' +
          requesterId +
          '>.\n> Confirme ci-dessous pour executer, modifier ou ignorer les ' +
          plan.steps.length +
          ' etape(s).';
      } else {
        title = '💡 CIVIS — Suggestion proactive (validation requise)' + versionTag;
        header =
          '**' +
          plan.summary +
          '**\nSuggestion suite a une modification manuelle de <@' +
          requesterId +
          '>, mais ce membre n a pas les permissions requises.\n> Un membre autorise peut valider, modifier ou refuser ci-dessous.';
      }
    } else {
      color = security.hasDestructive ? COLORS.DANGER : COLORS.WARNING;
      if (security.requesterAuthorized) {
        title = '📋 CIVIS — Plan pret a executer' + versionTag;
        header =
          '**' +
          plan.summary +
          '**\nPropose par <@' +
          requesterId +
          '>.\n> Confirme ci-dessous pour lancer les ' +
          plan.steps.length +
          ' etape(s).';
      } else {
        title = '🔐 CIVIS — Validation de plan requise' + versionTag;
        header =
          '**' +
          plan.summary +
          '**\n<@' +
          requesterId +
          '> propose ce plan mais n a pas les permissions requises.\n> Un membre autorise peut valider ou refuser ci-dessous.';
      }
    }
  } else if (phase === 'revising') {
    color = COLORS.ACCENT;
    title = '✏️ CIVIS — Modification du plan en cours';
    header =
      '**' +
      plan.summary +
      '**\nModification demandee par <@' +
      executorId +
      '> :\n> ' +
      String(pendingModification || '').slice(0, 300) +
      '\nGeneration du plan mis a jour...';
  } else if (phase === 'running') {
    color = COLORS.ACCENT;
    title = '⚙️ CIVIS — Execution du plan en cours';
    header = '**' + plan.summary + '**\nExecution lancee par <@' + executorId + '>...';
  } else if (phase === 'done') {
    let icon = '❌';
    if (okCount === plan.steps.length) {
      color = COLORS.SUCCESS;
      icon = '✅';
    } else if (okCount > 0) {
      color = COLORS.WARNING;
      icon = '⚠️';
    } else {
      color = COLORS.DANGER;
    }

    title =
      icon + ' CIVIS — Plan termine (' + okCount + '/' + plan.steps.length + ' reussies)';
    header =
      '**' +
      plan.summary +
      '**\nDemande par <@' +
      requesterId +
      '> • Execute par <@' +
      executorId +
      '>.';
  } else if (phase === 'cancelled') {
    const isSelfCancel = executorId === requesterId && security.requesterAuthorized;
    const isUnauthorizedCancel = executorId === requesterId && !security.requesterAuthorized;
    if (isSelfCancel || isUnauthorizedCancel) {
      color = COLORS.NEUTRAL;
      title = '🚫 CIVIS — Plan annule';
      header = '**' + plan.summary + '**\nPlan annule par <@' + executorId + '>.';
    } else {
      color = COLORS.DANGER;
      title = '❌ CIVIS — Plan refuse';
      header =
        '**' +
        plan.summary +
        '**\nPlan de <@' +
        requesterId +
        '> refuse par <@' +
        executorId +
        '>.';
    }
  } else if (phase === 'expired') {
    color = COLORS.NEUTRAL;
    title = '⌛ CIVIS — Plan expire';
    header =
      '**' +
      plan.summary +
      '**\nPlan de <@' +
      requesterId +
      '> expire sans validation (aucune action effectuee).';
  }

  const sections = [header, { heading: '🧭 Etapes du plan', body: stepText }];
  let footer = `🦊 CIVIS • ${formatDiscordTimestamp(Date.now(), 't')}`;

  if (phase === 'pending') {
    if (proactiveTrigger) {
      const triggerParts = [];
      if (proactiveTrigger.summary) {
        triggerParts.push(String(proactiveTrigger.summary));
      }
      if (proactiveTrigger.rationale) {
        triggerParts.push('Pourquoi : ' + String(proactiveTrigger.rationale));
      }
      if (triggerParts.length > 0) {
        sections.push({
          heading: '🔍 Modification manuelle detectee (Audit Log)',
          body: triggerParts.join('\n').slice(0, 1024),
        });
      }
    }

    if (lastModification) {
      sections.push({
        heading: '✏️ Derniere modification',
        body: ('Par <@' + lastModifiedBy + '> : ' + lastModification).slice(0, 1024),
      });
    }

    if (!security.requesterAuthorized) {
      sections.push({
        heading: '🔐 Autorisation requise',
        body: (security.reason || security.requiredPermissionsLabel).slice(0, 1024),
      });
    } else if (security.requiredPermissionsLabel) {
      sections.push({
        heading: '🛡️ Permissions',
        body: security.requiredPermissionsLabel.slice(0, 1024),
      });
    }

    if (isDebug && stats) {
      sections.push({
        heading: '🧪 Debug',
        body: (
          'Generation : `' +
          (stats.elapsedMs || 0) +
          ' ms` • Modele : `' +
          (stats.model || '-') +
          '`'
        ).slice(0, 1024),
      });
    }

    footer =
      '⏱️ ' +
      (revision > 0 ? 'v' + (revision + 1) + ' • ' : '') +
      'Expire dans ' +
      Math.round(timeoutMs / 1000) +
      's • ' +
      plan.steps.length +
      ' etape(s)';
  } else if (phase === 'done' && errorLines.length > 0) {
    sections.push({
      heading: '❌ Erreurs',
      body: errorLines.join('\n').slice(0, 1024),
    });
  }

  return buildV2Card({
    color,
    title,
    sections,
    footer,
    notice,
    actionRows,
  });
}

function schedulePlanExpiration(planId) {
  const entry = pendingPlans.get(planId);
  if (!entry) return;

  if (entry.timer) {
    clearTimeout(entry.timer);
  }

  const timer = setTimeout(async () => {
    const current = pendingPlans.get(planId);
    if (!current || current.inProgress) return;
    pendingPlans.delete(planId);

    const statuses = current.plan.steps.map(() => 'pending');
    const details = current.plan.steps.map(() => '');
    const disabledRow = buildPlanButtons(planId, {
      disabled: true,
      requesterAuthorized: current.security.requesterAuthorized,
      hasDestructive: current.security.hasDestructive,
      isProactive: Boolean(current.proactiveTrigger),
    });
    const expiredCard = buildPlanContainer({
      requesterId: current.requesterId,
      plan: current.plan,
      security: current.security,
      statuses,
      details,
      phase: 'expired',
      revision: current.revision,
      lastModification: current.lastModification,
      lastModifiedBy: current.lastModifiedBy,
      proactiveTrigger: current.proactiveTrigger,
      actionRows: [disabledRow],
    });
    const payload = buildV2Message(expiredCard, {
      allowedMentions: SAFE_ALLOWED_MENTIONS,
    });

    try {
      if (current.message && typeof current.message.edit === 'function') {
        await current.message.edit(payload);
      } else if (current.interaction) {
        await current.interaction.editReply(payload);
      }
    } catch (err) {
      console.error('[plans] Erreur expiration plan :', err.message);
    }
  }, entry.timeoutMs);

  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  entry.timer = timer;
}

async function updatePlanMessageViaModal(interaction, pending, payload) {
  if (typeof interaction.editReply === 'function') {
    try {
      return await interaction.editReply(payload);
    } catch (err) {
      if (pending?.message && typeof pending.message.edit === 'function') {
        return await pending.message.edit(payload);
      }
      throw err;
    }
  }
  if (pending?.message && typeof pending.message.edit === 'function') {
    return await pending.message.edit(payload);
  }
  return null;
}

async function resolveInteractionMember(interaction) {
  let member = interaction.member;
  if ((!member || !member.roles?.highest) && interaction.guild?.members?.fetch) {
    try {
      member = await interaction.guild.members.fetch(interaction.user.id);
    } catch {
      member = interaction.member;
    }
  }
  return member;
}

async function createPlanRequest({
  interaction = null,
  channel,
  guild,
  requester,
  requesterMember = interaction?.member || null,
  plan,
  security,
  userText,
  stats,
  isDebug,
  timeoutMs = PLAN_TIMEOUT_MS,
  stepDelayMs = PLAN_STEP_DELAY_MS,
  revisePlanFn = null,
  proactiveTrigger = null,
}) {
  if (hasPendingPlanForUser(channel.id, requester.id)) {
    if (interaction) {
      await interaction.editReply(
        buildNoticePayload({
          type: 'warning',
          title: '⏳ Plan deja en attente',
          description:
            'Tu as deja un plan en attente de validation dans ce salon. Annule-le ou attends son traitement avant d en proposer un autre.',
        })
      );
    }
    return null;
  }

  if (proactiveTrigger && hasPendingProactivePlanForGuild(guild.id)) {
    return null;
  }

  const planId = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const statuses = plan.steps.map(() => 'pending');
  const details = plan.steps.map(() => '');

  const row = buildPlanButtons(planId, {
    disabled: false,
    requesterAuthorized: security.requesterAuthorized,
    hasDestructive: security.hasDestructive,
    isProactive: Boolean(proactiveTrigger),
  });
  const notice = buildFallbackNotice(stats).trim() || null;

  const container = buildPlanContainer({
    requesterId: requester.id,
    plan,
    security,
    statuses,
    details,
    phase: 'pending',
    stats,
    isDebug,
    timeoutMs,
    proactiveTrigger,
    notice,
    actionRows: [row],
  });

  const payload = buildV2Message(container, {
    allowedMentions: SAFE_ALLOWED_MENTIONS,
  });

  let sentMessage;
  if (interaction) {
    sentMessage = await interaction.editReply(payload);
  } else {
    sentMessage = await channel.send(payload);
  }

  const entry = {
    planId,
    guildId: guild.id,
    channelId: channel.id,
    requesterId: requester.id,
    requesterMember,
    plan,
    security,
    userText: userText || '',
    originalUserText: userText || '',
    stats,
    isDebug,
    timeoutMs,
    stepDelayMs,
    revision: 0,
    lastModification: null,
    lastModifiedBy: null,
    revisePlanFn,
    proactiveTrigger: proactiveTrigger || null,
    message: sentMessage,
    interaction,
    timer: null,
    inProgress: false,
  };

  pendingPlans.set(planId, entry);
  schedulePlanExpiration(planId);

  return planId;
}

async function handlePlanButton(interaction) {
  if (!interaction.customId || !interaction.customId.startsWith(CUSTOM_ID_PREFIX)) {
    return false;
  }

  const parts = interaction.customId.split(':');
  if (
    parts.length !== 3 ||
    (parts[1] !== 'execute' && parts[1] !== 'modify' && parts[1] !== 'cancel') ||
    !parts[2]
  ) {
    return false;
  }

  const action = parts[1];
  const planId = parts[2];
  const pending = pendingPlans.get(planId);

  if (!pending) {
    await interaction.reply(
      buildNoticePayload({
        type: 'warning',
        title: '⌛ Plan expire',
        description: 'Ce plan a expire ou a deja ete traite.',
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
        description: 'Ce plan n appartient pas a ce serveur.',
        ephemeral: true,
      })
    );
    return true;
  }

  if (pending.inProgress) {
    await interaction.reply(
      buildNoticePayload({
        type: 'warning',
        title: '⚙️ Execution en cours',
        description: 'Ce plan est deja en cours d execution.',
        ephemeral: true,
      })
    );
    return true;
  }

  const member = await resolveInteractionMember(interaction);

  if (pendingPlans.get(planId) !== pending || pending.inProgress) {
    await interaction.reply(
      buildNoticePayload({
        type: 'warning',
        title: '⚙️ Execution en cours',
        description: 'Ce plan est deja en cours d execution.',
        ephemeral: true,
      })
    );
    return true;
  }

  const auth = checkPlanMemberAuthorization(
    interaction.guild,
    member,
    pending.security
  );

  if (action === 'modify') {
    const isRequester = interaction.user.id === pending.requesterId;
    if (!isRequester && !auth.authorized) {
      await interaction.reply(
        buildNoticePayload({
          type: 'error',
          title: '🔒 Action non autorisee',
          description:
            'Seul le demandeur ou un membre autorise (' +
            pending.security.requiredPermissionsLabel +
            ') peut modifier ce plan.',
          ephemeral: true,
        })
      );
      return true;
    }

    schedulePlanExpiration(planId);
    await interaction.showModal(buildPlanModifyModal(planId));
    return true;
  }

  if (action === 'cancel') {
    const isRequester = interaction.user.id === pending.requesterId;
    if (!isRequester && !auth.authorized) {
      await interaction.reply(
        buildNoticePayload({
          type: 'error',
          title: '🔒 Action non autorisee',
          description:
            'Seul le demandeur ou un membre autorise (' +
            pending.security.requiredPermissionsLabel +
            ') peut refuser ce plan.',
          ephemeral: true,
        })
      );
      return true;
    }

    pending.inProgress = true;
    clearTimeout(pending.timer);
    pendingPlans.delete(planId);

    const statuses = pending.plan.steps.map(() => 'pending');
    const details = pending.plan.steps.map(() => '');
    const disabledRow = buildPlanButtons(planId, {
      disabled: true,
      requesterAuthorized: pending.security.requesterAuthorized,
      hasDestructive: pending.security.hasDestructive,
      isProactive: Boolean(pending.proactiveTrigger),
    });
    const cancelledCard = buildPlanContainer({
      requesterId: pending.requesterId,
      plan: pending.plan,
      security: pending.security,
      statuses,
      details,
      phase: 'cancelled',
      executorId: interaction.user.id,
      proactiveTrigger: pending.proactiveTrigger,
      actionRows: [disabledRow],
    });

    await interaction.update(
      buildV2Message(cancelledCard, { allowedMentions: SAFE_ALLOWED_MENTIONS })
    );

    memory.addActionMessage(pending.channelId, pending.requesterId, {
      role: 'assistant',
      content: '[Plan annule : ' + pending.plan.summary + ']',
    });

    return true;
  }

  if (!auth.authorized) {
    await interaction.reply(
      buildNoticePayload({
        type: 'error',
        title: '🔒 Action non autorisee',
        description: 'Tu ne peux pas valider ce plan. ' + auth.reason,
        ephemeral: true,
      })
    );
    return true;
  }

  pending.inProgress = true;
  clearTimeout(pending.timer);

  try {
    await interaction.deferUpdate();

    const statuses = pending.plan.steps.map(() => 'pending');
    const details = pending.plan.steps.map(() => '');
    const disabledRow = buildPlanButtons(planId, {
      disabled: true,
      requesterAuthorized: pending.security.requesterAuthorized,
      hasDestructive: pending.security.hasDestructive,
      isProactive: Boolean(pending.proactiveTrigger),
    });
    let channelDeleted = false;

    const stepResults = [];

    for (let i = 0; i < pending.plan.steps.length; i += 1) {
      const step = pending.plan.steps[i];
      statuses[i] = 'running';

      if (!channelDeleted) {
        try {
          const runningCard = buildPlanContainer({
            requesterId: pending.requesterId,
            plan: pending.plan,
            security: pending.security,
            statuses,
            details,
            phase: 'running',
            executorId: interaction.user.id,
            proactiveTrigger: pending.proactiveTrigger,
            actionRows: [disabledRow],
          });
          await interaction.editReply(
            buildV2Message(runningCard, { allowedMentions: SAFE_ALLOWED_MENTIONS })
          );
        } catch {
          // Ignore transient edit errors while executing plan steps
        }
      }

      const isRoleColorStep =
        step.tool === 'create_role' || step.tool === 'modify_role_display';
      const stepUserText = isRoleColorStep
        ? step.args?.color
          ? String(step.args.color)
          : ''
        : pending.userText || '';

      const execRes = await executeTool(step.tool, step.args, {
        guild: interaction.guild,
        member,
        client: interaction.client,
        mode: 'agent',
        userText: stepUserText,
        confirmed: true,
      });

      if (execRes.ok) {
        statuses[i] = 'ok';
        const firstLine = String(execRes.result || '').split('\n')[0];
        details[i] = firstLine;
        stepResults.push({
          tool: step.tool,
          args: step.args,
          label: step.label || step.tool,
          ok: true,
          result: execRes.result || firstLine,
        });
        if (execRes.deletedChannelId && execRes.deletedChannelId === pending.channelId) {
          channelDeleted = true;
        }
      } else {
        const errMsg = execRes.error || execRes.approval?.reason || 'Erreur inconnue';
        statuses[i] = 'error';
        details[i] = errMsg;
        stepResults.push({
          tool: step.tool,
          args: step.args,
          label: step.label || step.tool,
          ok: false,
          result: errMsg,
        });
      }

      if (pending.stepDelayMs > 0 && i < pending.plan.steps.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, pending.stepDelayMs));
      }
    }

    const okCount = statuses.filter((s) => s === 'ok').length;
    memory.addActionMessage(pending.channelId, pending.requesterId, {
      role: 'assistant',
      content:
        '[Plan execute : ' +
        pending.plan.summary +
        ' (' +
        okCount +
        '/' +
        pending.plan.steps.length +
        ' reussies)]',
    });

    if (!channelDeleted) {
      const doneCard = buildPlanContainer({
        requesterId: pending.requesterId,
        plan: pending.plan,
        security: pending.security,
        statuses,
        details,
        phase: 'done',
        executorId: interaction.user.id,
        proactiveTrigger: pending.proactiveTrigger,
        actionRows: [disabledRow],
      });
      try {
        await interaction.editReply(
          buildV2Message(doneCard, { allowedMentions: SAFE_ALLOWED_MENTIONS })
        );
      } catch (err) {
        console.error('[plans] Erreur mise a jour bilan plan :', err.message);
      }

      const appDirResults = stepResults.filter(
        (r) => r.tool === 'search_app_directory' && r.ok && r.result
      );
      if (appDirResults.length > 0 && typeof interaction.followUp === 'function') {
        for (const r of appDirResults) {
          try {
            await interaction.followUp(
              buildNoticePayload({
                type: 'info',
                title: '🔎 Resultats App Directory Discord',
                description: r.result,
                ephemeral: false,
              })
            );
          } catch (err) {
            console.error('[plans] Erreur envoi resultats App Directory :', err.message);
          }
        }
      }
    }

    await actionLogs.logPlanExecution({
      guild: interaction.guild,
      client: interaction.client,
      planId,
      plan: pending.plan,
      stepResults,
      requesterId: pending.requesterId,
      executorId: interaction.user.id,
      channelId: pending.channelId,
      userText: pending.originalUserText || pending.userText || '',
      revision: (pending.revision || 0) + 1,
      lastModification: pending.lastModification || null,
      lastModifiedBy: pending.lastModifiedBy || null,
      stats: pending.stats || null,
    });
  } finally {
    pendingPlans.delete(planId);
  }

  return true;
}

async function handlePlanModal(interaction) {
  if (!interaction.customId || !interaction.customId.startsWith(CUSTOM_ID_PREFIX)) {
    return false;
  }

  const parts = interaction.customId.split(':');
  if (parts.length !== 3 || parts[1] !== 'revise' || !parts[2]) {
    return false;
  }

  const planId = parts[2];
  const pending = pendingPlans.get(planId);

  if (!pending) {
    await interaction.reply(
      buildNoticePayload({
        type: 'warning',
        title: '⌛ Plan expire',
        description: 'Ce plan a expire ou a deja ete traite.',
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
        description: 'Ce plan n appartient pas a ce serveur.',
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
        description: 'Ce plan est deja en cours de traitement.',
        ephemeral: true,
      })
    );
    return true;
  }

  const member = await resolveInteractionMember(interaction);

  if (pendingPlans.get(planId) !== pending || pending.inProgress) {
    await interaction.reply(
      buildNoticePayload({
        type: 'warning',
        title: '⏳ Traitement en cours',
        description: 'Ce plan est deja en cours de traitement.',
        ephemeral: true,
      })
    );
    return true;
  }

  const isRequester = interaction.user.id === pending.requesterId;
  const auth = checkPlanMemberAuthorization(
    interaction.guild,
    member,
    pending.security
  );

  if (!isRequester && !auth.authorized) {
    await interaction.reply(
      buildNoticePayload({
        type: 'error',
        title: '🔒 Action non autorisee',
        description:
          'Seul le demandeur ou un membre autorise (' +
          pending.security.requiredPermissionsLabel +
          ') peut modifier ce plan.',
        ephemeral: true,
      })
    );
    return true;
  }

  let rawInstructions = '';
  try {
    rawInstructions = interaction.fields?.getTextInputValue('instructions') || '';
  } catch {
    rawInstructions = '';
  }
  const modificationRequest = String(rawInstructions).trim();

  if (!modificationRequest) {
    await interaction.reply(
      buildNoticePayload({
        type: 'warning',
        title: '✏️ Instructions manquantes',
        description: 'Merci d indiquer les modifications souhaitees pour le plan.',
        ephemeral: true,
      })
    );
    return true;
  }

  pending.inProgress = true;
  clearTimeout(pending.timer);

  const buildCurrentPendingPayload = (noticeOverride = null) => {
    const row = buildPlanButtons(planId, {
      disabled: false,
      requesterAuthorized: pending.security.requesterAuthorized,
      hasDestructive: pending.security.hasDestructive,
      isProactive: Boolean(pending.proactiveTrigger),
    });
    const fallbackNotice =
      noticeOverride !== null
        ? noticeOverride
        : buildFallbackNotice(pending.stats).trim() || null;
    const container = buildPlanContainer({
      requesterId: pending.requesterId,
      plan: pending.plan,
      security: pending.security,
      statuses: pending.plan.steps.map(() => 'pending'),
      details: pending.plan.steps.map(() => ''),
      phase: 'pending',
      stats: pending.stats,
      isDebug: pending.isDebug,
      timeoutMs: pending.timeoutMs,
      revision: pending.revision,
      lastModification: pending.lastModification,
      lastModifiedBy: pending.lastModifiedBy,
      proactiveTrigger: pending.proactiveTrigger,
      notice: fallbackNotice,
      actionRows: [row],
    });
    return buildV2Message(container, { allowedMentions: SAFE_ALLOWED_MENTIONS });
  };

  let deferred = false;
  try {
    await interaction.deferUpdate();
    deferred = true;

    try {
      const disabledRow = buildPlanButtons(planId, {
        disabled: true,
        requesterAuthorized: pending.security.requesterAuthorized,
        hasDestructive: pending.security.hasDestructive,
        isProactive: Boolean(pending.proactiveTrigger),
      });
      const revisingCard = buildPlanContainer({
        requesterId: pending.requesterId,
        plan: pending.plan,
        security: pending.security,
        statuses: pending.plan.steps.map(() => 'pending'),
        details: pending.plan.steps.map(() => ''),
        phase: 'revising',
        executorId: interaction.user.id,
        pendingModification: modificationRequest,
        proactiveTrigger: pending.proactiveTrigger,
        actionRows: [disabledRow],
      });
      await updatePlanMessageViaModal(
        interaction,
        pending,
        buildV2Message(revisingCard, { allowedMentions: SAFE_ALLOWED_MENTIONS })
      );
    } catch {
      // Ignore transient edit errors while regenerating the plan
    }

    let memberForSecurity = isRequester ? member : pending.requesterMember;
    if (!memberForSecurity && interaction.guild?.members?.fetch) {
      try {
        memberForSecurity = await interaction.guild.members.fetch(pending.requesterId);
      } catch {
        memberForSecurity = null;
      }
    }

    const reviseFn = pending.revisePlanFn || reviseValidatedPlan;
    const revised = await reviseFn({
      originalUserText: pending.originalUserText || pending.userText,
      currentPlan: pending.plan,
      modificationRequest,
      guild: interaction.guild,
      member: memberForSecurity,
      authorId: interaction.user.id,
    });

    if (!revised.ok) {
      await updatePlanMessageViaModal(interaction, pending, buildCurrentPendingPayload());
      if (typeof interaction.followUp === 'function') {
        await interaction.followUp(
          buildNoticePayload({
            type: 'warning',
            title: '⚠️ Modification impossible',
            description:
              'Impossible de modifier le plan : ' +
              revised.error +
              '\n> Le plan precedent est conserve.',
            notice: buildFallbackNotice(revised.stats).trim() || null,
            ephemeral: true,
          })
        );
      }
      return true;
    }

    pending.plan = revised.plan;
    pending.security = revised.security;
    pending.stats = revised.stats;
    pending.revision += 1;
    pending.lastModification = modificationRequest;
    pending.lastModifiedBy = interaction.user.id;

    const notice = buildFallbackNotice(revised.stats).trim() || null;
    await updatePlanMessageViaModal(interaction, pending, buildCurrentPendingPayload(notice));
  } catch (err) {
    console.error('[plans] Erreur modification plan :', err);
    try {
      await updatePlanMessageViaModal(interaction, pending, buildCurrentPendingPayload());
    } catch {
      // Ignore restore error
    }
    try {
      const errPayload = buildNoticePayload({
        type: 'error',
        title: '❌ Erreur modification du plan',
        description: err.message,
        ephemeral: true,
      });
      if (deferred && typeof interaction.followUp === 'function') {
        await interaction.followUp(errPayload);
      } else if (typeof interaction.reply === 'function') {
        await interaction.reply(errPayload);
      }
    } catch {
      // Ignore followUp error
    }
  } finally {
    if (pendingPlans.get(planId) === pending) {
      pending.inProgress = false;
      schedulePlanExpiration(planId);
    }
  }

  return true;
}

function clearAllPendingPlans() {
  for (const entry of pendingPlans.values()) {
    clearTimeout(entry.timer);
  }
  pendingPlans.clear();
}

module.exports = {
  PLAN_TIMEOUT_MS,
  PLAN_STEP_DELAY_MS,
  createPlanRequest,
  handlePlanButton,
  handlePlanModal,
  hasPendingProactivePlanForGuild,
  clearAllPendingPlans,
};
