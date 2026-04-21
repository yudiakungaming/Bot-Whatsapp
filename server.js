// ============================================================
// server.js — WABot Manager (Baileys Version)
// Cocok untuk deploy di Railway / Render / VPS
// ============================================================

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());

// Serve file HTML dari folder public/
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    const indexPath = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.send(`
            <h2 style="font-family:sans-serif;padding:40px;color:#333;">
                WABot Manager Backend Aktif<br><br>
                <span style="color:#25D366;">Server berjalan</span><br><br>
                <span style="color:#666;font-size:13px;">
                Letakkan file HTML dashboard di folder <code>public/index.html</code>
                </span>
            </h2>
        `);
    }
});

// ==================== STATE ====================
let sock = null;
let waConnected = false;
let qrDataUrl = null;

let rules = [
    { id: 1, name: 'Sapaan', matchType: 'contains', keywords: ['halo','hai','selamat pagi','selamat siang','selamat malam'], reply: 'Halo! Terima kasih telah menghubungi kami. Ada yang bisa kami bantu?', priority: 'high', status: 'active', triggerCount: 0 },
    { id: 2, name: 'Info Harga', matchType: 'contains', keywords: ['harga','biaya','ongkir','murah'], reply: 'Untuk informasi harga, silakan kunjungi katalog kami atau hubungi tim sales.', priority: 'normal', status: 'active', triggerCount: 0 },
    { id: 3, name: 'Cek Pesanan', matchType: 'contains', keywords: ['pesanan','order','status','tracking'], reply: 'Untuk cek status pesanan, kirim nomor pesanan (INV-xxxxx).', priority: 'normal', status: 'active', triggerCount: 0 },
    { id: 4, name: 'Komplain', matchType: 'contains', keywords: ['komplain','keluhan','rusak','salah'], reply: 'Mohon maaf atas ketidaknyamanan. Tim kami akan menindaklanjuti. Sertakan foto dan nomor pesanan.', priority: 'high', status: 'active', triggerCount: 0 },
    { id: 5, name: 'Terima Kasih', matchType: 'contains', keywords: ['terima kasih','makasih','thanks','thx'], reply: 'Sama-sama! Senang bisa membantu.', priority: 'low', status: 'active', triggerCount: 0 },
];

let messageLogs = [];
let schedules = [];

// ==================== WHATSAPP (BAILEYS) ====================
async function initWhatsApp() {
    const SESSION_DIR = path.join(__dirname, 'auth_session');
    if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' })
    });

    // Simpan kredensial saat update
    sock.ev.on('creds.update', saveCreds);

    // Event: QR Code
    sock.ev.on('connection.update', async (update) => {
        const { qr, connection, lastDisconnect } = update;

        // QR tersedia
        if (qr) {
            console.log('[WA] QR Code tersedia');
            try {
                qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
                io.emit('wa-qr', { qr: qrDataUrl });
            } catch (e) {
                io.emit('wa-qr', { qr: null, qrString: qr });
            }
            io.emit('wa-status', { status: 'qr-ready' });
        }

        // Koneksi berubah
        if (connection === 'open') {
            console.log('[WA] TERHUBUNG!');
            waConnected = true;
            qrDataUrl = null;
            io.emit('wa-status', { status: 'connected' });
        }

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            console.log(`[WA] Diskonek, kode: ${code}`);
            waConnected = false;

            if (code === DisconnectReason.loggedOut) {
                console.log('[WA] Session logout, hapus auth_session dan restart');
                io.emit('wa-status', { status: 'auth-failure' });
            } else {
                console.log('[WA] Reconnecting...');
                io.emit('wa-status', { status: 'reconnecting' });
                setTimeout(() => initWhatsApp(), 5000);
            }
        }
    });

    // Event: Pesan masuk
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;
        if (msg.key.remoteJid === 'status@broadcast') return;

        const body = msg.message?.conversation ||
                     msg.message?.extendedTextMessage?.text || '';
        if (!body.trim()) return;

        const senderPhone = msg.key.remoteJid?.replace(/@s\.whatsapp\.net/, '') || 'Unknown';
        const pushName = msg.pushName || senderPhone;
        const now = new Date();
        const timeStr = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0');

        console.log(`[MSG] ${pushName}: ${body}`);

        // Cocokkan aturan
        let matchedRule = null;
        const bodyLower = body.toLowerCase();
        const sortedRules = [...rules]
            .filter(r => r.status === 'active')
            .sort((a, b) => ({ high:0, normal:1, low:2 }[a.priority]||1) - ({ high:0, normal:1, low:2 }[b.priority]||1));

        for (const rule of sortedRules) {
            for (const kw of rule.keywords) {
                const kwL = kw.toLowerCase();
                let found = false;
                if (rule.matchType === 'contains') found = bodyLower.includes(kwL);
                else if (rule.matchType === 'exact') found = bodyLower === kwL;
                else if (rule.matchType === 'startswith') found = bodyLower.startsWith(kwL);
                else if (rule.matchType === 'regex') { try { found = new RegExp(kw,'i').test(body); } catch(e){} }
                if (found) { matchedRule = rule; break; }
            }
            if (matchedRule) break;
        }

        if (matchedRule) {
            matchedRule.triggerCount++;
            const replyText = matchedRule.reply;
            const delay = 1000 + Math.random() * 2000;

            setTimeout(async () => {
                try {
                    await sock.sendMessage(msg.key.remoteJid, { text: replyText });
                    console.log(`[REPLY] -> ${pushName}: ${replyText.substring(0,50)}...`);
                } catch (err) {
                    console.error(`[ERR] Gagal reply: ${err.message}`);
                }
            }, delay);
        }

        const logEntry = {
            id: Date.now(), time: timeStr, sender: pushName, phone: senderPhone,
            incoming: body,
            reply: matchedRule ? matchedRule.reply.substring(0,80) + (matchedRule.reply.length>80?'...':'') : '-',
            rule: matchedRule ? matchedRule.name : '-',
            status: matchedRule ? 'replied' : 'missed'
        };
        messageLogs.unshift(logEntry);
        if (messageLogs.length > 500) messageLogs = messageLogs.slice(0, 500);

        io.emit('wa-message', logEntry);
        if (matchedRule) io.emit('rules-updated', rules);
    });
}

// ==================== SOCKET.IO ====================
io.on('connection', (socket) => {
    console.log(`[IO] Client: ${socket.id}`);

    socket.emit('wa-status', { status: waConnected ? 'connected' : (qrDataUrl ? 'qr-ready' : 'initializing') });
    socket.emit('rules-updated', rules);
    socket.emit('logs-updated', messageLogs.slice(0, 50));
    socket.emit('schedules-updated', schedules);

    socket.on('request-qr', () => { if (qrDataUrl) socket.emit('wa-qr', { qr: qrDataUrl }); });

    socket.on('disconnect-wa', () => {
        if (sock) { sock.end(); waConnected = false; io.emit('wa-status', { status: 'disconnected' }); }
    });

    socket.on('send-message', async (data) => {
        if (!sock || !waConnected) { socket.emit('send-error', 'WA tidak terhubung'); return; }
        try {
            const chatId = data.phone.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
            await sock.sendMessage(chatId, { text: data.message });
            socket.emit('send-success', { phone: data.phone });
        } catch (err) { socket.emit('send-error', err.message); }
    });

    socket.on('add-rule', (r) => { r.id = Date.now(); r.triggerCount = 0; rules.push(r); io.emit('rules-updated', rules); });
    socket.on('update-rule', (r) => { const i = rules.findIndex(x=>x.id===r.id); if(i!==-1){rules[i]=r; io.emit('rules-updated', rules);} });
    socket.on('delete-rule', (id) => { rules = rules.filter(r=>r.id!==id); io.emit('rules-updated', rules); });
    socket.on('toggle-rule', (id) => { const r=rules.find(r=>r.id===id); if(r){r.status=r.status==='active'?'paused':'active'; io.emit('rules-updated', rules);} });

    socket.on('add-schedule', (s) => { s.id=Date.now(); s.status='active'; schedules.push(s); io.emit('schedules-updated', schedules); });
    socket.on('delete-schedule', (id) => { schedules=schedules.filter(s=>s.id!==id); io.emit('schedules-updated', schedules); });
    socket.on('toggle-schedule', (id) => { const s=schedules.find(s=>s.id===id); if(s){s.status=s.status==='active'?'paused':'active'; io.emit('schedules-updated', schedules);} });

    socket.on('clear-logs', () => { messageLogs=[]; io.emit('logs-updated', []); });

    socket.on('disconnect', () => {});
});

// Jadwal checker
setInterval(() => {
    if (!sock || !waConnected) return;
    const now = new Date();
    const ct = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0');
    const cd = now.toISOString().split('T')[0];

    schedules.filter(s=>s.status==='active').forEach(s => {
        if (s.time === ct && s.date <= cd) {
            let targetId = null;
            if (s.target.startsWith('group:')) targetId = s.target.replace('group:','') + '@g.us';
            else if (s.target.startsWith('contact:')) targetId = s.target.replace('contact:','').replace(/[^0-9]/g,'') + '@s.whatsapp.net';
            if (targetId) {
                sock.sendMessage(targetId, { text: s.message }).then(() => {
                    io.emit('schedule-sent', { name: s.name });
                }).catch(e => console.error('[SCHED ERR]', e.message));
            }
            if (s.repeat === 'daily') { const n=new Date(now); n.setDate(n.getDate()+1); s.date=n.toISOString().split('T')[0]; }
            else if (s.repeat === 'weekly') { const n=new Date(now); n.setDate(n.getDate()+7); s.date=n.toISOString().split('T')[0]; }
            else if (s.repeat === 'monthly') { const n=new Date(now); n.setMonth(n.getMonth()+1); s.date=n.toISOString().split('T')[0]; }
            else { s.status = 'paused'; }
        }
    });
}, 60000);

// ==================== START ====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('WABot Manager berjalan di port ' + PORT);
    initWhatsApp();
});
