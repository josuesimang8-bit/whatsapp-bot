const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { execSync } = require('child_process');

// Handle Windows file lock (EBUSY) crashes gracefully
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    if (err.message && err.message.includes('EBUSY')) {
        console.log('Safe to ignore: Windows file lock (EBUSY) prevented deleting session files immediately.');
    }
});

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

// Multer setup for uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadPath = path.join(__dirname, 'uploads');
        if (!fs.existsSync(uploadPath)) {
            fs.mkdirSync(uploadPath);
        }
        cb(null, uploadPath);
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// WhatsApp Client
let client = null;
let currentQR = '';
let clientReady = false;
let initStatus = 'disconnected'; // 'disconnected' | 'initializing' | 'waiting_qr' | 'ready' | 'error'
let initError = '';
let landingBypassInterval = null;

function getChromiumPath() {
    const paths = [
        process.env.PUPPETEER_EXECUTABLE_PATH,
        // Linux Paths (for Render)
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome'
    ];
    
    for (const p of paths) {
        if (p && fs.existsSync(p)) {
            console.log(`Found browser executable at: ${p}`);
            return p;
        }
    }
    
    console.log('No specific browser executable found, letting Puppeteer choose default.');
    return undefined;
}

function getMessageMediaForFile(filePath) {
    if (!fs.existsSync(filePath)) return null;
    const ext = path.extname(filePath).toLowerCase();
    const fileBuffer = fs.readFileSync(filePath);
    const base64Data = fileBuffer.toString('base64');
    const filename = path.basename(filePath);
    
    let mimetype = '';
    if (ext === '.ogg') {
        mimetype = 'audio/ogg; codecs=opus';
    } else if (ext === '.mp3') {
        mimetype = 'audio/mp3';
    } else if (ext === '.wav') {
        mimetype = 'audio/wav';
    } else if (ext === '.m4a') {
        mimetype = 'audio/mp4';
    } else {
        // Fallback to standard mime guess
        const isImage = ext === '.jpg' || ext === '.jpeg' || ext === '.png' || ext === '.gif';
        const isVideo = ext === '.mp4' || ext === '.mov' || ext === '.avi';
        if (isImage) mimetype = 'image/' + (ext === '.jpg' ? 'jpeg' : ext.replace('.', ''));
        else if (isVideo) mimetype = 'video/' + ext.replace('.', '');
        else mimetype = 'application/octet-stream';
    }
    
    return new MessageMedia(mimetype, base64Data, filename);
}

function clearLandingBypass() {
    if (landingBypassInterval) {
        clearInterval(landingBypassInterval);
        landingBypassInterval = null;
    }
}

async function safeDestroyClient() {
    clearLandingBypass();
    console.log('Safely destroying WhatsApp client...');
    
    // Force kill the Chrome child process if it exists to release file locks
    if (client && client.pupBrowser && client.pupBrowser.process()) {
        const pid = client.pupBrowser.process().pid;
        console.log(`Force killing browser process (PID: ${pid}) to release file locks...`);
        try {
            process.kill(pid, 'SIGKILL');
        } catch (e) {
            console.log(`Process PID ${pid} already closed or not killable: ${e.message}`);
        }
    }
    
    // Proactively kill any zombie Chrome processes tied to our session dir
    if (process.platform === 'win32') {
        try {
            console.log('Force killing any zombie Chrome processes holding locks on the session directory...');
            const cmd = 'powershell -Command "Get-CimInstance Win32_Process -Filter \\"Name = \'chrome.exe\'\\" | Where-Object { $_.CommandLine -like \'*whatsapp-bot\\.wwebjs_auth\\session*\' } | Remove-CimInstance"';
            execSync(cmd, { stdio: 'ignore' });
            console.log('Zombie Chrome processes killed successfully.');
        } catch (e) {
            console.log('Non-critical: Error killing zombie Chrome processes:', e.message);
        }
    } else {
        try {
            console.log('Killing any zombie Chromium processes on Linux...');
            execSync('pkill -9 -f chromium || pkill -9 -f chrome || true', { stdio: 'ignore' });
            console.log('Zombie Chromium processes killed successfully.');
        } catch (e) {
            console.log('Non-critical: Error killing zombie processes on Linux:', e.message);
        }
    }
    
    if (client) {
        try {
            await client.destroy();
        } catch (err) {
            console.error('Error during client.destroy():', err.message);
        }
    }
    
    client = null;
    clientReady = false;
    initStatus = 'disconnected';
}

function initWhatsAppClient() {
    if (clientReady || initStatus === 'ready' || initStatus === 'waiting_qr' || initStatus === 'initializing') {
        console.log('Client is already active or initializing.');
        return;
    }

    // Clean up zombie locks and processes before launching Chrome to prevent launch timeouts or SingletonLock errors
    if (process.platform !== 'win32') {
        try {
            execSync('pkill -9 -f chromium || pkill -9 -f chrome || true', { stdio: 'ignore' });
        } catch (e) {}
    }

    try {
        const sessionPath = path.join(__dirname, '.wwebjs_auth', 'session');
        const lockNames = [
            'lockfile',
            'DevToolsActivePort',
            'SingletonLock',
            'SingletonCookie',
            'SingletonSocket',
            path.join('Default', 'LOCK')
        ];
        
        for (const name of lockNames) {
            const p = path.join(sessionPath, name);
            if (fs.existsSync(p)) {
                try {
                    fs.rmSync(p, { force: true, recursive: true });
                } catch (e) {}
            }
        }
        console.log('Cleaned up Chrome lock & Singleton files successfully.');
    } catch (err) {
        console.error('Non-critical: Error cleaning lock files on startup:', err.message);
    }

    console.log('Initializing WhatsApp client...');
    initStatus = 'initializing';
    initError = '';
    currentQR = '';
    let readyTimestamp = Math.floor(Date.now() / 1000);

    const isWindows = process.platform === 'win32';
    // User-Agent must strictly match host OS platform to avoid WhatsApp anti-bot session rejection after scan
    const userAgent = isWindows
        ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
        : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

    const puppeteerArgs = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-software-rasterizer',
        '--disable-blink-features=AutomationControlled',
        `--user-agent=${userAgent}`
    ];

    if (!isWindows) {
        // Essential low-memory args for cloud containers (Render 512MB RAM limit)
        puppeteerArgs.push(
            '--no-zygote',
            '--password-store=basic',
            '--use-mock-keychain',
            '--disable-background-networking',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-breakpad',
            '--disable-component-update',
            '--disable-renderer-backgrounding',
            '--js-flags=--max-old-space-size=300'
        );
    }

    const puppeteerOpts = {
        headless: true,
        args: puppeteerArgs
    };

    if (isWindows) {
        puppeteerOpts.channel = 'chrome';
        console.log('Windows detected: Using system Chrome channel for full media codec support.');
    } else {
        puppeteerOpts.executablePath = getChromiumPath();
        console.log('Linux/Other detected: Using detected Chromium path:', puppeteerOpts.executablePath);
    }

    client = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: puppeteerOpts,
        authTimeoutMs: 180000, // 3 minutes timeout so cloud containers have plenty of time to sync chats
        qrMaxRetries: 5,
        takeoverOnConflict: true,
        takeoverTimeoutMs: 0
    });

    // Interstitial landing bypass - only active during initial load before QR is received
    clearLandingBypass();
    landingBypassInterval = setInterval(async () => {
        if (client && client.pupPage && initStatus === 'initializing') {
            try {
                const buttons = await client.pupPage.$$('button, a, div[role="button"]');
                for (const button of buttons) {
                    const text = await client.pupPage.evaluate(el => el.textContent, button);
                    if (text && (text.includes('Continuar para o WhatsApp Web') || text.includes('Continue to WhatsApp Web'))) {
                        console.log('Detected WhatsApp Web landing interstitial page. Clicking "Continue to WhatsApp Web" button...');
                        await button.click();
                        break;
                    }
                }
            } catch (err) {
                // Ignore evaluation errors during reload or initialization
            }
        } else if (initStatus !== 'initializing') {
            clearLandingBypass();
        }
    }, 4000);

    client.on('qr', (qr) => {
        clearLandingBypass();
        console.log('QR Code generated. Please scan to authenticate.');
        initStatus = 'waiting_qr';
        qrcode.toDataURL(qr, (err, url) => {
            if (!err) {
                currentQR = url;
            } else {
                console.error('Error generating QR data URL:', err);
            }
        });
    });

    client.on('ready', () => {
        clearLandingBypass();
        console.log('Client is ready!');
        clientReady = true;
        currentQR = '';
        initStatus = 'ready';
        initError = '';
        readyTimestamp = Math.floor(Date.now() / 1000);
    });

    client.on('authenticated', () => {
        clearLandingBypass();
        console.log('Authenticated successfully!');
        initStatus = 'authenticated';
        currentQR = '';
        initError = 'Autenticado com sucesso! Sincronizando dados...';
    });

    client.on('loading_screen', (percent, message) => {
        clearLandingBypass();
        console.log(`WhatsApp Web Loading: ${percent}% - ${message}`);
        initStatus = 'loading';
        initError = `Sincronizando WhatsApp (${percent}%)... ${message || ''}`;
    });

    client.on('auth_failure', (msg) => {
        clearLandingBypass();
        console.error('Authentication failed:', msg);
        clientReady = false;
        initStatus = 'error';
        initError = 'Falha na autenticação: ' + (msg || 'Tente escanear novamente.');
    });

    client.on('disconnected', async (reason) => {
        clearLandingBypass();
        console.log('Client disconnected:', reason);
        clientReady = false;
        currentQR = '';
        initStatus = 'disconnected';
        initError = `Desconectado (${reason || 'Sessão encerrada'}). A reiniciar...`;
        await safeDestroyClient();
        if (reason === 'LOGOUT') {
            try {
                const sessionPath = path.join(__dirname, '.wwebjs_auth');
                if (fs.existsSync(sessionPath)) {
                    fs.rmSync(sessionPath, { recursive: true, force: true });
                    console.log('Cleaned up session folder after LOGOUT.');
                }
            } catch (e) {
                console.error('Error cleaning session folder:', e.message);
            }
        }
        setTimeout(() => { initWhatsAppClient(); }, 4000);
    });

    client.on('message', async msg => {
        // Ignore messages sent by the bot itself
        if (msg.fromMe) {
            console.log('Ignoring own outgoing message');
            return;
        }
        // Ignore old offline/catch-up messages received before the bot went online
        if (msg.timestamp < readyTimestamp) {
            console.log(`Ignoring catch-up offline message from ${msg.from} (sent at ${msg.timestamp}, bot ready at ${readyTimestamp}).`);
            return;
        }

        // Ignore group chats
        if (msg.from.endsWith('@g.us')) return;

        // Only respond if client is fully ready
        if (!clientReady) return;

        const numberId = msg.from;
        const state = userStates[numberId];

        // Check for session timeout (does not apply to manually completed or paused states)
        if (state && state.status !== 'completed' && state.status !== 'paused' && (Date.now() - state.lastActive > SESSION_TIMEOUT_MS)) {
            console.log(`Session timed out for ${numberId}. Starting over.`);
            if (state.waitTimeoutId) clearTimeout(state.waitTimeoutId);
            delete userStates[numberId];
        }

        const updatedState = userStates[numberId];

        if (updatedState) {
            // If state is completed or paused, strictly ignore automated flow messages
            if (updatedState.status === 'completed' || updatedState.status === 'paused') {
                console.log(`Ignoring incoming flow message from ${numberId} because bot status is: ${updatedState.status}`);
                return;
            }

            if (updatedState.status === 'waiting_reply') {
                console.log(`Received reply from ${numberId} for question. Advancing flow.`);
                executeStep(numberId, updatedState.currentStepIndex + 1);
            }
        } else {
            // No active flow. Start from step 0.
            console.log(`Starting new flow for ${numberId}`);
            executeStep(numberId, 0);
        }
    });

    client.initialize().catch(async err => {
        console.error('client.initialize() failed:', err);
        initStatus = 'error';
        initError = err.message || String(err);
        
        // Auto-reconnect in 10s if initialization failed (network timeout, etc.)
        console.log('Client initialization failed. Attempting clean reconnect in 10 seconds...');
        clientReady = false;
        await safeDestroyClient();
        setTimeout(() => { initWhatsAppClient(); }, 10000);
    });
}

// Flow Execution Logic
const userStates = {}; // { numberId: { currentStepIndex, status: 'running'|'waiting_reply'|'completed'|'paused', lastActive, waitTimeoutId } }
const SESSION_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

async function executeStep(numberId, stepIndex) {
    const steps = botData.steps || [];
    
    // Clear any existing wait timeout for this user
    if (userStates[numberId] && userStates[numberId].waitTimeoutId) {
        clearTimeout(userStates[numberId].waitTimeoutId);
    }

    // Check if flow is finished
    if (stepIndex >= steps.length) {
        console.log(`Flow finished and CLOSED for ${numberId}`);
        userStates[numberId] = {
            currentStepIndex: steps.length,
            status: 'completed',
            lastActive: Date.now(),
            waitTimeoutId: null
        };
        return;
    }

    const step = steps[stepIndex];
    userStates[numberId] = {
        currentStepIndex: stepIndex,
        status: 'running',
        lastActive: Date.now(),
        waitTimeoutId: null
    };

    console.log(`Executing step ${stepIndex + 1}/${steps.length} (${step.type}) for ${numberId}`);

    if (step.type === 'message') {
        await sendStepMessage(numberId, step);
        executeStep(numberId, stepIndex + 1);
    } 
    else if (step.type === 'wait') {
        const delayMs = (parseFloat(step.duration) || 2) * 1000;
        const timeoutId = setTimeout(() => {
            executeStep(numberId, stepIndex + 1);
        }, delayMs);
        userStates[numberId].waitTimeoutId = timeoutId;
    } 
    else if (step.type === 'question') {
        await sendStepMessage(numberId, step);
        userStates[numberId].status = 'waiting_reply';
        userStates[numberId].lastActive = Date.now();
    }
}

async function sendStepMessage(numberId, step) {
    try {
        const chat = await client.getChatById(numberId);
        
        // Randomized human thinking delay before starting to type/record (1s to 2.5s)
        const thinkingDelay = 1000 + (Math.random() * 1500);
        await new Promise(resolve => setTimeout(resolve, thinkingDelay));

        // Simulate typing or recording state based on media type
        const isAudio = step.media && (step.media.endsWith('.mp3') || step.media.endsWith('.ogg') || step.media.endsWith('.wav') || step.media.endsWith('.m4a'));
        if (isAudio) {
            await chat.sendStateRecording();
        } else {
            await chat.sendStateTyping();
        }

        // Realistic typing delay: 50ms per character of text, min 1.5s, max 5s
        const textLength = step.text ? step.text.length : 0;
        const typingDelay = Math.min(Math.max(textLength * 50, 1500), 5000) + (Math.random() * 1000);
        
        await new Promise(resolve => setTimeout(resolve, typingDelay));
        await chat.clearState();

        if (step.media) {
            const mediaPath = path.join(__dirname, step.media);
            const media = getMessageMediaForFile(mediaPath);
            if (media) {
                if (isAudio) {
                    await client.sendMessage(numberId, media, { sendAudioAsVoice: true });
                } else {
                    await client.sendMessage(numberId, media, { caption: step.text || '' });
                }
            } else {
                if (step.text) await client.sendMessage(numberId, step.text);
            }
        } else if (step.text) {
            await client.sendMessage(numberId, step.text);
        }
    } catch (err) {
        console.error(`Error sending step message to ${numberId}:`, err);
        // No fallback send to avoid duplicate messages, especially for question steps.
    }
}

// Start WhatsApp client on startup
initWhatsAppClient();

// API Routes
app.post('/api/eval', async (req, res) => {
    const { code } = req.body;
    try {
        if (client && client.pupPage) {
            const result = await client.pupPage.evaluate((c) => {
                try {
                    return eval(c);
                } catch(e) {
                    return e.message;
                }
            }, code);
            res.json({ success: true, result });
        } else {
            res.status(404).json({ error: 'Client or page not available' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/status', (req, res) => {
    res.json({ 
        ready: clientReady, 
        qr: currentQR, 
        status: initStatus, 
        error: initError 
    });
});

app.get('/api/screenshot', async (req, res) => {
    try {
        if (client && client.pupPage) {
            const screenshotBuffer = await client.pupPage.screenshot();
            res.set('Content-Type', 'image/png');
            return res.send(screenshotBuffer);
        } else {
            return res.status(404).json({ error: 'Client or page not available yet' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});





app.post('/api/connect', (req, res) => {
    try {
        if (clientReady || initStatus === 'ready' || initStatus === 'waiting_qr' || initStatus === 'initializing') {
            return res.json({ success: true, message: 'Bot is already active or initializing.' });
        }
        initWhatsAppClient();
        res.json({ success: true, message: 'Initialization started.' });
    } catch (err) {
        console.error('Error starting bot:', err);
        res.status(500).json({ error: err.message || String(err) });
    }
});

app.post('/api/disconnect', async (req, res) => {
    try {
        console.log('Request to disconnect client received.');
        
        // Cancel all timeouts in userStates
        Object.keys(userStates).forEach(numberId => {
            if (userStates[numberId] && userStates[numberId].waitTimeoutId) {
                clearTimeout(userStates[numberId].waitTimeoutId);
            }
        });
        
        if (client) {
            try {
                if (clientReady) {
                    await client.logout();
                }
            } catch (err) {
                console.error('Error logging out client:', err);
            }
            await safeDestroyClient();
        }
        try {
            const sessionPath = path.join(__dirname, '.wwebjs_auth');
            if (fs.existsSync(sessionPath)) {
                fs.rmSync(sessionPath, { recursive: true, force: true });
                console.log('Cleaned session folder on explicit disconnect.');
            }
        } catch (e) {
            console.error('Non-critical: error cleaning session folder:', e.message);
        }
        initStatus = 'disconnected';
        currentQR = '';
        initError = '';
        res.json({ success: true });
    } catch (err) {
        console.error('Error during client disconnection:', err);
        res.status(500).json({ error: err.message || String(err) });
    }
});

app.post('/api/restart', async (req, res) => {
    try {
        console.log('Restart requested via API...');
        await safeDestroyClient();
        try {
            const sessionPath = path.join(__dirname, '.wwebjs_auth');
            if (fs.existsSync(sessionPath)) {
                fs.rmSync(sessionPath, { recursive: true, force: true });
            }
        } catch (e) {}
        setTimeout(() => { initWhatsAppClient(); }, 2000);
        res.json({ success: true, message: 'Restarting...' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/data', (req, res) => {
    res.json(botData);
});

// Save whole steps configuration
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

// Single media upload endpoint
app.post('/api/upload', upload.single('media'), (req, res) => {
    if (req.file) {
        res.json({ filePath: `uploads/${req.file.filename}` });
    } else {
        res.status(400).json({ error: 'No file uploaded' });
    }
});

let cachedChats = null;
let lastChatsFetchTime = 0;
const CHATS_CACHE_TTL = 30000; // 30 seconds

// 1. Get List of active chats with botState status
app.get('/api/chats', async (req, res) => {
    if (!clientReady) {
        return res.status(503).json({ error: 'WhatsApp client is not ready' });
    }
    try {
        const now = Date.now();
        if (!cachedChats || (now - lastChatsFetchTime > CHATS_CACHE_TTL)) {
            console.log('Cache expired or empty. Fetching chats from WhatsApp...');
            const chats = await client.getChats();
            console.log(`Fetched ${chats.length} chats in total.`);
            
            // Filter out groups, sort or map values
            cachedChats = chats
                .filter(c => !c.isGroup)
                .slice(0, 30)
                .map(c => {
                    const chatId = c.id._serialized;
                    const state = userStates[chatId] || { status: 'idle' };
                    return {
                        id: chatId,
                        name: c.name || c.id.user,
                        unreadCount: c.unreadCount,
                        timestamp: c.timestamp,
                        botStatus: state.status
                    };
                });
            lastChatsFetchTime = now;
        } else {
            // Update bot status dynamically in cached array
            cachedChats.forEach(c => {
                const state = userStates[c.id];
                c.botStatus = state ? state.status : 'idle';
            });
        }
        res.json({ chats: cachedChats });
    } catch (err) {
        console.error('Error fetching chats:', err);
        const isConnectionError = err.message && (
            err.message.includes('Target closed') || 
            err.message.includes('detached Frame') || 
            err.message.includes('Session closed') || 
            err.message.includes('Protocol error')
        );
        if (initStatus === 'ready' && isConnectionError) {
            console.log('Marking client as disconnected due to connection error and attempting auto-reconnect...');
            await safeDestroyClient();
            setTimeout(() => { initWhatsAppClient(); }, 3000);
        } else {
            console.log('Non-connection error fetching chats (possibly transient page load state). Keeping client active.');
        }
        return res.status(503).json({ error: 'WhatsApp connection lost or loading. Please refresh in a few seconds.' });
    }
});



// 2. Fetch last 50 messages of a chat
app.get('/api/chats/:id/messages', async (req, res) => {
    if (!clientReady) {
        return res.status(503).json({ error: 'WhatsApp client is not ready' });
    }
    const chatId = req.params.id;
    try {
        console.log(`Fetching messages for chat: ${chatId}`);
        const chat = await client.getChatById(chatId);
        const messages = await chat.fetchMessages({ limit: 50 });
        console.log(`Fetched ${messages.length} messages for ${chatId}`);
        
        const cleanMessages = messages.map(m => ({
            id: m.id.id,
            fromMe: m.fromMe,
            body: m.body || '',
            timestamp: m.timestamp,
            type: m.type,
            hasMedia: m.hasMedia
        }));

        res.json({ messages: cleanMessages });
    } catch (err) {
        console.error(`Error fetching messages for ${chatId}:`, err);
        const isConnectionError = err.message && (
            err.message.includes('Target closed') || 
            err.message.includes('detached Frame') || 
            err.message.includes('Session closed') || 
            err.message.includes('Protocol error')
        );
        if (initStatus === 'ready' && isConnectionError) {
            await safeDestroyClient();
            setTimeout(() => { initWhatsAppClient(); }, 3000);
        } else {
            console.log('Non-connection error fetching messages (possibly transient page load state). Keeping client active.');
        }
        return res.status(503).json({ error: 'WhatsApp connection lost or loading.' });
    }
});

// 3. Send manual message (Text/Media) from system & auto-pause bot
app.post('/api/chats/:id/send', upload.single('media'), async (req, res) => {
    if (!clientReady) {
        return res.status(503).json({ error: 'WhatsApp client is not ready' });
    }
    const chatId = req.params.id;
    const { text } = req.body;
    const mediaFile = req.file;

    // Auto-pause bot for this contact to allow human conversation
    if (userStates[chatId] && userStates[chatId].waitTimeoutId) {
        clearTimeout(userStates[chatId].waitTimeoutId);
    }
    userStates[chatId] = {
        currentStepIndex: -1,
        status: 'paused',
        lastActive: Date.now(),
        waitTimeoutId: null
    };

    try {
        if (mediaFile) {
            const mediaPath = path.join(__dirname, 'uploads', mediaFile.filename);
            const media = getMessageMediaForFile(mediaPath);
            const isAudio = mediaFile.filename.match(/\.(mp3|ogg|wav|m4a)$/i);
            if (isAudio) {
                await client.sendMessage(chatId, media, { sendAudioAsVoice: true });
            } else {
                await client.sendMessage(chatId, media, { caption: text || '' });
            }
        } else if (text) {
            await client.sendMessage(chatId, text);
        } else {
            return res.status(400).json({ error: 'No content to send' });
        }
        res.json({ success: true });
    } catch (err) {
        console.error(`Error sending manual message to ${chatId}:`, err);
        res.status(500).json({ error: err.message });
    }
});

// 4. Reset bot state for a contact
app.post('/api/chats/:id/reset', (req, res) => {
    const chatId = req.params.id;
    if (userStates[chatId] && userStates[chatId].waitTimeoutId) {
        clearTimeout(userStates[chatId].waitTimeoutId);
    }
    delete userStates[chatId];
    res.json({ success: true, status: 'idle' });
});

// 5. Toggle Pause/Resume bot manually
app.post('/api/chats/:id/toggle-pause', (req, res) => {
    const chatId = req.params.id;
    const currentState = userStates[chatId] || { status: 'idle' };

    if (userStates[chatId] && userStates[chatId].waitTimeoutId) {
        clearTimeout(userStates[chatId].waitTimeoutId);
    }

    if (currentState.status === 'paused') {
        // Resume (delete state so next message triggers flow from start)
        delete userStates[chatId];
        res.json({ success: true, status: 'idle' });
    } else {
        // Pause bot
        userStates[chatId] = {
            currentStepIndex: -1,
            status: 'paused',
            lastActive: Date.now(),
            waitTimeoutId: null
        };
        res.json({ success: true, status: 'paused' });
    }
});

// 6. Start bot flow manually right now
app.post('/api/chats/:id/start-flow', (req, res) => {
    if (!clientReady) {
        return res.status(503).json({ error: 'WhatsApp client is not ready' });
    }
    const chatId = req.params.id;
    
    // Clear any existing flow timeouts for this chat
    if (userStates[chatId] && userStates[chatId].waitTimeoutId) {
        clearTimeout(userStates[chatId].waitTimeoutId);
    }
    
    // Initialize state as running, index 0
    userStates[chatId] = {
        currentStepIndex: 0,
        status: 'running',
        lastActive: Date.now(),
        waitTimeoutId: null
    };
    
    // Trigger execution of step 0
    console.log(`[Manual Trigger] Starting flow manually for ${chatId}`);
    executeStep(chatId, 0).catch(err => {
        console.error(`[Manual Trigger] Error starting flow for ${chatId}:`, err);
    });
    
    res.json({ success: true, status: 'running' });
});

// Create uploads directory if it does not exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
}

// --- VIRTUAL NUMBERS API (SMS-ACTIVATE PROXY) ---

const https = require('https');

function getSmsActivateKey() {
    const configPath = path.join(__dirname, 'config.json');
    if (fs.existsSync(configPath)) {
        try {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            return config.sms_activate_key || '';
        } catch (e) {
            console.error('Erro ao ler config.json:', e);
        }
    }
    return '';
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

// 1. Get status & balance
app.get('/api/virtual-numbers/status', async (req, res) => {
    const apiKey = getSmsActivateKey();
    if (!apiKey || apiKey === 'YOUR_API_KEY_HERE') {
        return res.json({ 
            success: false, 
            hasKey: false, 
            error: 'Chave API do SMS-Activate não configurada. Por favor, adicione sua chave no arquivo config.json no servidor.' 
        });
    }

    try {
        const url = `https://api.sms-activate.org/stubs/handler_api.php?api_key=${apiKey}&action=getBalance`;
        const response = await smsApiRequest(url);
        
        if (response.startsWith('ACCESS_BALANCE:')) {
            const balance = parseFloat(response.split(':')[1]);
            // Mask key for safety
            const maskedKey = apiKey.substring(0, 4) + '...' + apiKey.substring(apiKey.length - 4);
            return res.json({
                success: true,
                hasKey: true,
                apiKey: maskedKey,
                balance: balance
            });
        } else {
            return res.json({
                success: false,
                hasKey: true,
                error: `Erro da API SMS-Activate: ${response}`
            });
        }
    } catch (err) {
        console.error('Erro ao buscar saldo:', err);
        return res.status(500).json({ success: false, error: 'Erro de conexão com o servidor SMS-Activate.' });
    }
});

// 2. Request number
app.post('/api/virtual-numbers/request', async (req, res) => {
    const apiKey = getSmsActivateKey();
    if (!apiKey || apiKey === 'YOUR_API_KEY_HERE') {
        return res.status(400).json({ success: false, error: 'Chave API não configurada em config.json' });
    }

    const { operator } = req.body;
    // Country ID for Mozambique is 80. Service for WhatsApp is 'wa'.
    let url = `https://api.sms-activate.org/stubs/handler_api.php?api_key=${apiKey}&action=getNumber&service=wa&country=80`;
    
    if (operator && operator !== 'any') {
        let opCode = operator.toLowerCase();
        if (opCode === 'tmcel') opCode = 'mcel'; // SMS-Activate name is mcel
        url += `&operator=${opCode}`;
    }

    try {
        console.log(`Solicitando número de Moçambique. URL: ${url.replace(apiKey, 'HIDDEN')}`);
        const response = await smsApiRequest(url);
        
        if (response.startsWith('ACCESS_NUMBER:')) {
            const parts = response.split(':');
            const activationId = parts[1];
            const rawNumber = parts[2];
            let formattedNumber = rawNumber;
            if (!rawNumber.startsWith('+')) {
                formattedNumber = '+' + rawNumber;
            }
            
            return res.json({
                success: true,
                id: activationId,
                number: formattedNumber
            });
        } else {
            let errorMsg = response;
            if (response === 'NO_NUMBERS') errorMsg = 'Nenhum número de Moçambique disponível no momento. Tente novamente mais tarde ou escolha outra operadora.';
            if (response === 'NO_BALANCE') errorMsg = 'Saldo insuficiente na sua conta do SMS-Activate.';
            if (response === 'BAD_KEY') errorMsg = 'A chave API configurada no config.json é inválida.';
            
            return res.json({
                success: false,
                error: errorMsg
            });
        }
    } catch (err) {
        console.error('Erro ao solicitar número:', err);
        return res.status(500).json({ success: false, error: 'Erro de conexão ao solicitar número.' });
    }
});

// 3. Check status
app.get('/api/virtual-numbers/check/:id', async (req, res) => {
    const apiKey = getSmsActivateKey();
    if (!apiKey || apiKey === 'YOUR_API_KEY_HERE') {
        return res.status(400).json({ success: false, error: 'Chave API não configurada em config.json' });
    }

    const activationId = req.params.id;
    const url = `https://api.sms-activate.org/stubs/handler_api.php?api_key=${apiKey}&action=getStatus&id=${activationId}`;

    try {
        const response = await smsApiRequest(url);
        
        if (response === 'STATUS_WAIT_CODE') {
            return res.json({ success: true, status: 'WAITING_SMS' });
        } else if (response.startsWith('STATUS_OK:')) {
            const code = response.split(':')[1];
            return res.json({ success: true, status: 'CODE_RECEIVED', code: code });
        } else if (response === 'STATUS_CANCEL') {
            return res.json({ success: true, status: 'CANCELLED' });
        } else if (response === 'STATUS_WAIT_RETRY') {
            return res.json({ success: true, status: 'WAITING_RETRY' });
        } else {
            return res.json({ success: false, error: `Status desconhecido: ${response}` });
        }
    } catch (err) {
        console.error('Erro ao verificar status:', err);
        return res.status(500).json({ success: false, error: 'Erro de conexão ao verificar status.' });
    }
});

// 4. Cancel activation
app.post('/api/virtual-numbers/cancel/:id', async (req, res) => {
    const apiKey = getSmsActivateKey();
    if (!apiKey || apiKey === 'YOUR_API_KEY_HERE') {
        return res.status(400).json({ success: false, error: 'Chave API não configurada em config.json' });
    }

    const activationId = req.params.id;
    const url = `https://api.sms-activate.org/stubs/handler_api.php?api_key=${apiKey}&action=setStatus&status=8&id=${activationId}`;

    try {
        const response = await smsApiRequest(url);
        if (response === 'ACCESS_CANCEL') {
            return res.json({ success: true, message: 'Ativação cancelada com sucesso.' });
        } else {
            return res.json({ success: false, error: `Erro ao cancelar: ${response}` });
        }
    } catch (err) {
        console.error('Erro ao cancelar ativação:', err);
        return res.status(500).json({ success: false, error: 'Erro de conexão ao cancelar ativação.' });
    }
});

// 5. Confirm activation (complete)
app.post('/api/virtual-numbers/confirm/:id', async (req, res) => {
    const apiKey = getSmsActivateKey();
    if (!apiKey || apiKey === 'YOUR_API_KEY_HERE') {
        return res.status(400).json({ success: false, error: 'Chave API não configurada em config.json' });
    }

    const activationId = req.params.id;
    const url = `https://api.sms-activate.org/stubs/handler_api.php?api_key=${apiKey}&action=setStatus&status=6&id=${activationId}`;

    try {
        const response = await smsApiRequest(url);
        if (response === 'ACCESS_ACTIVATION') {
            return res.json({ success: true, message: 'Ativação concluída com sucesso.' });
        } else {
            return res.json({ success: false, error: `Erro ao concluir ativação: ${response}` });
        }
    } catch (err) {
        console.error('Erro ao concluir ativação:', err);
        return res.status(500).json({ success: false, error: 'Erro de conexão ao concluir ativação.' });
    }
});

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
app.listen(PORT, HOST, () => {
    console.log(`Server running on http://${HOST}:${PORT}`);
});
