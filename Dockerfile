# Menggunakan versi Node.js LTS yang ringan (Slim)
FROM node:18-slim

# 1. Update dan Install Library Sistem yang dibutuhkan Chromium/Puppeteer
# Termasuk libglib-2.0-0 yang menyebabkan error Anda
RUN apt-get update \
    && apt-get install -y wget gnupg \
    && apt-get install -y \
        ca-certificates \
        fonts-liberation \
        libappindicator1 \
        libasound2 \
        libatk-bridge2.0-0 \
        libatk1.0-0 \
        libc6 \
        libcairo2 \
        libcups2 \
        libdbus-1-3 \
        libexpat1 \
        libfontconfig1 \
        libgbm1 \
        libgcc1 \
        libglib2.0-0 \
        libgtk-3-0 \
        libnspr4 \
        libnss3 \
        libpango-1.0-0 \
        libpangocairo-1.0-0 \
        libstdc++6 \
        libx11-6 \
        libx11-xcb1 \
        libxcb1 \
        libxcomposite1 \
        libxcursor1 \
        libxdamage1 \
        libxext6 \
        libxfixes3 \
        libxi6 \
        libxrandr2 \
        libxrender1 \
        libxss1 \
        libxtst6 \
        lsb-release \
        xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# 2. Set working directory
WORKDIR /app

# 3. Copy package files
COPY package*.json ./

# 4. Install dependencies npm
RUN npm install

# 5. Copy sisa kode project
COPY . .

# 6. Menjalankan aplikasi
CMD ["node", "server.js"]
