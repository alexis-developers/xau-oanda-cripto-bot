#!/bin/bash
# ============================================================
# Setup do Servidor 2 — XAU OANDA Bot
# Ubuntu 20.04+ / Debian 11+
# Executar como root: bash vps-setup.sh
# ============================================================

set -e

REPO_URL="SEU_REPOSITORIO_GITHUB"   # ex: https://github.com/usuario/xau-oanda-bot.git
APP_DIR="/root/xau-oanda-bot"
DOMAIN="alexisprofit-bot.desenvolvimentodesites.dev.br"

echo "=== [1/6] Node.js 20 LTS ==="
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
node -v && npm -v

echo "=== [2/6] PM2 ==="
npm install -g pm2

echo "=== [3/6] Cloudflared ==="
wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
dpkg -i cloudflared-linux-amd64.deb
rm cloudflared-linux-amd64.deb
cloudflared --version

echo "=== [4/6] Clonar repositório ==="
if [ -d "$APP_DIR" ]; then
  echo "Diretório já existe, fazendo git pull..."
  cd "$APP_DIR" && git pull
else
  git clone "$REPO_URL" "$APP_DIR"
  cd "$APP_DIR"
fi

echo "=== [5/6] Instalar dependências ==="
cd "$APP_DIR"
npm install --production

echo "=== [6/6] Criar pasta de logs ==="
mkdir -p logs

echo ""
echo "============================================================"
echo "  Setup concluído!"
echo ""
echo "  PRÓXIMOS PASSOS:"
echo ""
echo "  1. Criar o .env:"
echo "     cp .env.example .env && nano .env"
echo "     (preencher OANDA_TOKEN e OANDA_ACCOUNT_ID)"
echo ""
echo "  2. Configurar Cloudflare Tunnel:"
echo "     cloudflared tunnel login"
echo "     cloudflared tunnel create alexisprofit-bot"
echo "     # Copiar o Tunnel ID e colar em deploy/tunnel-config.yml"
echo "     cp deploy/tunnel-config.yml ~/.cloudflared/config.yml"
echo "     nano ~/.cloudflared/config.yml   # substituir SEU-TUNNEL-ID"
echo "     cloudflared tunnel route dns alexisprofit-bot $DOMAIN"
echo ""
echo "  3. Iniciar com PM2:"
echo "     pm2 start ecosystem.config.cjs"
echo "     pm2 start \"cloudflared tunnel run alexisprofit-bot\" --name tunnel-alexis"
echo "     pm2 save && pm2 startup"
echo ""
echo "  4. Verificar:"
echo "     pm2 status"
echo "     curl https://$DOMAIN/status"
echo "============================================================"
