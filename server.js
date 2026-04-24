const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');

// --- LOGIKA RESET SESI (FIX RAILWAY) ---
const fs = require('fs');
const path = require('path');

// Cek apakah kita perlu merestart sesi (dari Environment Variable Railway)
const shouldReset = process.env.RESTART_SESSION === 'YES';

if (shouldReset) {
    const sessionFolder = path.resolve(__dirname, '.wwebjs_auth');
    if (fs.existsSync(sessionFolder)) {
        console.log('------------------------------------------');
        console.log('TERDETEKSI PERINTAH RESET SESI!');
        console.log('Menghapus folder .wwebjs_auth secara paksa...');
        fs.rmSync(sessionFolder, { recursive: true, force: true });
        console.log('Sesi lama berhasil dihapus!');
        console.log('------------------------------------------');
    }
}
// -----------------------------------------------

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
    authStrategy: new LocalAuth({ clientId: 'bot-wa' }),
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

// Saat QR Code muncul
client.on('qr', (qr) => {
    console.log('QR Code diterima, mengirim ke client...');
    io.emit('qr', { qr: qr });
});

// Saat Siap (Terhubung)
client.on('ready', () => {
    console.log('Client is ready!');
    isConnected = true;
    const info = client.info;
    io.emit('ready', { phone: info.wid.user });
});

// Saat Pesan Masuk
client.on('message', async (msg) => {
    console.log('Pesan masuk:', msg.body);
    
    if (msg.body.toLowerCase() === 'halo') {
        msg.reply('Halo! Bot ini sedang berjalan di Railway.');
    }
    
    io.emit('message', {
        from: msg.from,
        body: msg.body,
        time: new Date().toLocaleTimeString()
    });
});

client.on('authenticated', () => {
    console.log('AUTHENTICATED');
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
