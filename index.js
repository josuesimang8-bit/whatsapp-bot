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

// WhatsApp Connection State (Baileys) + 7-Layer Anti-Ban Shield
let sock = null;
let currentQR = '';
let clientReady = false;
let initStatus = 'disconnected'; // 'disconnected' | 'connecting' | 'waiting_qr' | 'ready'
let initError = '';
let connectedUser = null; // { phone, name }
let readyTimestamp = Math.floor(Date.now() / 1000);
let consecutiveDisconnects = 0;

const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');
const logger = pino({ level: 'silent' });
let isInitializing = false;

// ==================== 7-LAYER ANTI-BAN SHIELD HELPERS ====================
const processedMsgIds = new Set();
const lastIncomingKeys = new Map(); // jid -> msg.key for authentic read receipts
let offlinePresenceTimer = null;
let globalSendQueue = Promise.resolve();
let lastHandledJid = null;

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Layer 4A: Invisible zero-width text randomization so every outgoing text has a unique SHA-256 hash
const ZERO_WIDTH_CHARS = ['\u200B', '\u200C', '\u200D'];
function humanizeText(text) {
    if (!text || typeof text !== 'string') return text;
    const words = text.split(' ');
    if (words.length <= 1) {
        const zw = ZERO_WIDTH_CHARS[randomInt(0, ZERO_WIDTH_CHARS.length - 1)];
        return text + zw;
    }
    const insertions = randomInt(2, Math.min(5, words.length));
    for (let i = 0; i < insertions; i++) {
        const idx = randomInt(0, words.length - 1);
        const zw = ZERO_WIDTH_CHARS[randomInt(0, ZERO_WIDTH_CHARS.length - 1)];
        words[idx] = words[idx] + zw;
    }
    return words.join(' ');
}

// Layer 4B: Media buffer cryptographic salt (appends harmless random trailing bytes to change SHA-256/MD5 hash)
function humanizeMediaBuffer(buffer) {
    if (!Buffer.isBuffer(buffer)) return buffer;
    const salt = crypto.randomBytes(randomInt(4, 16));
    return Buffer.concat([buffer, salt]);
}

// Layer 1: Unwrap ephemeral / viewOnce / CTWA containers and strictly ignore internal protocol packets
function unwrapMessage(message) {
    if (!message) return null;
    if (message.ephemeralMessage?.message) return unwrapMessage(message.ephemeralMessage.message);
    if (message.viewOnceMessage?.message) return unwrapMessage(message.viewOnceMessage.message);
    if (message.viewOnceMessageV2?.message) return unwrapMessage(message.viewOnceMessageV2.message);
    if (message.viewOnceMessageV2Extension?.message) return unwrapMessage(message.viewOnceMessageV2Extension.message);
    if (message.documentWithCaptionMessage?.message) return unwrapMessage(message.documentWithCaptionMessage.message);
    if (message.editedMessage?.message) return unwrapMessage(message.editedMessage.message);
    if (message.deviceSentMessage?.message) return unwrapMessage(message.deviceSentMessage.message);
    if (message.futureProofMessage?.message) return unwrapMessage(message.futureProofMessage.message);
    if (message.botInvokeMessage?.message) return unwrapMessage(message.botInvokeMessage.message);
    return message;
}

// Layer 6: Automatic offline presence after idle period (avoids 24/7 online bot signature)
function scheduleOfflinePresence() {
    if (offlinePresenceTimer) clearTimeout(offlinePresenceTimer);
    offlinePresenceTimer = setTimeout(async () => {
        if (sock && clientReady) {
            try {
                await sock.sendPresenceUpdate('unavailable');
            } catch (e) {}
        }
    }, randomInt(14000, 24000));
}

// Layer 2: Authentic Human Read Receipt (Blue Ticks) & Reaction Delay
async function simulateHumanRead(jid) {
    if (!sock || !clientReady) return;
    const msgKey = lastIncomingKeys.get(jid);
    if (!msgKey) return;
    lastIncomingKeys.delete(jid);

    try {
        // 1. Wait 2.2s - 4.8s simulating human picking up phone after notification
        await delay(randomInt(2200, 4800));
        // 2. Come online
        await sock.sendPresenceUpdate('available', jid);
        // 3. Mark message as read (blue ticks) just like opening the chat in official WhatsApp
        await sock.readMessages([msgKey]);
        // 4. Wait 1.5s - 3.2s simulating human reading the message before typing
        await delay(randomInt(1500, 3200));
        scheduleOfflinePresence();
    } catch (e) {}
}

// Layer 5: Global Single-Human Send Queue (prevents typing in multiple chats simultaneously)
function enqueueHumanSend(jid, taskFn) {
    const nextTask = globalSendQueue.then(async () => {
        if (lastHandledJid && lastHandledJid !== jid) {
            // Natural pause when switching between different customer chats
            await delay(randomInt(2200, 4000));
        }
        lastHandledJid = jid;
        return await taskFn();
    }).catch((err) => {
        console.error('[Anti-Ban Queue Error]:', err);
    });
    globalSendQueue = nextTask;
    return nextTask;
}
// =========================================================================

function cleanCloseSock() {
    if (sock) {
        try {
            sock.ev.removeAllListeners('connection.update');
            sock.ev.removeAllListeners('creds.update');
            sock.ev.removeAllListeners('messages.upsert');
            sock.end(undefined);
        } catch (e) {}
        sock = null;
    }
}

async function initWhatsApp() {
    if (isInitializing) {
        console.log('Baileys: Already initializing. Skipping duplicate call.');
        return;
    }
    if (sock && clientReady) {
        console.log('Baileys: Client is already connected.');
        return;
    }

    isInitializing = true;
    console.log('Baileys: Initializing connection with 7-Layer Anti-Ban Shield...');
    initStatus = 'connecting';
    initError = '';

    try {
        if (!fs.existsSync(AUTH_DIR)) {
            fs.mkdirSync(AUTH_DIR, { recursive: true });
        }

        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        const { version, isLatest } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307], isLatest: true }));

        console.log(`Baileys: Using WA version v${version.join('.')}, isLatest: ${isLatest}`);

        cleanCloseSock();

        sock = makeWASocket({
            version,
            logger,
            printQRInTerminal: false,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger)
            },
            browser: Browsers.ubuntu('Chrome'),
            markOnlineOnConnect: false,
            generateHighQualityLinkPreview: false,
            syncFullHistory: false,
            keepAliveIntervalMs: 30000,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            retryRequestDelayMs: 1000,
            maxMsgRetryCount: 3
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('Baileys: New QR Code received.');
                initStatus = 'waiting_qr';
                consecutiveDisconnects = 0;
                qrcode.toDataURL(qr, (err, url) => {
                    if (!err) {
                        currentQR = url;
                    } else {
                        console.error('Error generating QR URL:', err);
                    }
                });
            }

            if (connection === 'close') {
                consecutiveDisconnects++;
                const statusCode = (lastDisconnect?.error)?.output?.statusCode || (lastDisconnect?.error)?.statusCode;
                const errorMsg = lastDisconnect?.error?.message || String(lastDisconnect?.error || '');
                const isLoggedOut = statusCode === DisconnectReason.loggedOut;
                console.log(`Baileys: Connection closed. Status: ${statusCode || 'unknown'} (${errorMsg}). LoggedOut: ${isLoggedOut}. Disconnects: ${consecutiveDisconnects}`);

                clientReady = false;
                cleanCloseSock();

                const isExplicitLogout = isLoggedOut || statusCode === 401 || statusCode === 403;

                if (isExplicitLogout) {
                    console.log('Baileys: Logged out by WhatsApp. Removing auth files to generate fresh QR code.');
                    connectedUser = null;
                    initStatus = 'waiting_qr';
                    initError = 'Dispositivo desconectado pelo WhatsApp. Conecte novamente via Código de 8 Dígitos ou QR Code.';
                    consecutiveDisconnects = 0;
                    currentQR = '';
                    try {
                        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                    } catch (e) {}
                    setTimeout(initWhatsApp, 2000);
                } else {
                    const isRestartRequired = statusCode === DisconnectReason.restartRequired || statusCode === 515;
                    const delayMs = isRestartRequired ? 1200 : Math.min(consecutiveDisconnects * 2500, 12000);
                    console.log(`Baileys: Reconnecting in ${delayMs}ms (Reason: ${statusCode || errorMsg}, RestartRequired: ${isRestartRequired})...`);
                    initStatus = 'connecting';
                    initError = 'Reconectando ao WhatsApp...';
                    setTimeout(initWhatsApp, delayMs);
                }
            } else if (connection === 'open') {
                console.log('Baileys: Connected successfully with Anti-Ban Shield active!');
                clientReady = true;
                consecutiveDisconnects = 0;
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

                // Start in stealth unavailable mode after connecting
                scheduleOfflinePresence();
            }
        });

        // Messages handling (Protected by Layer 1 Strict Real-Message Filter)
        sock.ev.on('messages.upsert', async (m) => {
            try {
                if (m.type !== 'notify') return;

                for (const msg of m.messages) {
                    try {
                        // Ignore outgoing messages or missing keys
                        if (!msg.key || msg.key.fromMe) continue;

                        const jid = msg.key.remoteJid;
                        // Strictly allow only direct 1-on-1 user chats (ignore groups, status, broadcasts, newsletters)
                        if (!jid || jid.endsWith('@g.us') || jid.includes('broadcast') || jid.endsWith('@newsletter')) continue;

                        // Ignore catch-up messages from before the bot connected
                        const msgTimestamp = Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000);
                        if (msgTimestamp < readyTimestamp - 5) {
                            continue;
                        }

                        // Unwrap ephemeral / viewOnce containers
                        // NEVER reply if rawMsg is null/undecrypted (sending to undecrypted stubs triggers immediate 401 ban!)
                        const rawMsg = unwrapMessage(msg.message);
                        if (!rawMsg) continue;

                        // Strictly ignore WhatsApp internal protocol / encryption / reaction / receipt packets
                        if (
                            rawMsg.protocolMessage ||
                            rawMsg.senderKeyDistributionMessage ||
                            rawMsg.reactionMessage ||
                            rawMsg.pollUpdateMessage ||
                            rawMsg.keepInChatMessage ||
                            rawMsg.pinInChatMessage ||
                            rawMsg.encReactionMessage
                        ) {
                            continue;
                        }

                        // Extract authentic human text or explicit media attachment
                        const text = (
                            rawMsg.conversation ||
                            rawMsg.extendedTextMessage?.text ||
                            rawMsg.imageMessage?.caption ||
                            rawMsg.videoMessage?.caption ||
                            rawMsg.buttonsResponseMessage?.selectedDisplayText ||
                            rawMsg.listResponseMessage?.title ||
                            rawMsg.templateButtonReplyMessage?.selectedDisplayText ||
                            ''
                        ).trim();

                        const mediaTypeLabel =
                            rawMsg.audioMessage ? '[Áudio recebido]' :
                            rawMsg.imageMessage ? '[Imagem recebida]' :
                            rawMsg.videoMessage ? '[Vídeo recebido]' :
                            rawMsg.documentMessage ? '[Documento recebido]' :
                            rawMsg.stickerMessage ? '[Figurinha]' :
                            (rawMsg.contactMessage || rawMsg.contactsArrayMessage) ? '[Contato]' :
                            (rawMsg.locationMessage || rawMsg.liveLocationMessage) ? '[Localização]' : '';

                        // CRITICAL ANTI-BAN GUARD: If there is neither real text nor real media, DO NOT reply!
                        const incomingContent = text || mediaTypeLabel;
                        if (!incomingContent) {
                            continue;
                        }

                        // Deduplicate message IDs ONLY AFTER confirming valid decrypted content
                        if (msg.key.id) {
                            if (processedMsgIds.has(msg.key.id)) continue;
                            processedMsgIds.add(msg.key.id);
                            if (processedMsgIds.size > 2000) {
                                const firstKey = processedMsgIds.values().next().value;
                                processedMsgIds.delete(firstKey);
                            }
                        }

                        console.log(`[Baileys Incoming] ${jid}: "${incomingContent}"`);

                        // Store message key so Layer 2 can mark it as read (blue ticks) naturally
                        lastIncomingKeys.set(jid, msg.key);

                        // Save to live chat history
                        recordIncomingMessage(jid, incomingContent, msg);

                        // Handle automated flow execution
                        if (clientReady) {
                            await handleFlowForUser(jid, incomingContent);
                        }
                    } catch (msgErr) {
                        console.error('Error handling single message:', msgErr);
                    }
                }
            } catch (err) {
                console.error('Error in messages.upsert:', err);
            }
        });

    } catch (err) {
        console.error('Baileys init error:', err);
        initStatus = 'error';
        initError = err.message || String(err);
        cleanCloseSock();
        setTimeout(initWhatsApp, 5000);
    } finally {
        isInitializing = false;
    }
}

// User Flow Execution State & Disk Persistence
const STATES_FILE = path.join(__dirname, 'user_states.json');
let userStates = {}; // { jid: { currentStepIndex, status: 'running'|'waiting_reply'|'sending_question'|'completed'|'paused', lastActive, answers: {}, pendingReply: null, waitTimeoutId: null } }
const userLocks = new Set(); // Prevent concurrent step execution for same jid

function loadUserStates() {
    if (fs.existsSync(STATES_FILE)) {
        try {
            const raw = JSON.parse(fs.readFileSync(STATES_FILE, 'utf-8'));
            for (const jid in raw) {
                userStates[jid] = {
                    currentStepIndex: typeof raw[jid].currentStepIndex === 'number' ? raw[jid].currentStepIndex : 0,
                    status: raw[jid].status || 'running',
                    lastActive: raw[jid].lastActive || Date.now(),
                    answers: raw[jid].answers || {},
                    pendingReply: null,
                    waitTimeoutId: null
                };
            }
            console.log(`[Baileys Flow] Carregados ${Object.keys(userStates).length} estados de utilizadores de user_states.json.`);
        } catch (e) {
            console.error('Error loading user_states.json:', e);
            userStates = {};
        }
    }
}

function saveUserStates() {
    try {
        const clean = {};
        for (const jid in userStates) {
            clean[jid] = {
                currentStepIndex: userStates[jid].currentStepIndex,
                status: userStates[jid].status,
                lastActive: userStates[jid].lastActive,
                answers: userStates[jid].answers || {}
            };
        }
        fs.writeFileSync(STATES_FILE, JSON.stringify(clean, null, 2));
    } catch (e) {
        console.error('Error saving user_states.json:', e);
    }
}

loadUserStates();

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
    const rawText = (incomingText || '').trim();

    // Check for user manual reset command
    if (rawText.toLowerCase() === '#reset' || rawText.toLowerCase() === '#reiniciar') {
        console.log(`[Baileys Flow] User ${jid} sent reset command: ${rawText}`);
        if (userStates[jid]?.waitTimeoutId) {
            clearTimeout(userStates[jid].waitTimeoutId);
        }
        delete userStates[jid];
        saveUserStates();
        if (liveChats[jid]) {
            liveChats[jid].botStatus = 'active';
            saveChats();
        }
        if (sock && clientReady) {
            await simulateHumanRead(jid);
            await sock.sendMessage(jid, {
                text: humanizeText('🔄 O seu fluxo foi reiniciado com sucesso!\nEnvie qualquer mensagem para começar novamente.')
            });
        }
        return;
    }

    // Check if user is manually paused by an operator in Live Chat
    if (liveChats[jid] && liveChats[jid].botStatus === 'paused') {
        console.log(`[Baileys Flow] Bot is paused for ${jid}. Operator active. Automated reply ignored.`);
        return;
    }

    const state = userStates[jid];

    // If flow is already completed for this user, do not loop
    if (state && state.status === 'completed') {
        console.log(`[Baileys Flow] User ${jid} already completed the flow. Ignoring automated loop.`);
        return;
    }

    // If currently paused in state
    if (state && state.status === 'paused') {
        return;
    }

    // If the question is currently transmitting, buffer this reply
    if (state && state.status === 'sending_question') {
        console.log(`[Baileys Flow] User ${jid} replied while question was transmitting. Buffering reply: "${rawText}"`);
        state.pendingReply = rawText || '[Resposta]';
        saveUserStates();
        return;
    }

    // If waiting for reply to a question -> user answered! Advance to next step
    if (state && state.status === 'waiting_reply') {
        console.log(`[Baileys Flow] User ${jid} answered question step ${state.currentStepIndex + 1}: "${rawText}". Advancing to step ${state.currentStepIndex + 2}...`);
        if (!state.answers) state.answers = {};
        state.answers[state.currentStepIndex] = rawText || '[Resposta]';
        state.status = 'running';
        state.lastActive = Date.now();
        state.pendingReply = null;
        saveUserStates();

        await simulateHumanRead(jid);
        await executeStep(jid, state.currentStepIndex + 1);
        return;
    }

    // If already actively running a step or in a wait delay
    if (state && state.status === 'running') {
        console.log(`[Baileys Flow] Flow is already active for ${jid} at step ${state.currentStepIndex + 1}. Message noted.`);
        return;
    }

    // New conversation -> reserve state immediately to prevent double-start, simulate human read, then start step 0
    console.log(`[Baileys Flow] Starting new automated funnel for ${jid}`);
    userStates[jid] = {
        currentStepIndex: 0,
        status: 'running',
        lastActive: Date.now(),
        answers: {},
        pendingReply: null,
        waitTimeoutId: null
    };
    saveUserStates();

    await simulateHumanRead(jid);
    await executeStep(jid, 0);
}

async function executeStep(jid, stepIndex) {
    // Concurrency lock per user
    if (userLocks.has(jid)) {
        console.log(`[Baileys Lock] Step execution currently active for ${jid}, queuing step ${stepIndex}`);
        setTimeout(() => executeStep(jid, stepIndex), 1000);
        return;
    }
    userLocks.add(jid);

    try {
        const steps = botData.steps || [];

        // Clear any pending wait timer
        if (userStates[jid]?.waitTimeoutId) {
            clearTimeout(userStates[jid].waitTimeoutId);
            userStates[jid].waitTimeoutId = null;
        }

        // Check if finished
        if (stepIndex >= steps.length) {
            console.log(`[Baileys Flow] Flow completed for ${jid}`);
            userStates[jid] = {
                currentStepIndex: steps.length,
                status: 'completed',
                lastActive: Date.now(),
                answers: userStates[jid]?.answers || {},
                waitTimeoutId: null
            };
            saveUserStates();
            scheduleOfflinePresence();
            return;
        }

        const step = steps[stepIndex];
        console.log(`[Baileys Step ${stepIndex + 1}/${steps.length}] (${step.type}) -> ${jid}`);

        if (step.type === 'message') {
            userStates[jid] = {
                currentStepIndex: stepIndex,
                status: 'running',
                lastActive: Date.now(),
                answers: userStates[jid]?.answers || {},
                waitTimeoutId: null
            };
            saveUserStates();

            await sendStepPayload(jid, step);

            // If the next step is immediately another message/question without an explicit wait step, add a natural human breather
            const nextStep = steps[stepIndex + 1];
            if (nextStep && nextStep.type !== 'wait') {
                await delay(randomInt(2400, 4600));
            }

            if (userStates[jid] && userStates[jid].status === 'running' && liveChats[jid]?.botStatus !== 'paused') {
                userLocks.delete(jid);
                return executeStep(jid, stepIndex + 1);
            }
        } else if (step.type === 'wait') {
            userStates[jid] = {
                currentStepIndex: stepIndex,
                status: 'running',
                lastActive: Date.now(),
                answers: userStates[jid]?.answers || {},
                waitTimeoutId: null
            };
            saveUserStates();

            // Layer 5: Add random human jitter (+3s to +7s + 30% variance) to break fixed robotic intervals
            const baseSec = Math.max(parseFloat(step.duration) || 3, 2);
            const jitterSec = (randomInt(30, 65) / 10) + (baseSec * (randomInt(15, 40) / 100));
            const totalDelayMs = Math.round((baseSec + jitterSec) * 1000);
            console.log(`[Anti-Ban Wait] Step ${stepIndex + 1}: Base ${baseSec}s -> Humanized ${(totalDelayMs / 1000).toFixed(1)}s for ${jid}...`);

            const timeoutId = setTimeout(() => {
                if (userStates[jid] && userStates[jid].status === 'running' && liveChats[jid]?.botStatus !== 'paused') {
                    executeStep(jid, stepIndex + 1);
                }
            }, totalDelayMs);
            userStates[jid].waitTimeoutId = timeoutId;
        } else if (step.type === 'question') {
            userStates[jid] = {
                currentStepIndex: stepIndex,
                status: 'sending_question',
                lastActive: Date.now(),
                answers: userStates[jid]?.answers || {},
                pendingReply: null,
                waitTimeoutId: null
            };
            saveUserStates();

            await sendStepPayload(jid, step);

            if (userStates[jid] && liveChats[jid]?.botStatus !== 'paused') {
                if (userStates[jid].pendingReply) {
                    const buffered = userStates[jid].pendingReply;
                    console.log(`[Baileys Flow] User ${jid} had buffered reply: "${buffered}". Advancing to step ${stepIndex + 1}`);
                    userStates[jid].answers[stepIndex] = buffered;
                    userStates[jid].pendingReply = null;
                    userStates[jid].status = 'running';
                    userStates[jid].lastActive = Date.now();
                    saveUserStates();

                    await simulateHumanRead(jid);
                    userLocks.delete(jid);
                    return executeStep(jid, stepIndex + 1);
                } else {
                    userStates[jid].status = 'waiting_reply';
                    userStates[jid].lastActive = Date.now();
                    saveUserStates();
                    scheduleOfflinePresence();
                    console.log(`🛑 [Baileys Question] Step ${stepIndex + 1} PAUSED. Bot is strictly waiting for user ${jid} to reply.`);
                }
            }
        }
    } catch (err) {
        console.error(`Error in executeStep for ${jid}:`, err);
    } finally {
        userLocks.delete(jid);
    }
}

async function sendStepPayload(jid, step) {
    if (!sock || !clientReady) return;

    return enqueueHumanSend(jid, async () => {
        if (!sock || !clientReady) return;

        try {
            const isAudio = step.media && (step.media.endsWith('.mp3') || step.media.endsWith('.ogg') || step.media.endsWith('.m4a') || step.media.endsWith('.wav'));
            const hasVisualMedia = step.media && !isAudio;

            try {
                await sock.sendPresenceUpdate('available', jid);
            } catch (e) {}

            // Layer 3: Realistic Human Typing / Audio Recording Cadence
            if (isAudio) {
                try {
                    await sock.sendPresenceUpdate('recording', jid);
                } catch (e) {}
                const recordDurationMs = randomInt(5000, 8800);
                if (recordDurationMs > 4500) {
                    await delay(4000);
                    try { await sock.sendPresenceUpdate('recording', jid); } catch (e) {}
                    await delay(recordDurationMs - 4000);
                } else {
                    await delay(recordDurationMs);
                }
            } else if (hasVisualMedia) {
                // Simulating opening gallery & picking photo/video
                await delay(randomInt(2200, 3800));
                if (step.text) {
                    try { await sock.sendPresenceUpdate('composing', jid); } catch (e) {}
                    const captionDelay = Math.min(Math.max(step.text.length * randomInt(42, 60), 2500), 6500);
                    await delay(captionDelay);
                }
            } else {
                try {
                    await sock.sendPresenceUpdate('composing', jid);
                } catch (e) {}
                const textLen = step.text ? step.text.length : 20;
                const typingDelayMs = Math.min(Math.max(textLen * randomInt(45, 65), 3200), 8500) + randomInt(300, 1100);
                if (typingDelayMs > 4500) {
                    await delay(4200);
                    try { await sock.sendPresenceUpdate('composing', jid); } catch (e) {}
                    await delay(typingDelayMs - 4200);
                } else {
                    await delay(typingDelayMs);
                }
            }

            try {
                await sock.sendPresenceUpdate('paused', jid);
            } catch (presErr) {}
            await delay(randomInt(300, 650));

            const safeCaption = step.text ? humanizeText(step.text) : undefined;

            let mediaSent = false;
            if (step.media) {
                const mediaFullPath = path.join(__dirname, step.media);
                if (fs.existsSync(mediaFullPath)) {
                    const ext = path.extname(mediaFullPath).toLowerCase();
                    const rawBuffer = fs.readFileSync(mediaFullPath);

                    if (isAudio) {
                        const audioInfo = await convertToUniversalAudio(mediaFullPath, 'm4a');
                        const audioBuffer = humanizeMediaBuffer(fs.readFileSync(audioInfo.path));
                        const wave = generateWaveform();

                        await sock.sendMessage(jid, {
                            audio: audioBuffer,
                            mimetype: 'audio/mp4',
                            ptt: true,
                            seconds: audioInfo.seconds > 0 ? audioInfo.seconds : undefined,
                            waveform: wave
                        });
                        recordOutgoingMessage(jid, '', step.media);
                        mediaSent = true;
                    } else if (['.jpg', '.jpeg', '.png', '.gif'].includes(ext)) {
                        const imgBuffer = humanizeMediaBuffer(rawBuffer);
                        await sock.sendMessage(jid, {
                            image: imgBuffer,
                            caption: safeCaption
                        });
                        recordOutgoingMessage(jid, step.text || '', step.media);
                        mediaSent = true;
                        scheduleOfflinePresence();
                        return;
                    } else if (['.mp4', '.mov', '.avi'].includes(ext)) {
                        const vidBuffer = humanizeMediaBuffer(rawBuffer);
                        try {
                            console.log(`[Baileys Video] Sending humanized video to ${jid} (${step.media})`);
                            await sock.sendMessage(jid, {
                                video: vidBuffer,
                                mimetype: 'video/mp4',
                                caption: safeCaption
                            });
                            recordOutgoingMessage(jid, step.text || '', step.media);
                            mediaSent = true;
                            scheduleOfflinePresence();
                            return;
                        } catch (vidErr) {
                            console.error(`[Baileys Video Error] Failed to send native video, falling back to document:`, vidErr);
                            await sock.sendMessage(jid, {
                                document: vidBuffer,
                                mimetype: 'video/mp4',
                                fileName: path.basename(mediaFullPath),
                                caption: safeCaption
                            });
                            recordOutgoingMessage(jid, step.text || '', step.media);
                            mediaSent = true;
                            scheduleOfflinePresence();
                            return;
                        }
                    } else {
                        const docBuffer = humanizeMediaBuffer(rawBuffer);
                        await sock.sendMessage(jid, {
                            document: docBuffer,
                            mimetype: 'application/octet-stream',
                            fileName: path.basename(mediaFullPath),
                            caption: safeCaption
                        });
                        recordOutgoingMessage(jid, step.text || '', step.media);
                        mediaSent = true;
                        scheduleOfflinePresence();
                        return;
                    }
                }
            }

            if (step.text && (!mediaSent || isAudio)) {
                if (isAudio) {
                    // Wait briefly after sending voice note before sending accompanying text
                    await delay(randomInt(1500, 2800));
                    try { await sock.sendPresenceUpdate('composing', jid); } catch (e) {}
                    await delay(Math.min(Math.max(step.text.length * 45, 2200), 5500));
                    try { await sock.sendPresenceUpdate('paused', jid); } catch (e) {}
                }
                await sock.sendMessage(jid, { text: safeCaption });
                recordOutgoingMessage(jid, step.text, null);
            }

            scheduleOfflinePresence();
        } catch (err) {
            console.error(`Error sending step payload to ${jid}:`, err);
        }
    });
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

    res.json({
        ready: clientReady,
        qr: currentQR,
        status: initStatus,
        error: initError,
        user: connectedUser,
        antiBan: {
            active: true,
            layers: 7,
            mode: 'Stealth Human Simulation'
        }
    });
});

// Layer 7: Connect via 8-Digit Pairing Code (No QR Code / No Camera needed)
app.post('/api/pair-code', checkAuth, async (req, res) => {
    try {
        const rawPhone = String(req.body?.phone || '');
        const cleanPhone = rawPhone.replace(/\D/g, '');
        if (!cleanPhone || cleanPhone.length < 8 || cleanPhone.length > 15) {
            return res.status(400).json({
                error: 'Digite o número completo com código do país (ex: 258841234567).'
            });
        }

        if (clientReady) {
            return res.status(400).json({
                error: 'O WhatsApp já está conectado! Desconecte primeiro se quiser trocar de número.'
            });
        }

        // Ensure we have an active unauthenticated socket ready for pairing
        if (!sock) {
            await initWhatsApp();
        }

        // Wait up to 6 seconds for socket to reach waiting_qr / initialized state
        for (let i = 0; i < 12; i++) {
            if (sock && (initStatus === 'waiting_qr' || currentQR)) break;
            await delay(500);
        }

        if (!sock || typeof sock.requestPairingCode !== 'function') {
            return res.status(503).json({
                error: 'A conexão ainda está a iniciar. Aguarde 3 segundos e tente novamente.'
            });
        }

        await delay(1000);
        const code = await sock.requestPairingCode(cleanPhone);
        const formatted = code && code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
        console.log(`[Baileys Pairing Code] Generated code ${formatted} for +${cleanPhone}`);

        return res.json({
            success: true,
            code: formatted,
            phone: '+' + cleanPhone
        });
    } catch (err) {
        console.error('[Baileys Pairing Code Error]:', err);
        return res.status(500).json({
            error: 'Não foi possível gerar o código agora. Clique em "Gerar Novo QR Code" e tente novamente em 3 segundos.'
        });
    }
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
        if (!sock || !clientReady) {
            return res.status(400).json({ error: 'WhatsApp não está conectado' });
        }
        let jid = req.query.jid;
        if (!jid && connectedUser?.id) {
            jid = connectedUser.id;
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
            sent = await sock.sendMessage(jid, {
                audio: buf,
                mimetype: 'audio/ogg; codecs=opus',
                ptt: true,
                seconds: audioInfo.seconds > 0 ? audioInfo.seconds : undefined,
                waveform: wave
            });
            res.json({ success: true, jid, format: 'ptt', ptt: true, file: audioInfo.path, duration: audioInfo.seconds, messageId: sent?.key?.id });
        } else {
            const targetFormat = format === 'mp3' ? 'mp3' : 'm4a';
            const audioInfo = await convertToUniversalAudio(fullPath, targetFormat);
            const buf = fs.readFileSync(audioInfo.path);
            const wave = generateWaveform();
            sent = await sock.sendMessage(jid, {
                audio: buf,
                mimetype: targetFormat === 'm4a' ? 'audio/mp4' : 'audio/mpeg',
                ptt: isPtt,
                seconds: audioInfo.seconds > 0 ? audioInfo.seconds : undefined,
                waveform: wave
            });
            res.json({ success: true, jid, format: targetFormat, ptt: isPtt, file: audioInfo.path, duration: audioInfo.seconds, messageId: sent?.key?.id });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/disconnect', checkAuth, async (req, res) => {
    try {
        console.log('Baileys: User requested disconnection.');
        clientReady = false;
        currentQR = '';
        connectedUser = null;
        initStatus = 'disconnected';
        initError = '';

        cleanCloseSock();

        try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        } catch (e) {}

        setTimeout(initWhatsApp, 2000);
        res.json({ success: true, message: 'Bot desconectado com sucesso.' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/restart', checkAuth, async (req, res) => {
    try {
        console.log('Baileys: Reconnection / QR code refresh requested.');
        clientReady = false;
        connectedUser = null;
        currentQR = '';
        initStatus = 'connecting';
        initError = '';
        consecutiveDisconnects = 0;

        cleanCloseSock();
        // If clean requested or if bot was not connected, wipe auth files to guarantee fresh QR
        if (req.query.clean === 'true' || req.body?.clean === true || !clientReady) {
            try {
                fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            } catch (e) {}
        }
        setTimeout(initWhatsApp, 1000);
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
    const jid = req.params.jid;
    const chat = liveChats[jid];
    if (chat) {
        chat.unread = 0;
        saveChats();
        const st = userStates[jid];
        const safeState = st ? {
            currentStepIndex: st.currentStepIndex,
            status: st.status,
            lastActive: st.lastActive,
            answers: st.answers || {}
        } : null;
        res.json({ success: true, chat: chat, flowState: safeState });
    } else {
        res.status(404).json({ error: 'Chat not found' });
    }
});

app.post('/api/reset-user/:jid', checkAuth, (req, res) => {
    const jid = req.params.jid;
    if (userStates[jid]?.waitTimeoutId) {
        clearTimeout(userStates[jid].waitTimeoutId);
    }
    delete userStates[jid];
    saveUserStates();
    if (liveChats[jid]) {
        liveChats[jid].botStatus = 'active';
        saveChats();
    }
    res.json({ success: true, message: 'Fluxo reiniciado com sucesso para este contato.' });
});

app.post('/api/send', checkAuth, async (req, res) => {
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

app.post('/api/bot-toggle/:jid', checkAuth, (req, res) => {
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
    initWhatsApp();
    startAntiSleep();
});
