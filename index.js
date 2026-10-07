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
const { exec } = require('child_process');

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
let isInitializing = false;

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
    console.log('Baileys: Initializing connection...');
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
            browser: ['Umbler Talk', 'Desktop', '1.0.0'],
            generateHighQualityLinkPreview: true,
            syncFullHistory: false,
            keepAliveIntervalMs: 15000, // Send ping every 15s to keep WebSocket alive through Cloudflare/Render
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            retryRequestDelayMs: 500,
            maxMsgRetryCount: 5
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
                const statusCode = (lastDisconnect?.error)?.output?.statusCode || (lastDisconnect?.error)?.statusCode;
                const errorMsg = lastDisconnect?.error?.message || String(lastDisconnect?.error || '');
                const isLoggedOut = statusCode === DisconnectReason.loggedOut;
                console.log(`Baileys: Connection closed. Status: ${statusCode || 'unknown'} (${errorMsg}). LoggedOut: ${isLoggedOut}`);

                clientReady = false;
                connectedUser = null;
                cleanCloseSock();

                if (isLoggedOut) {
                    console.log('Baileys: Session logged out by WhatsApp. Removing auth files.');
                    initStatus = 'disconnected';
                    initError = 'Desconectado do WhatsApp. Escaneie o código QR para reconectar.';
                    try {
                        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                    } catch (e) {}
                    setTimeout(initWhatsApp, 2000);
                } else {
                    console.log(`Baileys: Reconnecting in 3s (Reason: ${statusCode || errorMsg})...`);
                    initStatus = 'connecting';
                    initError = 'Reconectando ao WhatsApp...';
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

                // Extract message body text or media type
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

                console.log(`[Baileys Incoming] ${jid}: "${text || incomingContent}"`);

                // Save to live chat history
                recordIncomingMessage(jid, text || incomingContent, msg);

                // Handle automated flow execution
                if (clientReady) {
                    await handleFlowForUser(jid, text || incomingContent);
                }
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
            await sock.sendMessage(jid, {
                text: '🔄 O seu fluxo foi reiniciado com sucesso!\nEnvie qualquer mensagem para começar novamente.'
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

        await executeStep(jid, state.currentStepIndex + 1);
        return;
    }

    // If already actively running a step or in a wait delay
    if (state && state.status === 'running') {
        console.log(`[Baileys Flow] Flow is already active for ${jid} at step ${state.currentStepIndex + 1}. Message noted.`);
        return;
    }

    // New conversation -> start from step 0
    console.log(`[Baileys Flow] Starting new automated funnel for ${jid}`);
    await executeStep(jid, 0);
}

async function executeStep(jid, stepIndex) {
    // Concurrency lock per user
    if (userLocks.has(jid)) {
        console.log(`[Baileys Lock] Step execution currently active for ${jid}, queuing step ${stepIndex}`);
        setTimeout(() => executeStep(jid, stepIndex), 800);
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

            const delaySec = Math.max(parseFloat(step.duration) || 2, 1);
            console.log(`[Baileys Wait] Step ${stepIndex + 1}: Waiting ${delaySec}s before step ${stepIndex + 2} for ${jid}...`);

            const timeoutId = setTimeout(() => {
                if (userStates[jid] && userStates[jid].status === 'running' && liveChats[jid]?.botStatus !== 'paused') {
                    executeStep(jid, stepIndex + 1);
                }
            }, delaySec * 1000);
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

                    userLocks.delete(jid);
                    return executeStep(jid, stepIndex + 1);
                } else {
                    userStates[jid].status = 'waiting_reply';
                    userStates[jid].lastActive = Date.now();
                    saveUserStates();
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
                    recordOutgoingMessage(jid, '', step.media);
                    mediaSent = true;
                } else if (['.jpg', '.jpeg', '.png', '.gif'].includes(ext)) {
                    await sock.sendMessage(jid, {
                        image: buffer,
                        caption: step.text || undefined
                    });
                    recordOutgoingMessage(jid, step.text || '', step.media);
                    mediaSent = true;
                    return;
                } else if (['.mp4', '.mov', '.avi'].includes(ext)) {
                    try {
                        console.log(`[Baileys Video] Sending video to ${jid} (${step.media})`);
                        await sock.sendMessage(jid, {
                            video: buffer,
                            mimetype: 'video/mp4',
                            caption: step.text || undefined
                        });
                        recordOutgoingMessage(jid, step.text || '', step.media);
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
                        recordOutgoingMessage(jid, step.text || '', step.media);
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
                    recordOutgoingMessage(jid, step.text || '', step.media);
                    mediaSent = true;
                    return;
                }
            }
        }

        if (step.text && (!mediaSent || isAudio)) {
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

app.get('/api/test-audio', async (req, res) => {
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

app.get('/api/send-test-audio', async (req, res) => {
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

app.post('/api/disconnect', async (req, res) => {
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

app.post('/api/restart', async (req, res) => {
    try {
        console.log('Baileys: Reconnection requested by user.');
        clientReady = false;
        connectedUser = null;
        initStatus = 'connecting';
        initError = '';

        cleanCloseSock();
        // Preserves AUTH_DIR credentials so existing session reconnects without asking for new QR code
        setTimeout(initWhatsApp, 1500);
        res.json({ success: true, message: 'Reconectando sessão...' });
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

app.post('/api/upload', upload.single('file'), async (req, res) => {
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
        res.json({ success: true, chat: chat, flowState: userStates[jid] || null });
    } else {
        res.status(404).json({ error: 'Chat not found' });
    }
});

app.post('/api/reset-user/:jid', (req, res) => {
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

// Keep-alive timer to prevent Render free instance from sleeping
function startAntiSleep() {
    const url = process.env.RENDER_EXTERNAL_URL;
    if (url) {
        setInterval(() => {
            https.get(`${url}/api/status`, () => {}).on('error', () => {});
        }, 4 * 60 * 1000); // Ping every 4 minutes (well below Render's 15 min limit)
    }
}

app.listen(PORT, HOST, () => {
    console.log(`Umbler Talk Bot Server running on http://${HOST}:${PORT}`);
    initWhatsApp();
    startAntiSleep();
});
