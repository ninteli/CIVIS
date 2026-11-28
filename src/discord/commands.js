const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  ChannelType,
  AttachmentBuilder,
} = require('discord.js');
const debug = require('../agent/debug');
const brain = require('../agent/brain');
const memory = require('../agent/memory');
const llm = require('../agent/llm');
const planner = require('../agent/planner');
const rateLimit = require('../agent/rate-limit');
const userKeys = require('../agent/user-keys');
const antiNuke = require('../agent/anti-nuke');
const { isGuildOwner } = require('../agent/permissions');
const versionManager = require('../version');
const approvals = require('./approvals');
const plans = require('./plans');
const actionLogs = require('./action-logs');
const auditSuggestions = require('./audit-suggestions');
const serverExport = require('./server-export');
const planImport = require('./plan-import');
const { COLORS, buildV2Card, buildV2Message } = require('./ui-v2');
const {
  buildFallbackNotice,
  buildNoticePayload,
  buildChatReplyPayload,
  sanitizePublicError,
} = require('./format');

const exportRateLimit = rateLimit.createRateLimiter({ cooldownMs: 10_000 });
const apiKeyRateLimit = rateLimit.createRateLimiter({ cooldownMs: 5_000 });

const commandsData = [
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Teste si le bot est vivant')
    .toJSON(),

  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Pose une question a CIVIS')
    .addStringOption((opt) =>
      opt.setName('question').setDescription('Ta question').setRequired(true)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('agent')
    .setDescription('Demande une action a CIVIS (creer un salon, etc.)')
    .addStringOption((opt) =>
      opt.setName('demande').setDescription('Ta demande d action').setRequired(true)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('plan')
    .setDescription('Planifie et execute une configuration multi-etapes du serveur')
    .addStringOption((opt) =>
      opt
        .setName('demande')
        .setDescription('Configuration souhaitee (salons, categories, roles, permissions)')
        .setRequired(true)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('debugmod')
    .setDescription('Active/desactive le mode debug pour ce salon (admin uniquement)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .toJSON(),

  new SlashCommandBuilder()
    .setName('apikey')
    .setDescription('Configure ta cle API personnelle (sinon l IA locale gratuite est utilisee)')
    .addSubcommand((sub) =>
      sub
        .setName('set')
        .setDescription('Enregistrer ta cle API personnelle')
        .addStringOption((opt) =>
          opt
            .setName('fournisseur')
            .setDescription('Fournisseur d API')
            .setRequired(true)
            .addChoices(
              { name: 'OpenAI', value: 'openai' },
              { name: 'Gemini (Google)', value: 'gemini' },
              { name: 'Groq', value: 'groq' },
              { name: 'OpenRouter', value: 'openrouter' },
              { name: 'Mistral', value: 'mistral' },
              { name: 'Personnalise', value: 'custom' }
            )
        )
        .addStringOption((opt) =>
          opt
            .setName('cle')
            .setDescription('Ta cle API personnelle (stockee chiffree, visible uniquement par toi)')
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName('modele')
            .setDescription('Nom du modele (optionnel, defaut selon fournisseur)')
            .setRequired(false)
        )
        .addStringOption((opt) =>
          opt
            .setName('url')
            .setDescription('URL de base HTTPS OpenAI-compatible (requis si Personnalise)')
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('test')
        .setDescription('Tester ta cle API enregistree (et ajuster le modele si besoin)')
    )
    .addSubcommand((sub) =>
      sub
        .setName('model')
        .setDescription('Changer le modele utilise par ta cle API')
        .addStringOption((opt) =>
          opt
            .setName('modele')
            .setDescription('Nom exact du modele (ex: gemini-3.8-flash, gpt-4o-mini)')
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('status')
        .setDescription('Voir ta configuration IA actuelle (locale gratuite ou cle API)')
    )
    .addSubcommand((sub) =>
      sub
        .setName('clear')
        .setDescription('Supprimer ta cle API personnelle et revenir sur l IA locale gratuite')
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('logs')
    .setDescription('Configurer et tester les logs automatiques par webhook (Administrateurs)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName('set')
        .setDescription('Definir le salon Discord qui recevra les webhooks de logs')
        .addChannelOption((opt) =>
          opt
            .setName('salon')
            .setDescription('Salon texte ou annonce dedie aux logs')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('webhook')
        .setDescription('Configurer une URL de webhook Discord personnalisee (stockage chiffre)')
        .addStringOption((opt) =>
          opt
            .setName('url')
            .setDescription('URL https://discord.com/api/webhooks/<id>/<token>')
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('status')
        .setDescription('Afficher la configuration actuelle des logs sur ce serveur')
    )
    .addSubcommand((sub) =>
      sub
        .setName('test')
        .setDescription('Envoyer un log de test avec informations IA vers le canal/webhook configure')
    )
    .addSubcommand((sub) =>
      sub
        .setName('off')
        .setDescription('Desactiver temporairement l envoi des logs sur ce serveur')
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('suggestions')
    .setDescription(
      'Configurer les suggestions proactives sur modifications manuelles (Audit Logs)'
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName('on')
        .setDescription('Activer les suggestions proactives de plans via Audit Logs')
    )
    .addSubcommand((sub) =>
      sub
        .setName('off')
        .setDescription('Desactiver les suggestions proactives sur ce serveur')
    )
    .addSubcommand((sub) =>
      sub
        .setName('set')
        .setDescription('Definir le salon ou poster les suggestions et activer la fonction')
        .addChannelOption((opt) =>
          opt
            .setName('salon')
            .setDescription('Salon texte ou annonce dedie aux suggestions IA')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('cooldown')
        .setDescription('Regler le delai minimal entre deux suggestions proactives (10 a 3600s)')
        .addIntegerOption((opt) =>
          opt
            .setName('secondes')
            .setDescription('Delai minimal en secondes (10 a 3600)')
            .setMinValue(10)
            .setMaxValue(3600)
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('status')
        .setDescription('Voir la configuration des suggestions proactives et la permission Audit Logs')
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('export')
    .setDescription('Exporte en fichier .md toutes les informations accessibles du serveur')
    .addBooleanOption((opt) =>
      opt
        .setName('public')
        .setDescription('Publier le fichier dans ce salon (par defaut : visible uniquement par toi)')
        .setRequired(false)
    )
    .addBooleanOption((opt) =>
      opt
        .setName('guide_ia')
        .setDescription('Inclure le guide de format JSON CIVIS pour IA externe (defaut : oui)')
        .setRequired(false)
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('import')
    .setDescription('Importe et pre-valide un script JSON de modifications du serveur (genere par IA)')
    .addAttachmentOption((opt) =>
      opt
        .setName('fichier')
        .setDescription('Fichier .json contenant le plan d actions CIVIS (max 256 Ko)')
        .setRequired(false)
    )
    .addStringOption((opt) =>
      opt
        .setName('json')
        .setDescription('Script JSON colle directement (si aucun fichier n est joint)')
        .setRequired(false)
    )
    .toJSON(),
];

async function registerCommands(client) {
  try {
    // 1. Commandes globales uniquement (evite les doublons global + serveur)
    await client.application.commands.set(commandsData);
    console.log('[commands] ' + commandsData.length + ' commande(s) globale(s) enregistree(s)');

    // 2. Nettoyage d'eventuelles commandes par serveur restantes pour eviter le double affichage
    for (const [, guild] of client.guilds.cache) {
      try {
        await guild.commands.set([]);
        console.log('[commands] Doublons serveur nettoyes sur : ' + guild.name);
      } catch (e) {
        console.error('[commands] Erreur nettoyage serveur ' + guild.name + ' : ' + e.message);
      }
    }
  } catch (err) {
    console.error('[commands] Erreur enregistrement :', err);
  }
}

function buildVerifyFailurePayload(title, header, cfgSummary, verify) {
  const sections = [
    header,
    `• **Fournisseur** : ${cfgSummary.label}\n• **Modele teste** : \`${cfgSummary.model}\`\n• **Raison** : ${verify.reason}`,
  ];
  if (verify.apiMessage) {
    sections.push({
      heading: '💬 Detail API',
      body: '`' + String(verify.apiMessage).slice(0, 400) + '`',
    });
  }
  if (verify.attemptErrors && verify.attemptErrors.length > 0) {
    sections.push({
      heading: '🔁 Essais automatiques echoues',
      body: verify.attemptErrors
        .slice(0, 3)
        .map((e) => '• ' + e)
        .join('\n'),
    });
  }
  if (verify.suggestedModels && verify.suggestedModels.length > 0) {
    sections.push({
      heading: '🤖 Modeles detectes sur ton compte',
      body:
        verify.suggestedModels.map((m) => '`' + m + '`').join(', ') +
        '\n> Utilise `/apikey model modele:<nom>` pour en selectionner un.',
    });
  }
  return buildNoticePayload({
    type: 'warning',
    title,
    sections,
    ephemeral: true,
  });
}

async function handleInteraction(interaction) {
  if (interaction.guild && interaction.user && !isGuildOwner(interaction.guild, interaction.member || interaction.user)) {
    const lock = antiNuke.checkUserLockout(interaction.guild.id, interaction.user.id);
    if (lock.locked) {
      const mins = Math.floor(lock.remainingSec / 60);
      const secs = lock.remainingSec % 60;
      const timeLabel = mins > 0 ? `${mins} min ${secs}s` : `${secs}s`;
      const ownerNote = interaction.guild.ownerId
        ? `\n> Seul le proprietaire du serveur (<@${interaction.guild.ownerId}>) peut lever ce blocage avant expiration.`
        : '';
      return interaction.reply(
        buildNoticePayload({
          type: 'error',
          title: '🚨 Acces bloque par l anti-nuke',
          description:
            `Toute intervention envers CIVIS est bloquee pour toi pendant encore **${timeLabel}**.\n` +
            `• **Motif** : ${lock.reason}` +
            ownerNote,
          ephemeral: true,
        })
      );
    }
  }

  if (interaction.isButton()) {
    if (interaction.customId && interaction.customId.startsWith('plan:')) {
      return plans.handlePlanButton(interaction);
    }
    return approvals.handleApprovalButton(interaction);
  }
  if (typeof interaction.isModalSubmit === 'function' && interaction.isModalSubmit()) {
    if (interaction.customId && interaction.customId.startsWith('plan:')) {
      return plans.handlePlanModal(interaction);
    }
    return;
  }
  if (!interaction.isChatInputCommand()) return;

  const { commandName, channel, user, member } = interaction;

  if (commandName === 'ping') {
    const wsPing = interaction.client?.ws?.ping;
    const version = versionManager.getCurrentVersion();
    const pingLine =
      Number.isFinite(wsPing) && wsPing >= 0 ? `\n• **Latence passerelle** : \`${Math.round(wsPing)} ms\`` : '';
    return interaction.reply(
      buildNoticePayload({
        type: 'info',
        title: '🏓 Pong !',
        description:
          '🟢 **CIVIS est en ligne et operationnel.**' +
          `\n• **Version** : \`v${version}\`` +
          pingLine,
        footer: `🦊 CIVIS • v${version}`,
        ephemeral: true,
      })
    );
  }

  if (commandName === 'export') {
    if (!interaction.guild) {
      return interaction.reply(
        buildNoticePayload({
          type: 'error',
          title: '❌ Action impossible',
          description: 'Cette commande doit etre utilisee dans un serveur Discord.',
          ephemeral: true,
        })
      );
    }

    const limit = exportRateLimit.acquire(user.id);
    if (!limit.ok) {
      return interaction.reply(
        buildNoticePayload({
          type: 'warning',
          title: '⏳ Un instant...',
          description: limit.message,
          ephemeral: true,
        })
      );
    }

    const requestedPublic = interaction.options.getBoolean('public') === true;
    const canPublishPublic =
      isGuildOwner(interaction.guild, member) ||
      Boolean(
        member?.permissions?.has?.(PermissionFlagsBits.Administrator) ||
          member?.permissions?.has?.(PermissionFlagsBits.ManageGuild)
      );
    const isPublic = requestedPublic && canPublishPublic;
    const includeAiGuide = interaction.options.getBoolean('guide_ia') !== false;
    await interaction.deferReply(isPublic ? {} : { flags: MessageFlags.Ephemeral });

    try {
      const exp = await serverExport.buildServerExport({
        guild: interaction.guild,
        member,
        client: interaction.client,
        actionLogs,
        auditSuggestions,
        includeAiGuide,
      });

      const attachment = new AttachmentBuilder(Buffer.from(exp.markdown, 'utf8'), {
        name: exp.filename,
      });

      const sizeKb = (exp.bytes / 1024).toFixed(1);
      const scopeLabel = exp.access.isAdminOrOwner
        ? 'Complet (Administrateur)'
        : 'Filtre selon tes permissions';

      const summaryLines = [
        `• **Serveur** : ${interaction.guild.name} (\`${interaction.guild.id}\`)`,
        `• **Perimetre** : ${scopeLabel}`,
        `• **Contenu** : ${exp.stats.rolesCount} role(s), ${exp.stats.categoriesCount} categorie(s), ${exp.stats.channelsCount} salon(s), ${exp.stats.threadsCount} thread(s)`,
        `• **Ressources** : ${exp.stats.emojisCount} emoji(s), ${exp.stats.stickersCount} sticker(s), ${exp.stats.eventsCount} evenement(s)`,
        `• **Fichier** : \`${exp.filename}\` (${sizeKb} Ko)`,
      ];

      const noticeParts = [];
      if (!exp.access.isAdminOrOwner) {
        noticeParts.push(
          'Les salons prives et sections d administration auxquels tu n as pas acces ont ete automatiquement filtres.'
        );
      }
      if (requestedPublic && !canPublishPublic) {
        noticeParts.push(
          '🔒 Tu n as pas les permissions requises (ManageGuild) pour publier cet export dans le salon : il a ete envoye en mode prive (ephemere).'
        );
      }
      const notice = noticeParts.length > 0 ? noticeParts.join('\n') : null;

      const card = buildV2Card({
        color: COLORS.SUCCESS,
        title: '📄 Export Markdown du serveur',
        sections: [summaryLines.join('\n')],
        fileAttachments: [exp.filename],
        notice,
        footer: '🦊 CIVIS • Export serveur',
      });

      await interaction.editReply(
        buildV2Message(card, {
          ephemeral: !isPublic,
          files: [attachment],
        })
      );
    } catch (err) {
      console.error('[export] Erreur :', err);
      await interaction.editReply(
        buildNoticePayload({
          type: 'error',
          title: '❌ Erreur lors de l export',
          description: sanitizePublicError(
            err,
            'Impossible de generer l export Markdown du serveur.'
          ),
          ephemeral: !isPublic,
        })
      );
    } finally {
      exportRateLimit.release(user.id);
    }
    return;
  }

  if (commandName === 'import') {
    if (!interaction.guild) {
      return interaction.reply(
        buildNoticePayload({
          type: 'error',
          title: '❌ Action impossible',
          description: 'Cette commande doit etre utilisee dans un serveur Discord.',
          ephemeral: true,
        })
      );
    }

    const attachment =
      typeof interaction.options.getAttachment === 'function'
        ? interaction.options.getAttachment('fichier')
        : null;
    const rawJsonText =
      typeof interaction.options.getString === 'function'
        ? interaction.options.getString('json')
        : null;

    if (!attachment && (!rawJsonText || !rawJsonText.trim())) {
      return interaction.reply(
        buildNoticePayload({
          type: 'info',
          title: '📥 Importer un script JSON CIVIS',
          description:
            'Fournis un fichier `.json` via l option `fichier` ou colle ton JSON via l option `json`.\n' +
            '> Astuce : utilise `/export` pour obtenir l etat complet du serveur ainsi que le guide de format JSON a transmettre a une IA externe (Gemini, etc.).',
          ephemeral: true,
        })
      );
    }

    const limit = rateLimit.acquire(user.id);
    if (!limit.ok) {
      return interaction.reply(
        buildNoticePayload({
          type: 'warning',
          title: '⏳ Un instant...',
          description: limit.message,
          ephemeral: true,
        })
      );
    }

    await interaction.deferReply();

    try {
      const importRes = await planImport.loadAndValidateImportedPlan({
        attachment,
        rawJsonText,
        guild: interaction.guild,
        member,
      });

      if (!importRes.ok) {
        if (importRes.protectedChannel || importRes.securityAlert) {
          await actionLogs.logSecurityAlert({
            guild: interaction.guild,
            client: interaction.client,
            actorId: user.id,
            channelId: channel.id,
            title: '🛡️ Tentative sur salon protege bloquee (/import)',
            reason: importRes.error,
          });
        }
        await interaction.editReply(
          buildNoticePayload({
            type: 'warning',
            title: '⚠️ Script JSON invalide',
            description: importRes.error,
            footer: '💡 Tu peux copier cette erreur a ton IA externe pour corriger le script JSON.',
          })
        );
        return;
      }

      if (importRes.security?.antiNukeBlocked) {
        antiNuke.triggerLockout(interaction.guild.id, user.id, importRes.security.antiNukeReason);
        await actionLogs.logSecurityAlert({
          guild: interaction.guild,
          client: interaction.client,
          actorId: user.id,
          channelId: channel.id,
          title: '🚨 Anti-Nuke : script /import bloque en pre-validation',
          reason: importRes.security.antiNukeReason,
          details: `Plan "${importRes.plan.summary}" (${importRes.plan.steps.length} etape(s)) — approbation proprietaire requise.`,
          lockedMinutes: 10,
        });
      }

      memory.addActionMessage(channel.id, user.id, {
        role: 'user',
        content: `[import JSON] ${importRes.sourceLabel}`,
        authorName: member?.displayName || user.username,
      });
      if (importRes.plan?.summary) {
        memory.addActionMessage(channel.id, user.id, {
          role: 'assistant',
          content: `[import JSON] ${importRes.plan.summary}`,
        });
      }

      await plans.createPlanRequest({
        interaction,
        channel,
        guild: interaction.guild,
        requester: user,
        plan: importRes.plan,
        security: importRes.security,
        userText: `[import JSON] ${importRes.plan.summary}`,
        stats: importRes.stats,
        isDebug: debug.isEnabled(channel.id),
      });
    } catch (err) {
      console.error('[import] Erreur :', err);
      await interaction.editReply(
        buildNoticePayload({
          type: 'error',
          title: '❌ Erreur lors de l import JSON',
          description: sanitizePublicError(err, 'Impossible de charger ce script JSON.'),
        })
      );
    } finally {
      rateLimit.release(user.id);
    }
    return;
  }

  if (commandName === 'debugmod') {
    if (!interaction.guild) {
      return interaction.reply(
        buildNoticePayload({
          type: 'error',
          title: '❌ Action impossible',
          description: 'Cette commande doit etre utilisee dans un serveur Discord.',
          ephemeral: true,
        })
      );
    }
    if (!member?.permissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply(
        buildNoticePayload({
          type: 'error',
          title: '🔒 Permission requise',
          description: 'Permission requise : Gerer le serveur (`ManageGuild`).',
          ephemeral: true,
        })
      );
    }
    const nowEnabled = debug.toggle(channel.id);
    return interaction.reply(
      buildNoticePayload({
        type: nowEnabled ? 'accent' : 'neutral',
        title: nowEnabled ? '🧪 Mode Debug active' : '🧪 Mode Debug desactive',
        description: nowEnabled
          ? 'Mode debug active pour ce salon.\n> Les reponses de CIVIS afficheront les metriques IA detaillees.'
          : 'Mode debug desactive pour ce salon.',
        ephemeral: true,
      })
    );
  }

  if (commandName === 'logs') {
    if (!interaction.guild) {
      return interaction.reply(
        buildNoticePayload({
          type: 'error',
          title: '❌ Action impossible',
          description: 'Cette commande doit etre utilisee dans un serveur Discord.',
          ephemeral: true,
        })
      );
    }
    if (!member?.permissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply(
        buildNoticePayload({
          type: 'error',
          title: '🔒 Permission requise',
          description: 'Permission requise : Gerer le serveur (`ManageGuild`).',
          ephemeral: true,
        })
      );
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'set') {
      const targetChannel = interaction.options.getChannel('salon');
      if (!targetChannel) {
        return interaction.reply(
          buildNoticePayload({
            type: 'error',
            title: '❌ Salon invalide',
            description: 'Salon invalide.',
            ephemeral: true,
          })
        );
      }
      actionLogs.setLogChannel(interaction.guild.id, targetChannel.id, user.id);
      actionLogs.clearWebhookCache(targetChannel.id);

      const perms = targetChannel.permissionsFor?.(interaction.client?.user);
      const warnings = [];
      if (perms && !perms.has(PermissionFlagsBits.SendMessages)) {
        warnings.push('⚠️ Le bot n a pas la permission `SendMessages` dans ce salon.');
      }
      if (perms && !perms.has(PermissionFlagsBits.ManageWebhooks)) {
        warnings.push(
          'ℹ️ Permission `ManageWebhooks` absente : repli automatique sur les cartes V2 classiques.'
        );
      }
      return interaction.reply(
        buildNoticePayload({
          type: warnings.length > 0 ? 'warning' : 'success',
          title: '✅ Salon de logs configure',
          description: `✅ Salon de logs configure sur <#${targetChannel.id}>.`,
          sections: warnings.length > 0 ? [warnings.join('\n')] : [],
          ephemeral: true,
        })
      );
    }

    if (sub === 'webhook') {
      const url = interaction.options.getString('url');
      const res = actionLogs.setWebhookUrl(interaction.guild.id, url, user.id);
      if (!res.ok) {
        return interaction.reply(
          buildNoticePayload({
            type: 'error',
            title: '❌ Webhook invalide',
            description: res.error,
            ephemeral: true,
          })
        );
      }
      return interaction.reply(
        buildNoticePayload({
          type: 'success',
          title: '🔐 Webhook chiffre enregistre',
          description:
            '✅ Webhook personnalise enregistre et chiffre (`AES-256-GCM`) : `' +
            res.maskedUrl +
            '`.\n> Toutes les actions et infos IA y seront envoyees.',
          ephemeral: true,
        })
      );
    }

    if (sub === 'status') {
      const status = actionLogs.getGuildLogStatus(interaction.guild.id);
      const lines = [];
      let type = 'info';
      if (!status.enabled || status.mode === 'off') {
        type = 'neutral';
        lines.push('• **Statut** : 🔴 Desactive (`/logs off`)');
        lines.push('> Utilise `/logs set` ou `/logs webhook` pour reactiver.');
      } else if (status.mode === 'webhook') {
        type = 'success';
        lines.push('• **Statut** : 🟢 Actif (Webhook personnalise chiffre)');
        lines.push('• **Webhook** : `' + (status.maskedWebhookUrl || 'inconnu') + '`');
      } else if (status.mode === 'channel') {
        type = 'success';
        lines.push('• **Statut** : 🟢 Actif (Salon configure)');
        lines.push('• **Salon** : <#' + status.channelId + '>');
      } else {
        const autoChan = actionLogs.findAutoLogChannel(interaction.guild, interaction.client);
        type = autoChan ? 'success' : 'warning';
        lines.push('• **Statut** : 🟢 Actif (Detection automatique `#logs`)');
        if (autoChan) {
          const perms = autoChan.permissionsFor?.(interaction.client?.user);
          const whOk = perms ? perms.has(PermissionFlagsBits.ManageWebhooks) : true;
          lines.push(
            '• **Salon detecte** : <#' +
              autoChan.id +
              '> (`' +
              autoChan.name +
              '`) — ' +
              (whOk ? 'Webhook pret' : 'Sans ManageWebhooks (repli message)')
          );
        } else {
          lines.push(
            '• **Salon detecte** : ⚠️ Aucun salon `#logs` trouve. Cree un salon `#logs` ou utilise `/logs set`.'
          );
        }
      }
      const footer = status.updatedBy ? 'Derniere modification par <@' + status.updatedBy + '>' : null;
      return interaction.reply(
        buildNoticePayload({
          type,
          title: '🧾 Configuration des logs — ' + interaction.guild.name,
          description: lines.join('\n'),
          sections: status.updatedBy ? ['👤 **Derniere modification** : <@' + status.updatedBy + '>'] : [],
          footer: footer ? '🦊 CIVIS • Logs' : undefined,
          ephemeral: true,
        })
      );
    }

    if (sub === 'test') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const res = await actionLogs.sendTestLog({
        guild: interaction.guild,
        client: interaction.client,
        requesterId: user.id,
        originChannelId: channel?.id || null,
      });
      if (res.ok) {
        const loc = res.channelId ? ' dans <#' + res.channelId + '>' : '';
        return interaction.editReply(
          buildNoticePayload({
            type: 'success',
            title: '🧪 Log de test envoye',
            description: '✅ Log de test envoye avec succes (`' + res.delivery + '`' + loc + ').',
            ephemeral: true,
          })
        );
      }
      return interaction.editReply(
        buildNoticePayload({
          type: 'warning',
          title: '⚠️ Echec du log de test',
          description:
            'Impossible d envoyer le log de test (`' +
            (res.reason || res.error || 'inconnu') +
            '`).\n> Verifie qu un salon `#logs`, `/logs set` ou `/logs webhook` est configure et accessible.',
          ephemeral: true,
        })
      );
    }

    if (sub === 'off') {
      actionLogs.disableLogs(interaction.guild.id, user.id);
      return interaction.reply(
        buildNoticePayload({
          type: 'neutral',
          title: '🛑 Logs desactives',
          description:
            'Logs automatiques desactives pour ce serveur.\n> Utilise `/logs set` ou `/logs webhook` pour les reactiver.',
          ephemeral: true,
        })
      );
    }
  }

  if (commandName === 'suggestions') {
    if (!interaction.guild) {
      return interaction.reply(
        buildNoticePayload({
          type: 'error',
          title: '❌ Action impossible',
          description: 'Cette commande doit etre utilisee dans un serveur Discord.',
          ephemeral: true,
        })
      );
    }
    if (!member?.permissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply(
        buildNoticePayload({
          type: 'error',
          title: '🔒 Permission requise',
          description: 'Permission requise : Gerer le serveur (`ManageGuild`).',
          ephemeral: true,
        })
      );
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'on') {
      const res = auditSuggestions.enableSuggestions(interaction.guild.id, user.id);
      if (!res.ok) {
        return interaction.reply(
          buildNoticePayload({
            type: 'warning',
            title: '⚠️ Salon requis',
            description: res.error,
            ephemeral: true,
          })
        );
      }
      const hasViewAudit = interaction.guild.members?.me?.permissions?.has(
        PermissionFlagsBits.ViewAuditLog
      );
      const warnAudit = hasViewAudit === false
        ? '⚠️ Permission `Voir les logs du serveur` (`ViewAuditLog`) manquante pour le bot.'
        : null;
      return interaction.reply(
        buildNoticePayload({
          type: warnAudit ? 'warning' : 'success',
          title: '💡 Suggestions proactives activees',
          description: '✅ Suggestions proactives sur Audit Logs **activees** pour ce serveur.',
          sections: warnAudit ? [warnAudit] : [],
          ephemeral: true,
        })
      );
    }

    if (sub === 'off') {
      auditSuggestions.disableSuggestions(interaction.guild.id, user.id);
      return interaction.reply(
        buildNoticePayload({
          type: 'neutral',
          title: '🛑 Suggestions proactives desactivees',
          description:
            'Suggestions proactives **desactivees** pour ce serveur.\n> Utilise `/suggestions set salon:#salon` ou `/suggestions on` pour les reactiver.',
          ephemeral: true,
        })
      );
    }

    if (sub === 'set') {
      const targetChannel = interaction.options.getChannel('salon');
      if (!targetChannel) {
        return interaction.reply(
          buildNoticePayload({
            type: 'error',
            title: '❌ Salon invalide',
            description: 'Salon invalide.',
            ephemeral: true,
          })
        );
      }
      auditSuggestions.setSuggestionChannel(interaction.guild.id, targetChannel.id, user.id);
      const perms = targetChannel.permissionsFor?.(interaction.client?.user);
      const warnSend =
        perms && !perms.has(PermissionFlagsBits.SendMessages)
          ? '⚠️ Le bot n a pas la permission `SendMessages` dans ce salon.'
          : null;
      return interaction.reply(
        buildNoticePayload({
          type: warnSend ? 'warning' : 'success',
          title: '✅ Salon des suggestions configure',
          description: `✅ Salon des suggestions proactives configure sur <#${targetChannel.id}> (suggestions activees).`,
          sections: warnSend ? [warnSend] : [],
          ephemeral: true,
        })
      );
    }

    if (sub === 'cooldown') {
      const seconds = interaction.options.getInteger('secondes');
      const res = auditSuggestions.setCooldown(interaction.guild.id, seconds, user.id);
      if (!res.ok) {
        return interaction.reply(
          buildNoticePayload({
            type: 'error',
            title: '❌ Cooldown invalide',
            description: res.error,
            ephemeral: true,
          })
        );
      }
      return interaction.reply(
        buildNoticePayload({
          type: 'success',
          title: '⏱️ Cooldown mis a jour',
          description: `✅ Cooldown des suggestions proactives regle sur **${res.config.cooldownSec}s**.`,
          ephemeral: true,
        })
      );
    }

    if (sub === 'status') {
      const cfg = auditSuggestions.getGuildConfig(interaction.guild.id);
      const resolvedChan = await auditSuggestions.resolveSuggestionChannel(
        interaction.guild,
        interaction.client,
        cfg
      );
      const botMe = interaction.guild.members?.me;
      const hasViewAudit = botMe?.permissions?.has(PermissionFlagsBits.ViewAuditLog);

      const lines = [
        cfg.enabled ? '• **Statut** : 🟢 Actives' : '• **Statut** : 🔴 Desactivees (`/suggestions set`)',
      ];

      if (cfg.channelId) {
        lines.push('• **Salon cible** : Configure (<#' + cfg.channelId + '>)');
        if (!resolvedChan) {
          lines.push('  ⚠️ Salon configure introuvable ou inaccessible en ecriture.');
        }
      } else {
        lines.push(
          '• **Salon cible** : ⚠️ Aucun salon configure (utilise `/suggestions set salon:#salon`)'
        );
      }

      lines.push(`• **Cooldown entre suggestions** : \`${cfg.cooldownSec}s\``);
      lines.push(
        '• **Permission `ViewAuditLog`** : ' +
          (hasViewAudit === true
            ? '🟢 Accordee'
            : hasViewAudit === false
              ? '🔴 Manquante (active "Voir les logs du serveur" sur le role du bot)'
              : 'Inconnue')
      );
      if (cfg.updatedBy) {
        lines.push('• **Derniere modification** : par <@' + cfg.updatedBy + '>');
      }

      return interaction.reply(
        buildNoticePayload({
          type: cfg.enabled ? 'accent' : 'neutral',
          title: '💡 Suggestions proactives — ' + interaction.guild.name,
          description: lines.join('\n'),
          ephemeral: true,
        })
      );
    }
  }

  if (commandName === 'apikey') {
    const sub = interaction.options.getSubcommand();

    if (sub === 'set' || sub === 'test' || sub === 'model') {
      const limit = apiKeyRateLimit.acquire(user.id);
      if (!limit.ok) {
        return interaction.reply(
          buildNoticePayload({
            type: 'warning',
            title: '⏳ Un instant...',
            description: limit.message,
            ephemeral: true,
          })
        );
      }

      try {
        if (sub === 'set') {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });

          const provider = interaction.options.getString('fournisseur');
          const apiKey = interaction.options.getString('cle');
          const model = interaction.options.getString('modele');
          const customUrl = interaction.options.getString('url');

          if (String(provider || '').trim().toLowerCase() === 'custom') {
            const dnsCheck = await userKeys.validateCustomUrlDns(customUrl);
            if (!dnsCheck.ok) {
              return await interaction.editReply(
                buildNoticePayload({
                  type: 'error',
                  title: '❌ Erreur de configuration',
                  description: dnsCheck.error,
                  ephemeral: true,
                })
              );
            }
          }

          const res = userKeys.setUserConfig(user.id, {
            provider,
            apiKey,
            model,
            customUrl,
          });

          if (!res.ok) {
            return await interaction.editReply(
              buildNoticePayload({
                type: 'error',
                title: '❌ Erreur de configuration',
                description: res.error,
                ephemeral: true,
              })
            );
          }

          const savedCfg = userKeys.getUserConfig(user.id);
          const verify = await llm.verifyAndResolveModel(savedCfg, {
            allowAutoPick: !model,
          });

          if (verify.ok) {
            if (verify.autoSelected) {
              userKeys.updateUserModel(user.id, verify.model);
            }
            return await interaction.editReply(
              buildNoticePayload({
                type: 'success',
                title: '🔐 Cle API enregistree et verifiee',
                description:
                  '• **Latence** : `' + verify.elapsedMs + ' ms`\n' +
                  '• **Fournisseur** : ' + res.summary.label + '\n' +
                  '• **Modele** : `' + verify.model + '`' +
                  (verify.autoSelected
                    ? ' *(ajuste automatiquement, `' + verify.previousModel + '` indisponible)*'
                    : '') +
                  '\n• **Cle** : `' + res.summary.maskedKey + '`',
                footer: 'Si l API devient indisponible, CIVIS bascule automatiquement sur l IA locale gratuite.',
                ephemeral: true,
              })
            );
          }

          return await interaction.editReply(
            buildVerifyFailurePayload(
              '⚠️ Cle enregistree, mais test echoue',
              'Cle API enregistree et chiffree (`' +
                res.summary.maskedKey +
                '`), mais le test de connexion a echoue (bascule sur IA locale en attendant) :',
              res.summary,
              verify
            )
          );
        }

        if (sub === 'test') {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });

          const cfg = userKeys.getUserConfig(user.id);
          if (!cfg) {
            if (userKeys.getUserStatus(user.id)) {
              return await interaction.editReply(
                buildNoticePayload({
                  type: 'error',
                  title: '🔑 Cle API illisible',
                  description:
                    'Impossible de dechiffrer ta cle API enregistree : cle API incorrecte, merci de reconfigurer la cle API avec `/apikey set`.',
                  ephemeral: true,
                })
              );
            }
            return await interaction.editReply(
              buildNoticePayload({
                type: 'info',
                title: '🤖 IA locale gratuite active',
                description: 'Aucune cle API configuree : tu utilises l IA locale gratuite.',
                ephemeral: true,
              })
            );
          }

          const verify = await llm.verifyAndResolveModel(cfg, { allowAutoPick: true });
          if (verify.ok) {
            if (verify.autoSelected) {
              userKeys.updateUserModel(user.id, verify.model);
              return await interaction.editReply(
                buildNoticePayload({
                  type: 'success',
                  title: '🔧 Connexion reparee et verifiee',
                  description:
                    'Le modele precedent `' +
                    verify.previousModel +
                    '` a renvoye 404 ; bascule automatique effectuee.\n\n' +
                    '• **Latence** : `' + verify.elapsedMs + ' ms`\n' +
                    '• **Fournisseur** : ' + cfg.label + '\n' +
                    '• **Nouveau modele** : `' + verify.model + '`\n' +
                    '• **Cle** : `' + cfg.maskedKey + '`',
                  ephemeral: true,
                })
              );
            }

            return await interaction.editReply(
              buildNoticePayload({
                type: 'success',
                title: '✅ Connexion API valide',
                description:
                  '• **Latence** : `' + verify.elapsedMs + ' ms`\n' +
                  '• **Fournisseur** : ' + cfg.label + '\n' +
                  '• **Modele** : `' + verify.model + '`\n' +
                  '• **Cle** : `' + cfg.maskedKey + '`',
                ephemeral: true,
              })
            );
          }

          return await interaction.editReply(
            buildVerifyFailurePayload('❌ Test de connexion API echoue', 'Test de connexion API echoue :', cfg, verify)
          );
        }

        if (sub === 'model') {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });

          const newModel = interaction.options.getString('modele');
          const upd = userKeys.updateUserModel(user.id, newModel);
          if (!upd.ok) {
            return await interaction.editReply(
              buildNoticePayload({
                type: 'error',
                title: '❌ Erreur',
                description: upd.error,
                ephemeral: true,
              })
            );
          }

          const cfg = userKeys.getUserConfig(user.id);
          const verify = await llm.verifyAndResolveModel(cfg, { allowAutoPick: false });
          if (verify.ok) {
            return await interaction.editReply(
              buildNoticePayload({
                type: 'success',
                title: '🤖 Modele mis a jour et verifie',
                description:
                  '• **Latence** : `' + verify.elapsedMs + ' ms`\n' +
                  '• **Fournisseur** : ' + upd.summary.label + '\n' +
                  '• **Modele** : `' + verify.model + '`',
                ephemeral: true,
              })
            );
          }

          return await interaction.editReply(
            buildVerifyFailurePayload(
              '⚠️ Modele enregistre, mais test echoue',
              'Modele enregistre, mais le test avec ce modele a echoue :',
              upd.summary,
              verify
            )
          );
        }
      } finally {
        apiKeyRateLimit.release(user.id);
      }
    }

    if (sub === 'status') {
      const status = userKeys.getUserStatus(user.id);
      if (!status) {
        return interaction.reply(
          buildNoticePayload({
            type: 'info',
            title: '🤖 Configuration IA actuelle',
            description:
              '• **Mode** : IA locale gratuite (`gemma3:1B` chat / `qwen2.5:3B` agent)\n> Utilise `/apikey set` pour brancher une cle API personnelle.',
            ephemeral: true,
          })
        );
      }

      return interaction.reply(
        buildNoticePayload({
          type: 'success',
          title: '🔐 API personnelle active',
          description:
            '• **Fournisseur** : ' + status.label + '\n' +
            '• **Modele** : `' + status.model + '`\n' +
            '• **URL** : `' + status.baseUrl + '`\n' +
            '• **Cle** : `' + status.maskedKey + '`',
          ephemeral: true,
        })
      );
    }

    if (sub === 'clear') {
      const removed = userKeys.clearUserConfig(user.id);
      return interaction.reply(
        buildNoticePayload({
          type: removed ? 'neutral' : 'info',
          title: removed ? '🗑️ Cle API supprimee' : '🤖 IA locale gratuite',
          description: removed
            ? 'Ta cle API personnelle a ete supprimee. Retour sur l IA locale gratuite.'
            : 'Aucune cle API configuree : tu utilises deja l IA locale gratuite.',
          ephemeral: true,
        })
      );
    }
  }

  if (commandName === 'plan') {
    if (!interaction.guild) {
      return interaction.reply(
        buildNoticePayload({
          type: 'error',
          title: '❌ Action impossible',
          description: 'Cette commande doit etre utilisee dans un serveur Discord.',
          ephemeral: true,
        })
      );
    }

    const limit = rateLimit.acquire(user.id);
    if (!limit.ok) {
      return interaction.reply(
        buildNoticePayload({
          type: 'warning',
          title: '⏳ Un instant...',
          description: limit.message,
          ephemeral: true,
        })
      );
    }

    const demande = interaction.options.getString('demande');
    await interaction.deferReply();

    try {
      const planRes = await planner.buildValidatedPlan({
        userText: demande,
        guild: interaction.guild,
        member,
        authorId: user.id,
        channelId: channel.id,
      });

      if (!planRes.ok) {
        if (planRes.protectedChannel || planRes.securityAlert) {
          await actionLogs.logSecurityAlert({
            guild: interaction.guild,
            client: interaction.client,
            actorId: user.id,
            channelId: channel.id,
            title: '🛡️ Tentative sur salon protege bloquee (/plan)',
            reason: planRes.error,
          });
        }
        await interaction.editReply(
          buildNoticePayload({
            type: 'warning',
            title: '⚠️ Planification impossible',
            description: planRes.error,
            notice: buildFallbackNotice(planRes.stats).trim() || null,
          })
        );
        return;
      }

      if (planRes.security?.antiNukeBlocked) {
        antiNuke.triggerLockout(interaction.guild.id, user.id, planRes.security.antiNukeReason);
        await actionLogs.logSecurityAlert({
          guild: interaction.guild,
          client: interaction.client,
          actorId: user.id,
          channelId: channel.id,
          title: '🚨 Anti-Nuke : /plan bloque en pre-validation',
          reason: planRes.security.antiNukeReason,
          details: `Plan "${planRes.plan.summary}" (${planRes.plan.steps.length} etape(s)) — approbation proprietaire requise.`,
          lockedMinutes: 10,
        });
      }

      memory.addActionMessage(channel.id, user.id, {
        role: 'user',
        content: `[plan] ${demande}`,
        authorName: member?.displayName || user.username,
      });
      if (planRes.plan?.summary) {
        memory.addActionMessage(channel.id, user.id, {
          role: 'assistant',
          content: `[plan] ${planRes.plan.summary}`,
        });
      }

      await plans.createPlanRequest({
        interaction,
        channel,
        guild: interaction.guild,
        requester: user,
        plan: planRes.plan,
        security: planRes.security,
        userText: demande,
        stats: planRes.stats,
        isDebug: debug.isEnabled(channel.id),
      });
    } catch (err) {
      console.error('[plan] Erreur :', err);
      await interaction.editReply(
        buildNoticePayload({
          type: 'error',
          title: '❌ Erreur de planification',
          description: sanitizePublicError(
            err,
            'Une erreur interne est survenue lors de la planification.'
          ),
        })
      );
    } finally {
      rateLimit.release(user.id);
    }
    return;
  }

  if (commandName === 'ask' || commandName === 'agent') {
    if (!interaction.guild) {
      return interaction.reply(
        buildNoticePayload({
          type: 'error',
          title: '❌ Action impossible',
          description: 'Cette commande doit etre utilisee dans un serveur Discord.',
          ephemeral: true,
        })
      );
    }

    const limit = rateLimit.acquire(user.id);
    if (!limit.ok) {
      return interaction.reply(
        buildNoticePayload({
          type: 'warning',
          title: '⏳ Un instant...',
          description: limit.message,
          ephemeral: true,
        })
      );
    }

    const isAgent = commandName === 'agent';
    const question = isAgent
      ? interaction.options.getString('demande')
      : interaction.options.getString('question');
    await interaction.deferReply();

    try {
      const result = await brain.processMessage({
        userText: question,
        channelId: channel.id,
        authorName: member?.displayName || user.username,
        authorId: user.id,
        guild: interaction.guild,
        member,
        client: interaction.client,
        mode: isAgent ? 'agent' : 'chat',
      });

      if (result.needsApproval) {
        await approvals.createApprovalRequest({
          interaction,
          channel,
          guild: interaction.guild,
          requester: user,
          approval: result.approval,
          stats: result.stats,
          isDebug: debug.isEnabled(channel.id),
        });
        return;
      }

      await interaction.editReply(
        buildChatReplyPayload({
          content: result.content,
          usedTool: result.usedTool,
          toolArgs: result.toolArgs,
          stats: result.stats,
          question,
          isDebug: debug.isEnabled(channel.id),
          mode: isAgent ? 'agent' : 'chat',
          actionOk: result.actionOk !== false,
        })
      );

      if (isAgent && result.usedTool) {
        if (
          result.actionOk === false &&
          String(result.actionError || result.content || '').includes('🛡️')
        ) {
          await actionLogs.logSecurityAlert({
            guild: interaction.guild,
            client: interaction.client,
            actorId: user.id,
            channelId: channel.id,
            title: '🛡️ Tentative sur salon protege bloquee (/agent)',
            reason: result.actionError || result.content,
            details: `Outil : ${result.usedTool}`,
          });
        } else if (result.actionOk !== false) {
          const burst = antiNuke.recordBurstActivity(interaction.guild, member, {
            toolName: result.usedTool,
          });
          if (burst.blocked) {
            await actionLogs.logSecurityAlert({
              guild: interaction.guild,
              client: interaction.client,
              actorId: user.id,
              channelId: channel.id,
              title: '🚨 Anti-Rafale declenche (/agent)',
              reason: burst.reason,
              details: `Dernier outil : ${result.usedTool}`,
              lockedMinutes: 10,
            });
          }
        }

        await actionLogs.logAction({
          guild: interaction.guild,
          client: interaction.client,
          trigger: 'direct',
          ok: result.actionOk !== false,
          toolName: result.usedTool,
          args: result.toolArgs,
          result: result.actionResult ?? result.content,
          error: result.actionError || null,
          requesterId: user.id,
          executorId: user.id,
          channelId: channel.id,
          userText: question,
          stats: result.stats,
        });
      }
    } catch (err) {
      console.error('[ask] Erreur :', err);
      await interaction.editReply(
        buildNoticePayload({
          type: 'error',
          title: '❌ Erreur',
          description: sanitizePublicError(err),
        })
      );
    } finally {
      rateLimit.release(user.id);
    }
  }
}

module.exports = { registerCommands, handleInteraction, exportRateLimit, apiKeyRateLimit };
