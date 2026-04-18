// ==========================================
// WhatsApp Sender — Standalone HTTP Server
// Run this in a SEPARATE terminal: node wa-sender.js
// bot.js talks to this via HTTP on port 3210
// ==========================================
require('dotenv').config();
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const http = require('http');
const path = require('path');
const fs = require('fs');

const PORT = 3210;

const CHAPTER_GROUP_MAP = {
    'KODUVALLY': '120363408203900284@g.us',
    'MANJERI': '120363406348392031@g.us',
    'PERINTHALMANNA': '120363423624359405@g.us',
    'VENGARA': '120363425493882488@g.us',
    'PALAKKAD': '120363408553527114@g.us',
    'KANNUR': '120363427413358835@g.us',
    'EDAPPAL': '120363406276491354@g.us',
    'KONDOTTY': '120363424681010488@g.us',
    'TRISSUR': '120363423851339877@g.us',
    'WANDOOR': '120363405995339272@g.us',
    'ERANAKULAM': '120363407239889206@g.us',
    'TIRURANGADI': '120363408623875282@g.us',
    'VATAKARA': '120363423729744708@g.us',
    'WAYANAD': '120363424744419511@g.us',
    'JEDDAH': '120363426331295799@g.us',
    'JIZAN': '120363422497793378@g.us',
    'MANGLORE': '120363407251423617@g.us',
    'KASARGOD': '120363408986045744@g.us',
    'MALAPPURAM': '120363425407630575@g.us',
    'TIRUR': '120363425155347486@g.us',
    'CALICUT': '120363422623453757@g.us',
    'KOTTAKKAL': '120363425180729639@g.us',
    'SAUDI EASTERN (DAMMAM)': '120363424204221586@g.us',
    'SAUDI EASTERN': '120363424204221586@g.us',
    'RIYADH': '120363424431866970@g.us',
    'DAWADMI': '120363424988382493@g.us',
    'OMAN': '120363407596223587@g.us',
};

let isReady = false;
let waClient = null;
let consecutiveFails = 0;
const MAX_FAILS = 3;
let isRestarting = false;

async function refreshWAPage() {
    try {
        const page = waClient.pupPage;
        if (page && !page.isClosed()) {
            console.log('🔄 Refreshing WhatsApp page to recover frame...');
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
            // Wait for WhatsApp web to fully load after refresh
            await new Promise(r => setTimeout(r, 8000));
            console.log('✅ Page refreshed successfully.');
        }
    } catch (err) {
        console.log('⚠️ Page refresh failed:', err.message);
    }
}

async function sendWithRetry(chatId, content, options = {}, maxRetries = 2) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            await waClient.sendMessage(chatId, content, options);
            return; // Success
        } catch (e) {
            const msg = (e.message || '').toUpperCase();
            const isFrameError = msg.includes('DETACHED') || msg.includes('CONTEXT') || msg.includes('CLOSED');

            if (isFrameError && attempt < maxRetries) {
                console.log(`⚠️ Frame detached (attempt ${attempt + 1}/${maxRetries + 1}), refreshing page...`);
                await refreshWAPage();
                continue; // Retry after refresh
            }
            throw e; // Non-frame error or out of retries
        }
    }
}

async function smartRestart() {
    if (isRestarting) return;
    isRestarting = true;
    console.log('🔄 [SMART RESTART] Browser crash/freeze detected! Forcing a fresh launch...');
    isReady = false;
    try {
        if (waClient) {
            if (waClient.pupBrowser) {
                const childProcess = waClient.pupBrowser.process();
                if (childProcess) childProcess.kill('SIGKILL');
            }
            await waClient.destroy();
        }
    } catch (e) {
        console.log('⚠️ Ignored destroy error (browser already dead):', e.message);
    }
    
    setTimeout(() => {
        // Clear lingering lock file if Puppeteer crashed without cleanup
        const lockPath = path.join(__dirname, 'wa_session', 'session', 'SingletonLock');
        if (fs.existsSync(lockPath)) {
            try { fs.unlinkSync(lockPath); console.log('🧹 Cleared stale browser lock file.'); } catch (e) {}
        }

        console.log('🚀 Relaunching WhatsApp browser...');
        client.initialize().catch(err => {
            console.error('❌ Failed to relaunch:', err.message);
            console.log('⚠️ Exiting process for a clean manual or auto-restart.');
            process.exit(1); // Exit process if completely stuck so the user (or PM2) can cleanly restart
        });
        isRestarting = false;
        consecutiveFails = 0;
    }, 5000); // Give the OS a few seconds to fully release ports/locks
}

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(__dirname, 'wa_session') }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    }
});

client.on('qr', qr => {
    console.log('\n📱 Scan this QR with your WhatsApp:\n');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('✅ WhatsApp connected and ready!');
    isReady = true;
    waClient = client;
});

client.on('auth_failure', () => {
    console.error('❌ Auth failed. Delete wa_session folder and restart.');
});

client.on('disconnected', reason => {
    console.log('⚠️ Disconnected:', reason);
    isReady = false;
    waClient = null;

    // Auto-reconnect after a short delay
    console.log('🔄 Attempting to reconnect in 5 seconds...');
    setTimeout(async () => {
        try {
            console.log('🔄 Re-initializing WhatsApp client...');
            await client.initialize();
        } catch (e) {
            console.error('❌ Reconnect failed:', e.message);
            console.log('🔄 Will retry in 30 seconds...');
            setTimeout(() => {
                client.initialize().catch(err => {
                    console.error('❌ Second reconnect attempt failed:', err.message);
                    console.log('⚠️ Please restart wa-sender.js manually.');
                });
            }, 30000);
        }
    }, 5000);
});

// Prevent crashes from Puppeteer execution context errors
process.on('unhandledRejection', (err) => {
    console.error('⚠️ Unhandled rejection (kept alive):', err?.message || err);
});
process.on('uncaughtException', (err) => {
    console.error('⚠️ Uncaught exception (kept alive):', err?.message || err);
});

const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ready: isReady }));
    }

    // ── Send to personal WhatsApp chat by phone number ──
    if (req.method === 'POST' && req.url === '/send-personal') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { phone, imagePath, caption } = JSON.parse(body);

                if (!isReady || !waClient) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, error: 'WhatsApp not connected yet. Please wait and try again.' }));
                }

                if (!phone) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, error: 'No phone number provided' }));
                }

                // Format phone to WhatsApp chatId: strip leading + and non-digits, then append @c.us
                let cleanPhone = phone.replace(/[^\d]/g, '');
                // If Indian number without country code, add 91
                if (cleanPhone.length === 10) cleanPhone = '91' + cleanPhone;
                const chatId = cleanPhone + '@c.us';

                if (!imagePath) {
                    if (!caption) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ success: false, error: 'Must provide either imagePath or caption' }));
                    }
                    await sendWithRetry(chatId, caption);
                } else {
                    if (!fs.existsSync(imagePath)) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ success: false, error: `Receipt image not found: ${imagePath}` }));
                    }

                    const media = MessageMedia.fromFilePath(imagePath);
                    await sendWithRetry(chatId, media, { caption: caption || '' });
                }

                console.log(`[WA] ✓ Receipt sent to personal chat: ${cleanPhone}`);
                consecutiveFails = 0; // Reset counter on success
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, sentTo: cleanPhone }));

            } catch (e) {
                console.error('[WA] Personal send error:', e.message);
                
                // Smart Restart Logic
                const errUpper = e.message.toUpperCase();
                if (errUpper.includes('DETACHED') || errUpper.includes('CONTEXT') || errUpper.includes('CLOSED') || errUpper.includes('PROTOCOL')) {
                    consecutiveFails++;
                    console.error(`⚠️ WhatsApp crash/freeze detected! (Fail ${consecutiveFails}/${MAX_FAILS})`);
                    if (consecutiveFails >= MAX_FAILS) {
                        smartRestart();
                    }
                }

                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    if (req.method !== 'POST' || req.url !== '/send') {
        res.writeHead(404);
        return res.end('Not found');
    }

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
        try {
            const { chapter, imagePath, caption } = JSON.parse(body);

            if (!isReady || !waClient) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: false, error: 'WhatsApp not connected yet. Please wait and try again.' }));
            }

            const groupId = CHAPTER_GROUP_MAP[chapter];
            if (!groupId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: false, error: `No WhatsApp group mapped for chapter: ${chapter}` }));
            }

            if (!imagePath) {
                // Text-only message
                if (!caption) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, error: 'Must provide either imagePath or caption' }));
                }
                await sendWithRetry(groupId, caption);
            } else {
                // Media message
                if (!fs.existsSync(imagePath)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, error: `Receipt image not found: ${imagePath}` }));
                }
                const media = MessageMedia.fromFilePath(imagePath);
                await sendWithRetry(groupId, media, { caption: caption || '' });
            }

            console.log(`[WA] ✓ Receipt sent to ${chapter}`);
            consecutiveFails = 0; // Reset counter on success
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));

        } catch (e) {
            console.error('[WA] Error:', e.message);
            
            // Smart Restart Logic
            const errUpper = e.message.toUpperCase();
            if (errUpper.includes('DETACHED') || errUpper.includes('CONTEXT') || errUpper.includes('CLOSED') || errUpper.includes('PROTOCOL')) {
                consecutiveFails++;
                console.error(`⚠️ WhatsApp crash/freeze detected! (Fail ${consecutiveFails}/${MAX_FAILS})`);
                if (consecutiveFails >= MAX_FAILS) {
                    smartRestart();
                }
            }

            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
    });
});

server.listen(PORT, () => {
    console.log(`🌐 WA Sender running on port ${PORT}`);
    console.log('🚀 Starting WhatsApp...\n');
    client.initialize();
});