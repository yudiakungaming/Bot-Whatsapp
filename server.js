const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');

// --- LOGIKA HAPUS SESI LAMA (FIX RAILWAY) ---
const fs = require('fs');
const path = require('path');

// Tentukan folder sesi default LocalAuth (.wwebjs_auth)
const sessionFolder = path.resolve(__dirname, '.wwebjs_auth');

if (fs.existsSync(sessionFolder)) {
    console.log('------------------------------------------');
    console.log('Menemukan sesi lama (session conflict).');
    console.log('Menghapus paksa data sesi untuk memaksa QR muncul ulang...');
    fs.rmSync(sessionFolder, { recursive: true, force: true });
    console.log('Sesi lama berhasil dihapus! Silakan refresh web & scan ulang.');
    console.log('------------------------------------------');
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
        origin: "*", // Mengizinkan koneksi dari mana saja
        methods: ["GET", "POST"]
    }
});

// Inisialisasi Client WhatsApp
// Menggunakan LocalAuth untuk menyimpan sesi
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
            '--single-process', // Diperlukan di beberapa environment cloud
            '--disable-gpu'
        ]
    }
});

let isConnected = false;

// --- EVENTS WHATSAPP ---

// Saat QR Code muncul
client.on('qr', (qr) => {
    console.log('QR Code diterima, mengirim ke client...');
    // Kirim event 'qr' ke frontend
    io.emit('qr', { qr: qr });
});

// Saat Siap (Terhubung)
client.on('ready', () => {
    console.log('Client is ready!');
    isConnected = true;
    const info = client.info;
    // Kirim info user ke frontend
    io.emit('ready', { phone: info.wid.user });
});

// Saat Pesan Masuk
client.on('message', async (msg) => {
    console.log('Pesan masuk:', msg.body);
    
    // --- LOGIKA BALAS SEDERHANA (CONTOH) ---
    // Anda bisa menambah logika di sini atau memanggil dari database
    if (msg.body.toLowerCase() === 'halo') {
        msg.reply('Halo! Bot ini sedang berjalan di Railway.');
    }
    
    // Kirim log ke frontend (opsional)
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
    // Jika auth gagal (misal session korup), frontend akan stuck di loading/terputus
    // Tapi karena script di atas sudah menghapus session, ini seharusnya jarang terjadi.
});

client.initialize();

// --- EVENTS SOCKET.IO ---

io.on('connection', (socket) => {
    console.log('Frontend terhubung!');

    // Jika client minta stats
    socket.on('get-stats', () => {
        socket.emit('stats', {
            connected: isConnected,
            chats: client.chats ? client.chats.length : 0
        });
    });

    // Jika client minta putus koneksi (Logout WA)
    socket.on('disconnect-wa', () => {
        console.log('User request disconnect WA...');
        client.logout();
    });
});

// Jalankan Server di port yang ditentukan Railway atau port 3000 lokal
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server berjalan di port ${PORT}`);
});
