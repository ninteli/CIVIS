# Contribuer à CIVIS

Merci pour votre intérêt pour **CIVIS** !

## Prérequis

- **Node.js** `>= 20`
- `npm`

## Installation locale

```bash
git clone https://github.com/ninteli/CIVIS.git
cd CIVIS
npm install
cp .env.example .env
```

## Lancer les tests

Avant toute Pull Request, assurez-vous que la suite de tests passe intégralement :

```bash
npm test
```

## Bonnes pratiques

- N'ajoutez jamais de secrets, tokens, fichiers `.env`, `data/` ou `*.log` dans vos commits.
- Ajoutez ou mettez à jour les tests unitaires dans `tests/` pour toute nouvelle fonctionnalité ou correction.
- Respectez le style de code existant (CommonJS, Node.js standard `node:test`).
- Privilégiez des Pull Requests ciblées avec une description claire des changements et des tests effectués.
