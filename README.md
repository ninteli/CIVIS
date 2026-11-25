# CIVIS

[![CI](https://github.com/ninteli/CIVIS/actions/workflows/ci.yml/badge.svg)](https://github.com/ninteli/CIVIS/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/Node.js-%3E%3D20-339933.svg)](https://nodejs.org/)

Bot Discord d'administration de serveur propulsé par **IA locale (`llama.cpp`)** — **Gemma 3 1B** pour la conversation et **Qwen 2.5 3B** pour les actions et plans multi-étapes — avec prise en charge optionnelle de clés API externes par utilisateur (OpenAI, Gemini, Groq, OpenRouter, Mistral ou endpoint HTTPS compatible OpenAI) et interface **Discord Components V2**.

## Fonctionnalités principales

- **Conversation & lecture (`/ask`, `@CIVIS`)** : réponses contextuelles, analyse de la structure du serveur, recherche dans l'App Directory Discord.
- **Agent d'administration (`/agent`)** : création, modification, archivage et suppression de salons, catégories, rôles et permissions avec contrôle strict des droits et de la hiérarchie Discord.
- **Planificateur multi-étapes (`/plan`)** : génération d'un plan complet avec pré-validation serveur, aperçu interactif, modification, validation puis exécution en direct.
- **Validation publique par boutons** : délégation sécurisée lorsqu'un membre n'a pas les permissions requises, et confirmation obligatoire avant toute suppression (avec archivage automatique en cas d'expiration).
- **Suggestions proactives (`/suggestions`)** : analyse des *Audit Logs* Discord pour proposer des suites logiques après une modification du serveur.
- **Journalisation chiffrée (`/logs`)** : envoi des actions dans un salon ou via webhook Discord (URLs chiffrées en AES-256-GCM).
- **Clés API personnelles (`/apikey`)** : chaque utilisateur peut enregistrer sa propre clé API chiffrée en AES-256-GCM avec bascule automatique sur l'IA locale en cas d'erreur.

## Prérequis

- **Node.js** `>= 20.0.0`
- Un bot créé sur le [Discord Developer Portal](https://discord.com/developers/applications) :
  - Activer l'intent privilégié **Message Content Intent** (*Bot → Privileged Gateway Intents*).
  - Inviter le bot avec les scopes `bot` et `applications.commands` et les permissions nécessaires (ex. `Manage Channels`, `Manage Roles`, `View Audit Log`, `Send Messages`, `Embed Links`, `Manage Webhooks`).
- *(Optionnel mais recommandé pour le mode local gratuit)* **`llama.cpp`** compilé (`llama-server`) et les modèles GGUF :
  - `gemma-3-1b-it-q4_k_m.gguf` (~0,8 Go) : conversation
  - `qwen2.5-3b-instruct-q4_k_m.gguf` (~2 Go) : agent / plans

## Installation

```bash
git clone https://github.com/ninteli/CIVIS.git
cd CIVIS
npm install
cp .env.example .env
```

Éditez `.env` et renseignez au minimum `DISCORD_TOKEN` (vous pouvez aussi personnaliser `SYSTEM_PROMPT`, `LLM_URL`, etc.).

### Option A — Avec IA locale (`llama.cpp`)

Téléchargez les deux modèles dans `~/models` (ou définissez `MODELS_DIR`) :

```bash
mkdir -p ~/models && cd ~/models
curl -L -o gemma-3-1b-it-q4_k_m.gguf https://huggingface.co/bartowski/google_gemma-3-1b-it-GGUF/resolve/main/google_gemma-3-1b-it-Q4_K_M.gguf
curl -L -o qwen2.5-3b-instruct-q4_k_m.gguf https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf
```

Puis lancez le routeur LLM et le bot :

```bash
./start.sh
```

`start.sh` génère automatiquement `models-preset.ini` à partir de `models-preset.ini.example` s'il n'existe pas encore.

Pour arrêter :

```bash
./stop.sh
```

### Option B — Sans serveur local (API externe uniquement)

Lancez directement le bot :

```bash
npm start
```

Les utilisateurs pourront configurer leur propre clé via `/apikey set`.

## Structure du projet

```text
CIVIS/
├── .env.example                # Modele de configuration (.env hors Git)
├── .github/workflows/ci.yml    # Integration continue (npm test)
├── config.js                   # Config centrale (prompt systeme, modeles locaux)
├── index.js                    # Point d'entree
├── models-preset.ini.example   # Modele de presets du routeur llama-server
├── start.sh                    # Script de demarrage (llama-server + bot)
├── stop.sh                     # Script d'arret
├── tests/                      # Suite de tests (node --test)
└── src/
    ├── discord/
    │   ├── action-logs.js      # Journal des actions (/logs : salon ou webhook chiffre)
    │   ├── approvals.js        # Demandes de validation publique par boutons
    │   ├── audit-suggestions.js# Suggestions proactives a partir de l'audit log (/suggestions)
    │   ├── client.js           # Client Discord
    │   ├── commands.js         # Slash commands
    │   ├── events.js           # Gestion des messages (mention) et de l'audit log
    │   ├── format.js           # Formatage des reponses
    │   ├── plans.js            # Validation et execution en direct des plans multi-etapes
    │   └── ui-v2.js            # Composants Discord Components V2
    └── agent/
        ├── brain.js            # Orchestration LLM + outils (modes chat / agent)
        ├── channel-types.js    # Types de salons Discord
        ├── colors.js           # Palette et resolution des couleurs de roles
        ├── debug.js            # Toggle mode debug
        ├── llm.js              # Client HTTP (API externe + fallback IA locale)
        ├── master-key.js       # Cle maitre de chiffrement (stockee hors de data/)
        ├── memory.js           # Memoire par salon
        ├── permissions.js      # Controle des permissions et hierarchie Discord
        ├── planner.js          # Planification multi-etapes et pre-validation serveur
        ├── tool-executor.js    # Execution des outils sur Discord
        ├── tools.js            # Definitions des outils pour le LLM
        └── user-keys.js        # Stockage chiffre par utilisateur des cles API
```

## Commandes Discord

- `/ping` : Test basique
- `/ask question:<texte>` : Poser une question (mode conversation + lecture)
- `/agent demande:<texte>` : Action unitaire (créer/modifier/archiver/supprimer salons, catégories ou rôles, gérer les permissions)
- `/plan demande:<texte>` : Configuration multi-étapes du serveur (aperçu, modification, validation puis exécution en direct)
- `/apikey set|model|test|status|clear` : Gérer sa clé API personnelle (réponses éphémères)
- `/logs set|webhook|status|test|off` : Journal des actions de CIVIS dans un salon ou via webhook
- `/suggestions on|off|set|auto|cooldown|status` : Suggestions proactives de plans après modification du serveur
- `/debugmod` : Active/désactive le mode debug
- `@CIVIS <message>` : Conversation par mention (seule la vraie mention `@` déclenche le bot)

## Gestion des modèles locaux

- Par défaut, `--models-max 1` garde un seul modèle en RAM à la fois (~6 Go de RAM). Alterner conversation et action provoque un rechargement de modèle (quelques secondes). Avec plus de RAM, passez `MODELS_MAX=2 ./start.sh` pour supprimer cette latence.

## Sécurité et clé maître de chiffrement

La clé maître qui chiffre `data/user-keys.json` et les webhooks de `data/guild-logs.json` (AES-256-GCM) est stockée **hors du dossier `data/`**, afin qu'une sauvegarde ou fuite de `data/` ne suffise pas à déchiffrer les secrets.

Ordre de résolution :
1. Variable d'environnement `KEY_ENCRYPTION_SECRET` (dérivée par `scrypt`) : recommandé en déploiement serveur / systemd.
2. Fichier pointé par `CIVIS_MASTER_KEY_FILE`.
3. Par défaut : `~/.config/civis/master.key` (dossier `0700`, fichier `0600`, créé automatiquement).

Consultez [SECURITY.md](SECURITY.md) pour signaler une vulnérabilité.

## Tests

```bash
npm test
```

## Contribuer

Les contributions sont les bienvenues ! Consultez [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

Distribué sous licence [MIT](LICENSE) — © 2026 Ninteli pour Furcitivas.
