const express = require('express');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers,
    delay
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const https = require('https');
const { exec } = require('child_process');
const crypto = require('crypto');

// Security & Anti-Clone Configuration (PIN 201707)
const ACCESS_PIN = process.env.ACCESS_PIN || '201707';
const AUTH_SECRET = process.env.AUTH_SECRET || 'umbler-talk-anti-clone-secret-key-201707';
const VALID_TOKEN = crypto.createHmac('sha256', AUTH_SECRET).update(ACCESS_PIN).digest('hex');

// Anti-brute force store: { ip: { count, lockedUntil } }
const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const LOCKOUT_TIME_MS = 15 * 60 * 1000; // 15 minutos

function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();
    return req.socket?.remoteAddress || req.ip || 'unknown';
}

function checkAuth(req, res, next) {
    const token = req.headers['x-access-token'] || req.query.token;
    if (token === VALID_TOKEN) {
        return next();
    }
    return res.status(401).json({ error: 'Acesso negado: Autenticação necessária.' });
}

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

// WhatsApp Voice Note (PTT) Audio Converter
// WhatsApp strictly requires OGG container with Opus codec at 48000Hz mono.
// Uses -avoid_negative_ts make_zero to fix stream timestamps so WhatsApp client downloads cleanly.
function convertToWhatsAppOpus(inputPath) {
    return new Promise((resolve) => {
        if (!fs.existsSync(inputPath)) {
            return resolve({ path: inputPath, seconds: 0 });
        }

        const dir = path.dirname(inputPath);
        const ext = path.extname(inputPath);
        const base = path.basename(inputPath, ext);
        const outputPath = path.join(dir, `${base}_v2_wa_opus.ogg`);

        if (fs.existsSync(outputPath)) {
            try {
                const stats = fs.statSync(outputPath);
                if (stats.size > 1000) {
                    const probeCmd = `ffprobe -i "${outputPath}" -show_entries format=duration -v quiet -of csv="p=0"`;
                    return exec(probeCmd, (probeErr, probeOut) => {
                        const dur = Math.max(Math.round(parseFloat(probeOut) || 0), 1);
                        resolve({ path: outputPath, seconds: dur });
                    });
                }
            } catch (e) {}
        }

        const cmd = `ffmpeg -y -i "${inputPath}" -vn -c:a libopus -b:a 64k -ar 48000 -ac 1 -af asetpts=N/SR/TB -f ogg "${outputPath}"`;
        console.log(`[FFmpeg] Converting audio for WhatsApp Opus PTT: ${inputPath} -> ${outputPath}`);

        exec(cmd, (err, stdout, stderr) => {
            if (err) {
                console.error(`[FFmpeg Error] Audio conversion failed for ${inputPath}:`, err.message);
                resolve({ path: inputPath, seconds: 0 });
            } else {
                console.log(`[FFmpeg Success] Audio successfully converted to WhatsApp Opus: ${outputPath}`);
                const probeCmd = `ffprobe -i "${outputPath}" -show_entries format=duration -v quiet -of csv="p=0"`;
                exec(probeCmd, (probeErr, probeOut) => {
                    const dur = Math.max(Math.round(parseFloat(probeOut) || 0), 1);
                    resolve({ path: outputPath, seconds: dur });
                });
            }
        });
    });
}

function generateWaveform() {
    const samples = 64;
    const wave = new Uint8Array(samples);
    for (let i = 0; i < samples; i++) {
        const val = Math.floor(25 + 55 * Math.abs(Math.sin((i / samples) * Math.PI * 3)) + Math.random() * 15);
        wave[i] = Math.min(100, Math.max(10, val));
    }
    return wave;
}

function convertToUniversalAudio(inputPath, targetFormat = 'mp3') {
    return new Promise((resolve) => {
        if (!fs.existsSync(inputPath)) return resolve({ path: inputPath, seconds: 0, mimetype: 'audio/mpeg' });
        const dir = path.dirname(inputPath);
        const ext = path.extname(inputPath);
        const base = path.basename(inputPath, ext);
        const outExt = targetFormat === 'm4a' ? '.m4a' : '.mp3';
        const outputPath = path.join(dir, `${base}_universal${outExt}`);
        const mimetype = targetFormat === 'm4a' ? 'audio/mp4' : 'audio/mpeg';

        if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000) {
            const probeCmd = `ffprobe -i "${outputPath}" -show_entries format=duration -v quiet -of csv="p=0"`;
            return exec(probeCmd, (probeErr, probeOut) => {
                const dur = Math.max(Math.round(parseFloat(probeOut) || 0), 1);
                resolve({ path: outputPath, seconds: dur, mimetype });
            });
        }

        const codec = targetFormat === 'm4a' ? '-c:a aac -b:a 128k' : '-c:a libmp3lame -b:a 128k';
        const cmd = `ffmpeg -y -i "${inputPath}" -vn ${codec} -ar 44100 "${outputPath}"`;
        console.log(`[FFmpeg Universal Audio] Converting ${inputPath} -> ${outputPath}`);

        exec(cmd, (err) => {
            if (err) {
                console.error(`Audio conversion to ${targetFormat} failed for ${inputPath}:`, err.message);
                resolve({ path: inputPath, seconds: 0, mimetype: 'audio/mpeg' });
            } else {
                console.log(`[FFmpeg Universal Audio] Converted successfully: ${outputPath}`);
                const probeCmd = `ffprobe -i "${outputPath}" -show_entries format=duration -v quiet -of csv="p=0"`;
                exec(probeCmd, (probeErr, probeOut) => {
                    const dur = Math.max(Math.round(parseFloat(probeOut) || 0), 1);
                    resolve({ path: outputPath, seconds: dur, mimetype });
                });
            }
        });
    });
}

async function preConvertAudios() {
    try {
        const steps = botData.steps || [];
        for (const step of steps) {
            if (step.media) {
                const ext = path.extname(step.media).toLowerCase();
                if (['.ogg', '.mp3', '.m4a', '.wav', '.aac', '.wma'].includes(ext)) {
                    const fullPath = path.join(__dirname, step.media);
                    if (fs.existsSync(fullPath)) {
                        await convertToWhatsAppOpus(fullPath);
                    }
                }
            }
        }
    } catch (e) {
        console.error('Error during audio pre-conversion:', e);
    }
}

// Pre-convert audios on startup in background
setTimeout(preConvertAudios, 2000);

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

// WhatsApp Multi-Instance State Manager (Linha 1 & Linha 2)
const logger = pino({ level: 'silent' });

const instances = {
    '1': {
        id: '1',
        name: 'Linha 1',
        authDir: path.join(__dirname, 'auth_info_baileys_1'),
        sock: null,
        currentQR: '',
        clientReady: false,
        initStatus: 'disconnected',
        initError: '',
        connectedUser: null,
        readyTimestamp: Math.floor(Date.now() / 1000),
        isInitializing: false,
        consecutiveDisconnects: 0
    },
    '2': {
        id: '2',
        name: 'Linha 2',
        authDir: path.join(__dirname, 'auth_info_baileys_2'),
        sock: null,
        currentQR: '',
        clientReady: false,
        initStatus: 'disconnected',
        initError: '',
        connectedUser: null,
        readyTimestamp: Math.floor(Date.now() / 1000),
        isInitializing: false,
        consecutiveDisconnects: 0
    }
};

// Auto-migrate legacy auth_info_baileys to Linha 1 if present
const LEGACY_AUTH_DIR = path.join(__dirname, 'auth_info_baileys');
if (fs.existsSync(LEGACY_AUTH_DIR) && !fs.existsSync(instances['1'].authDir)) {
    try {
        fs.cpSync(LEGACY_AUTH_DIR, instances['1'].authDir, { recursive: true });
        console.log('Migrated legacy auth_info_baileys to Linha 1 auth directory.');
    } catch (e) {
        console.error('Migration failed:', e);
    }
}

function cleanCloseSock(instId) {
    const inst = instances[instId];
    if (inst && inst.sock) {
        try {
            inst.sock.ev.removeAllListeners('connection.update');
            inst.sock.ev.removeAllListeners('creds.update');
            inst.sock.ev.removeAllListeners('messages.upsert');
            inst.sock.end(undefined);
        } catch (e) {}
        inst.sock = null;
    }
}

async function initWhatsApp(instId = '1') {
    const inst = instances[instId];
    if (!inst) return;

    if (inst.isInitializing) {
        console.log(`Baileys [Linha ${instId}]: Already initializing. Skipping duplicate call.`);
        return;
    }
    if (inst.sock && inst.clientReady) {
        console.log(`Baileys [Linha ${instId}]: Client is already connected.`);
        return;
    }

    inst.isInitializing = true;
    console.log(`Baileys [Linha ${instId}]: Initializing connection...`);
    inst.initStatus = 'connecting';
    inst.initError = '';

    try {
        if (!fs.existsSync(inst.authDir)) {
            fs.mkdirSync(inst.authDir, { recursive: true });
        }

        const { state, saveCreds } = await useMultiFileAuthState(inst.authDir);
        const { version, isLatest } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307], isLatest: true }));

        console.log(`Baileys [Linha ${instId}]: Using WA version v${version.join('.')}, isLatest: ${isLatest}`);

        cleanCloseSock(instId);

        inst.sock = makeWASocket({
            version,
            logger,
            printQRInTerminal: false,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger)
            },
            browser: instId === '1' ? Browsers.macOS('Desktop') : Browsers.ubuntu('Chrome'),
            generateHighQualityLinkPreview: true,
            syncFullHistory: false,
            keepAliveIntervalMs: 25000,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            retryRequestDelayMs: 500,
            maxMsgRetryCount: 5
        });

        inst.sock.ev.on('creds.update', saveCreds);

        inst.sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log(`Baileys [Linha ${instId}]: New QR Code received.`);
                inst.initStatus = 'waiting_qr';
                inst.consecutiveDisconnects = 0;
                qrcode.toDataURL(qr, (err, url) => {
                    if (!err) {
                        inst.currentQR = url;
                    } else {
                        console.error(`Error generating QR URL for Linha ${instId}:`, err);
                    }
                });
            }

            if (connection === 'close') {
                inst.consecutiveDisconnects++;
                const statusCode = (lastDisconnect?.error)?.output?.statusCode || (lastDisconnect?.error)?.statusCode;
                const errorMsg = lastDisconnect?.error?.message || String(lastDisconnect?.error || '');
                const isLoggedOut = statusCode === DisconnectReason.loggedOut;
                console.log(`Baileys [Linha ${instId}]: Connection closed. Status: ${statusCode || 'unknown'} (${errorMsg}). LoggedOut: ${isLoggedOut}. Disconnects: ${inst.consecutiveDisconnects}`);

                inst.clientReady = false;
                cleanCloseSock(instId);

                // ONLY clear session if WhatsApp explicitly reports loggedOut (401) or forbidden (403)
                const isExplicitLogout = isLoggedOut || statusCode === 401 || statusCode === 403;

                if (isExplicitLogout) {
                    console.log(`Baileys [Linha ${instId}]: Logged out by WhatsApp. Removing session files.`);
                    inst.connectedUser = null;
                    inst.initStatus = 'waiting_qr';
                    inst.initError = 'Dispositivo desconectado pelo WhatsApp. Escaneie novo QR Code.';
                    inst.consecutiveDisconnects = 0;
                    inst.currentQR = '';
                    try {
                        fs.rmSync(inst.authDir, { recursive: true, force: true });
                    } catch (e) {}
                    setTimeout(() => initWhatsApp(instId), 1500);
                } else {
                    // Normal disconnect, restart required (515) or network blip - reconnect using existing creds!
                    const isRestartRequired = statusCode === DisconnectReason.restartRequired || statusCode === 515;
                    const delayMs = isRestartRequired ? 1000 : Math.min(inst.consecutiveDisconnects * 2000, 10000);
                    console.log(`Baileys [Linha ${instId}]: Reconnecting in ${delayMs}ms (Reason: ${statusCode || errorMsg}, RestartRequired: ${isRestartRequired})...`);
                    inst.initStatus = 'connecting';
                    inst.initError = 'Reconectando ao WhatsApp...';
                    setTimeout(() => initWhatsApp(instId), delayMs);
                }
            } else if (connection === 'open') {
                console.log(`Baileys [Linha ${instId}]: Connected successfully!`);
                inst.clientReady = true;
                inst.consecutiveDisconnects = 0;
                inst.initStatus = 'ready';
                inst.currentQR = '';
                inst.initError = '';
                inst.readyTimestamp = Math.floor(Date.now() / 1000);

                const rawId = inst.sock.user?.id || '';
                const phone = rawId.split(':')[0] || rawId.split('@')[0];
                inst.connectedUser = {
                    id: rawId,
                    phone: '+' + phone,
                    name: inst.sock.user?.name || phone
                };
            }
        });

        // Messages handling
        inst.sock.ev.on('messages.upsert', async (m) => {
            try {
                if (m.type !== 'notify') return;

                for (const msg of m.messages) {
                    try {
                        if (msg.key.fromMe) continue;

                        const jid = msg.key.remoteJid;
                        if (!jid || jid.endsWith('@g.us') || jid.includes('status@broadcast')) continue;

                        const msgTimestamp = Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000);
                        if (msgTimestamp < inst.readyTimestamp) {
                            continue;
                        }

                        const text = msg.message?.conversation ||
                                     msg.message?.extendedTextMessage?.text ||
                                     msg.message?.imageMessage?.caption ||
                                     msg.message?.videoMessage?.caption || '';

                        const incomingContent = text || (
                            msg.message?.audioMessage ? '[Áudio recebido]' :
                            msg.message?.imageMessage ? '[Imagem recebida]' :
                            msg.message?.videoMessage ? '[Vídeo recebido]' :
                            msg.message?.documentMessage ? '[Documento recebido]' :
                            msg.message?.stickerMessage ? '[Figurinha]' : '[Mensagem]'
                        );

                        console.log(`[Baileys Linha ${instId}] ${jid}: "${text || incomingContent}"`);

                        recordIncomingMessage(instId, jid, text || incomingContent, msg);

                        if (inst.clientReady) {
                            await handleFlowForUser(instId, jid, text || incomingContent);
                        }
                    } catch (msgErr) {
                        console.error(`[Baileys Linha ${instId}] Error handling single message:`, msgErr);
                    }
                }
            } catch (err) {
                console.error(`[Baileys Linha ${instId}] Error in messages.upsert:`, err);
            }
        });

    } catch (err) {
        console.error(`Baileys [Linha ${instId}] init error:`, err);
        inst.initStatus = 'error';
        inst.initError = err.message || String(err);
        cleanCloseSock(instId);
        setTimeout(() => initWhatsApp(instId), 5000);
    } finally {
        inst.isInitializing = false;
    }
}

// User Flow Execution State & Disk Persistence
const STATES_FILE = path.join(__dirname, 'user_states.json');
let userStates = {}; // { 'instId:jid': { instanceId, jid, currentStepIndex, status, lastActive, answers, pendingReply, waitTimeoutId } }
const userLocks = new Set(); // Prevent concurrent step execution for same user & line

function loadUserStates() {
    if (fs.existsSync(STATES_FILE)) {
        try {
            const raw = JSON.parse(fs.readFileSync(STATES_FILE, 'utf-8'));
            for (const key in raw) {
                const parts = key.includes(':') ? key.split(':') : ['1', key];
                userStates[key] = {
                    instanceId: raw[key].instanceId || parts[0],
                    jid: raw[key].jid || parts[1],
                    currentStepIndex: typeof raw[key].currentStepIndex === 'number' ? raw[key].currentStepIndex : 0,
                    status: raw[key].status || 'running',
                    lastActive: raw[key].lastActive || Date.now(),
                    answers: raw[key].answers || {},
                    pendingReply: null,
                    waitTimeoutId: null
                };
            }
            console.log(`[Baileys Flow] Carregados ${Object.keys(userStates).length} estados de utilizadores.`);
        } catch (e) {
            console.error('Error loading user_states.json:', e);
            userStates = {};
        }
    }
}

function saveUserStates() {
    try {
        const clean = {};
        for (const key in userStates) {
            clean[key] = {
                instanceId: userStates[key].instanceId,
                jid: userStates[key].jid,
                currentStepIndex: userStates[key].currentStepIndex,
                status: userStates[key].status,
                lastActive: userStates[key].lastActive,
                answers: userStates[key].answers || {}
            };
        }
        fs.writeFileSync(STATES_FILE, JSON.stringify(clean, null, 2));
    } catch (e) {
        console.error('Error saving user_states.json:', e);
    }
}

loadUserStates();

function recordIncomingMessage(instId, jid, text, msg) {
    const rawNumber = jid.split('@')[0];
    const pushName = msg.pushName || rawNumber;
    const chatKey = `${instId}:${jid}`;
    const instName = instId === '1' ? 'Linha 1' : 'Linha 2';

    if (!liveChats[chatKey]) {
        liveChats[chatKey] = {
            id: chatKey,
            jid: jid,
            instanceId: instId,
            instanceName: instName,
            name: pushName,
            phone: '+' + rawNumber,
            lastMessage: text || 'Mídia recebida',
            timestamp: Date.now(),
            unread: 1,
            botStatus: 'active',
            messages: []
        };
    } else {
        liveChats[chatKey].lastMessage = text || 'Mídia recebida';
        liveChats[chatKey].timestamp = Date.now();
        liveChats[chatKey].unread = (liveChats[chatKey].unread || 0) + 1;
        liveChats[chatKey].instanceId = instId;
        liveChats[chatKey].instanceName = instName;
        if (pushName && pushName !== rawNumber) liveChats[chatKey].name = pushName;
    }

    liveChats[chatKey].messages.push({
        id: msg.key.id || String(Date.now()),
        fromMe: false,
        text: text || '',
        timestamp: Date.now()
    });

    if (liveChats[chatKey].messages.length > 50) {
        liveChats[chatKey].messages.shift();
    }

    saveChats();
}

function recordOutgoingMessage(instId, jid, text, mediaPath) {
    const rawNumber = jid.split('@')[0];
    const chatKey = `${instId}:${jid}`;
    const instName = instId === '1' ? 'Linha 1' : 'Linha 2';

    if (!liveChats[chatKey]) {
        liveChats[chatKey] = {
            id: chatKey,
            jid: jid,
            instanceId: instId,
            instanceName: instName,
            name: rawNumber,
            phone: '+' + rawNumber,
            lastMessage: text || (mediaPath ? 'Mídia enviada' : ''),
            timestamp: Date.now(),
            unread: 0,
            botStatus: 'active',
            messages: []
        };
    } else {
        liveChats[chatKey].lastMessage = text || (mediaPath ? 'Mídia enviada' : '');
        liveChats[chatKey].timestamp = Date.now();
        liveChats[chatKey].instanceId = instId;
        liveChats[chatKey].instanceName = instName;
    }

    liveChats[chatKey].messages.push({
        id: String(Date.now()),
        fromMe: true,
        text: text || '',
        media: mediaPath || null,
        timestamp: Date.now()
    });

    if (liveChats[chatKey].messages.length > 50) {
        liveChats[chatKey].messages.shift();
    }

    saveChats();
}

async function handleFlowForUser(instId, jid, incomingText) {
    const rawText = (incomingText || '').trim();
    const chatKey = `${instId}:${jid}`;
    const inst = instances[instId] || instances['1'];

    // Check for user manual reset command
    if (rawText.toLowerCase() === '#reset' || rawText.toLowerCase() === '#reiniciar') {
        console.log(`[Baileys Flow L${instId}] User ${jid} sent reset command: ${rawText}`);
        if (userStates[chatKey]?.waitTimeoutId) {
            clearTimeout(userStates[chatKey].waitTimeoutId);
        }
        delete userStates[chatKey];
        saveUserStates();
        if (liveChats[chatKey]) {
            liveChats[chatKey].botStatus = 'active';
            saveChats();
        }
        if (inst.sock && inst.clientReady) {
            await inst.sock.sendMessage(jid, {
                text: '🔄 O seu fluxo foi reiniciado com sucesso!\nEnvie qualquer mensagem para começar novamente.'
            });
        }
        return;
    }

    // Check if user is manually paused by an operator in Live Chat
    if (liveChats[chatKey] && liveChats[chatKey].botStatus === 'paused') {
        console.log(`[Baileys Flow L${instId}] Bot is paused for ${jid}. Operator active. Automated reply ignored.`);
        return;
    }

    const state = userStates[chatKey];

    // If flow is already completed for this user, do not loop
    if (state && state.status === 'completed') {
        console.log(`[Baileys Flow L${instId}] User ${jid} already completed the flow. Ignoring automated loop.`);
        return;
    }

    // If currently paused in state
    if (state && state.status === 'paused') {
        return;
    }

    // If the question is currently transmitting, buffer this reply
    if (state && state.status === 'sending_question') {
        console.log(`[Baileys Flow L${instId}] User ${jid} replied while question was transmitting. Buffering reply: "${rawText}"`);
        state.pendingReply = rawText || '[Resposta]';
        saveUserStates();
        return;
    }

    // If waiting for reply to a question -> user answered! Advance to next step
    if (state && state.status === 'waiting_reply') {
        console.log(`[Baileys Flow L${instId}] User ${jid} answered question step ${state.currentStepIndex + 1}: "${rawText}". Advancing to step ${state.currentStepIndex + 2}...`);
        if (!state.answers) state.answers = {};
        state.answers[state.currentStepIndex] = rawText || '[Resposta]';
        state.status = 'running';
        state.lastActive = Date.now();
        state.pendingReply = null;
        saveUserStates();

        await executeStep(instId, jid, state.currentStepIndex + 1);
        return;
    }

    // If already actively running a step or in a wait delay
    if (state && state.status === 'running') {
        console.log(`[Baileys Flow L${instId}] Flow is already active for ${jid} at step ${state.currentStepIndex + 1}. Message noted.`);
        return;
    }

    // New conversation -> start from step 0
    console.log(`[Baileys Flow L${instId}] Starting new automated funnel for ${jid}`);
    await executeStep(instId, jid, 0);
}

async function executeStep(instId, jid, stepIndex) {
    const chatKey = `${instId}:${jid}`;
    // Concurrency lock per user & line
    if (userLocks.has(chatKey)) {
        console.log(`[Baileys Lock] Step execution currently active for ${chatKey}, queuing step ${stepIndex}`);
        setTimeout(() => executeStep(instId, jid, stepIndex), 800);
        return;
    }
    userLocks.add(chatKey);

    try {
        const steps = botData.steps || [];

        // Clear any pending wait timer
        if (userStates[chatKey]?.waitTimeoutId) {
            clearTimeout(userStates[chatKey].waitTimeoutId);
            userStates[chatKey].waitTimeoutId = null;
        }

        // Check if finished
        if (stepIndex >= steps.length) {
            console.log(`[Baileys Flow L${instId}] Flow completed for ${jid}`);
            userStates[chatKey] = {
                instanceId: instId,
                jid: jid,
                currentStepIndex: steps.length,
                status: 'completed',
                lastActive: Date.now(),
                answers: userStates[chatKey]?.answers || {},
                waitTimeoutId: null
            };
            saveUserStates();
            return;
        }

        const step = steps[stepIndex];
        console.log(`[Baileys Step ${stepIndex + 1}/${steps.length}] (${step.type}) -> [L${instId}] ${jid}`);

        if (step.type === 'message') {
            userStates[chatKey] = {
                instanceId: instId,
                jid: jid,
                currentStepIndex: stepIndex,
                status: 'running',
                lastActive: Date.now(),
                answers: userStates[chatKey]?.answers || {},
                waitTimeoutId: null
            };
            saveUserStates();

            await sendStepPayload(instId, jid, step);

            if (userStates[chatKey] && userStates[chatKey].status === 'running' && liveChats[chatKey]?.botStatus !== 'paused') {
                userLocks.delete(chatKey);
                return executeStep(instId, jid, stepIndex + 1);
            }
        } else if (step.type === 'wait') {
            userStates[chatKey] = {
                instanceId: instId,
                jid: jid,
                currentStepIndex: stepIndex,
                status: 'running',
                lastActive: Date.now(),
                answers: userStates[chatKey]?.answers || {},
                waitTimeoutId: null
            };
            saveUserStates();

            const delaySec = Math.max(parseFloat(step.duration) || 2, 1);
            console.log(`[Baileys Wait L${instId}] Step ${stepIndex + 1}: Waiting ${delaySec}s before step ${stepIndex + 2} for ${jid}...`);

            const timeoutId = setTimeout(() => {
                if (userStates[chatKey] && userStates[chatKey].status === 'running' && liveChats[chatKey]?.botStatus !== 'paused') {
                    executeStep(instId, jid, stepIndex + 1);
                }
            }, delaySec * 1000);
            userStates[chatKey].waitTimeoutId = timeoutId;
        } else if (step.type === 'question') {
            userStates[chatKey] = {
                instanceId: instId,
                jid: jid,
                currentStepIndex: stepIndex,
                status: 'sending_question',
                lastActive: Date.now(),
                answers: userStates[chatKey]?.answers || {},
                pendingReply: null,
                waitTimeoutId: null
            };
            saveUserStates();

            await sendStepPayload(instId, jid, step);

            if (userStates[chatKey] && liveChats[chatKey]?.botStatus !== 'paused') {
                if (userStates[chatKey].pendingReply) {
                    const buffered = userStates[chatKey].pendingReply;
                    console.log(`[Baileys Flow L${instId}] User ${jid} had buffered reply: "${buffered}". Advancing to step ${stepIndex + 1}`);
                    userStates[chatKey].answers[stepIndex] = buffered;
                    userStates[chatKey].pendingReply = null;
                    userStates[chatKey].status = 'running';
                    userStates[chatKey].lastActive = Date.now();
                    saveUserStates();

                    userLocks.delete(chatKey);
                    return executeStep(instId, jid, stepIndex + 1);
                } else {
                    userStates[chatKey].status = 'waiting_reply';
                    userStates[chatKey].lastActive = Date.now();
                    saveUserStates();
                    console.log(`🛑 [Baileys Question L${instId}] Step ${stepIndex + 1} PAUSED. Bot waiting for user ${jid} reply.`);
                }
            }
        }
    } catch (err) {
        console.error(`Error in executeStep for [L${instId}] ${jid}:`, err);
    } finally {
        userLocks.delete(chatKey);
    }
}

async function sendStepPayload(instId, jid, step) {
    const inst = instances[instId] || instances['1'];
    if (!inst.sock || !inst.clientReady) return;
    const sock = inst.sock;

    try {
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

        let mediaSent = false;
        if (step.media) {
            const mediaFullPath = path.join(__dirname, step.media);
            if (fs.existsSync(mediaFullPath)) {
                const ext = path.extname(mediaFullPath).toLowerCase();
                const buffer = fs.readFileSync(mediaFullPath);

                if (isAudio) {
                    const audioInfo = await convertToUniversalAudio(mediaFullPath, 'm4a');
                    const audioBuffer = fs.readFileSync(audioInfo.path);
                    const wave = generateWaveform();

                    await sock.sendMessage(jid, {
                        audio: audioBuffer,
                        mimetype: 'audio/mp4',
                        ptt: true,
                        seconds: audioInfo.seconds > 0 ? audioInfo.seconds : undefined,
                        waveform: wave
                    });
                    recordOutgoingMessage(instId, jid, '', step.media);
                    mediaSent = true;
                } else if (['.jpg', '.jpeg', '.png', '.gif'].includes(ext)) {
                    await sock.sendMessage(jid, {
                        image: buffer,
                        caption: step.text || undefined
                    });
                    recordOutgoingMessage(instId, jid, step.text || '', step.media);
                    mediaSent = true;
                    return;
                } else if (['.mp4', '.mov', '.avi'].includes(ext)) {
                    try {
                        console.log(`[Baileys Video L${instId}] Sending video to ${jid} (${step.media})`);
                        await sock.sendMessage(jid, {
                            video: buffer,
                            mimetype: 'video/mp4',
                            caption: step.text || undefined
                        });
                        recordOutgoingMessage(instId, jid, step.text || '', step.media);
                        mediaSent = true;
                        return;
                    } catch (vidErr) {
                        console.error(`[Baileys Video Error] Failed to send native video, falling back to document:`, vidErr);
                        await sock.sendMessage(jid, {
                            document: buffer,
                            mimetype: 'video/mp4',
                            fileName: path.basename(mediaFullPath),
                            caption: step.text || undefined
                        });
                        recordOutgoingMessage(instId, jid, step.text || '', step.media);
                        mediaSent = true;
                        return;
                    }
                } else {
                    await sock.sendMessage(jid, {
                        document: buffer,
                        mimetype: 'application/octet-stream',
                        fileName: path.basename(mediaFullPath),
                        caption: step.text || undefined
                    });
                    recordOutgoingMessage(instId, jid, step.text || '', step.media);
                    mediaSent = true;
                    return;
                }
            }
        }

        if (step.text && (!mediaSent || isAudio)) {
            await sock.sendMessage(jid, { text: step.text });
            recordOutgoingMessage(instId, jid, step.text, null);
        }
    } catch (err) {
        console.error(`Error sending step payload to [L${instId}] ${jid}:`, err);
    }
}

// API Routes
app.post('/api/verify-pin', (req, res) => {
    const ip = getClientIp(req);
    const now = Date.now();
    const record = loginAttempts.get(ip) || { count: 0, lockedUntil: 0 };

    if (record.lockedUntil && now < record.lockedUntil) {
        const remainingMin = Math.ceil((record.lockedUntil - now) / 60000);
        return res.status(429).json({ 
            error: `Muitas tentativas incorretas. Acesso bloqueado por segurança por mais ${remainingMin} minuto(s).` 
        });
    }

    const { pin } = req.body || {};
    if (pin && String(pin).trim() === ACCESS_PIN) {
        loginAttempts.delete(ip);
        return res.json({ success: true, token: VALID_TOKEN });
    }

    record.count = (record.count || 0) + 1;
    if (record.count >= MAX_ATTEMPTS) {
        record.lockedUntil = now + LOCKOUT_TIME_MS;
        loginAttempts.set(ip, record);
        return res.status(429).json({ 
            error: 'Número máximo de tentativas excedido. Bloqueado por 15 minutos.' 
        });
    }

    loginAttempts.set(ip, record);
    const remaining = MAX_ATTEMPTS - record.count;
    return res.status(401).json({ 
        error: `PIN incorreto. Você tem mais ${remaining} tentativa(s) antes do bloqueio temporário.` 
    });
});

app.get('/api/status', (req, res) => {
    const token = req.headers['x-access-token'] || req.query.token;
    if (token !== VALID_TOKEN) {
        return res.json({
            locked: true,
            ready: false,
            status: 'locked'
        });
    }

    const inst1 = instances['1'];
    const inst2 = instances['2'];

    res.json({
        ready: inst1.clientReady || inst2.clientReady,
        qr: inst1.currentQR || inst2.currentQR,
        status: inst1.initStatus,
        error: inst1.initError,
        user: inst1.connectedUser,
        instances: {
            '1': {
                id: '1',
                name: 'Linha 1',
                ready: inst1.clientReady,
                qr: inst1.currentQR,
                status: inst1.initStatus,
                error: inst1.initError,
                user: inst1.connectedUser
            },
            '2': {
                id: '2',
                name: 'Linha 2',
                ready: inst2.clientReady,
                qr: inst2.currentQR,
                status: inst2.initStatus,
                error: inst2.initError,
                user: inst2.connectedUser
            }
        }
    });
});

app.get('/api/test-audio', checkAuth, async (req, res) => {
    const file = req.query.file || 'uploads/1791248087020.ogg';
    const fullPath = path.join(__dirname, file);
    try {
        const result = await convertToWhatsAppOpus(fullPath);
        res.json({
            success: true,
            file,
            result,
            exists: fs.existsSync(result.path),
            size: fs.existsSync(result.path) ? fs.statSync(result.path).size : 0
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/send-test-audio', checkAuth, async (req, res) => {
    try {
        const instId = String(req.query.instance || '1');
        const inst = instances[instId] || instances['1'];
        if (!inst.sock || !inst.clientReady) {
            return res.status(400).json({ error: `WhatsApp (${inst.name}) não está conectado` });
        }
        let jid = req.query.jid;
        if (!jid && inst.connectedUser?.id) {
            jid = inst.connectedUser.id;
        }
        if (!jid) {
            return res.status(400).json({ error: 'JID de destino não especificado' });
        }
        const file = req.query.file || 'uploads/1791251073918.ogg';
        const fullPath = path.join(__dirname, file);
        const format = req.query.format || 'm4a'; // 'm4a', 'mp3', 'ptt'
        const isPtt = req.query.ptt === 'false' ? false : true;

        let sent;
        if (format === 'ptt') {
            const audioInfo = await convertToWhatsAppOpus(fullPath);
            const buf = fs.readFileSync(audioInfo.path);
            const wave = generateWaveform();
            sent = await inst.sock.sendMessage(jid, {
                audio: buf,
                mimetype: 'audio/ogg; codecs=opus',
                ptt: true,
                seconds: audioInfo.seconds > 0 ? audioInfo.seconds : undefined,
                waveform: wave
            });
            res.json({ success: true, jid, format: 'ptt', ptt: true, file: audioInfo.path, duration: audioInfo.seconds, messageId: sent?.key?.id, instance: instId });
        } else {
            const targetFormat = format === 'mp3' ? 'mp3' : 'm4a';
            const audioInfo = await convertToUniversalAudio(fullPath, targetFormat);
            const buf = fs.readFileSync(audioInfo.path);
            const wave = generateWaveform();
            sent = await inst.sock.sendMessage(jid, {
                audio: buf,
                mimetype: targetFormat === 'm4a' ? 'audio/mp4' : 'audio/mpeg',
                ptt: isPtt,
                seconds: audioInfo.seconds > 0 ? audioInfo.seconds : undefined,
                waveform: wave
            });
            res.json({ success: true, jid, format: targetFormat, ptt: isPtt, file: audioInfo.path, duration: audioInfo.seconds, messageId: sent?.key?.id, instance: instId });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/disconnect', checkAuth, async (req, res) => {
    try {
        const instId = String(req.query.instance || req.body?.instance || '1');
        const inst = instances[instId];
        if (inst) {
            console.log(`Baileys [Linha ${instId}]: User requested disconnection.`);
            inst.clientReady = false;
            inst.currentQR = '';
            inst.connectedUser = null;
            inst.initStatus = 'disconnected';
            inst.initError = '';

            cleanCloseSock(instId);

            try {
                fs.rmSync(inst.authDir, { recursive: true, force: true });
            } catch (e) {}

            setTimeout(() => initWhatsApp(instId), 2000);
        }
        res.json({ success: true, message: `Linha ${instId} desconectada com sucesso.` });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/restart', checkAuth, async (req, res) => {
    try {
        const instId = String(req.query.instance || req.body?.instance || 'all');
        const targetIds = instId === 'all' ? ['1', '2'] : [instId];

        for (const id of targetIds) {
            const inst = instances[id];
            if (!inst) continue;
            console.log(`Baileys [Linha ${id}]: Reconnection / QR refresh requested.`);
            inst.clientReady = false;
            inst.connectedUser = null;
            inst.currentQR = '';
            inst.initStatus = 'connecting';
            inst.initError = '';
            inst.consecutiveDisconnects = 0;

            cleanCloseSock(id);
            if (req.query.clean === 'true' || req.body?.clean === true || !inst.clientReady) {
                try {
                    fs.rmSync(inst.authDir, { recursive: true, force: true });
                } catch (e) {}
            }
            setTimeout(() => initWhatsApp(id), 1000);
        }

        res.json({ success: true, message: 'Gerando novo código QR...' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/data', checkAuth, (req, res) => {
    res.json(botData);
});

app.post('/api/save-steps', checkAuth, (req, res) => {
    const { steps } = req.body;
    if (Array.isArray(steps)) {
        botData.steps = steps;
        saveData();
        res.json({ success: true, steps: botData.steps });
    } else {
        res.status(400).json({ error: 'Steps must be an array' });
    }
});

app.post('/api/upload', checkAuth, upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }
    const relativePath = 'uploads/' + req.file.filename;
    const fullPath = path.join(__dirname, relativePath);

    // If uploaded file is audio, pre-convert to WhatsApp Opus
    const ext = path.extname(req.file.filename).toLowerCase();
    if (['.ogg', '.mp3', '.m4a', '.wav', '.aac', '.wma'].includes(ext)) {
        try {
            await convertToWhatsAppOpus(fullPath);
        } catch (e) {
            console.error('Audio conversion on upload failed:', e);
        }
    }

    res.json({ success: true, path: relativePath });
});

// Live Chat API
app.get('/api/chats', checkAuth, (req, res) => {
    const chatList = Object.values(liveChats).sort((a, b) => b.timestamp - a.timestamp);
    res.json({ success: true, chats: chatList });
});

app.get('/api/messages/:jid', checkAuth, (req, res) => {
    const rawKey = req.params.jid;
    const chat = liveChats[rawKey] || liveChats[`1:${rawKey}`] || liveChats[`2:${rawKey}`];
    if (chat) {
        chat.unread = 0;
        saveChats();
        const fullKey = chat.id;
        res.json({ success: true, chat: chat, flowState: userStates[fullKey] || null });
    } else {
        res.status(404).json({ error: 'Chat not found' });
    }
});

app.post('/api/reset-user/:jid', checkAuth, (req, res) => {
    const rawKey = req.params.jid;
    const chat = liveChats[rawKey] || liveChats[`1:${rawKey}`] || liveChats[`2:${rawKey}`];
    const fullKey = chat ? chat.id : (rawKey.includes(':') ? rawKey : `1:${rawKey}`);

    if (userStates[fullKey]?.waitTimeoutId) {
        clearTimeout(userStates[fullKey].waitTimeoutId);
    }
    delete userStates[fullKey];
    saveUserStates();

    if (liveChats[fullKey]) {
        liveChats[fullKey].botStatus = 'active';
        saveChats();
    }
    res.json({ success: true, message: 'Fluxo reiniciado com sucesso para este contato.' });
});

app.post('/api/send', checkAuth, async (req, res) => {
    const { jid, message, instanceId, chatKey } = req.body;
    if (!message || (!jid && !chatKey)) {
        return res.status(400).json({ error: 'jid ou chatKey e mensagem são obrigatórios' });
    }

    let actualJid = jid;
    let actualInstId = instanceId || '1';

    const rawKey = chatKey || jid;
    if (liveChats[rawKey]) {
        actualInstId = liveChats[rawKey].instanceId || actualInstId;
        actualJid = liveChats[rawKey].jid || actualJid;
    } else if (rawKey.includes(':')) {
        const parts = rawKey.split(':');
        actualInstId = parts[0];
        actualJid = parts[1];
    }

    const inst = instances[actualInstId] || instances['1'];
    if (!inst.sock || !inst.clientReady) {
        return res.status(503).json({ error: `WhatsApp (${inst.name}) não está conectado.` });
    }

    try {
        await inst.sock.sendMessage(actualJid, { text: message });
        recordOutgoingMessage(actualInstId, actualJid, message, null);

        const fullChatKey = `${actualInstId}:${actualJid}`;
        if (liveChats[fullChatKey]) {
            liveChats[fullChatKey].botStatus = 'paused';
            saveChats();
        }
        if (userStates[fullChatKey]) {
            userStates[fullChatKey].status = 'paused';
        }

        res.json({ success: true });
    } catch (err) {
        console.error('Error sending manual message:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/bot-toggle/:jid', checkAuth, (req, res) => {
    const rawKey = req.params.jid;
    const chat = liveChats[rawKey] || liveChats[`1:${rawKey}`] || liveChats[`2:${rawKey}`];
    if (!chat) {
        return res.status(404).json({ error: 'Chat not found' });
    }
    const current = chat.botStatus || 'active';
    const nextStatus = current === 'active' ? 'paused' : 'active';
    chat.botStatus = nextStatus;

    const fullKey = chat.id;
    if (userStates[fullKey]) {
        userStates[fullKey].status = nextStatus === 'paused' ? 'paused' : 'running';
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

app.get('/api/virtual-numbers/status', checkAuth, async (req, res) => {
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

// Keep-alive timer to prevent Render free instance from sleeping
function startAntiSleep() {
    const url = process.env.RENDER_EXTERNAL_URL;
    if (url) {
        setInterval(() => {
            https.get(`${url}/api/status?token=${VALID_TOKEN}`, () => {}).on('error', () => {});
        }, 4 * 60 * 1000); // Ping every 4 minutes (well below Render's 15 min limit)
    }
}

app.listen(PORT, HOST, () => {
    console.log(`Umbler Talk Bot Server running on http://${HOST}:${PORT}`);
    initWhatsApp('1');
    initWhatsApp('2');
    startAntiSleep();
});
