# Politique de sécurité

## Signaler une vulnérabilité

Si vous découvrez une faille de sécurité dans **CIVIS**, merci de **ne pas ouvrir d'issue publique** afin de protéger les serveurs utilisant le bot.

Utilisez de préférence la fonctionnalité **Private vulnerability reporting** de GitHub ([Report a vulnerability](https://github.com/ninteli/CIVIS/security/advisories/new)) ou contactez le mainteneur directement via GitHub.

Merci d'inclure :
- Une description claire du problème et de son impact potentiel
- Les étapes de reproduction (ou un test minimal)
- La version ou le commit concerné

## Modèle de sécurité de CIVIS

- **Chiffrement au repos** : les clés API personnelles (`/apikey`) et les URLs de webhooks (`/logs`) sont chiffrées en **AES-256-GCM** avec une clé maître stockée hors du dossier `data/` (`KEY_ENCRYPTION_SECRET`, `CIVIS_MASTER_KEY_FILE` ou `~/.config/civis/master.key`).
- **Protection anti-SSRF** : les URLs personnalisées (fournisseurs IA compatibles OpenAI et webhooks Discord) sont validées (HTTPS obligatoire, blocage des adresses privées/loopback et vérification DNS).
- **Contrôle des permissions Discord** : vérification systématique des permissions et de la hiérarchie des rôles du bot et du demandeur, avec délégation publique par boutons et confirmation obligatoire pour les suppressions.
