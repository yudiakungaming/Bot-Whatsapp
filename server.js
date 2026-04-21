// ============================================================
// server.js — Backend WABot Manager
// Jalankan: npm install whatsapp-web.js express socket.io qrcode
// Kemudian: node server.js
// Buka: http://localhost:3000
// ============================================================

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

// whatsapp-web.js akan di-import jika tersedia
let Client, LocalAuth, QRCode;
try {
    const wh = require('whatsapp-web.js');
    Client = wh.Client;
    LocalAuth = wh.LocalAuth;
    QRCode = require('qrcode');
} catch (e) {
    console.log('[INFO] whatsapp-web.js belum terinstall.');
    console.log('[INFO] Jalankan: npm install whatsapp-web.js qrcode');
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Serve index.html dari folder public/
app.get('/', (req, res) => {
    const indexPath = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.send(`
            <h2 style="font-family:sans-serif;padding:40px;color:#333;">
                WABot Manager — Backend Aktif<br><br>
                <span style="color:#25D366;font-size:14px;">Server berjalan di port 3000</span><br><br>
                <span style="color:#666;font-size:13px;">
                Letakkan file HTML dashboard di folder <code>public/index.html</code>
                </span>
            </h2>
        `);
    }
});

// ==================== STATE ====================
let waClient = null;
let waConnected = false;
let waQR = null;

// Aturan auto-reply (disimpan di memory, bisa diganti ke database)
let rules = [
    {
        id: 1, name: 'Sapaan',
        matchType: 'contains',
        keywords: ['halo', 'hai', 'selamat pagi', 'selamat siang'],
        reply: 'Halo! Terima kasih telah menghubungi kami. Ada yang bisa kami bantu?',
        priority: 'high', status: 'active', triggerCount: 0
    },
    {
        id: 2, name: 'Info Harga',
        matchType: 'contains',
        keywords: ['harga', 'biaya', 'ongkir'],
        reply: 'Untuk info harga, silakan hubungi tim sales kami.',
        priority: 'normal', status: 'active', triggerCount: 0
    },
    {
        id: 3, name: 'Terima Kasih',
        matchType: 'contains',
        keywords: ['terima kasih', 'makasih', 'thanks'],
        reply: 'Sama-sama! Senang bisa membantu.',
        priority: 'low', status: 'active', triggerCount: 0
    }
];

// Log pesan
let messageLogs = [];

// Jadwal pesan
let schedules = [];

// ==================== WHATSAPP CLIENT ====================
function initWhatsApp() {
    if (!Client) {
        console.log('[WARN] whatsapp-web.js tidak tersedia. Menjalankan mode demo.');
        io.emit('wa-status', { status: 'no-library' });
        return;
    }

    waClient = new Client({
        authStrategy: new LocalAuth({ clientId: 'wabot-session' }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
    });

    // Event: QR Code tersedia
    waClient.on('qr', async (qr) => {
        console.log('[WA] QR Code tersedia, menunggu scan...');
        try {
            const qrImage = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
            waQR = qrImage;
            io.emit('wa-qr', { qr: qrImage });
        } catch (err) {
            // Fallback: kirim QR string mentah
            io.emit('wa-qr', { qr: null, qrString: qr });
        }
        io.emit('wa-status', { status: 'qr-ready' });
    });

    // Event: Berhasil terhubung
    waClient.on('ready', () => {
        console.log('[WA] Terhubung!');
        waConnected = true;
        waQR = null;
        io.emit('wa-status', { status: 'connected' });

        waClient.getContacts().then(contacts => {
            console.log(`[WA] ${contacts.length} kontak ditemukan`);
        }).catch(() => {});
    });

    // Event: Pesan masuk
    waClient.on('message', async (msg) => {
        if (msg.from === 'status@broadcast') return;
        if (msg.hasMedia) return;

        const body = msg.body.trim();
        if (!body) return;

        const sender = await msg.getContact();
        const senderName = sender.pushName || sender.number || 'Unknown';
        const senderPhone = sender.number || msg.from;
        const now = new Date();
        const timeStr = now.getHours().toString().padStart(2, '0') + ':' +
                        now.getMinutes().toString().padStart(2, '0');

        console.log(`[MSG] ${senderName}: ${body}`);

        // Cocokkan dengan aturan
        let matchedRule = null;
        const bodyLower = body.toLowerCase();

        // Urutkan berdasarkan prioritas
        const sortedRules = [...rules]
            .filter(r => r.status === 'active')
            .sort((a, b) => {
                const p = { high: 0, normal: 1, low: 2 };
                return (p[a.priority] || 1) - (p[b.priority] || 1);
            });

        for (const rule of sortedRules) {
            for (const kw of rule.keywords) {
                const kwLower = kw.toLowerCase();
                let found = false;

                if (rule.matchType === 'contains') found = bodyLower.includes(kwLower);
                else if (rule.matchType === 'exact') found = bodyLower === kwLower;
                else if (rule.matchType === 'startswith') found = bodyLower.startsWith(kwLower);
                else if (rule.matchType === 'regex') {
                    try { found = new RegExp(kw, 'i').test(body); } catch(e) {}
                }

                if (found) { matchedRule = rule; break; }
            }
            if (matchedRule) break;
        }

        let replyText = null;
        if (matchedRule) {
            replyText = matchedRule.reply;
            matchedRule.triggerCount++;

            // Kirim balasan dengan delay 1-3 detik (agar terlihat natural)
            const delay = 1000 + Math.random() * 2000;
            setTimeout(async () => {
                try {
                    await msg.reply(replyText);
                    console.log(`[REPLY] -> ${senderName}: ${replyText.substring(0, 50)}...`);
                } catch (err) {
                    console.error(`[ERROR] Gagal kirim balasan: ${err.message}`);
                }
            }, delay);
        }

        // Simpan ke log
        const logEntry = {
            id: Date.now(),
            time: timeStr,
            sender: senderName,
            phone: senderPhone,
            incoming: body,
            reply: replyText ? replyText.substring(0, 80) + (replyText.length > 80 ? '...' : '') : '-',
            rule: matchedRule ? matchedRule.name : '-',
            status: matchedRule ? 'replied' : 'missed'
        };
        messageLogs.unshift(logEntry);
        if (messageLogs.length > 500) messageLogs = messageLogs.slice(0, 500);

        // Kirim ke dashboard via WebSocket
        io.emit('wa-message', logEntry);
        if (matchedRule) io.emit('rules-updated', rules);
    });

    // Event: Diskonek
    waClient.on('disconnected', (reason) => {
        console.log(`[WA] Diskonek: ${reason}`);
        waConnected = false;
        io.emit('wa-status', { status: 'disconnected', reason });
    });

    // Event: Auth failure
    waClient.on('auth_failure', () => {
        console.log('[WA] Auth gagal, hapus folder .wabot-session dan coba lagi');
        io.emit('wa-status', { status: 'auth-failure' });
    });

    waClient.initialize();
}

// ==================== SOCKET.IO EVENTS ====================
io.on('connection', (socket) => {
    console.log(`[IO] Client terhubung: ${socket.id}`);

    // Kirim status awal
    socket.emit('wa-status', {
        status: waConnected ? 'connected' : (waQR ? 'qr-ready' : 'initializing')
    });
    socket.emit('rules-updated', rules);
    socket.emit('logs-updated', messageLogs.slice(0, 50));
    socket.emit('schedules-updated', schedules);

    // Client minta QR
    socket.on('request-qr', () => {
        if (waQR) socket.emit('wa-qr', { qr: waQR });
    });

    // Client putuskan koneksi WA
    socket.on('disconnect-wa', async () => {
        if (waClient && waConnected) {
            try {
                await waClient.logout();
                waConnected = false;
                io.emit('wa-status', { status: 'disconnected' });
                console.log('[WA] Logout oleh user');
            } catch(e) {}
        }
    });

    // Client mengirim pesan manual
    socket.on('send-message', async (data) => {
        if (!waClient || !waConnected) {
            socket.emit('send-error', 'WhatsApp tidak terhubung');
            return;
        }
        try {
            const chatId = data.phone.replace(/[^0-9]/g, '') + '@c.us';
            await waClient.sendMessage(chatId, data.message);
            socket.emit('send-success', { phone: data.phone, message: data.message });
            console.log(`[SEND] -> ${data.phone}: ${data.message.substring(0, 50)}`);
        } catch (err) {
            socket.emit('send-error', err.message);
        }
    });

    // CRUD Rules
    socket.on('add-rule', (rule) => {
        rule.id = Date.now();
        rule.triggerCount = 0;
        rules.push(rule);
        io.emit('rules-updated', rules);
    });

    socket.on('update-rule', (rule) => {
        const idx = rules.findIndex(r => r.id === rule.id);
        if (idx !== -1) { rules[idx] = rule; io.emit('rules-updated', rules); }
    });

    socket.on('delete-rule', (id) => {
        rules = rules.filter(r => r.id !== id);
        io.emit('rules-updated', rules);
    });

    socket.on('toggle-rule', (id) => {
        const r = rules.find(r => r.id === id);
        if (r) { r.status = r.status === 'active' ? 'paused' : 'active'; io.emit('rules-updated', rules); }
    });

    // CRUD Schedules
    socket.on('add-schedule', (sched) => {
        sched.id = Date.now();
        sched.status = 'active';
        schedules.push(sched);
        io.emit('schedules-updated', schedules);
    });

    socket.on('delete-schedule', (id) => {
        schedules = schedules.filter(s => s.id !== id);
        io.emit('schedules-updated', schedules);
    });

    socket.on('toggle-schedule', (id) => {
        const s = schedules.find(s => s.id === id);
        if (s) { s.status = s.status === 'active' ? 'paused' : 'active'; io.emit('schedules-updated', schedules); }
    });

    // Clear logs
    socket.on('clear-logs', () => {
        messageLogs = [];
        io.emit('logs-updated', []);
    });

    socket.on('disconnect', () => {
        console.log(`[IO] Client diskonek: ${socket.id}`);
    });
});

// ==================== JADWAL CHECKER ====================
setInterval(() => {
    const now = new Date();
    const currentTime = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
    const currentDate = now.toISOString().split('T')[0];

    schedules.filter(s => s.status === 'active').forEach(sched => {
        if (sched.time === currentTime && sched.date <= currentDate) {
            if (sched.repeat === 'none' && sched.date !== currentDate) return;

            // Kirim pesan terjadwal
            if (waClient && waConnected) {
                let targetId;
                if (sched.target === 'all') {
                    console.log(`[SCHED] Tidak bisa kirim ke "semua kontak" langsung. Target spesifik diperlukan.`);
                    return;
                } else if (sched.target.startsWith('group:')) {
                    targetId = sched.target.replace('group:', '') + '@g.us';
                } else if (sched.target.startsWith('contact:')) {
                    const phone = sched.target.replace('contact:', '');
                    targetId = phone + '@c.us';
                }

                if (targetId) {
                    waClient.sendMessage(targetId, sched.message).then(() => {
                        console.log(`[SCHED] Pesan terjadwal terkirim: ${sched.name}`);
                        io.emit('schedule-sent', { name: sched.name, time: currentTime });
                    }).catch(err => {
                        console.error(`[SCHED] Error: ${err.message}`);
                    });
                }

                // Update tanggal untuk repeat
                if (sched.repeat === 'daily') {
                    const next = new Date(now); next.setDate(next.getDate() + 1);
                    sched.date = next.toISOString().split('T')[0];
                } else if (sched.repeat === 'weekly') {
                    const next = new Date(now); next.setDate(next.getDate() + 7);
                    sched.date = next.toISOString().split('T')[0];
                } else if (sched.repeat === 'monthly') {
                    const next = new Date(now); next.setMonth(next.getMonth() + 1);
                    sched.date = next.toISOString().split('T')[0];
                } else if (sched.repeat === 'none') {
                    sched.status = 'paused';
                }
            }
        }
    });
}, 60000); // Cek setiap menit

// ==================== START SERVER ====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════╗');
    console.log('║        WABot Manager Backend             ║');
    console.log('║   Server berjalan di port ' + PORT + '            ║');
    console.log('║   Buka: http://localhost:' + PORT + '            ║');
    console.log('╚══════════════════════════════════════════╝');
    console.log('');
    initWhatsApp();
});
