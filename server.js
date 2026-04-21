// ============================================================
// server.js — WABot Manager (Versi Lengkap dengan Settings)
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
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

// ==================== SETTINGS (default) ====================
let settings = {
    botName: 'WABot Assistant',
    botPhone: '+62 812-xxxx-7890',
    timezone: 'WIB',
    delayReply: 2,
    randomDelay: true,
    randomDelayMax: 3,
    cooldownEnabled: true,
    cooldownSeconds: 30,
    maxRepliesPerHour: 100,
    replyPrivate: true,
    replyGroup: true,
    groupTagOnly: false,
    caseSensitive: false,
    replyMedia: false,
    prefixEnabled: false,
    prefixText: '[BOT] ',
    suffixEnabled: false,
    suffixText: '',
    defaultReplyEnabled: true,
    defaultReplyText: 'Terima kasih telah menghubungi kami. Pesan Anda akan segera diproses. Jam operasional: Senin-Jumat, 08.00-17.00 WIB.',
    whitelistMode: false,
    blacklist: []
};

let rules = [
    { id: 1, name: 'Sapaan', matchType: 'contains', keywords: ['halo','hai','selamat pagi','selamat siang','selamat malam'], reply: 'Halo! Terima kasih telah menghubungi kami. Ada yang bisa kami bantu?', priority: 'high', status: 'active', triggerCount: 0 },
    { id: 2, name: 'Info Harga', matchType: 'contains', keywords: ['harga','biaya','ongkir','murah'], reply: 'Untuk info harga, silakan kunjungi katalog kami atau hubungi tim sales.', priority: 'normal', status: 'active', triggerCount: 0 },
    { id: 3, name: 'Cek Pesanan', matchType: 'contains', keywords: ['pesanan','order','status','tracking'], reply: 'Untuk cek status pesanan, kirim nomor pesanan (INV-xxxxx).', priority: 'normal', status: 'active', triggerCount: 0 },
    { id: 4, name: 'Komplain', matchType: 'contains', keywords: ['komplain','keluhan','rusak','salah'], reply: 'Mohon maaf atas ketidaknyamanan. Tim kami akan menindaklanjuti. Sertakan foto dan nomor pesanan.', priority: 'high', status: 'active', triggerCount: 0 },
    { id: 5, name: 'Terima Kasih', matchType: 'contains', keywords: ['terima kasih','makasih','thanks','thx'], reply: 'Sama-sama! Senang bisa membantu.', priority: 'low', status: 'active', triggerCount: 0 },
];

let messageLogs = [];
let schedules = [];
let botEnabled = false;
let hourlyCount = 0;
let cooldownMap = {}; // phone -> timestamp

// Reset hourly counter setiap jam
setInterval(() => { hourlyCount = 0; }, 3600000);

// ==================== WHATSAPP (BAILEYS) ====================
let sock = null;
let waConnected = false;

async function initWhatsApp() {
    const SESSION_DIR = path.join(__dirname, 'auth_session');
    if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { qr, connection, lastDisconnect } = update;

        if (qr) {
            try {
                const url = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
                io.emit('wa-qr', { qr: url });
            } catch (e) {
                io.emit('wa-qr', { qr: null, qrString: qr });
            }
            io.emit('wa-status', { status: 'qr-ready' });
        }

        if (connection === 'open') {
            waConnected = true;
            console.log('[WA] TERHUBUNG');
            io.emit('wa-status', { status: 'connected' });
        }

        if (connection === 'close') {
            waConnected = false;
            const code = lastDisconnect?.error?.output?.statusCode;
            console.log('[WA] Diskonek:', code);
            if (code === DisconnectReason.loggedOut) {
                io.emit('wa-status', { status: 'auth-failure' });
            } else {
                io.emit('wa-status', { status: 'reconnecting' });
                setTimeout(() => initWhatsApp(), 5000);
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;
        if (msg.key.remoteJid === 'status@broadcast') return;

        // Cek apakah bot aktif
        if (!botEnabled) return;

        const isGroup = msg.key.remoteJid.endsWith('@g.us');
        const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        const hasMedia = !!(msg.message?.imageMessage || msg.message?.videoMessage || msg.message?.stickerMessage);

        // Cek: balas grup?
        if (isGroup && !settings.replyGroup) return;
        // Cek: balas private?
        if (!isGroup && !settings.replyPrivate) return;
        // Cek: media?
        if (hasMedia && !settings.replyMedia) return;
        // Cek: group tag only
        if (isGroup && settings.groupTagOnly) {
            const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
            const botJid = sock.user?.id;
            if (!mentioned.includes(botJid)) return;
        }
        // Cek: blacklist
        const senderPhone = msg.key.remoteJid.replace(/@s\.whatsapp\.net/, '').replace(/@g\.us/, '');
        if (settings.blacklist.includes(senderPhone)) return;

        if (!body.trim() && !hasMedia) return;

        // Cek: rate limit per jam
        if (settings.maxRepliesPerHour > 0 && hourlyCount >= settings.maxRepliesPerHour) {
            console.log('[RATE] Limit per jam tercapai, skip');
            return;
        }

        // Cek: cooldown per nomor
        if (settings.cooldownEnabled) {
            const lastReply = cooldownMap[senderPhone] || 0;
            if (Date.now() - lastReply < settings.cooldownSeconds * 1000) {
                console.log('[COOLDOWN] Skip:', senderPhone);
                return;
            }
        }

        const pushName = msg.pushName || senderPhone;
        const now = new Date();
        const timeStr = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0');

        console.log(`[MSG] ${pushName}: ${body.substring(0, 60)}`);

        // Cocokkan aturan
        let matchedRule = null;
        const bodyCmp = settings.caseSensitive ? body : body.toLowerCase();
        const sortedRules = [...rules]
            .filter(r => r.status === 'active')
            .sort((a, b) => ({ high: 0, normal: 1, low: 2 }[a.priority] || 1) - ({ high: 0, normal: 1, low: 2 }[b.priority] || 1));

        for (const rule of sortedRules) {
            for (const kw of rule.keywords) {
                const kwCmp = settings.caseSensitive ? kw : kw.toLowerCase();
                let found = false;
                if (rule.matchType === 'contains') found = bodyCmp.includes(kwCmp);
                else if (rule.matchType === 'exact') found = bodyCmp === kwCmp;
                else if (rule.matchType === 'startswith') found = bodyCmp.startsWith(kwCmp);
                else if (rule.matchType === 'regex') { try { found = new RegExp(kw, settings.caseSensitive ? '' : 'i').test(body); } catch(e) {} }
                if (found) { matchedRule = rule; break; }
            }
            if (matchedRule) break;
        }

        // Susun pesan balasan
        let replyText = null;
        if (matchedRule) {
            replyText = matchedRule.reply;
            matchedRule.triggerCount++;
        } else if (settings.defaultReplyEnabled && body.trim()) {
            replyText = settings.defaultReplyText;
        }

        if (replyText) {
            // Tambah prefix/suffix
            if (settings.prefixEnabled) replyText = settings.prefixText + replyText;
            if (settings.suffixEnabled && settings.suffixText) replyText = replyText + settings.suffixText;

            // Hitung delay
            let delay = settings.delayReply * 1000;
            if (settings.randomDelay) {
                delay += Math.random() * settings.randomDelayMax * 1000;
            }
            delay = Math.max(0, delay);

            setTimeout(async () => {
                try {
                    await sock.sendMessage(msg.key.remoteJid, { text: replyText });
                    console.log(`[REPLY] -> ${pushName}: ${replyText.substring(0, 50)}...`);
                    hourlyCount++;
                    cooldownMap[senderPhone] = Date.now();
                } catch (err) {
                    console.error('[ERR] Gagal reply:', err.message);
                }
            }, delay);
        }

        // Log
        const logEntry = {
            id: Date.now(),
            time: timeStr,
            sender: pushName,
            phone: senderPhone,
            incoming: body || '[Media]',
            reply: replyText ? replyText.substring(0, 80) + (replyText.length > 80 ? '...' : '') : '-',
            rule: matchedRule ? matchedRule.name : (settings.defaultReplyEnabled ? 'Default' : '-'),
            status: replyText ? 'replied' : 'missed'
        };
        messageLogs.unshift(logEntry);
        if (messageLogs.length > 500) messageLogs = messageLogs.slice(0, 500);
        io.emit('wa-message', logEntry);
        if (matchedRule) io.emit('rules-updated', rules);
    });
}

// ==================== SOCKET.IO ====================
io.on('connection', (socket) => {
    console.log('[IO] Client:', socket.id);
    socket.emit('wa-status', { status: waConnected ? 'connected' : 'initializing' });
    socket.emit('settings-updated', settings);
    socket.emit('rules-updated', rules);
    socket.emit('logs-updated', messageLogs.slice(0, 50));
    socket.emit('schedules-updated', schedules);

    socket.on('request-qr', () => {
        // QR akan dikirim otomatis via event connection.update
    });

    socket.on('disconnect-wa', () => {
        if (sock) { sock.end(); waConnected = false; io.emit('wa-status', { status: 'disconnected' }); }
    });

    socket.on('toggle-bot', (val) => {
        botEnabled = val;
        console.log('[BOT] Bot', val ? 'diaktifkan' : 'dimatikan');
    });

    // Settings
    socket.on('get-settings', () => { socket.emit('settings-updated', settings); });
    socket.on('update-setting', (data) => {
        settings[data.key] = data.value;
        console.log('[SET] ' + data.key + ' =', data.value);
        io.emit('settings-updated', settings);
    });
    socket.on('update-settings', (data) => {
        Object.assign(settings, data);
        console.log('[SET] Batch update');
        io.emit('settings-updated', settings);
    });

    // Rules
    socket.on('get-rules', () => { socket.emit('rules-updated', rules); });
    socket.on('add-rule', (r) => { r.id = Date.now(); r.triggerCount = 0; rules.push(r); io.emit('rules-updated', rules); });
    socket.on('update-rule', (r) => { const i = rules.findIndex(x => x.id === r.id); if (i !== -1) { rules[i] = r; io.emit('rules-updated', rules); } });
    socket.on('delete-rule', (id) => { rules = rules.filter(r => r.id !== id); io.emit('rules-updated', rules); });
    socket.on('toggle-rule', (id) => { const r = rules.find(r => r.id === id); if (r) { r.status = r.status === 'active' ? 'paused' : 'active'; io.emit('rules-updated', rules); } });

    // Schedules
    socket.on('get-schedules', () => { socket.emit('schedules-updated', schedules); });
    socket.on('add-schedule', (s) => { schedules.push(s); io.emit('schedules-updated', schedules); });
    socket.on('delete-schedule', (id) => { schedules = schedules.filter(s => s.id !== id); io.emit('schedules-updated', schedules); });
    socket.on('toggle-schedule', (id) => { const s = schedules.find(s => s.id === id); if (s) { s.status = s.status === 'active' ? 'paused' : 'active'; io.emit('schedules-updated', schedules); } });

    // Logs
    socket.on('get-logs', () => { socket.emit('logs-updated', messageLogs.slice(0, 50)); });
    socket.on('clear-logs', () => { messageLogs = []; io.emit('logs-updated', []); });

    socket.on('disconnect', () => {});
});

// Jadwal checker
setInterval(() => {
    if (!sock || !waConnected) return;
    const now = new Date();
    const ct = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0');
    const cd = now.toISOString().split('T')[0];

    schedules.filter(s => s.status === 'active').forEach(s => {
        if (s.time === ct && s.date <= cd) {
            let targetId = null;
            if (s.target.startsWith('group:')) targetId = s.target.replace('group:', '') + '@g.us';
            else if (s.target.startsWith('contact:')) targetId = s.target.replace('contact:', '').replace(/[^0-9]/g, '') + '@s.whatsapp.net';

            if (targetId) {
                let txt = s.message;
                if (settings.prefixEnabled) txt = settings.prefixText + txt;
                if (settings.suffixEnabled && settings.suffixText) txt = txt + settings.suffixText;

                sock.sendMessage(targetId, { text: txt }).then(() => {
                    console.log('[SCHED] Terkirim:', s.name);
                    io.emit('schedule-sent', { name: s.name });
                }).catch(e => console.error('[SCHED ERR]', e.message));
            }

            if (s.repeat === 'daily') { const n = new Date(now); n.setDate(n.getDate() + 1); s.date = n.toISOString().split('T')[0]; }
            else if (s.repeat === 'weekly') { const n = new Date(now); n.setDate(n.getDate() + 7); s.date = n.toISOString().split('T')[0]; }
            else if (s.repeat === 'monthly') { const n = new Date(now); n.setMonth(n.getMonth() + 1); s.date = n.toISOString().split('T')[0]; }
            else { s.status = 'paused'; }
        }
    });
}, 60000);

// ==================== START ====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('');
    console.log('╔════════════════════════════════════════════╗');
    console.log('║     WABot Manager — Server Aktif          ║');
    console.log('║     http://localhost:' + PORT + '                 ║');
    console.log('╚════════════════════════════════════════════╝');
    console.log('');
    initWhatsApp();
});
