#!/bin/bash

# ==========================================
# Script de demarrage de CIVIS
# ==========================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODELS_DIR="${MODELS_DIR:-$HOME/models}"
LLAMA_SERVER="${LLAMA_SERVER:-$HOME/llama.cpp/build/bin/llama-server}"
LLM_HOST="${LLM_HOST:-127.0.0.1}"
LLM_PORT="${LLM_PORT:-8080}"
MODELS_MAX="${MODELS_MAX:-1}"

echo "=== Demarrage de CIVIS ==="
echo ""

# 1. Verification des modeles locaux et presets
AGENT_MODEL_PATH="$MODELS_DIR/qwen2.5-3b-instruct-q4_k_m.gguf"
if [ ! -f "$AGENT_MODEL_PATH" ]; then
    echo "ERREUR : modele agent introuvable a $AGENT_MODEL_PATH"
    echo "Telecharge-le avec :"
    echo "  mkdir -p \"$MODELS_DIR\" && cd \"$MODELS_DIR\""
    echo "  curl -L -o qwen2.5-3b-instruct-q4_k_m.gguf https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf"
    exit 1
fi

CHAT_MODEL_PATH="$MODELS_DIR/gemma-3-1b-it-q4_k_m.gguf"
if [ ! -f "$CHAT_MODEL_PATH" ]; then
    echo "ERREUR : modele conversationnel introuvable a $CHAT_MODEL_PATH"
    echo "Telecharge-le avec :"
    echo "  mkdir -p \"$MODELS_DIR\" && cd \"$MODELS_DIR\""
    echo "  curl -L -o gemma-3-1b-it-q4_k_m.gguf https://huggingface.co/bartowski/google_gemma-3-1b-it-GGUF/resolve/main/google_gemma-3-1b-it-Q4_K_M.gguf"
    exit 1
fi

PRESET_PATH="$SCRIPT_DIR/models-preset.ini"
PRESET_EXAMPLE="$SCRIPT_DIR/models-preset.ini.example"
if [ ! -f "$PRESET_PATH" ]; then
    if [ ! -f "$PRESET_EXAMPLE" ]; then
        echo "ERREUR : models-preset.ini et models-preset.ini.example introuvables dans $SCRIPT_DIR"
        exit 1
    fi
    echo "Creation de models-preset.ini depuis models-preset.ini.example (MODELS_DIR=$MODELS_DIR)..."
    node -e '
    const fs = require("node:fs");
    const tpl = fs.readFileSync(process.argv[1], "utf8");
    fs.writeFileSync(process.argv[2], tpl.split("__MODELS_DIR__").join(process.argv[3]), "utf8");
    ' "$PRESET_EXAMPLE" "$PRESET_PATH" "$MODELS_DIR"
fi

# 2. Verification du serveur llama-server
if [ ! -f "$LLAMA_SERVER" ]; then
    echo "ERREUR : llama-server introuvable a $LLAMA_SERVER"
    echo "Definis LLAMA_SERVER=/chemin/vers/llama-server ou compile llama.cpp."
    exit 1
fi

# 3. Verification du .env et cle API locale
if [ ! -f "$SCRIPT_DIR/.env" ]; then
    echo "ERREUR : .env introuvable dans $SCRIPT_DIR"
    echo "Copie .env.example vers .env et renseigne DISCORD_TOKEN."
    exit 1
fi

if [ -z "${LLM_API_KEY:-}" ]; then
    LLM_API_KEY="$(node -e '
    const fs = require("node:fs");
    const dotenv = require("dotenv");
    const parsed = dotenv.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (parsed.LLM_API_KEY) process.stdout.write(parsed.LLM_API_KEY.trim());
    ' "$SCRIPT_DIR/.env")"
fi
if [ -z "${LLM_API_KEY:-}" ]; then
    LLM_API_KEY="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"
fi
export LLM_API_KEY

# 4. Lancement du routeur llama-server (Gemma 3 1B + Qwen 2.5 3B)
echo "[1/2] Lancement du routeur LLM (gemma3:1B + qwen2.5:3B, models-max=$MODELS_MAX)..."
if curl -s --max-time 2 -H "Authorization: Bearer $LLM_API_KEY" "http://$LLM_HOST:$LLM_PORT/props" 2>/dev/null | grep -q '"role":"router"'; then
    echo "  -> Routeur deja en cours d execution, on skip"
else
    if curl -s --max-time 2 "http://$LLM_HOST:$LLM_PORT/v1/models" > /dev/null 2>&1; then
        echo "  -> Ancien serveur LLM non-routeur detecte, arret..."
        if [ -f "$SCRIPT_DIR/.llama-server.pid" ]; then
            OLD_LLAMA_PID="$(cat "$SCRIPT_DIR/.llama-server.pid" 2>/dev/null || true)"
            if [ -n "$OLD_LLAMA_PID" ] && kill -0 "$OLD_LLAMA_PID" 2>/dev/null; then
                kill "$OLD_LLAMA_PID" 2>/dev/null || true
            fi
            rm -f "$SCRIPT_DIR/.llama-server.pid"
        else
            pkill -f "llama-server.*--models-preset" 2>/dev/null || true
        fi
        sleep 1
    fi

    nohup "$LLAMA_SERVER" \
        --models-preset "$PRESET_PATH" \
        --models-max "$MODELS_MAX" \
        --port "$LLM_PORT" \
        --host "$LLM_HOST" \
        --api-key "$LLM_API_KEY" \
        > "$SCRIPT_DIR/llama-server.log" 2>&1 &
    LLAMA_PID=$!
    echo "$LLAMA_PID" > "$SCRIPT_DIR/.llama-server.pid"
    chmod 600 "$SCRIPT_DIR/.llama-server.pid" 2>/dev/null || true
    echo "  -> Lance en arriere-plan (PID $LLAMA_PID, log: $SCRIPT_DIR/llama-server.log)"

    echo "  -> Attente du demarrage (max 60s)..."
    for i in {1..60}; do
        if curl -s --max-time 1 -H "Authorization: Bearer $LLM_API_KEY" "http://$LLM_HOST:$LLM_PORT/v1/models" > /dev/null 2>&1; then
            echo "  -> Serveur LLM pret !"
            break
        fi
        sleep 1
    done
fi

# 5. Lancement du bot Discord
echo "[2/2] Lancement du bot Discord..."
cd "$SCRIPT_DIR"
echo ""
echo "=== Bot en cours d execution (Ctrl+C pour arreter) ==="
echo ""
node index.js &
BOT_PID=$!
echo "$BOT_PID" > "$SCRIPT_DIR/.civis-bot.pid"
chmod 600 "$SCRIPT_DIR/.civis-bot.pid" 2>/dev/null || true
trap 'rm -f "$SCRIPT_DIR/.civis-bot.pid"; kill "$BOT_PID" 2>/dev/null || true' INT TERM
wait "$BOT_PID"
EXIT_CODE=$?
rm -f "$SCRIPT_DIR/.civis-bot.pid"
exit "$EXIT_CODE"
