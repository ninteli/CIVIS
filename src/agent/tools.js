const searchAppDirectoryTool = {
  name: 'search_app_directory',
  description:
    'Recherche des bots ou applications Discord dans l App Directory officiel de Discord par mot-cle ou categorie.',
  parameters: {
    query:
      'Mot-cle de recherche (nom du bot, fonctionnalite ou besoin, ex: musique, moderation, tickets, welcome, quiz)',
    category:
      'Categorie optionnelle : jeux, divertissements, moderation, social, services (optionnel)',
    limit: 'Nombre maximum de resultats a afficher (1 a 10, defaut: 5, optionnel)',
  },
  requiredPermission: null,
};

// Outils de LECTURE (pour /ask et @mention /chat)
const readTools = [
  {
    name: 'list_channels',
    description: 'Liste tous les salons du serveur avec leurs noms, types et categories.',
    parameters: {},
    requiredPermission: null,
  },
  {
    name: 'list_roles',
    description: 'Liste tous les roles du serveur avec leurs noms et couleurs.',
    parameters: {},
    requiredPermission: null,
  },
  searchAppDirectoryTool,
];

// Outils d'ACTION (pour /agent)
const actionTools = [
  {
    name: 'create_channel',
    description: 'Cree un SALON (texte, forum, annonce, voix ou conference) dans le serveur. NE PAS utiliser pour les roles.',
    parameters: {
      name: 'Nom du SALON (sans #). Ex: general, annonces, entraide, Salon Vocal',
      type: 'text (texte), forum, announcement (annonce), voice (voix) ou stage (conference) (defaut: text)',
      slowmode: 'Cooldown en secondes entre chaque message/post (0 = desactive, max 21600)',
      spoiler: 'true pour activer l option salon de spoiler (texte, annonce, forum), sinon false',
      nsfw: 'true si contenu sensible (limite d age), sinon false',
      category: 'Nom de la categorie parente (optionnel)',
      category_hint: 'important / discussion / autre',
      topic: 'Description/sujet du salon texte, annonce ou forum (optionnel)',
    },
    requiredPermission: 'ManageChannels',
  },
  {
    name: 'create_role',
    description: 'Cree un ROLE dans le serveur (badge attribue aux membres, ex: Moderateur, VIP, Membre). Un role n est PAS un salon de discussion.',
    parameters: {
      name: 'Nom du ROLE (ex: Moderateur, VIP, Membre)',
      color: 'Couleur en hexadecimal (ex: #FF0000) ou nom (red, blue, green). Optionnel.',
      hoist: 'true pour afficher separement dans la liste des membres',
      mentionable: 'true pour que le role soit mentionnable',
    },
    requiredPermission: 'ManageRoles',
  },
  {
    name: 'modify_channel',
    description: 'Modifie un salon existant : nom, type (text/announcement), categorie, cooldown/slowmode, salon de spoiler, NSFW ou topic.',
    parameters: {
      channel: 'Nom du salon a modifier (sans #)',
      new_name: 'Nouveau nom (optionnel)',
      type: 'Nouveau type : text ou announcement uniquement (optionnel)',
      slowmode: 'Nouveau cooldown en secondes (0 = desactive, optionnel)',
      spoiler: 'Activer/desactiver l option salon de spoiler (true/false, optionnel)',
      nsfw: 'Nouveau statut NSFW (true/false, optionnel)',
      topic: 'Nouveau topic/description (optionnel)',
      category: 'Nom de la categorie ou deplacer le salon (optionnel)',
    },
    requiredPermission: 'ManageChannels',
  },
  {
    name: 'modify_role_display',
    description: 'Modifie l apparence d un role : nom, couleur, hoist, mentionable. Ne touche PAS aux permissions.',
    parameters: {
      role: 'Nom du role a modifier',
      new_name: 'Nouveau nom (optionnel)',
      color: 'Nouvelle couleur hex (ex: #00FF00) (optionnel)',
      hoist: 'Nouveau hoist (true/false, optionnel)',
      mentionable: 'Nouveau mentionable (true/false, optionnel)',
    },
    requiredPermission: 'ManageRoles',
  },
  {
    name: 'modify_role_perm',
    description: 'Modifie les PERMISSIONS d un role. Action sensible, a utiliser avec precaution.',
    parameters: {
      role: 'Nom du role a modifier',
      add: 'Liste de permissions a ajouter (ex: ["ManageMessages", "KickMembers"])',
      remove: 'Liste de permissions a retirer (ex: ["Administrator"])',
    },
    requiredPermission: 'ManageRoles',
  },
  {
    name: 'delete_channel',
    description: 'Supprime un SALON existant (texte, forum, annonce, voix ou conference). Demande toujours une confirmation avant suppression.',
    parameters: {
      channel: 'Nom du salon a supprimer (sans #). Ex: general, annonces',
    },
    requiredPermission: 'ManageChannels',
  },
  {
    name: 'delete_role',
    description: 'Supprime un ROLE existant du serveur. Demande toujours une confirmation avant suppression.',
    parameters: {
      role: 'Nom du role a supprimer. Ex: VIP, Testeur',
    },
    requiredPermission: 'ManageRoles',
  },
  {
    name: 'archive_channel',
    description: 'Archive un SALON existant (texte, forum, annonce, voix ou conference) : le deplace dans la categorie "archivée" et le masque pour tout le monde.',
    parameters: {
      channel: 'Nom du salon a archiver (sans #). Ex: general, annonces',
    },
    requiredPermission: 'ManageChannels',
  },
  {
    name: 'archive_role',
    description: 'Archive (met en quarantaine) un ROLE existant : le renomme "[Archivé] <nom>", retire ses permissions et desactive hoist et mentionable.',
    parameters: {
      role: 'Nom du role a archiver. Ex: VIP, Testeur',
    },
    requiredPermission: 'ManageRoles',
  },
  {
    name: 'create_category',
    description: 'Cree une CATEGORIE pour organiser les salons (ex: Important, Communaute, Staff, Vocal).',
    parameters: {
      name: 'Nom de la categorie (ex: Important, Staff, Vocal)',
    },
    requiredPermission: 'ManageChannels',
  },
  {
    name: 'set_channel_permissions',
    description: 'Definit les permissions d une CATEGORIE (appliquees a toute la categorie et ses salons) ou d un SALON specifique pour un role ou @everyone. Pour modifier toute une categorie, cible la CATEGORIE directement avec target_type:"category".',
    parameters: {
      channel: 'Nom de la categorie ou du salon (sans #). Ex: Staff, Important, annonces',
      target_type: '"category" pour une categorie entiere, "channel" pour un salon precis (optionnel)',
      role: 'Nom du role ou @everyone. Ex: @everyone, Moderateur, VIP',
      allow: 'Permissions a autoriser (ex: ["ViewChannel", "SendMessages", "Connect"])',
      deny: 'Permissions a refuser (ex: ["SendMessages", "ViewChannel"])',
      reset: 'Permissions a reinitialiser (optionnel)',
      sync_children: 'true (defaut) pour synchroniser les salons de la categorie, false pour la categorie seule (optionnel)',
    },
    requiredPermission: 'ManageChannels',
    requiredPermissions: ['ManageChannels', 'ManageRoles'],
  },
  searchAppDirectoryTool,
];

const allTools = [
  ...readTools,
  ...actionTools.filter((t) => !readTools.some((r) => r.name === t.name)),
];

function getToolsPrompt(toolList) {
  return toolList.map((t) => {
    const params = Object.keys(t.parameters).length
      ? Object.entries(t.parameters).map(([k, v]) => k + ' (' + v + ')').join('; ')
      : 'aucun parametre';
    return '- ' + t.name + ' : ' + t.description + '\n  Parametres : ' + params;
  }).join('\n\n');
}

function getTool(name) {
  return allTools.find((t) => t.name === name);
}

module.exports = { readTools, actionTools, allTools, getToolsPrompt, getTool };
