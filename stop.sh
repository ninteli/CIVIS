#!/bin/bash

echo "=== Arret de CIVIS ==="

# Arret du bot Discord (processus node)
echo "Arret du bot Discord..."
pkill -f "node index.js" 2>/dev/null && echo "  -> Bot arrete" || echo "  -> Aucun bot en cours"

# Arret du serveur LLM
echo "Arret du serveur LLM..."
pkill -f "llama-server" 2>/dev/null && echo "  -> Serveur LLM arrete" || echo "  -> Aucun serveur LLM en cours"

echo "=== Termine ==="
