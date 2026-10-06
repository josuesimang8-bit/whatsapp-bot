const express = require('express');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    delay
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Data handling
const DATA_FILE = path.join(__dirname, 'data.json');
let botData = { steps: [] };

function loadData() {
    if (fs.existsSync(DATA_FILE)) {
        try {
            botData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
        } catch (e) {
            console.error('Error loading data.json:', e);
            botData = { steps: [] };
        }
    }
}

function saveData() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(botData, null, 2));
}

loadData();

// Live Chat History Storage
const CHATS_FILE = path.join(__dirname, 'live_chats.json');
let liveChats = {}; // { jid: { id, name, lastMessage, timestamp, unread, botStatus: 'active'|'paused', messages: [] } }

function loadChats() {
    if (fs.existsSync(CHATS_FILE)) {
        try {
            liveChats = JSON.parse(fs.readFileSync(CHATS_FILE, 'utf-8'));
        } catch (e) {
            liveChats = {};
        }
    }
}

function saveChats() {
    try {
        fs.writeFileSync(CHATS_FILE, JSON.stringify(liveChats, null, 2));
    } catch (e) {}
}

loadChats();

// Multer setup for uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadPath = path.join(__dirname, 'uploads');
        if (!fs.existsSync(uploadPath)) {
            fs.mkdirSync(uploadPath, { recursive: true });
        }
        cb(null, uploadPath);
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// WhatsApp Connection State (Baileys)
let sock = null;
let currentQR = '';
let clientReady = false;
let initStatus = 'disconnected'; // 'disconnected' | 'connecting' | 'waiting_qr' | 'ready'
let initError = '';
let connectedUser = null; // { phone, name }
let readyTimestamp = Math.floor(Date.now() / 1000);

const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');
const logger = pino({ level: 'silent' });

async function initWhatsApp() {
    if (sock && (clientReady || initStatus === 'connecting')) {
        console.log('Baileys: Client is already connecting or active.');
        return;
    }

    console.log('Baileys: Initializing connection...');
    initStatus = 'connecting';
    initError = '';
    currentQR = '';

    try {
        if (!fs.existsSync(AUTH_DIR)) {
            fs.mkdirSync(AUTH_DIR, { recursive: true });
        }

        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        const { version, isLatest } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307], isLatest: true }));

        console.log(`Baileys: Using WA version v${version.join('.')}, isLatest: ${isLatest}`);

        sock = makeWASocket({
            version,
            logger,
            printQRInTerminal: false,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger)
            },
            browser: ['Umbler Talk', 'Desktop', '1.0.0'],
            generateHighQualityLinkPreview: true,
            syncFullHistory: false
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('Baileys: New QR Code received.');
                initStatus = 'waiting_qr';
                qrcode.toDataURL(qr, (err, url) => {
                    if (!err) {
                        currentQR = url;
                    } else {
                        console.error('Error generating QR URL:', err);
                    }
                });
            }

            if (connection === 'close') {
                const statusCode = (lastDisconnect?.error)?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log(`Baileys: Connection closed. Status: ${statusCode}. Reconnecting: ${shouldReconnect}`);

                clientReady = false;
                currentQR = '';
                connectedUser = null;

                if (statusCode === DisconnectReason.loggedOut) {
                    initStatus = 'disconnected';
                    initError = 'Desconectado do WhatsApp. Escaneie o código QR para reconectar.';
                    try {
                        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                    } catch (e) {}
                    sock = null;
                    setTimeout(initWhatsApp, 2000);
                } else {
                    initStatus = 'connecting';
                    initError = 'Reconectando ao WhatsApp...';
                    sock = null;
                    setTimeout(initWhatsApp, 3000);
                }
            } else if (connection === 'open') {
                console.log('Baileys: Connected successfully!');
                clientReady = true;
                initStatus = 'ready';
                currentQR = '';
                initError = '';
                readyTimestamp = Math.floor(Date.now() / 1000);

                const rawId = sock.user?.id || '';
                const phone = rawId.split(':')[0] || rawId.split('@')[0];
                connectedUser = {
                    id: rawId,
                    phone: '+' + phone,
                    name: sock.user?.name || phone
                };
            }
        });

        // Messages handling
        sock.ev.on('messages.upsert', async (m) => {
            if (m.type !== 'notify') return;

            for (const msg of m.messages) {
                // Ignore outgoing messages sent by the bot
                if (msg.key.fromMe) continue;

                const jid = msg.key.remoteJid;
                // Ignore group chats and status/broadcasts
                if (!jid || jid.endsWith('@g.us') || jid.includes('status@broadcast')) continue;

                // Ignore catch-up messages from before the bot connected
                const msgTimestamp = Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000);
                if (msgTimestamp < readyTimestamp) {
                    console.log(`Ignoring old message from ${jid}`);
                    continue;
                }

                // Extract message body text
                const text = msg.message?.conversation ||
                             msg.message?.extendedTextMessage?.text ||
                             msg.message?.imageMessage?.caption ||
                             msg.message?.videoMessage?.caption || '';

                console.log(`[Baileys Incoming] ${jid}: "${text}"`);

                // Save to live chat history
                recordIncomingMessage(jid, text, msg);

                // Handle automated flow execution
                if (clientReady) {
                    handleFlowForUser(jid, text);
                }
            }
        });

    } catch (err) {
        console.error('Baileys init error:', err);
        initStatus = 'error';
        initError = err.message || String(err);
        sock = null;
        setTimeout(initWhatsApp, 5000);
    }
}

// User Flow Execution State
const userStates = {}; // { jid: { currentStepIndex, status: 'running'|'waiting_reply'|'completed'|'paused', lastActive, waitTimeoutId } }
const SESSION_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

function recordIncomingMessage(jid, text, msg) {
    const rawNumber = jid.split('@')[0];
    const pushName = msg.pushName || rawNumber;

    if (!liveChats[jid]) {
        liveChats[jid] = {
            id: jid,
            name: pushName,
            phone: '+' + rawNumber,
            lastMessage: text || 'Mídia recebida',
            timestamp: Date.now(),
            unread: 1,
            botStatus: 'active',
            messages: []
        };
    } else {
        liveChats[jid].lastMessage = text || 'Mídia recebida';
        liveChats[jid].timestamp = Date.now();
        liveChats[jid].unread = (liveChats[jid].unread || 0) + 1;
        if (pushName && pushName !== rawNumber) liveChats[jid].name = pushName;
    }

    liveChats[jid].messages.push({
        id: msg.key.id || String(Date.now()),
        fromMe: false,
        text: text || '',
        timestamp: Date.now()
    });

    if (liveChats[jid].messages.length > 50) {
        liveChats[jid].messages.shift();
    }

    saveChats();
}

function recordOutgoingMessage(jid, text, mediaPath) {
    const rawNumber = jid.split('@')[0];
    if (!liveChats[jid]) {
        liveChats[jid] = {
            id: jid,
            name: rawNumber,
            phone: '+' + rawNumber,
            lastMessage: text || (mediaPath ? 'Mídia enviada' : ''),
            timestamp: Date.now(),
            unread: 0,
            botStatus: 'active',
            messages: []
        };
    } else {
        liveChats[jid].lastMessage = text || (mediaPath ? 'Mídia enviada' : '');
        liveChats[jid].timestamp = Date.now();
    }

    liveChats[jid].messages.push({
        id: String(Date.now()),
        fromMe: true,
        text: text || '',
        media: mediaPath || null,
        timestamp: Date.now()
    });

    if (liveChats[jid].messages.length > 50) {
        liveChats[jid].messages.shift();
    }

    saveChats();
}

async function handleFlowForUser(jid, incomingText) {
    const state = userStates[jid];

    // Check if user is manually paused or completed
    if (liveChats[jid] && liveChats[jid].botStatus === 'paused') {
        console.log(`Bot is paused for ${jid}. Ignoring automated reply.`);
        return;
    }

    // Session timeout check
    if (state && state.status !== 'completed' && state.status !== 'paused' && (Date.now() - state.lastActive > SESSION_TIMEOUT_MS)) {
        console.log(`Session timed out for ${jid}. Resetting.`);
        if (state.waitTimeoutId) clearTimeout(state.waitTimeoutId);
        delete userStates[jid];
    }

    const currentState = userStates[jid];

    if (currentState) {
        if (currentState.status === 'completed' || currentState.status === 'paused') {
            return;
        }

        if (currentState.status === 'waiting_reply') {
            console.log(`User ${jid} replied to question. Advancing flow to step ${currentState.currentStepIndex + 1}`);
            executeStep(jid, currentState.currentStepIndex + 1);
        }
    } else {
        // Start flow from beginning
        console.log(`Starting new flow for ${jid}`);
        executeStep(jid, 0);
    }
}

async function executeStep(jid, stepIndex) {
    const steps = botData.steps || [];

    // Clear any pending wait timer
    if (userStates[jid] && userStates[jid].waitTimeoutId) {
        clearTimeout(userStates[jid].waitTimeoutId);
    }

    // Check if flow finished
    if (stepIndex >= steps.length) {
        console.log(`Flow finished for ${jid}`);
        userStates[jid] = {
            currentStepIndex: steps.length,
            status: 'completed',
            lastActive: Date.now(),
            waitTimeoutId: null
        };
        return;
    }

    const step = steps[stepIndex];
    userStates[jid] = {
        currentStepIndex: stepIndex,
        status: 'running',
        lastActive: Date.now(),
        waitTimeoutId: null
    };

    console.log(`[Step ${stepIndex + 1}/${steps.length}] (${step.type}) -> ${jid}`);

    if (step.type === 'message') {
        await sendStepPayload(jid, step);
        executeStep(jid, stepIndex + 1);
    } else if (step.type === 'wait') {
        const delaySec = parseFloat(step.duration) || 2;
        const timeoutId = setTimeout(() => {
            executeStep(jid, stepIndex + 1);
        }, delaySec * 1000);
        userStates[jid].waitTimeoutId = timeoutId;
    } else if (step.type === 'question') {
        await sendStepPayload(jid, step);
        userStates[jid].status = 'waiting_reply';
        userStates[jid].lastActive = Date.now();
    }
}

async function sendStepPayload(jid, step) {
    if (!sock || !clientReady) return;

    try {
        // Natural human typing/recording delay
        const isAudio = step.media && (step.media.endsWith('.mp3') || step.media.endsWith('.ogg') || step.media.endsWith('.m4a') || step.media.endsWith('.wav'));
        
        if (isAudio) {
            await sock.sendPresenceUpdate('recording', jid);
        } else {
            await sock.sendPresenceUpdate('composing', jid);
        }

        const textLen = step.text ? step.text.length : 0;
        const typingDelayMs = Math.min(Math.max(textLen * 35, 1200), 4000);
        await delay(typingDelayMs);
        await sock.sendPresenceUpdate('paused', jid);

        if (step.media) {
            const mediaFullPath = path.join(__dirname, step.media);
            if (fs.existsSync(mediaFullPath)) {
                const ext = path.extname(mediaFullPath).toLowerCase();
                const buffer = fs.readFileSync(mediaFullPath);

                if (isAudio) {
                    // Send as WhatsApp Voice Note (PTT)
                    let mimetype = 'audio/mp4';
                    if (ext === '.ogg') mimetype = 'audio/ogg; codecs=opus';
                    else if (ext === '.mp3') mimetype = 'audio/mp3';
                    else if (ext === '.wav') mimetype = 'audio/wav';

                    await sock.sendMessage(jid, {
                        audio: buffer,
                        mimetype: mimetype,
                        ptt: true
                    });
                    recordOutgoingMessage(jid, '', step.media);
                } else if (['.jpg', '.jpeg', '.png', '.gif'].includes(ext)) {
                    await sock.sendMessage(jid, {
                        image: buffer,
                        caption: step.text || undefined
                    });
                    recordOutgoingMessage(jid, step.text || '', step.media);
                } else if (['.mp4', '.mov', '.avi'].includes(ext)) {
                    await sock.sendMessage(jid, {
                        video: buffer,
                        caption: step.text || undefined
                    });
                    recordOutgoingMessage(jid, step.text || '', step.media);
                } else {
                    await sock.sendMessage(jid, {
                        document: buffer,
                        mimetype: 'application/octet-stream',
                        fileName: path.basename(mediaFullPath),
                        caption: step.text || undefined
                    });
                    recordOutgoingMessage(jid, step.text || '', step.media);
                }
                return;
            }
        }

        if (step.text) {
            await sock.sendMessage(jid, { text: step.text });
            recordOutgoingMessage(jid, step.text, null);
        }
    } catch (err) {
        console.error(`Error sending step payload to ${jid}:`, err);
    }
}

// API Routes
app.get('/api/status', (req, res) => {
    res.json({
        ready: clientReady,
        qr: currentQR,
        status: initStatus,
        error: initError,
        user: connectedUser
    });
});

app.post('/api/disconnect', async (req, res) => {
    try {
        console.log('Baileys: User requested disconnection.');
        clientReady = false;
        currentQR = '';
        connectedUser = null;
        initStatus = 'disconnected';
        initError = '';

        if (sock) {
            try {
                await sock.logout();
            } catch (e) {}
            sock = null;
        }

        try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        } catch (e) {}

        setTimeout(initWhatsApp, 2000);
        res.json({ success: true, message: 'Bot desconectado com sucesso.' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/restart', async (req, res) => {
    try {
        console.log('Baileys: Restart requested.');
        clientReady = false;
        currentQR = '';
        connectedUser = null;
        initStatus = 'connecting';
        initError = '';

        if (sock) {
            try {
                sock.end();
            } catch (e) {}
            sock = null;
        }

        try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        } catch (e) {}

        setTimeout(initWhatsApp, 1500);
        res.json({ success: true, message: 'Reiniciando conexão...' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/data', (req, res) => {
    res.json(botData);
});

app.post('/api/save-steps', (req, res) => {
    const { steps } = req.body;
    if (Array.isArray(steps)) {
        botData.steps = steps;
        saveData();
        res.json({ success: true, steps: botData.steps });
    } else {
        res.status(400).json({ error: 'Steps must be an array' });
    }
});

app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }
    const relativePath = 'uploads/' + req.file.filename;
    res.json({ success: true, path: relativePath });
});

// Live Chat API
app.get('/api/chats', (req, res) => {
    const chatList = Object.values(liveChats).sort((a, b) => b.timestamp - a.timestamp);
    res.json({ success: true, chats: chatList });
});

app.get('/api/messages/:jid', (req, res) => {
    const jid = req.params.jid;
    const chat = liveChats[jid];
    if (chat) {
        chat.unread = 0;
        saveChats();
        res.json({ success: true, chat: chat });
    } else {
        res.status(404).json({ error: 'Chat not found' });
    }
});

app.post('/api/send', async (req, res) => {
    const { jid, message } = req.body;
    if (!jid || !message) {
        return res.status(400).json({ error: 'jid and message required' });
    }

    if (!sock || !clientReady) {
        return res.status(503).json({ error: 'WhatsApp is not connected' });
    }

    try {
        await sock.sendMessage(jid, { text: message });
        recordOutgoingMessage(jid, message, null);

        // Pause automated bot for this conversation so human can take over
        if (liveChats[jid]) {
            liveChats[jid].botStatus = 'paused';
            saveChats();
        }
        if (userStates[jid]) {
            userStates[jid].status = 'paused';
        }

        res.json({ success: true });
    } catch (err) {
        console.error('Error sending manual message:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/bot-toggle/:jid', (req, res) => {
    const jid = req.params.jid;
    if (!liveChats[jid]) {
        return res.status(404).json({ error: 'Chat not found' });
    }
    const current = liveChats[jid].botStatus || 'active';
    const nextStatus = current === 'active' ? 'paused' : 'active';
    liveChats[jid].botStatus = nextStatus;

    if (userStates[jid]) {
        userStates[jid].status = nextStatus === 'paused' ? 'paused' : 'running';
    }
    saveChats();
    res.json({ success: true, botStatus: nextStatus });
});

// SMS-Activate Virtual Number Integrations (Kept intact)
const CONFIG_FILE = path.join(__dirname, 'config.json');
function getSmsActivateKey() {
    if (process.env.SMS_ACTIVATE_KEY) return process.env.SMS_ACTIVATE_KEY;
    if (fs.existsSync(CONFIG_FILE)) {
        try {
            const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
            return config.SMS_ACTIVATE_KEY;
        } catch (e) {}
    }
    return null;
}

function smsApiRequest(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => resolve(data.trim()));
        }).on('error', (err) => reject(err));
    });
}

app.get('/api/virtual-numbers/status', async (req, res) => {
    const apiKey = getSmsActivateKey();
    if (!apiKey || apiKey === 'YOUR_API_KEY_HERE') {
        return res.json({ success: false, hasKey: false, error: 'Chave API não configurada.' });
    }
    try {
        const url = `https://api.sms-activate.org/stubs/handler_api.php?api_key=${apiKey}&action=getBalance`;
        const response = await smsApiRequest(url);
        if (response.startsWith('ACCESS_BALANCE:')) {
            const balance = parseFloat(response.split(':')[1]);
            const maskedKey = apiKey.substring(0, 4) + '...' + apiKey.substring(apiKey.length - 4);
            return res.json({ success: true, hasKey: true, apiKey: maskedKey, balance: balance });
        }
        res.json({ success: false, hasKey: true, error: response });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

app.listen(PORT, HOST, () => {
    console.log(`Umbler Talk Bot Server running on http://${HOST}:${PORT}`);
    initWhatsApp();
});
