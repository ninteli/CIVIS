# Politique de sécurité

## Signaler une vulnérabilité

Si vous découvrez une faille de sécurité dans **CIVIS**, merci de **ne pas ouvrir d'issue publique** afin de protéger les serveurs utilisant le bot.

Utilisez de préférence la fonctionnalité **Private vulnerability reporting** de GitHub ([Report a vulnerability](https://github.com/ninteli/CIVIS/security/advisories/new)) ou contactez le mainteneur directement via GitHub.

Merci d'inclure :
- Une description claire du problème et de son impact potentiel
- Les étapes de reproduction (ou un test minimal)
- La version ou le commit concerné

## Modèle de sécurité de CIVIS

- **Chiffrement au repos** : les clés API personnelles (`/apikey`) et les URLs de webhooks (`/logs`) sont chiffrées en **AES-256-GCM lié par AAD** (*Associated Authenticated Data*) avec une clé maître stockée hors du dossier `data/` (`KEY_ENCRYPTION_SECRET`, `CIVIS_MASTER_KEY_FILE` ou `~/.config/civis/master.key`).
- **Protection anti-SSRF étendue** : les URLs personnalisées (fournisseurs IA compatibles OpenAI et webhooks Discord) sont validées (HTTPS obligatoire, `BlockList` IPv4/IPv6 privés et spéciaux, DNS pinning, blocage des redirections HTTP et limite de taille des réponses).
- **Protection Anti-Nuke & récupération** : protection des salons vitaux (règles, mises à jour, marqueurs de topic), détection anti-raid et anti-rafale pour les non-propriétaires avec verrouillage temporaire et alerte `#logs`, bouton d'arrêt d'urgence et retour en arrière (*rollback* 300 s).
- **Authentification locale `llama-server`** : protection du serveur LLM local via `LLM_API_KEY` (`Authorization: Bearer`) générée automatiquement au démarrage, et arrêt ciblé via fichiers PID.
- **Contrôle des permissions Discord** : vérification systématique des permissions et de la hiérarchie des rôles du bot et du demandeur, avec délégation publique par boutons et confirmation obligatoire pour les suppressions.
