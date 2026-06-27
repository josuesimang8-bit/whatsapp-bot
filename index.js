const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

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

function getChromiumPath() {
    const paths = [
        process.env.PUPPETEER_EXECUTABLE_PATH,
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome'
    ];
    
    for (const p of paths) {
        if (p && fs.existsSync(p)) {
            console.log(`Found Chromium executable at: ${p}`);
            return p;
        }
    }
    
    console.log('No specific Chromium executable found, letting Puppeteer choose default.');
    return undefined;
}

function initWhatsAppClient() {
    if (clientReady || initStatus === 'ready' || initStatus === 'waiting_qr' || initStatus === 'initializing') {
        console.log('Client is already active or initializing.');
        return;
    }

    console.log('Initializing WhatsApp client...');
    initStatus = 'initializing';
    initError = '';
    currentQR = '';

    client = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--disable-gpu',
                '--disable-extensions',
                '--disable-software-rasterizer'
            ],
            executablePath: getChromiumPath()
        }
    });

    client.on('qr', (qr) => {
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
        console.log('Client is ready!');
        clientReady = true;
        currentQR = '';
        initStatus = 'ready';
        initError = '';
    });

    client.on('authenticated', () => {
        console.log('Authenticated successfully!');
    });

    client.on('auth_failure', (msg) => {
        console.error('Authentication failed:', msg);
        clientReady = false;
        initStatus = 'error';
        initError = 'Authentication failed: ' + (msg || 'Check details.');
    });

    client.on('disconnected', (reason) => {
        console.log('Client disconnected:', reason);
        clientReady = false;
        currentQR = '';
        initStatus = 'disconnected';
    });

    client.on('message', async msg => {
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

    client.initialize().catch(err => {
        console.error('client.initialize() failed:', err);
        initStatus = 'error';
        initError = err.message || String(err);
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
            if (fs.existsSync(mediaPath)) {
                const media = MessageMedia.fromFilePath(mediaPath);
                await client.sendMessage(numberId, media, { caption: step.text || '' });
            } else {
                if (step.text) await client.sendMessage(numberId, step.text);
            }
        } else if (step.text) {
            await client.sendMessage(numberId, step.text);
        }
    } catch (err) {
        console.error(`Error sending step message to ${numberId}:`, err);
        // Fallback send direct
        try {
            if (step.media) {
                const mediaPath = path.join(__dirname, step.media);
                if (fs.existsSync(mediaPath)) {
                    const media = MessageMedia.fromFilePath(mediaPath);
                    await client.sendMessage(numberId, media, { caption: step.text || '' });
                } else {
                    if (step.text) await client.sendMessage(numberId, step.text);
                }
            } else if (step.text) {
                await client.sendMessage(numberId, step.text);
            }
        } catch (fallbackErr) {
            console.error('Fallback send failed:', fallbackErr);
        }
    }
}

// Start WhatsApp client on startup
initWhatsAppClient();

// API Routes
app.get('/api/status', (req, res) => {
    res.json({ 
        ready: clientReady, 
        qr: currentQR, 
        status: initStatus, 
        error: initError 
    });
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
            
            try {
                await client.destroy();
            } catch (err) {
                console.error('Error destroying client:', err);
            }
        }
        
        client = null;
        clientReady = false;
        initStatus = 'disconnected';
        currentQR = '';
        initError = '';
        res.json({ success: true });
    } catch (err) {
        console.error('Error during client disconnection:', err);
        res.status(500).json({ error: err.message || String(err) });
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

// LIVE CHAT API ENDPOINTS

// 1. Get List of active chats with botState status
app.get('/api/chats', async (req, res) => {
    if (!clientReady) {
        return res.status(503).json({ error: 'WhatsApp client is not ready' });
    }
    try {
        console.log('Fetching chats from WhatsApp...');
        const chats = await client.getChats();
        console.log(`Fetched ${chats.length} chats in total.`);
        
        // Filter out groups, sort or map values
        const cleanChats = chats
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
        console.log(`Sending ${cleanChats.length} filtered chats to dashboard.`);
        res.json({ chats: cleanChats });
    } catch (err) {
        console.error('Error fetching chats:', err);
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
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
            const media = MessageMedia.fromFilePath(mediaPath);
            await client.sendMessage(chatId, media, { caption: text || '' });
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

// Create uploads directory if it does not exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
}

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
