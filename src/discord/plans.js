const crypto = require('crypto');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
} = require('discord.js');
const memory = require('../agent/memory');
const { executeTool, executeUndoAction } = require('../agent/tool-executor');
const { isGuildOwner } = require('../agent/permissions');
const antiNuke = require('../agent/anti-nuke');
const {
  checkPlanMemberAuthorization,
  reviseValidatedPlan,
  serializePlanJson,
} = require('../agent/planner');
const {
  COLORS,
  buildV2Card,
  buildV2Message,
  formatDiscordTimestamp,
  truncateMarkdownSafe,
} = require('./ui-v2');
const {
  SAFE_ALLOWED_MENTIONS,
  sanitizePublicError,
  buildFallbackNotice,
  buildNoticePayload,
} = require('./format');
const actionLogs = require('./action-logs');

const PLAN_TIMEOUT_MS = 120_000;
const ROLLBACK_WINDOW_MS = 300_000; // 300 secondes (5 min)
const PLAN_STEP_DELAY_MS = 350;
const CUSTOM_ID_PREFIX = 'plan:';
const PLAN_JSON_CACHE_TTL_MS = 30 * 60 * 1000;
const PLAN_JSON_CACHE_MAX = 50;

const pendingPlans = new Map();
const planJsonSnapshots = new Map();
const rollbackSnapshots = new Map();

function prunePlanJsonSnapshots(now = Date.now()) {
  for (const [id, snap] of planJsonSnapshots.entries()) {
    if (now - snap.updatedAt > PLAN_JSON_CACHE_TTL_MS) {
      planJsonSnapshots.delete(id);
    }
  }
  while (planJsonSnapshots.size > PLAN_JSON_CACHE_MAX) {
    const oldestKey = planJsonSnapshots.keys().next().value;
    if (!oldestKey) break;
    planJsonSnapshots.delete(oldestKey);
  }
}

function savePlanJsonSnapshot(
  planId,
  { guildId, requesterId = null, security = null, plan, revision = 0 }
) {
  prunePlanJsonSnapshots();
  planJsonSnapshots.delete(planId);
  planJsonSnapshots.set(planId, {
    guildId,
    requesterId,
    security,
    planJson: serializePlanJson(plan),
    revision,
    updatedAt: Date.now(),
  });
}

function getPlanJsonSnapshot(planId) {
  const pending = pendingPlans.get(planId);
  if (pending) {
    return {
      guildId: pending.guildId,
      requesterId: pending.requesterId,
      security: pending.security,
      planJson: serializePlanJson(pending.plan),
      revision: pending.revision || 0,
    };
  }
  const snap = planJsonSnapshots.get(planId);
  if (!snap) return null;
  if (Date.now() - snap.updatedAt > PLAN_JSON_CACHE_TTL_MS) {
    planJsonSnapshots.delete(planId);
    return null;
  }
  return snap;
}

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
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(CUSTOM_ID_PREFIX + 'json:' + planId)
      .setLabel('Voir le JSON')
      .setEmoji('📄')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(false)
  );
}

function buildRunningButtons(planId, { disabled = false } = {}) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(CUSTOM_ID_PREFIX + 'stop:' + planId)
      .setLabel('Arret d urgence')
      .setEmoji('🛑')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(CUSTOM_ID_PREFIX + 'json:' + planId)
      .setLabel('Voir le JSON')
      .setEmoji('📄')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(false)
  );
}

function buildRollbackRow(planId, { disabled = false, rollbackWindowSec = 300 } = {}) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(CUSTOM_ID_PREFIX + 'rollback:' + planId)
      .setLabel(disabled ? 'Retour en arriere indisponible' : `Retour en arriere (${rollbackWindowSec}s)`)
      .setEmoji('↩️')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled)
  );
}

function buildOwnerApprovalButtons(planId, { disabled = false } = {}) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(CUSTOM_ID_PREFIX + 'owner_unlock:' + planId)
      .setLabel('Debloquer et executer')
      .setEmoji('🔓')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(CUSTOM_ID_PREFIX + 'owner_deny:' + planId)
      .setLabel('Maintenir le blocage (10 min)')
      .setEmoji('🚫')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(CUSTOM_ID_PREFIX + 'json:' + planId)
      .setLabel('Voir le JSON')
      .setEmoji('📄')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(false)
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
    cancelled: '⏭️',
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
  ownerId = null,
  abortedBy = null,
  abortReason = null,
  rollbackSummary = null,
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

  if (phase === 'owner_approval') {
    color = COLORS.DANGER;
    title = '🚨 CIVIS — Anti-Nuke : Approbation proprietaire requise';
    const ownerMention = ownerId ? `<@${ownerId}>` : 'le proprietaire du serveur';
    header =
      `**${plan.summary}**\n` +
      `Demande de <@${requesterId}> bloquee par l anti-nuke (intervention bloquee pendant **10 minutes**).\n` +
      `> **Motif** : ${security.antiNukeReason || security.reason || 'Activite massive suspectee'}\n` +
      `> Seul ${ownerMention} peut debloquer et autoriser ce plan ci-dessous.`;
  } else if (phase === 'pending') {
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
  } else if (phase === 'aborted') {
    color = COLORS.DANGER;
    title =
      '🛑 CIVIS — Execution arretee en urgence (' + okCount + '/' + plan.steps.length + ' executees)';
    header =
      '**' +
      plan.summary +
      '**\n' +
      (abortedBy ? `Arret declenche par <@${abortedBy}>.` : 'Arret automatique par l anti-nuke.') +
      (abortReason ? '\n> **Motif** : ' + abortReason : '');
  } else if (phase === 'rolling_back') {
    color = COLORS.ACCENT;
    title = '↩️ CIVIS — Retour en arriere en cours';
    header =
      '**' +
      plan.summary +
      '**\nAnnulation des modifications lancee par <@' +
      executorId +
      '>...';
  } else if (phase === 'rolled_back') {
    color = COLORS.SUCCESS;
    title = '↩️ CIVIS — Retour en arriere termine';
    header =
      '**' +
      plan.summary +
      '**\nRetour en arriere execute par <@' +
      executorId +
      '>.' +
      (rollbackSummary ? '\n> ' + rollbackSummary : '');
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
      const debugLine = stats.pipeline
        ? 'Raisonnement : `' +
          stats.pipeline.reasoningModel +
          '` (`' +
          (stats.pipeline.reasoningElapsedMs || 0) +
          ' ms`) -> JSON : `' +
          stats.pipeline.jsonModel +
          '` (`' +
          (stats.pipeline.jsonElapsedMs || 0) +
          ' ms`) • Total : `' +
          (stats.elapsedMs || 0) +
          ' ms`'
        : 'Generation : `' +
          (stats.elapsedMs || 0) +
          ' ms` • Modele : `' +
          (stats.model || '-') +
          '`';
      sections.push({
        heading: '🧪 Debug',
        body: debugLine.slice(0, 1024),
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

  const isOwnerApproval = Boolean(security?.antiNukeBlocked && security?.requiresOwnerApproval);
  const row = isOwnerApproval
    ? buildOwnerApprovalButtons(planId, { disabled: false })
    : buildPlanButtons(planId, {
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
    phase: isOwnerApproval ? 'owner_approval' : 'pending',
    ownerId: guild?.ownerId || null,
    stats,
    isDebug,
    timeoutMs,
    proactiveTrigger,
    notice,
    actionRows: [row],
  });

  const payload = buildV2Message(container, {
    allowedMentions:
      isOwnerApproval && guild?.ownerId
        ? { users: [guild.ownerId] }
        : SAFE_ALLOWED_MENTIONS,
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
    ownerOnly: isOwnerApproval,
    ownerApproved: false,
    aborted: false,
    abortedBy: null,
    message: sentMessage,
    interaction,
    timer: null,
    inProgress: false,
  };

  pendingPlans.set(planId, entry);
  savePlanJsonSnapshot(planId, {
    guildId: guild.id,
    requesterId: requester.id,
    security,
    plan,
    revision: 0,
  });
  schedulePlanExpiration(planId);

  return planId;
}

async function handlePlanButton(interaction) {
  if (!interaction.customId || !interaction.customId.startsWith(CUSTOM_ID_PREFIX)) {
    return false;
  }

  const parts = interaction.customId.split(':');
  const VALID_ACTIONS = new Set([
    'execute',
    'modify',
    'cancel',
    'json',
    'stop',
    'rollback',
    'owner_unlock',
    'owner_deny',
  ]);
  if (parts.length !== 3 || !VALID_ACTIONS.has(parts[1]) || !parts[2]) {
    return false;
  }

  const action = parts[1];
  const planId = parts[2];

  if (action === 'json') {
    const snapshot = getPlanJsonSnapshot(planId);
    if (!snapshot) {
      await interaction.reply(
        buildNoticePayload({
          type: 'warning',
          title: '📄 JSON indisponible',
          description: 'Le JSON de ce plan n est plus disponible en memoire.',
          ephemeral: true,
        })
      );
      return true;
    }

    if (!interaction.guild || interaction.guild.id !== snapshot.guildId) {
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

    const member = await resolveInteractionMember(interaction);
    const isRequester = Boolean(snapshot.requesterId && interaction.user.id === snapshot.requesterId);
    const isAdminOrManager =
      isGuildOwner(interaction.guild, member) ||
      Boolean(
        member?.permissions?.has?.(PermissionFlagsBits.Administrator) ||
          member?.permissions?.has?.(PermissionFlagsBits.ManageGuild)
      );
    const auth = snapshot.security
      ? checkPlanMemberAuthorization(interaction.guild, member, snapshot.security)
      : { authorized: false };

    if (!isRequester && !isAdminOrManager && !auth.authorized) {
      await interaction.reply(
        buildNoticePayload({
          type: 'error',
          title: '🔒 Action non autorisee',
          description: 'Tu n as pas la permission requise pour consulter le JSON de ce plan.',
          ephemeral: true,
        })
      );
      return true;
    }

    const rawJson = JSON.stringify(snapshot.planJson, null, 2);
    const codeBlock = truncateMarkdownSafe('```json\n' + rawJson + '\n```', 3500);
    const versionTag = snapshot.revision > 0 ? ' (v' + (snapshot.revision + 1) + ')' : '';
    const stepCount = Array.isArray(snapshot.planJson.steps) ? snapshot.planJson.steps.length : 0;

    await interaction.reply(
      buildNoticePayload({
        type: 'info',
        title: '📄 JSON du plan' + versionTag,
        description: codeBlock,
        footer: `🦊 CIVIS • ${stepCount} etape(s) • Genere en JSON`,
        ephemeral: true,
      })
    );
    return true;
  }

  if (action === 'rollback') {
    const snap = rollbackSnapshots.get(planId);
    if (!snap || Date.now() > snap.expiresAt) {
      rollbackSnapshots.delete(planId);
      await interaction.reply(
        buildNoticePayload({
          type: 'warning',
          title: '⌛ Retour en arriere expire',
          description: 'Le delai de 300 secondes pour annuler ce plan est depasse.',
          ephemeral: true,
        })
      );
      return true;
    }

    if (!interaction.guild || interaction.guild.id !== snap.guildId) {
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

    if (snap.inProgress) {
      await interaction.reply(
        buildNoticePayload({
          type: 'warning',
          title: '⏳ Retour en arriere en cours',
          description: 'Le retour en arriere de ce plan est deja en cours.',
          ephemeral: true,
        })
      );
      return true;
    }

    const member = await resolveInteractionMember(interaction);
    if (rollbackSnapshots.get(planId) !== snap || snap.inProgress) {
      await interaction.reply(
        buildNoticePayload({
          type: 'warning',
          title: '⏳ Retour en arriere en cours',
          description: 'Le retour en arriere de ce plan est deja en cours.',
          ephemeral: true,
        })
      );
      return true;
    }

    const isOwner = isGuildOwner(interaction.guild, member);
    const isAdminOrOwner =
      isOwner || Boolean(member?.permissions?.has?.(PermissionFlagsBits.Administrator));
    const auth = checkPlanMemberAuthorization(interaction.guild, member, snap.security);
    if ((snap.ownerOnly && !isOwner) || (!isAdminOrOwner && !auth.authorized)) {
      await interaction.reply(
        buildNoticePayload({
          type: 'error',
          title: '🔒 Action non autorisee',
          description: snap.ownerOnly
            ? 'Seul le proprietaire du serveur peut annuler ce plan.'
            : 'Seul un administrateur ou un membre autorise peut lancer le retour en arriere.',
          ephemeral: true,
        })
      );
      return true;
    }

    snap.inProgress = true;
    clearTimeout(snap.timer);
    rollbackSnapshots.delete(planId);

    await interaction.deferUpdate();

    const disabledPlanRow = buildPlanButtons(planId, {
      disabled: true,
      requesterAuthorized: snap.security.requesterAuthorized,
      hasDestructive: snap.security.hasDestructive,
      isProactive: Boolean(snap.proactiveTrigger),
    });
    const disabledRollbackRow = buildRollbackRow(planId, { disabled: true });

    try {
      const rollingCard = buildPlanContainer({
        requesterId: snap.requesterId,
        plan: snap.plan,
        security: snap.security,
        statuses: snap.statuses,
        details: snap.details,
        phase: 'rolling_back',
        executorId: interaction.user.id,
        proactiveTrigger: snap.proactiveTrigger,
        actionRows: [disabledPlanRow, disabledRollbackRow],
      });
      await interaction.editReply(
        buildV2Message(rollingCard, { allowedMentions: SAFE_ALLOWED_MENTIONS })
      );
    } catch {
      // Ignore transient edit error
    }

    const reversed = [...snap.undoStack].reverse();
    let undoOk = 0;
    const undoErrors = [];
    for (const undoItem of reversed) {
      const res = await executeUndoAction(interaction.guild, undoItem, { member });
      if (res.ok) {
        undoOk += 1;
      } else {
        undoErrors.push((undoItem.label || undoItem.kind) + ' : ' + (res.error || 'erreur'));
      }
    }

    const rollbackSummary =
      `${undoOk}/${reversed.length} modification(s) annulee(s).` +
      (undoErrors.length > 0 ? ` Erreurs : ${undoErrors.slice(0, 3).join(' ; ')}` : '');

    const rolledCard = buildPlanContainer({
      requesterId: snap.requesterId,
      plan: snap.plan,
      security: snap.security,
      statuses: snap.statuses,
      details: snap.details,
      phase: 'rolled_back',
      executorId: interaction.user.id,
      proactiveTrigger: snap.proactiveTrigger,
      rollbackSummary,
      actionRows: [disabledPlanRow, disabledRollbackRow],
    });
    try {
      await interaction.editReply(
        buildV2Message(rolledCard, { allowedMentions: SAFE_ALLOWED_MENTIONS })
      );
    } catch (err) {
      console.error('[plans] Erreur mise a jour carte rollback :', err.message);
    }

    await actionLogs.logAction({
      guild: interaction.guild,
      client: interaction.client,
      trigger: 'rollback',
      ok: undoErrors.length === 0,
      toolName: 'plan_rollback',
      args: { planId, stepsUndone: undoOk, totalUndo: reversed.length },
      result: rollbackSummary,
      error: undoErrors.length > 0 ? undoErrors.join(' ; ') : null,
      requesterId: snap.requesterId,
      executorId: interaction.user.id,
      channelId: snap.channelId,
      userText: `Rollback du plan "${snap.plan.summary}"`,
    });

    return true;
  }

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

  if (action === 'stop') {
    if (!pending.inProgress) {
      await interaction.reply(
        buildNoticePayload({
          type: 'info',
          title: 'ℹ️ Aucune execution en cours',
          description: 'Ce plan n est pas en cours d execution.',
          ephemeral: true,
        })
      );
      return true;
    }

    const member = await resolveInteractionMember(interaction);
    const canStop =
      isGuildOwner(interaction.guild, member) ||
      Boolean(member?.permissions?.has?.(PermissionFlagsBits.Administrator)) ||
      Boolean(pending.executorId && interaction.user.id === pending.executorId);
    if (!canStop) {
      await interaction.reply(
        buildNoticePayload({
          type: 'error',
          title: '🔒 Action non autorisee',
          description: 'Seul le proprietaire, un administrateur ou l executeur du plan peut declencher l arret d urgence.',
          ephemeral: true,
        })
      );
      return true;
    }

    pending.aborted = true;
    pending.abortedBy = interaction.user.id;
    await interaction.reply(
      buildNoticePayload({
        type: 'warning',
        title: '🛑 Arret d urgence declenche',
        description: 'L execution du plan est interrompue immediatement apres l etape courante.',
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
    if (pending.ownerOnly && !isGuildOwner(interaction.guild, member)) {
      await interaction.reply(
        buildNoticePayload({
          type: 'error',
          title: '🔒 Reserve au proprietaire',
          description:
            'Ce plan est bloque par l anti-nuke et ne peut pas etre modifie avant validation du proprietaire.',
          ephemeral: true,
        })
      );
      return true;
    }

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
    if (pending.ownerOnly && !isGuildOwner(interaction.guild, member)) {
      await interaction.reply(
        buildNoticePayload({
          type: 'error',
          title: '🔒 Reserve au proprietaire',
          description:
            'Ce plan est bloque par l anti-nuke et ne peut pas etre annule avant decision du proprietaire.',
          ephemeral: true,
        })
      );
      return true;
    }

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

  if (action === 'owner_deny') {
    if (!isGuildOwner(interaction.guild, member)) {
      await interaction.reply(
        buildNoticePayload({
          type: 'error',
          title: '🔒 Reserve au proprietaire',
          description: 'Seul le proprietaire du serveur peut statuer sur un blocage anti-nuke.',
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
    const disabledOwnerRow = buildOwnerApprovalButtons(planId, { disabled: true });
    const cancelledCard = buildPlanContainer({
      requesterId: pending.requesterId,
      plan: pending.plan,
      security: pending.security,
      statuses,
      details,
      phase: 'cancelled',
      executorId: interaction.user.id,
      actionRows: [disabledOwnerRow],
    });
    await interaction.update(
      buildV2Message(cancelledCard, { allowedMentions: SAFE_ALLOWED_MENTIONS })
    );
    return true;
  }

  if (action === 'owner_unlock') {
    if (!isGuildOwner(interaction.guild, member)) {
      await interaction.reply(
        buildNoticePayload({
          type: 'error',
          title: '🔒 Reserve au proprietaire',
          description: 'Seul le proprietaire du serveur peut debloquer et autoriser ce plan.',
          ephemeral: true,
        })
      );
      return true;
    }
    antiNuke.unlockUser(interaction.guild.id, pending.requesterId);
    pending.ownerApproved = true;
  }

  if (
    (pending.ownerOnly ||
      pending.security?.requiresOwnerApproval ||
      pending.security?.antiNukeBlocked) &&
    !pending.ownerApproved
  ) {
    await interaction.reply(
      buildNoticePayload({
        type: 'error',
        title: '🔒 Approbation proprietaire requise',
        description: 'Ce plan est bloque par l anti-nuke et ne peut etre debloque que par le proprietaire du serveur.',
        ephemeral: true,
      })
    );
    return true;
  }

  if (!pending.ownerApproved && !auth.authorized) {
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
  pending.executorId = interaction.user.id;
  clearTimeout(pending.timer);

  try {
    await interaction.deferUpdate();

    const statuses = pending.plan.steps.map(() => 'pending');
    const details = pending.plan.steps.map(() => '');
    const runningRow = buildRunningButtons(planId, { disabled: false });
    let channelDeleted = false;
    let burstAbortReason = null;

    const stepResults = [];
    const undoStack = [];

    for (let i = 0; i < pending.plan.steps.length; i += 1) {
      if (pending.aborted) {
        for (let k = i; k < pending.plan.steps.length; k += 1) {
          statuses[k] = 'cancelled';
        }
        break;
      }

      const step = pending.plan.steps[i];

      // Anti-rafale en cours d execution pour les non-proprietaires (sauf approbation proprietaire)
      if (!pending.ownerApproved && !isGuildOwner(interaction.guild, member)) {
        const burst = antiNuke.recordBurstActivity(interaction.guild, member, {
          toolName: step.tool,
        });
        if (burst.blocked) {
          pending.aborted = true;
          burstAbortReason = burst.reason + ' (blocage 10 minutes active).';
          for (let k = i; k < pending.plan.steps.length; k += 1) {
            statuses[k] = 'cancelled';
          }
          await actionLogs.logSecurityAlert({
            guild: interaction.guild,
            client: interaction.client,
            actorId: interaction.user.id,
            channelId: pending.channelId,
            title: '🚨 Raid / Rafale bloquee en cours d execution',
            reason: burst.reason,
            details: `Plan "${pending.plan.summary}" interrompu a l etape ${i + 1}/${pending.plan.steps.length}.`,
            lockedMinutes: 10,
          });
          break;
        }
      }

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
            actionRows: [runningRow],
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
        if (execRes.undo) {
          undoStack.push(execRes.undo);
        }
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
        if (execRes.protectedChannel) {
          await actionLogs.logSecurityAlert({
            guild: interaction.guild,
            client: interaction.client,
            actorId: interaction.user.id,
            channelId: pending.channelId,
            title: '🛡️ Tentative de suppression d un salon protege bloquee',
            reason: errMsg,
            details: `Plan "${pending.plan.summary}" — etape ${i + 1} (${step.tool}).`,
          });
        }
        stepResults.push({
          tool: step.tool,
          args: step.args,
          label: step.label || step.tool,
          ok: false,
          result: errMsg,
        });
      }

      if (pending.aborted) {
        for (let k = i + 1; k < pending.plan.steps.length; k += 1) {
          statuses[k] = 'cancelled';
        }
        break;
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

    const canRollback = undoStack.length > 0;
    const rollbackWindowSec = Math.round(ROLLBACK_WINDOW_MS / 1000);
    const disabledPlanRow = buildPlanButtons(planId, {
      disabled: true,
      requesterAuthorized: pending.security.requesterAuthorized,
      hasDestructive: pending.security.hasDestructive,
      isProactive: Boolean(pending.proactiveTrigger),
    });
    const postActionRows = canRollback
      ? [disabledPlanRow, buildRollbackRow(planId, { disabled: false, rollbackWindowSec })]
      : [disabledPlanRow];

    const finalPhase = pending.aborted ? 'aborted' : 'done';

    if (canRollback) {
      const snap = {
        planId,
        guildId: pending.guildId,
        channelId: pending.channelId,
        requesterId: pending.requesterId,
        executorId: interaction.user.id,
        plan: pending.plan,
        security: pending.security,
        undoStack,
        statuses: [...statuses],
        details: [...details],
        proactiveTrigger: pending.proactiveTrigger,
        ownerOnly: Boolean(pending.ownerOnly),
        message: pending.message,
        interaction,
        expiresAt: Date.now() + ROLLBACK_WINDOW_MS,
        inProgress: false,
        timer: null,
      };
      const rbTimer = setTimeout(async () => {
        const cur = rollbackSnapshots.get(planId);
        if (!cur || cur.inProgress) return;
        rollbackSnapshots.delete(planId);
        if (channelDeleted) return;
        const expiredRows = [disabledPlanRow, buildRollbackRow(planId, { disabled: true })];
        const expiredCard = buildPlanContainer({
          requesterId: cur.requesterId,
          plan: cur.plan,
          security: cur.security,
          statuses: cur.statuses,
          details: cur.details,
          phase: finalPhase,
          executorId: cur.executorId,
          abortedBy: pending.abortedBy,
          abortReason: burstAbortReason,
          proactiveTrigger: cur.proactiveTrigger,
          actionRows: expiredRows,
        });
        try {
          await interaction.editReply(
            buildV2Message(expiredCard, { allowedMentions: SAFE_ALLOWED_MENTIONS })
          );
        } catch {
          // Ignore expired interaction edit error
        }
      }, ROLLBACK_WINDOW_MS);
      if (typeof rbTimer.unref === 'function') {
        rbTimer.unref();
      }
      snap.timer = rbTimer;
      rollbackSnapshots.set(planId, snap);
    }

    if (!channelDeleted) {
      const doneCard = buildPlanContainer({
        requesterId: pending.requesterId,
        plan: pending.plan,
        security: pending.security,
        statuses,
        details,
        phase: finalPhase,
        executorId: interaction.user.id,
        abortedBy: pending.abortedBy,
        abortReason: burstAbortReason,
        proactiveTrigger: pending.proactiveTrigger,
        actionRows: postActionRows,
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

  if (pending.ownerOnly && !isGuildOwner(interaction.guild, member)) {
    await interaction.reply(
      buildNoticePayload({
        type: 'error',
        title: '🔒 Reserve au proprietaire',
        description:
          'Ce plan est bloque par l anti-nuke et ne peut pas etre modifie avant validation du proprietaire.',
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
      if (revised.protectedChannel || revised.securityAlert) {
        await actionLogs.logSecurityAlert({
          guild: interaction.guild,
          client: interaction.client,
          actorId: interaction.user.id,
          channelId: pending.channelId,
          title: '🛡️ Tentative sur salon protege bloquee (modification plan)',
          reason: revised.error,
        });
      }
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

    const modifierAntiNuke = !isGuildOwner(interaction.guild, member)
      ? antiNuke.inspectPlanForAntiNuke(revised.plan, interaction.guild, member, {
          actionLogs,
        })
      : null;

    if (modifierAntiNuke?.protectedViolation) {
      await actionLogs.logSecurityAlert({
        guild: interaction.guild,
        client: interaction.client,
        actorId: interaction.user.id,
        channelId: pending.channelId,
        title: '🛡️ Tentative sur salon protege bloquee (modification plan)',
        reason: modifierAntiNuke.reason,
      });
      await updatePlanMessageViaModal(interaction, pending, buildCurrentPendingPayload());
      if (typeof interaction.followUp === 'function') {
        await interaction.followUp(
          buildNoticePayload({
            type: 'warning',
            title: '🛡️ Modification bloquee',
            description:
              '🛡️ ' + modifierAntiNuke.reason + '\n> Le plan precedent est conserve.',
            ephemeral: true,
          })
        );
      }
      return true;
    }

    const isNowAntiNukeBlocked = Boolean(
      revised.security?.antiNukeBlocked ||
        revised.security?.requiresOwnerApproval ||
        modifierAntiNuke?.blocked
    );
    const antiNukeReason =
      revised.security?.antiNukeReason ||
      modifierAntiNuke?.reason ||
      revised.security?.reason ||
      'Activite massive suspectee';

    pending.plan = revised.plan;
    pending.security = isNowAntiNukeBlocked
      ? {
          ...revised.security,
          antiNukeBlocked: true,
          requiresOwnerApproval: true,
          requesterAuthorized: false,
          antiNukeReason,
          reason: antiNukeReason,
        }
      : revised.security;
    pending.stats = revised.stats;
    pending.revision += 1;
    pending.lastModification = modificationRequest;
    pending.lastModifiedBy = interaction.user.id;
    if (isNowAntiNukeBlocked) {
      pending.ownerOnly = true;
      pending.ownerApproved = false;
    }
    savePlanJsonSnapshot(planId, {
      guildId: pending.guildId,
      requesterId: pending.requesterId,
      security: pending.security,
      plan: pending.plan,
      revision: pending.revision,
    });

    if (isNowAntiNukeBlocked) {
      antiNuke.triggerLockout(interaction.guild.id, interaction.user.id, antiNukeReason);
      await actionLogs.logSecurityAlert({
        guild: interaction.guild,
        client: interaction.client,
        actorId: interaction.user.id,
        channelId: pending.channelId,
        title: '🚨 Anti-Nuke : modification de plan bloquee',
        reason: antiNukeReason,
        details: `Plan "${pending.plan.summary}" (${pending.plan.steps.length} etape(s)) — approbation proprietaire requise.`,
        lockedMinutes: 10,
      });
      const ownerRow = buildOwnerApprovalButtons(planId, { disabled: false });
      const ownerCard = buildPlanContainer({
        requesterId: pending.requesterId,
        plan: pending.plan,
        security: pending.security,
        statuses: pending.plan.steps.map(() => 'pending'),
        details: pending.plan.steps.map(() => ''),
        phase: 'owner_approval',
        ownerId: interaction.guild?.ownerId || null,
        stats: pending.stats,
        isDebug: pending.isDebug,
        timeoutMs: pending.timeoutMs,
        revision: pending.revision,
        lastModification: pending.lastModification,
        lastModifiedBy: pending.lastModifiedBy,
        proactiveTrigger: pending.proactiveTrigger,
        notice: buildFallbackNotice(revised.stats).trim() || null,
        actionRows: [ownerRow],
      });
      await updatePlanMessageViaModal(
        interaction,
        pending,
        buildV2Message(ownerCard, {
          allowedMentions: interaction.guild?.ownerId
            ? { users: [interaction.guild.ownerId] }
            : SAFE_ALLOWED_MENTIONS,
        })
      );
      return true;
    }

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
        description: sanitizePublicError(
          err,
          'Une erreur interne est survenue lors de la modification du plan.'
        ),
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
  for (const snap of rollbackSnapshots.values()) {
    clearTimeout(snap.timer);
  }
  pendingPlans.clear();
  planJsonSnapshots.clear();
  rollbackSnapshots.clear();
}

module.exports = {
  PLAN_TIMEOUT_MS,
  ROLLBACK_WINDOW_MS,
  PLAN_STEP_DELAY_MS,
  createPlanRequest,
  handlePlanButton,
  handlePlanModal,
  hasPendingProactivePlanForGuild,
  clearAllPendingPlans,
};
