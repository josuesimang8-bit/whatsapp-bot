#!/bin/bash
# ============================================
# WhatsApp Bot - Setup Automático Oracle Cloud
# ============================================
# Corre este script UMA VEZ no servidor Ubuntu
# Uso: bash setup-server.sh
# ============================================

set -e

echo "============================================"
echo "  WhatsApp Bot - Instalação Automática"
echo "============================================"
echo ""

# 1. Atualizar sistema
echo "[1/6] Atualizando sistema..."
sudo apt update -y && sudo apt upgrade -y

# 2. Instalar Node.js 20.x
echo "[2/6] Instalando Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

echo "Node.js versão: $(node -v)"
echo "NPM versão: $(npm -v)"

# 3. Instalar Chromium e dependências
echo "[3/6] Instalando Chromium e dependências..."
sudo apt install -y chromium-browser || sudo apt install -y chromium
sudo apt install -y \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libxshmfence1 \
    xdg-utils \
    wget

# 4. Instalar PM2
echo "[4/6] Instalando PM2 (gerenciador de processos)..."
sudo npm install -g pm2

# 5. Instalar dependências do projeto
echo "[5/6] Instalando dependências do bot..."
cd ~/whatsapp-bot
npm install

# 6. Criar diretórios necessários
echo "[6/6] Criando diretórios..."
mkdir -p uploads
mkdir -p public

# Configurar PM2 para iniciar com o sistema
pm2 startup systemd -u $USER --hp $HOME 2>/dev/null || true

echo ""
echo "============================================"
echo "  ✅ INSTALAÇÃO COMPLETA!"
echo "============================================"
echo ""
echo "  Para iniciar o bot:"
echo "    cd ~/whatsapp-bot"
echo "    pm2 start index.js --name whatsapp-bot"
echo ""
echo "  Para ver os logs:"
echo "    pm2 logs whatsapp-bot"
echo ""
echo "  Para ver o QR code:"
echo "    pm2 logs whatsapp-bot"
echo "    (escaneia o QR com teu WhatsApp)"
echo ""
echo "  Para parar o bot:"
echo "    pm2 stop whatsapp-bot"
echo ""
echo "  Para reiniciar:"
echo "    pm2 restart whatsapp-bot"
echo ""
echo "  Dashboard: http://SEU_IP:3000"
echo "============================================"
