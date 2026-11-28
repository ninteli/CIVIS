#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

stop_by_pidfile() {
    local pidfile="$1"
    local expected="$2"
    local label="$3"
    local fallback_pattern="$4"

    if [ -f "$pidfile" ]; then
        local pid
        pid="$(cat "$pidfile" 2>/dev/null || true)"
        rm -f "$pidfile"
        if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
            local cmd
            cmd="$(ps -p "$pid" -o args= 2>/dev/null || true)"
            if [[ "$cmd" == *"$expected"* ]]; then
                kill "$pid" 2>/dev/null && echo "  -> $label arrete (PID $pid)" && return 0
            fi
        fi
    fi

    if [ -n "$fallback_pattern" ] && pkill -f "$fallback_pattern" 2>/dev/null; then
        echo "  -> $label arrete"
    else
        echo "  -> Aucun $label en cours"
    fi
}

echo "=== Arret de CIVIS ==="

# Arret du bot Discord (processus node)
echo "Arret du bot Discord..."
stop_by_pidfile "$SCRIPT_DIR/.civis-bot.pid" "index.js" "Bot" ""

# Arret du serveur LLM
echo "Arret du serveur LLM..."
stop_by_pidfile "$SCRIPT_DIR/.llama-server.pid" "llama-server" "Serveur LLM" "$SCRIPT_DIR/models-preset.ini"

echo "=== Termine ==="
