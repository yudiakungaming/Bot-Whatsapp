const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');

// --- LOGIKA RESET TOTAL ---
const fs = require('fs');
const path = require('path');

// 1. Hapus semua folder sesi lama yang mungkin ada (bersih total)
const rootDir = __dirname;
fs.readdirSync(rootDir).forEach(file => {
    if (file.startsWith('.wwebjs_auth')) {
        const folderPath = path.join(rootDir, file);
        console.log(`Menemukan folder sesi lama: ${file}. Menghapus...`);
        fs.rmSync(folderPath, { recursive: true, force: true });
    }
});

// 2. Gunakan Client ID BARU (PENTING!)
// Ini memaksa bot menggunakan folder sesi baru yang bersih
const NEW_CLIENT_ID = 'bot-wa-fresh-reset-v2'; 

console.log(`Menggunakan Client ID: ${NEW_CLIENT_ID}`);
// -------------------------------

const app = express();
app.use(cors());

// Melayani file HTML statis dari folder 'public'
app.use(express.static('public'));

// Setup HTTP Server & Socket.io
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

// Inisialisasi Client WhatsApp
const client = new Client({
    authStrategy: new LocalAuth({ clientId: NEW_CLIENT_ID }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process', 
            '--disable-gpu'
        ]
    }
});

let isConnected = false;

// --- EVENTS WHATSAPP ---

client.on('qr', (qr) => {
    console.log('QR Code Baru Muncul! Mengirim ke client...');
    io.emit('qr', { qr: qr });
});

client.on('ready', () => {
    console.log('Client is ready! Sesi berhasil dibuat.');
    isConnected = true;
    const info = client.info;
    io.emit('ready', { phone: info.wid.user });
});

client.on('message', async (msg) => {
    console.log('Pesan masuk:', msg.body);
    
    if (msg.body.toLowerCase() === 'halo') {
        msg.reply('Halo! Bot ini sudah fresh login baru.');
    }
    
    io.emit('message', {
        from: msg.from,
        body: msg.body,
        time: new Date().toLocaleTimeString()
    });
});

client.on('authenticated', () => {
    console.log('AUTHENTICATED (Login Berhasil)');
});

client.on('auth_failure', msg => {
    console.error('AUTHENTICATION FAILURE', msg);
});

client.initialize();

// --- EVENTS SOCKET.IO ---

io.on('connection', (socket) => {
    console.log('Frontend terhubung!');

    socket.on('get-stats', () => {
        socket.emit('stats', {
            connected: isConnected,
            chats: client.chats ? client.chats.length : 0
        });
    });

    socket.on('disconnect-wa', () => {
        console.log('User request disconnect WA...');
        client.logout();
    });
});

// Jalankan Server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server berjalan di port ${PORT}`);
});
