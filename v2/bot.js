require('dotenv').config();
const { Telegraf, Markup, session } = require('telegraf');
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');

const receiptDir = path.join(__dirname, 'receipts');
const sessionDir = path.join(__dirname, 'user_session');
if (!fs.existsSync(receiptDir)) fs.mkdirSync(receiptDir);

// ==========================================
// PERSISTENT BROWSER — kept open for bot lifetime
// ==========================================
let globalContext = null;

async function ensureBrowser() {
    // Check if existing browser is still alive
    if (globalContext) {
        try {
            const pages = globalContext.pages();
            if (pages.length > 0) {
                await pages[0].url(); // Simple health check
            } else {
                await globalContext.newPage(); // Ensure at least one page exists if needed
            }
            console.log('[BROWSER] ✓ Reusing existing browser context');
            return { context: globalContext };
        } catch (e) {
            console.log('[BROWSER] ✗ Existing browser is dead, relaunching...');
            try { await globalContext.close(); } catch (_) { }
            globalContext = null;
        }
    }

    console.log('[BROWSER] Launching new persistent browser context...');
    globalContext = await chromium.launchPersistentContext(sessionDir, {
        headless: true,
        viewport: { width: 1280, height: 1000 },
        // args: ['--headless=new']
    });
    console.log('[BROWSER] ✓ Browser context launched and ready');
    return { context: globalContext };
}

async function closeBrowser() {
    if (globalContext) {
        try { await globalContext.close(); } catch (_) { }
        globalContext = null;
        console.log('[BROWSER] Browser context closed');
    }
}

const bot = new Telegraf(process.env.BOT_TOKEN);
const BACKUP_CHANNEL_ID = process.env.BACKUP_CHANNEL_ID || "-1003845761232";

// Global error handler — prevents crashes from network/stale query errors
bot.catch((err, ctx) => {
    const msg = err.message || '';
    if (msg.includes('query is too old') || msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT') || msg.includes('timed out') || msg.includes('TimeoutError')) {
        console.log(`⚠️ Non-fatal error (ignored): ${msg.substring(0, 100)}`);
    } else {
        console.error('❌ Bot error:', err);
    }
});

process.on('unhandledRejection', (err) => {
    const msg = err?.message || String(err);
    if (msg.includes('409') && msg.includes('Conflict')) {
        console.error('\n⛔ CONFLICT: Another bot instance started on a different PC!');
        console.error('   This instance has been disconnected by Telegram.');
        console.error('   Only ONE instance can run at a time per bot token.');
        console.error('   This instance will now exit. The OTHER PC is now in control.\n');
        process.exit(0);
    }
    console.error('⚠️ Unhandled rejection (kept alive):', msg);
});
process.on('uncaughtException', (err) => {
    const msg = err?.message || String(err);
    if (msg.includes('409') && msg.includes('Conflict')) {
        console.error('\n⛔ CONFLICT: Another bot instance started on a different PC!');
        console.error('   This instance will now exit.\n');
        process.exit(0);
    }
    console.error('⚠️ Uncaught exception (kept alive):', msg);
});

// ==========================================
// WHATSAPP SENDER — HTTP client
// Calls wa-sender.js running on port 3210
// ==========================================
const pendingWhatsApp = {};

async function waHttpRequest(endpoint, payload, maxRetries = 2) {
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        const result = await new Promise((resolve) => {
            const body = JSON.stringify(payload);
            const req = http.request({
                hostname: 'localhost',
                port: 3210,
                path: endpoint,
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); }
                    catch (e) { resolve({ success: false, error: 'Invalid response from WA sender' }); }
                });
            });
            req.on('error', (e) => {
                resolve({ success: false, error: `wa-sender.js not running. Start it with: node wa-sender.js` });
            });
            req.setTimeout(60000, () => { // Increased timeout for patience (up to 60s)
                req.destroy();
                resolve({ success: false, error: 'WA sender timed out' });
            });
            req.write(body);
            req.end();
        });

        if (result.success) return result;

        // "Patience": If WA Sender is not ready or timing out, retry automatically
        const isNotReady = result.error && (result.error.includes('not connected') || result.error.includes('timed out') || result.error.includes('not running') || result.error.includes('Detached') || result.error.includes('context'));
        if (isNotReady && attempt <= maxRetries) {
            console.log(`[BOT] WA sender seems busy/restarting. Pausing for 15s to retry ${endpoint} (Attempt ${attempt}/${maxRetries})...`);
            await new Promise(r => setTimeout(r, 15000));
        } else {
            return result;
        }
    }
}

async function sendReceiptToGroup(chapter, imagePath, caption) {
    return waHttpRequest('/send', { chapter, imagePath, caption });
}

async function sendReceiptToPersonal(phone, imagePath, caption) {
    return waHttpRequest('/send-personal', { phone, imagePath, caption });
}

// ==========================================
// SECURITY — Authorized Users Allowlist
// ==========================================
const AUTHORIZED_IDS = (process.env.AUTHORIZED_USERS || '')
    .split(',')
    .map(id => id.trim())
    .filter(id => id.length > 0)
    .map(Number);

if (AUTHORIZED_IDS.length === 0) {
    console.warn('⚠️  WARNING: AUTHORIZED_USERS is empty in .env — bot is open to everyone!');
} else {
    console.log(`🔒 Bot restricted to ${AUTHORIZED_IDS.length} authorized user(s).`);
}

// ==========================================
// ROBOT QUEUE MANAGEMENT — Support Parallel Workers
// ==========================================
let robotQueue = [];
const cancellationFlags = {};
let activeWorkers = 0;
const MAX_WORKERS = 3;

function addToQueue(ctx, donors, type) {
    const taskId = Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
    robotQueue.push({ ctx, donors, type, taskId });

    console.log(`[QUEUE] Added task. Queue size: ${robotQueue.length} | Active workers: ${activeWorkers}`);

    if (activeWorkers < MAX_WORKERS) {
        processNext();
    } else {
        const pos = robotQueue.length;
        ctx.reply(`⏳ **All Robot Slots Busy**\nYou are at position #${pos} in the queue. I will notify you automatically when a slot opens up!`,
            Markup.inlineKeyboard([[Markup.button.callback('🛑 Cancel Task', `canceltask_${taskId}`)]])
        );
    }
}

async function processNext() {
    if (robotQueue.length === 0 /* || activeWorkers >= MAX_WORKERS */) {
        return; // Handled by activeWorkers check below, but also if queue empty
    }

    if (activeWorkers >= MAX_WORKERS) return;

    const nextTask = robotQueue[0];
    if (cancellationFlags[nextTask.taskId]) {
        robotQueue.shift();
        console.log(`[QUEUE] Task ${nextTask.taskId} was cancelled before starting.`);
        setTimeout(processNext, 500);
        return;
    }

    activeWorkers++;
    const { ctx, donors, type, taskId } = robotQueue.shift();

    let page = null;

    try {
        await ctx.reply(`🚀 **It's your turn!** Processing your ${type === 'bulk' ? `${donors.length} receipts` : 'receipt'}...`,
            Markup.inlineKeyboard([[Markup.button.callback('🛑 Cancel', `canceltask_${taskId}`)]])
        );

        const { context } = await ensureBrowser();
        page = await context.newPage(); // Each worker gets its own page

        const traceDir = path.join(__dirname, 'traces');
        if (!fs.existsSync(traceDir)) fs.mkdirSync(traceDir, { recursive: true });
        const bulkTracePath = path.join(traceDir, `queue-trace-${taskId}.zip`);

        try {
            await context.tracing.start({ screenshots: true, snapshots: true });

            for (let i = 0; i < donors.length; i++) {
                if (cancellationFlags[taskId]) {
                    await ctx.reply(`❌ **Task Cancelled by User.** Stopping automation...`);
                    break;
                }

                const d = donors[i];
                let statusMsg = null;

                if (type === 'bulk') {
                    statusMsg = await ctx.reply(`⏳ [${i + 1}/${donors.length}] Processing **${d.name}**...`);
                }

                let res;
                let isSubmitTimeout = false;
                try {
                    res = await executeSingleAutomation(page, d, bulkTracePath);
                } catch (e) {
                    console.error(`❌ QUEUE ERROR [${i + 1}]:`, e.message);

                    if (e.message.startsWith('SESSION_EXPIRED')) {
                        await closeBrowser(); // Close so next task relaunches for fresh login
                        await ctx.reply(`🔒 **Session Expired!**\nThe bot got logged out of the website.\n\n**To fix:** Send a new receipt — the bot will relaunch the browser for manual login.`);
                        robotQueue = [];
                        return;
                    }

                    if (e.message.startsWith('SUBMIT_TIMEOUT::')) {
                        isSubmitTimeout = true;
                        const parts = e.message.split('::');
                        const debugImgPath = parts[1];
                        const details = parts.slice(2).join('::');
                        const label = `${type === 'bulk' ? `[${i + 1}/${donors.length}] ` : ''}`;
                        if (statusMsg) {
                            await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, `❌ ${label}Submit failed for **${d.name}** — screenshot attached 👇`).catch(() => { });
                        } else {
                            await ctx.reply(`❌ ${label}Submit failed for **${d.name}** — screenshot attached 👇`);
                        }
                        if (fs.existsSync(debugImgPath)) {
                            await ctx.replyWithPhoto({ source: debugImgPath }, { caption: `🔍 Debug: ${details.substring(0, 200)}` }).catch(() => { });
                        }
                        res = { success: false, error: `Submit timed out. See screenshot above.` };
                    } else if (e.message.startsWith('DOWNLOAD_FAILED')) {
                        const label = `${type === 'bulk' ? `[${i + 1}/${donors.length}] ` : ''}`;
                        const errMsg = `❌ ${label}**${d.name}**: Receipt download failed after 3 attempts. The donation was created but the receipt could not be downloaded. Please download it manually from the website.`;
                        if (statusMsg) {
                            await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, errMsg).catch(() => ctx.reply(errMsg));
                        } else {
                            await ctx.reply(errMsg);
                        }
                        res = { success: false, error: 'Download failed' };
                    } else {
                        res = { success: false, error: e.message };
                    }
                }

                if (res.success) {
                    if (statusMsg) {
                        const phase2Note = d.skipReceipts ? '' : '\n(Receipt will be downloaded in Phase 2)';
                        await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, `✅ [${i + 1}/${donors.length}] Added: **${d.name}**${phase2Note}`);
                    }
                } else if (!isSubmitTimeout) {
                    const errMsg = `❌ ${type === 'bulk' ? `[${i + 1}/${donors.length}] ` : ""}Failed to add: **${d.name}**\nError: ${res.error}`;
                    if (statusMsg) {
                        await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, errMsg).catch(() => ctx.reply(errMsg));
                    } else {
                        await ctx.reply(errMsg);
                    }
                    d.failedPhase1 = true;
                }

                if (i < donors.length - 1) await page.waitForTimeout(1000);
            }

            // --- PHASE 2: Refresh and Search for all added donors ---
            if (cancellationFlags[taskId]) return;

            const needsReceipts = donors.some(d => !d.skipReceipts && !d.failedPhase1);
            if (!needsReceipts) {
                await ctx.reply(`✅ All ${donors.length} donation(s) added to the website. No receipts needed. /new`);
            } else {
                await ctx.reply(`🔄 **Phase 2:** Refreshing page and downloading all ${donors.length} receipts...`);
                await page.goto('https://taawun.hadiacse.in/admin/finance', { waitUntil: 'domcontentloaded', timeout: 120000 });
                await page.waitForTimeout(3000); // Give the table time to load

                for (let i = 0; i < donors.length; i++) {
                    const d = donors[i];
                    if (d.failedPhase1 || d.skipReceipts) continue; // skip if failed or no receipt needed

                    let dlRes;
                    try {
                        dlRes = await downloadReceiptForDonor(page, d, bulkTracePath);
                    } catch (dlErr) {
                        // If the row wasn't found, refresh the page and retry once
                        if (dlErr.message.includes('Could not find row')) {
                            console.log(`[PHASE 2] Row not found for "${d.name}" — refreshing page and retrying...`);
                            const label = `${type === 'bulk' ? `[${i + 1}/${donors.length}] ` : ''}`;
                            await ctx.reply(`🔄 ${label}**${d.name}**: Not found, refreshing and retrying...`);
                            await page.goto('https://taawun.hadiacse.in/admin/finance', { waitUntil: 'domcontentloaded', timeout: 120000 });
                            await page.waitForTimeout(3000);
                            try {
                                dlRes = await downloadReceiptForDonor(page, d, bulkTracePath);
                            } catch (retryErr) {
                                console.error(`❌ PHASE 2 RETRY ERROR [${i + 1}]:`, retryErr.message);
                                const errMsg = `❌ ${label}**${d.name}**: Receipt search/download failed after retry. The donation was likely added, but couldn't find/download it. Error: ${retryErr.message}`;
                                await ctx.reply(errMsg);
                                dlRes = { success: false, error: retryErr.message };
                            }
                        } else {
                            console.error(`❌ PHASE 2 ERROR [${i + 1}]:`, dlErr.message);
                            const label = `${type === 'bulk' ? `[${i + 1}/${donors.length}] ` : ''}`;
                            const errMsg = `❌ ${label}**${d.name}**: Receipt search/download failed. The donation was likely added, but couldn't find/download it. Error: ${dlErr.message}`;
                            await ctx.reply(errMsg);
                            dlRes = { success: false, error: dlErr.message };
                        }
                    }

                    if (dlRes.success) {
                        const promoText = `\n-------------------------\nനിങ്ങൾ നൽകിയ ദാനം ഉത്തരേന്ത്യയിലുണ്ടാക്കിയ മാറ്റങ്ങൾ അറിയാൻ ഗ്രൂപ്പിൽ ജോയിൻ ചെയ്യുക :\nhttps://chat.whatsapp.com/J3m3BLKrMij4i7wWcYyTcg`;
                        const waCaption = `Receipt for ${d.name}${d.phone ? `\n${d.phone}` : ''}${promoText}`;
                        const tgCaption = `Receipt for ${d.name}${d.phone ? ` (${d.phone})` : ""}`;

                        const isPersonal = d.chapter === 'NONE' && d.phone;
                        const isRealChapter = d.chapter && d.chapter !== 'NONE';

                        if (isRealChapter) {
                            // AUTO-SEND to WhatsApp group for real chapters
                            const waResult = await sendReceiptToGroup(d.chapter, dlRes.path, waCaption);
                            if (waResult.success) {
                                await ctx.replyWithPhoto(
                                    { source: dlRes.path },
                                    { caption: `${tgCaption}\n\n✅ Auto-sent to WhatsApp group (${d.chapter})` }
                                );
                                console.log(`[WA AUTO] ✓ Sent to group ${d.chapter} for "${d.name}"`);
                            } else {
                                if (waResult.error && waResult.error.includes('No WhatsApp group mapped')) {
                                    const waKey = `wa_${taskId}_${i}`;
                                    pendingWhatsApp[waKey] = {
                                        imagePath: dlRes.path,
                                        chapter: d.chapter,
                                        caption: waCaption,
                                        isUnmapped: true
                                    };
                                    setTimeout(() => delete pendingWhatsApp[waKey], 10 * 60 * 1000);

                                    const kbButtons = [
                                        [Markup.button.callback(`⌨️ Send to Custom Number`, `customwa_${waKey}`)],
                                        [Markup.button.callback(`⏭ Skip`, `skipwa_${waKey}`)]
                                    ];

                                    await ctx.replyWithPhoto(
                                        { source: dlRes.path },
                                        { 
                                            caption: `${tgCaption}\n\n⚠️ Chapter ${d.chapter} is not mapped to a group.`,
                                            ...Markup.inlineKeyboard(kbButtons)
                                        }
                                    );
                                    console.log(`[WA AUTO] ✗ Unmapped group ${d.chapter} for "${d.name}"`);
                                } else {
                                    await ctx.replyWithPhoto(
                                        { source: dlRes.path },
                                        { caption: `${tgCaption}\n\n❌ Failed to auto-send to WhatsApp (${d.chapter}): ${waResult.error}` }
                                    );
                                    console.log(`[WA AUTO] ✗ Failed for group ${d.chapter}: ${waResult.error}`);
                                }
                            }
                        } else {
                            // Personal or None — show buttons as before
                            const waKey = `wa_${taskId}_${i}`;
                            pendingWhatsApp[waKey] = {
                                imagePath: dlRes.path,
                                chapter: d.chapter,
                                caption: waCaption,
                                ...(isPersonal ? { personalPhone: d.phone } : {})
                            };
                            setTimeout(() => delete pendingWhatsApp[waKey], 10 * 60 * 1000);

                            const kbButtons = [];
                            if (isPersonal) {
                                kbButtons.push([Markup.button.callback(`📱 Send to ${d.name}'s WhatsApp (${d.phone})`, `sendwa_${waKey}`)]);
                            }
                            kbButtons.push([Markup.button.callback(`⌨️ Send to Custom Number`, `customwa_${waKey}`)]);
                            kbButtons.push([Markup.button.callback(`⏭ Skip`, `skipwa_${waKey}`)]);

                            await ctx.replyWithPhoto(
                                { source: dlRes.path },
                                {
                                    caption: tgCaption + (d.chapter === 'NONE' && !d.phone ? '\n\n⚠️ No WhatsApp number — personal send not possible' : ''),
                                    ...Markup.inlineKeyboard(kbButtons)
                                }
                            );
                        }

                        // Backup
                        if (BACKUP_CHANNEL_ID) {
                            try {
                                await ctx.telegram.sendPhoto(BACKUP_CHANNEL_ID, { source: dlRes.path }, { caption: `📦 ${type.toUpperCase()} Backup: ${tgCaption}` });
                            } catch (backupErr) {
                                console.error(`[BACKUP ERROR] Could not send backup to ${BACKUP_CHANNEL_ID}:`, backupErr.message);
                            }
                        }
                    }
                }
            } // end if (needsReceipts)

        } finally {
            try {
                await context.tracing.stop({ path: bulkTracePath });
            } catch (te) { }
            if (page) await page.close().catch(() => { });
        }

        // Collect all successful receipts from this batch for master send button
        const batchKey = `batch_${taskId}`;
        const allPendingThisTask = Object.entries(pendingWhatsApp).filter(([key]) => key.startsWith(`wa_${taskId}_`));
        const successfulReceipts = allPendingThisTask
            .filter(([key, val]) => !val.isUnmapped)
            .map(([key, val]) => ({ key, ...val }));
        const unmappedCount = allPendingThisTask.length - successfulReceipts.length;

        if (successfulReceipts.length > 0) {
            // Only personal/none receipts remain — group ones were already auto-sent
            const chapterCounts = {};
            for (const r of successfulReceipts) {
                chapterCounts[r.chapter] = (chapterCounts[r.chapter] || 0) + 1;
            }
            const chapterList = Object.entries(chapterCounts).map(([ch, n]) => `${ch}: ${n}`).join(', ');

            pendingWhatsApp[batchKey] = { receipts: successfulReceipts };
            setTimeout(() => delete pendingWhatsApp[batchKey], 10 * 60 * 1000);

            let msg = `🏁 Processing complete. ${successfulReceipts.length} personal receipt(s) pending.\n📊 ${chapterList}`;
            if (unmappedCount > 0) msg += `\n⚠️ ${unmappedCount} receipt(s) unmapped. Please use their custom number buttons.`;
            msg += `\n\nSend all to their WhatsApp? /new`;

            await ctx.reply(msg, {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback(`📲 Send All to WhatsApp`, `sendall_${batchKey}`)],
                    [Markup.button.callback(`⏭ Skip All`, `skipall_${batchKey}`)]
                ])
            });
        } else {
            let msg = `🏁 Processing complete. All group receipts auto-sent ✅ /new`;
            if (unmappedCount > 0) msg = `🏁 Processing complete. ⚠️ ${unmappedCount} receipt(s) were unmapped. Please use their custom number buttons. /new`;
            await ctx.reply(msg);
        }

    } catch (globalErr) {
        console.error("❌ CRITICAL QUEUE ERROR:", globalErr);
        await ctx.reply("❌ A system error occurred while processing your queue request. /new");
    } finally {
        activeWorkers--;
        console.log(`[QUEUE] Worker finished. Active: ${activeWorkers} | Remaining: ${robotQueue.length}`);
        setTimeout(processNext, 500); // Check for next job
    }
}

bot.use(session());
bot.use((ctx, next) => {
    ctx.session = ctx.session || {};
    ctx.session.donation = ctx.session.donation || {};

    if (AUTHORIZED_IDS.length > 0) {
        const userId = ctx.from?.id;
        if (!userId || !AUTHORIZED_IDS.includes(userId)) {
            console.log(`🚫 Blocked unauthorized user: ${userId} (@${ctx.from?.username || 'unknown'})`);
            if (ctx.chat?.type === 'private') {
                return ctx.reply('🔒 This bot is private. You are not authorized to use it.');
            }
            return;
        }
    }

    return next();
});

const realChapters = [
    "KASARGOD", "KANNUR", "WAYANAD", "VATAKARA", "KODUVALLY",
    "CALICUT", "KONDOTTY", "MANJERI", "WANDOOR", "PERINTHALMANNA",
    "MALAPPURAM", "VENGARA", "KOTTAKKAL", "TIRUR", "TIRURANGADI",
    "EDAPPAL", "PALAKKAD", "TRISSUR", "ERANAKULAM", "SOUTH KERALA",
    "ABU DHABI", "AJMAN & UAQ", "AL AIN", "ANDHRA PRADESH", "BANGALORE", "BHIWANDI",
    "DAWADMI", "DUBAI", "FUJAIRAH", "GUWAHATI", "HYDERABAD", "JEDDAH", "JIZAN",
    "KUWAIT", "MANGLORE", "MUMBAI", "NATIONAL HADIA", "OMAN", "QATAR", "RAS AL KHAIMA",
    "RIYADH", "SAUDI EASTERN", "SEEMANCHAL", "SHARJAH", "SOUTHEAST ASIA",
    "TURKEY", "UK", "WEST BENGAL", "YANBU", "GAZWA UNION"
];

const chapterCodes = { "VENGARA": "VNG", "KASARGOD": "KSG", "KANNUR": "KNR", "MALAPPURAM": "MPM" };

// Map bot chapter names to website dropdown names (only needed when they differ)
const CHAPTER_WEBSITE_MAP = {
    'SAUDI EASTERN': 'SAUDI EASTERN (DAMMAM)',
};

function getChapterKeyboard(page) {
    const ITEMS_PER_PAGE = 20;
    const start = page * ITEMS_PER_PAGE;
    const end = start + ITEMS_PER_PAGE;
    const items = realChapters.slice(start, end);

    const buttons = items.map(name => Markup.button.callback(name, `chapter_${name}`));
    const grid = [];
    for (let i = 0; i < buttons.length; i += 2) {
        grid.push(buttons.slice(i, i + 2));
    }

    const navRow = [];
    if (page > 0) navRow.push(Markup.button.callback('⬅️ Prev', `page_${page - 1}`));
    if (end < realChapters.length) navRow.push(Markup.button.callback('Next ➡️', `page_${page + 1}`));
    if (navRow.length > 0) grid.push(navRow);

    if (page === 0 || end >= realChapters.length) {
        grid.push([Markup.button.callback('🚫 None', 'chapter_none')]);
    }

    return Markup.inlineKeyboard(grid);
}

const CURRENCY_MAP = [
    { keywords: ['inr', 'rs', 'rupee', 'rupees', '₹', 'രൂപ'], currency: '₹ INR' },
    { keywords: ['aed', 'dirham', 'dirhams'], currency: 'د.إ AED' },
    { keywords: ['sar', 'riyal', 'riyals'], currency: '﷼ SAR' },
    { keywords: ['kwd', 'kd', 'dinar', 'dinars'], currency: 'د.ك KWD' },
    { keywords: ['bhd', 'bd', 'baisa'], currency: '.د.ب BHD' },
    { keywords: ['omr', 'rial', 'rials'], currency: 'ر.ع. OMR' },
    { keywords: ['qar', 'qr', 'qatari'], currency: 'ر.ق QAR' },
];

const UNSUPPORTED_KEYWORDS = ['usd', 'eur', 'gbp', 'cad', 'aud', '$', '€', '£', 'dollar', 'euro', 'pound'];
const DEFAULT_CURRENCY = '₹ INR';

function validatePhone(raw) {
    if (!raw || raw.trim().length === 0) return { valid: true, phone: '' };
    let cleaned = raw.replace(/[\s\-]/g, '');
    const hasPlus = cleaned.startsWith('+');
    const digits = hasPlus ? cleaned.substring(1) : cleaned;
    if (!/^\d+$/.test(digits)) return { valid: false, phone: cleaned, error: 'Phone contains non-digit characters' };
    if (digits.length < 8 || digits.length > 15) return { valid: false, phone: cleaned, error: `Phone digit count (${digits.length}) must be between 8 and 15` };
    return { valid: true, phone: cleaned };
}

function extractAmount(rawLine) {
    const numericMatch = rawLine.match(/(\d+(?:\.\d{1,2})?)/);
    if (!numericMatch) return { amount: null, currency: DEFAULT_CURRENCY, explicit: false };
    const amount = parseFloat(numericMatch[1]);
    if (isNaN(amount) || amount <= 0) return { amount: null, currency: DEFAULT_CURRENCY, explicit: false };
    const lineLower = rawLine.toLowerCase();
    for (const { keywords, currency } of CURRENCY_MAP) {
        for (const kw of keywords) {
            if (kw.length === 1 && '₹'.includes(kw)) {
                if (rawLine.includes(kw)) return { amount, currency, explicit: true };
            } else {
                if (new RegExp(`(?:\\b|(?<=\\d))${kw}(?:\\b|$)`, 'i').test(lineLower)) return { amount, currency, explicit: true };
            }
        }
    }
    for (const kw of UNSUPPORTED_KEYWORDS) {
        if (kw.length === 1 && '$£€'.includes(kw)) {
            if (rawLine.includes(kw)) return { amount, currency: null, explicit: true, error: `Currency symbol "${kw}" is not supported by the system` };
        } else {
            if (new RegExp(`(?:\\b|(?<=\\d))${kw}(?:\\b|$)`, 'i').test(lineLower)) {
                return { amount, currency: null, explicit: true, error: `Currency "${kw.toUpperCase()}" is not supported` };
            }
        }
    }
    return { amount, currency: DEFAULT_CURRENCY, explicit: false };
}

const RECOGNIZED_LABELS = [
    'donor name', 'place', 'whatsapp number', 'amount', 'chapter',
    'c/o phone', 'c/o number', 'c/o mobile', 'c/o contact', 'c/o no',
    'care of phone', 'care of number', 'care of mobile', 'care of contact', 'care of no',
    'c/o', 'care of'
];

function matchLabel(line) {
    // Remove invisible formatting characters (like LRM, ZWSP used by WhatsApp/Telegram)
    line = line.replace(/[\u200B-\u200F\u202A-\u202E\uFEFF]/g, '').trim();
    const lineLower = line.toLowerCase();
    for (const label of RECOGNIZED_LABELS) {
        if (lineLower.startsWith(label)) {
            const rest = line.substring(label.length);
            const sepMatch = rest.match(/^.*?[:\-]\s*(.*)/);
            return { label, value: sepMatch ? sepMatch[1].trim() : rest.trim() };
        }
    }
    return null;
}

function parseDonorInput(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const labeledLines = [];
    for (const line of lines) {
        const match = matchLabel(line);
        if (match) labeledLines.push(match);
    }

    if (labeledLines.length > 0) {
        const fields = {};
        for (const { label, value } of labeledLines) fields[label] = value;
        const errors = [];
        const name = fields['donor name'];
        const place = fields['place'];
        const amountRaw = fields['amount'];
        if (!name || name.length === 0) errors.push('❌ Donor Name is not given');
        if (!place || place.length === 0) errors.push('❌ Place is not given');
        if (!amountRaw || amountRaw.length === 0) errors.push('❌ Amount is not given');
        let amount, currency, currencyExplicit;
        if (amountRaw) {
            const ar = extractAmount(amountRaw);
            amount = ar.amount;
            currency = ar.currency;
            currencyExplicit = ar.explicit;
            if (ar.error) errors.push(ar.error);
            if (!amount) errors.push('Amount must be a valid number greater than 0');
        }
        const phoneRaw = fields['whatsapp number'] || '';
        let phone = '';
        if (!phoneRaw || phoneRaw.length === 0) {
            errors.push('❌ WhatsApp Number is not given');
        } else {
            const pr = validatePhone(phoneRaw);
            if (!pr.valid) errors.push(`❌ WhatsApp Number is invalid: ${pr.error}`);
            else phone = pr.phone;
        }
        let careOf = fields['c/o'] || fields['care of'] || '';
        let careOfPhone = fields['c/o phone'] || fields['c/o number'] || fields['c/o mobile'] || fields['c/o contact'] || fields['c/o no'] ||
            fields['care of phone'] || fields['care of number'] || fields['care of mobile'] || fields['care of contact'] || fields['care of no'] || '';

        // Smart extraction: if careOf contains a number but careOfPhone is empty, try to separate them
        if (careOf && !careOfPhone) {
            const phoneInCareOf = careOf.match(/(?:^|[\s\-\:])(\d{8,15})(?:$|\b)/);
            if (phoneInCareOf) {
                careOfPhone = phoneInCareOf[1];
                careOf = careOf.replace(phoneInCareOf[0], '').trim();
                // Clean up trailing dashes/colons from name
                careOf = careOf.replace(/[\s\-\:]+$/, '').trim();
            }
        }
        if (errors.length > 0) return { success: false, mode: 'A', errors };
        const chapter = (fields['chapter'] || '').toUpperCase().trim();
        return { success: true, mode: 'A', data: { name, place, amount: String(amount), currency, currencyExplicit, phone, careOf, careOfPhone, chapter } };

    } else {
        if (lines.length < 2) return { success: false, mode: 'B', errors: [`Not enough data. Got ${lines.length} line(s).`] };
        let phone = '', careOf = '';
        let amountResult = null;
        const leadingText = [];
        const trailingText = [];
        let detectedSomething = false;
        for (const line of lines) {
            const coMatch = line.match(/^(?:c\/o|care\s+of)[\s:\-]*(.*)/i);
            if (coMatch) { careOf = coMatch[1].trim(); detectedSomething = true; continue; }
            const phoneCleaned = line.replace(/[\s\-]/g, '');
            const phoneDigits = phoneCleaned.startsWith('+') ? phoneCleaned.substring(1) : phoneCleaned;
            if (/^\d+$/.test(phoneDigits) && phoneDigits.length >= 8 && phoneDigits.length <= 15 && !phone) {
                phone = phoneCleaned; detectedSomething = true; continue;
            }
            if (!amountResult) {
                const ar = extractAmount(line);
                if (ar.amount) {
                    amountResult = ar;
                    if (ar.error) amountResult.validationError = ar.error;
                    detectedSomething = true; continue;
                }
            }
            if (!detectedSomething) leadingText.push(line);
            else trailingText.push(line);
        }
        const name = leadingText[0] || '';
        const place = leadingText[1] || '';
        if (trailingText.length >= 1 && !careOf) careOf = trailingText[0];
        let careOfPhone = '';
        // If careOf was found and looks like it contains a number, extract it
        if (careOf) {
            const phoneInCareOf = careOf.match(/(?:^|[\s\-\:])(\d{8,15})(?:$|\b)/);
            if (phoneInCareOf) {
                careOfPhone = phoneInCareOf[1];
                careOf = careOf.replace(phoneInCareOf[0], '').trim();
                careOf = careOf.replace(/[\s\-\:]+$/, '').trim();
            }
        }

        // Validate required fields
        const errors = [];
        if (!name || name.length === 0) errors.push('❌ Donor Name is not given');
        if (!place || place.length === 0) errors.push('❌ Place is not given');
        if (!amountResult || !amountResult.amount) errors.push('❌ Amount is not given');
        if (!phone || phone.length === 0) errors.push('❌ WhatsApp Number is not given');
        if (errors.length > 0) return { success: false, mode: 'B', errors };
        return { success: true, mode: 'B', data: { name, place, amount: String(amountResult.amount), currency: amountResult.currency, currencyExplicit: amountResult.explicit, phone, careOf, careOfPhone } };
    }
}

function validateDonorData(data) {
    const errors = [];
    if (!data.name || data.name.length === 0) errors.push('Donor Name is missing');
    if (!data.place || data.place.length === 0) errors.push('Place is missing');
    if (!data.amount || parseFloat(data.amount) <= 0) errors.push('Amount is invalid or zero');
    if (data.phone && data.phone.length > 0) {
        const pc = validatePhone(data.phone);
        if (!pc.valid) errors.push(`Phone invalid: ${pc.error}`);
    }
    return { valid: errors.length === 0, errors };
}

async function executeSingleAutomation(page, donorData, tracePath) {
    console.log(`[AUTOMATION] Starting for: ${donorData.name}`);
    let currentUrl = page.url();
    if (!currentUrl.includes('admin/finance')) {
        await page.goto('https://taawun.hadiacse.in/admin/finance', { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForTimeout(2000);
        currentUrl = page.url();
    }
    if (currentUrl.includes('/login') || currentUrl.includes('/signin') || currentUrl.includes('/auth')) {
        console.log('[AUTH] Login page detected — waiting for manual login (up to 2 minutes)...');
        const maxWait = 120000;
        const pollInterval = 3000;
        const startTime = Date.now();
        let loggedIn = false;
        while (Date.now() - startTime < maxWait) {
            await page.waitForTimeout(pollInterval);
            const url = page.url();
            if (!url.includes('/login') && !url.includes('/signin') && !url.includes('/auth')) {
                loggedIn = true;
                console.log(`[AUTH] ✓ Login detected! Now on: ${url}`);
                break;
            }
        }
        if (!loggedIn) throw new Error('SESSION_EXPIRED: Waited 2 minutes but no login detected.');
        await page.goto('https://taawun.hadiacse.in/admin/finance', { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForTimeout(2000);
    }

    const openModalBtn = page.locator('button:has-text("Add Payment")').first();
    await openModalBtn.waitFor({ state: 'visible', timeout: 120000 });

    // Retry clicking — if dialog doesn't appear within 15s, click again
    let dialogOpened = false;
    for (let clickAttempt = 1; clickAttempt <= 5; clickAttempt++) {
        await openModalBtn.click({ force: true });
        try {
            await page.waitForSelector('div[role="dialog"]', { state: 'visible', timeout: 15000 });
            dialogOpened = true;
            break;
        } catch (e) {
            console.log(`[MODAL] Click attempt ${clickAttempt}/5 — dialog didn't appear, retrying click...`);
            await page.waitForTimeout(2000);
        }
    }
    if (!dialogOpened) throw new Error('Add Payment dialog did not open after 5 click attempts');
    await page.waitForSelector('input[name="name"]', { state: 'visible' });
    await page.fill('input[name="name"]', donorData.name);
    await page.fill('input[placeholder="Enter place"]', donorData.place);
    await page.fill('input[name="amount"]', donorData.amount);
    await page.fill('input[name="phone"]', donorData.phone);
    if (donorData.careOf) await page.fill('input[name="careOf.name"]', donorData.careOf);
    if (donorData.careOfPhone) await page.fill('input[name="careOf.phone"]', donorData.careOfPhone);

    const dialog = page.locator('div[role="dialog"]');
    const currencyCombobox = dialog.getByRole('combobox', { name: 'Currency' });
    await currencyCombobox.click();
    const currencyCode = donorData.currency.split(' ').pop();
    const currencyOption = page.locator('role=option').filter({ hasText: new RegExp(`\\b${currencyCode}\\b`) });
    await currencyOption.waitFor({ state: 'visible', timeout: 60000 });
    await currencyOption.click();

    if (donorData.chapter && donorData.chapter !== 'NONE') {
        const chapterCombobox = dialog.getByRole('combobox', { name: 'Chapter (Optional)' });
        await chapterCombobox.click();
        const websiteChapterName = CHAPTER_WEBSITE_MAP[donorData.chapter] || donorData.chapter;
        const chapterOption = page.getByRole('option', { name: websiteChapterName, exact: true });
        await chapterOption.waitFor({ state: 'visible', timeout: 60000 });
        await chapterOption.click();
    }

    const submitBtn = page.locator('button[type="submit"]:has-text("Add Payment")');
    await submitBtn.waitFor({ state: 'visible', timeout: 120000 });
    await submitBtn.click({ force: true });

    try {
        await Promise.race([
            page.waitForSelector('div[role="dialog"]', { state: 'hidden', timeout: 120000 }),
            (async () => {
                await page.waitForFunction(() => {
                    const dialog = document.querySelector('div[role="dialog"]');
                    if (!dialog) return false;
                    const text = dialog.innerText || '';
                    return text.includes('error') || text.includes('Error') || text.includes('failed') || text.includes('invalid') || text.includes('already');
                }, { timeout: 120000 });
                const errorText = await page.evaluate(() => {
                    const d = document.querySelector('div[role="dialog"]');
                    return d ? d.innerText.substring(0, 300) : '';
                });
                throw new Error(`Payment rejected by site: "${errorText.replace(/\n/g, ' ')}"`);
            })(),
        ]);
    } catch (e) {
        if (e.message.startsWith('Payment rejected')) throw e;
        const debugPath = path.join(receiptDir, `debug-submit-${Date.now()}.png`);
        await page.screenshot({ path: debugPath, fullPage: false }).catch(() => { });
        const pageText = await page.evaluate(() => document.body.innerText.substring(0, 400)).catch(() => '');
        throw new Error(`SUBMIT_TIMEOUT::${debugPath}::Page text: ${pageText.replace(/\n/g, ' ')}`);
    }

    // Wait for Add Payment modal to close completely
    await page.waitForTimeout(1000);
    return { success: true, tracePath };
}

async function downloadReceiptForDonor(page, donorData, tracePath) {
    const cleanAmount = donorData.amount.replace(/[^0-9.]/g, '');
    const searchName = donorData.name.toLowerCase().trim();
    const searchPlace = (donorData.place || '').toLowerCase().trim();
    const searchPhone = (donorData.phone || '').replace(/\D/g, '');

    // Search the table — full name only, refresh page if not found after 2 attempts
    const searchInput = page.locator('input[placeholder*="Search"]');
    await searchInput.waitFor({ state: 'visible', timeout: 120000 });

    let tableRow = null;
    const MAX_REFRESH_CYCLES = 3; // up to 3 refresh cycles
    const ATTEMPTS_PER_CYCLE = 2; // 2 attempts before refreshing

    for (let cycle = 0; cycle < MAX_REFRESH_CYCLES && !tableRow; cycle++) {
        if (cycle > 0) {
            console.log(`[SEARCH] Cycle ${cycle + 1}/${MAX_REFRESH_CYCLES} — refreshing page and retrying...`);
            await page.goto('https://taawun.hadiacse.in/admin/finance', { waitUntil: 'domcontentloaded', timeout: 120000 });
            await page.waitForTimeout(3000);
            await searchInput.waitFor({ state: 'visible', timeout: 120000 });
        }

        await searchInput.click();
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(500);
        await searchInput.fill(searchName);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(3000);

        for (let attempt = 1; attempt <= ATTEMPTS_PER_CYCLE; attempt++) {
            const overallAttempt = cycle * ATTEMPTS_PER_CYCLE + attempt;
            const totalAttempts = MAX_REFRESH_CYCLES * ATTEMPTS_PER_CYCLE;
            try {
                const rows = await page.locator('table tbody tr').all();
                if (rows.length === 0) {
                    console.log(`[SEARCH] Attempt ${overallAttempt}/${totalAttempts} — no rows visible yet, retrying...`);
                    await page.waitForTimeout(2000);
                    continue;
                }

                // Collect all row data for matching
                const rowData = [];
                for (const row of rows) {
                    const cells = await row.locator('td').allInnerTexts().catch(() => []);
                    if (cells.length === 0) continue;
                    rowData.push({ row, cells });
                }

                for (const { row, cells } of rowData) {
                    const cellTexts = cells.map(c => c.toLowerCase().trim());
                    const rowTextFull = cellTexts.join(' ').replace(/\s+/g, ' ');
                    const rowTextNoCommas = rowTextFull.replace(/,/g, '');

                    // STRICT MATCHING: ALL fields must match
                    const normalizedSearchName = searchName.replace(/\s+/g, ' ').trim();
                    const nameMatch = cellTexts.some(c => c.replace(/\s+/g, ' ').includes(normalizedSearchName)) || rowTextFull.includes(normalizedSearchName);

                    const amountMatch = rowTextNoCommas.includes(cleanAmount);

                    const placeMatch = searchPlace ? (rowTextFull.includes(searchPlace)) : true;

                    let phoneMatch = true;
                    if (searchPhone && searchPhone.length >= 8) {
                        const rowDigits = rowTextFull.replace(/\D/g, '');
                        phoneMatch = rowDigits.includes(searchPhone);
                    }

                    if (nameMatch && amountMatch && placeMatch && phoneMatch) {
                        tableRow = row;
                        console.log(`[SEARCH] ✓ Matched row for "${donorData.name}" | place=${searchPlace} | amount=${cleanAmount} | phone=${searchPhone || 'none'}`);
                        break;
                    } else if (nameMatch || amountMatch) {
                        // Log partial matches for debugging
                        console.log(`[SEARCH] ✗ Partial match — name:${nameMatch} place:${placeMatch} amount:${amountMatch} phone:${phoneMatch} | row: ${rowTextFull.substring(0, 120)}`);
                    }
                }

                if (tableRow) break;

                // Debug: log what we see
                const preview = rowData.slice(0, 3).map(({ cells }) => cells.slice(0, 4).join(' | ')).join('\n    ');
                console.log(`[SEARCH] Attempt ${overallAttempt}/${totalAttempts} — ${rowData.length} rows, no match. Top rows:\n    ${preview}`);
                await page.waitForTimeout(2000);

            } catch (e) {
                console.log(`[SEARCH] Attempt ${overallAttempt}/${totalAttempts} — error: ${e.message}`);
                await page.waitForTimeout(2000);
            }
        }
    }

    if (!tableRow) {
        // Clear search before failing
        await searchInput.fill('').catch(() => { });
        await page.waitForTimeout(1000);
        throw new Error(`Could not find row matching "${donorData.name}" + amount "${cleanAmount}" after search.`);
    }

    // Click download button on the matched row
    const downloadButtonSelectors = ['button:has(.lucide-download)', 'a:has(.lucide-download)', '[aria-label*="Download"]'];
    let tableDownloadBtn = null;
    for (const selector of downloadButtonSelectors) {
        const btn = tableRow.locator(selector).first();
        if (await btn.isVisible().catch(() => false)) { tableDownloadBtn = btn; break; }
    }
    if (!tableDownloadBtn) {
        const buttons = await tableRow.locator('button, a').all();
        if (buttons.length > 0) tableDownloadBtn = buttons[buttons.length - 1];
        else throw new Error("No download button found on matched row");
    }
    await tableDownloadBtn.click({ force: true });

    const dialogElement = page.locator('div[role="dialog"]');
    await dialogElement.waitFor({ state: 'visible', timeout: 120000 });

    // Hard verification: reject if dialog doesn't contain the donor name
    try {
        const dialogText = await dialogElement.innerText();
        const dialogLower = dialogText.toLowerCase();
        if (!dialogLower.includes(searchName)) {
            console.log(`[VERIFY] ✗ Dialog does NOT contain "${donorData.name}" — WRONG RECEIPT! Closing dialog.`);
            const closeBtn = dialogElement.locator('button[aria-label="Close"], button:has(.lucide-x)').first();
            if (await closeBtn.isVisible().catch(() => false)) await closeBtn.click().catch(() => { });
            else await page.keyboard.press('Escape').catch(() => { });
            throw new Error(`Wrong receipt detected: dialog shows "${dialogText.substring(0, 150)}" but expected "${donorData.name}"`);
        }
        console.log(`[VERIFY] ✓ Dialog confirmed for "${donorData.name}"`);
    } catch (verifyErr) {
        if (verifyErr.message.startsWith('Wrong receipt')) throw verifyErr;
        console.log(`[VERIFY] Could not verify dialog: ${verifyErr.message}`);
    }

    let downloadReceiptBtn = null;
    for (const selector of ['button:has(.lucide-download)', 'button:has-text("Download Receipt")']) {
        const btn = dialogElement.locator(selector).first();
        if (await btn.isVisible().catch(() => false)) { downloadReceiptBtn = btn; break; }
    }
    if (!downloadReceiptBtn) throw new Error("Download button not found in modal");

    const chCode = chapterCodes[donorData.chapter] || donorData.chapter.substring(0, 3) || "REC";
    const phoneClean = donorData.phone.replace(/\D/g, '') || 'nophone';
    const uniqueId = Date.now();
    const fileName = `${chCode}-${phoneClean}-${uniqueId}.png`;
    const savePath = path.join(receiptDir, fileName);

    let downloaded = false;
    for (let attempt = 1; attempt <= 3 && !downloaded; attempt++) {
        const timeout = 60000 + (attempt - 1) * 20000;
        try {
            const pageDownloadPromise = page.waitForEvent('download', { timeout });
            const contextDownloadPromise = page.context().waitForEvent('page', { timeout: 15000 })
                .then(async (newPage) => {
                    const dl = await newPage.waitForEvent('download', { timeout: timeout - 15000 });
                    return dl;
                }).catch(() => null);
            await downloadReceiptBtn.click({ force: true });
            const download = await Promise.race([
                pageDownloadPromise,
                contextDownloadPromise.then(dl => { if (!dl) throw new Error('no popup download'); return dl; })
            ]);
            await download.saveAs(savePath);
            downloaded = true;
        } catch (dlErr) {
            if (attempt < 3) await page.waitForTimeout(1500);
        }
    }
    if (!downloaded) throw new Error(`DOWNLOAD_FAILED: Could not download receipt for "${donorData.name}" after 3 attempts.`);

    // Close dialog to prep for next search
    const closeBtn = dialogElement.locator('button[aria-label="Close"], button:has(.lucide-x)').first();
    if (await closeBtn.isVisible().catch(() => false)) await closeBtn.click().catch(() => { });
    else await page.keyboard.press('Escape').catch(() => { });
    await dialogElement.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => { });

    // Clear search box for next iteration
    await page.fill('input[placeholder*="Search"]', '');
    await page.waitForTimeout(500);

    return { success: true, path: savePath, fileName, tracePath };
}

// ==========================================
// TELEGRAM COMMANDS
// ==========================================
bot.command('start', (ctx) => {
    return ctx.reply('👋 Welcome! Use /new to start a new donation receipt.');
});

bot.command('new', (ctx) => {
    ctx.session.step = 'select_mode';
    ctx.session.donation = {};
    ctx.session.chapterMode = null;
    ctx.session.skipReceipts = false;
    return ctx.reply(
        "How would you like to assign chapters?",
        Markup.inlineKeyboard([
            [Markup.button.callback('🔀 Mixed Chapters', 'mode_mixed')],
            [Markup.button.callback('📋 Choose Chapter', 'mode_choose')],
            [Markup.button.callback('� Personal WhatsApp', 'mode_none')],
            [Markup.button.callback('📝 Add Only (No Receipts)', 'mode_addonly')]
        ])
    );
});

bot.action(/^page_(\d+)$/, async (ctx) => {
    const page = parseInt(ctx.match[1]);
    await ctx.answerCbQuery();
    try { await ctx.editMessageText("Select Chapter:", getChapterKeyboard(page)); } catch (e) { }
});

bot.action('mode_mixed', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.chapterMode = 'mixed';
    ctx.session.step = 'awaiting_data';
    return ctx.editMessageText('Mixed Chapters Mode\nEach donor block must include a Chapter: line.\n\nPaste details now:');
});

bot.action('mode_choose', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.chapterMode = 'single';
    ctx.session.step = 'select_chapter';
    return ctx.editMessageText("Select Chapter:", getChapterKeyboard(0));
});

bot.action('mode_none', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.chapterMode = 'none';
    ctx.session.donation.chapter = 'NONE';
    ctx.session.step = 'awaiting_data';
    return ctx.editMessageText('� **Personal WhatsApp Mode**\nReceipts will be sent directly to each donor\'s personal WhatsApp using their phone number.\n\nMake sure to include the WhatsApp number for each donor!\n\nPaste details now:');
});

bot.action('mode_addonly', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.chapterMode = 'single';
    ctx.session.skipReceipts = true;
    ctx.session.step = 'select_chapter';
    return ctx.editMessageText('📝 **Add Only Mode**\nDonations will be added to the site but NO receipts will be downloaded.\n\nSelect Chapter:', getChapterKeyboard(0));
});

bot.action(/^chapter_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.donation.chapter = ctx.match[1].toUpperCase();
    ctx.session.step = 'awaiting_data';
    return ctx.reply(`✅ Chapter: ${ctx.session.donation.chapter}\nPaste details now:`);
});

function generateBulkPreview(donors, batchId) {
    let text = `📦 **Bulk Preview (${donors.length} entries):**\n\n`;
    const buttons = [];
    donors.forEach((d, i) => {
        const isIncluded = d.included !== false;
        text += `${isIncluded ? '✅' : '❌ ~~'} **Donor ${i + 1}** ${isIncluded ? '' : '~~ (SKIPPED)'}\n`;
        text += `👤 Name: ${d.name}\n`;
        text += `📍 Place: ${d.place}\n`;
        text += `💰 Amount: ${d.amount} ${d.currency}\n`;
        if (d.phone) text += `📞 WhatsApp: ${d.phone}\n`;
        if (d.careOf) text += `👥 C/o: ${d.careOf}\n`;
        if (d.careOfPhone) text += `📱 C/o Phone: ${d.careOfPhone}\n`;
        text += `🏷 Chapter: ${d.chapter || 'NONE'}\n`;
        text += `──────────────────\n`;
        buttons.push(Markup.button.callback(`${isIncluded ? '✅' : '❌'} ${i + 1}`, `toggle_${batchId}_${i}`));
    });
    const includedCount = donors.filter(d => d.included !== false).length;
    const keyboard = [];
    for (let i = 0; i < buttons.length; i += 5) keyboard.push(buttons.slice(i, i + 5));
    keyboard.push([
        Markup.button.callback(`🚀 Confirm (${includedCount})`, `confirm_bulk_${batchId}`),
        Markup.button.callback('❌ Cancel', 'cancel_process')
    ]);
    return { text, keyboard: Markup.inlineKeyboard(keyboard) };
}

bot.command('cancel_custom', (ctx) => {
    if (ctx.session && ctx.session.awaitingCustomNumber) {
        ctx.session.awaitingCustomNumber = null;
        return ctx.reply("❌ Custom number entry cancelled. You can still use the buttons on the previous receipt message.");
    }
});

bot.on('text', async (ctx, next) => {
    if (ctx.session && ctx.session.awaitingCustomNumber) {
        const waKey = ctx.session.awaitingCustomNumber;
        const pending = pendingWhatsApp[waKey];
        
        if (ctx.message.text.trim() === '/cancel_custom') {
            ctx.session.awaitingCustomNumber = null;
            return ctx.reply("❌ Custom number entry cancelled.");
        }

        if (!pending) {
            ctx.session.awaitingCustomNumber = null;
            return ctx.reply("❌ This receipt has expired or was already sent.");
        }
        
        const phoneRaw = ctx.message.text.trim();
        const { valid, phone, error } = validatePhone(phoneRaw);
        
        if (!valid) {
            return ctx.reply(`❌ Invalid number: ${error}. Please reply with a valid number or /cancel_custom`);
        }
        
        await ctx.reply(`⏳ Sending receipt to ${phone}...`);
        const result = await sendReceiptToPersonal(phone, pending.imagePath, pending.caption);
        
        if (result.success) {
            await ctx.reply(`✅ Successfully sent receipt to custom number: ${phone}`);
            delete pendingWhatsApp[waKey];
            ctx.session.awaitingCustomNumber = null;
        } else {
            await ctx.reply(`❌ Failed to send: ${result.error}. Try another number or /cancel_custom`);
        }
        return;
    }

    if (ctx.session.step !== 'awaiting_data') return next();
    const blocks = ctx.message.text.split(/\n\s*\n/).map(b => b.trim()).filter(b => b.length > 0);
    const donorResults = [];
    const globalErrors = [];
    const isMixed = ctx.session.chapterMode === 'mixed';

    for (let i = 0; i < blocks.length; i++) {
        const result = parseDonorInput(blocks[i]);
        if (!result.success) {
            globalErrors.push(`Block ${i + 1}: ${result.errors.join(', ')}`);
        } else {
            const donorData = { ...result.data, included: true };
            if (isMixed) {
                // In mixed mode, chapter must come from the text
                if (!donorData.chapter || donorData.chapter.length === 0) {
                    globalErrors.push(`Block ${i + 1}: "Chapter" label is required in Mixed mode`);
                    continue;
                }
                const chapterUpper = donorData.chapter.toUpperCase();
                if (!realChapters.includes(chapterUpper)) {
                    globalErrors.push(`Block ${i + 1}: Unknown chapter "${donorData.chapter}". Check spelling against the chapter list.`);
                    continue;
                }
                donorData.chapter = chapterUpper;
            } else {
                // Single or None mode: override with session chapter
                donorData.chapter = ctx.session.donation.chapter || 'NONE';
            }
            donorResults.push(donorData);
        }
    }
    if (globalErrors.length > 0) {
        return ctx.reply(`❌ **Input Rejected (${blocks.length} blocks detected)**\n\n` + globalErrors.map(e => `• ${e}`).join('\n') + `\n\nEnsure each donor block is separated by an empty line. /new`);
    }
    const batchId = Date.now().toString(36);
    ctx.session.batches = ctx.session.batches || {};
    ctx.session.batches[batchId] = donorResults;
    const { text, keyboard } = generateBulkPreview(donorResults, batchId);
    return ctx.reply(text, keyboard);
});

bot.action(/^toggle_(.+)_(\d+)$/, async (ctx) => {
    const batchId = ctx.match[1];
    const index = parseInt(ctx.match[2]);
    await ctx.answerCbQuery();
    if (ctx.session.batches && ctx.session.batches[batchId] && ctx.session.batches[batchId][index]) {
        ctx.session.batches[batchId][index].included = !ctx.session.batches[batchId][index].included;
        const { text, keyboard } = generateBulkPreview(ctx.session.batches[batchId], batchId);
        try { await ctx.editMessageText(text, { ...keyboard, parse_mode: 'Markdown' }); } catch (e) { }
    }
});

bot.action('confirm_robot', async (ctx) => {
    await ctx.answerCbQuery();
    const donor = (ctx.session.bulkDonors && ctx.session.bulkDonors[0]) || ctx.session.donation;
    const validation = validateDonorData(donor);
    if (!validation.valid) return ctx.editMessageText(`🛑 **Validation Failed:**\n${validation.errors.join('\n')} /new`);
    if (ctx.session.skipReceipts) donor.skipReceipts = true;
    addToQueue(ctx, [donor], 'single');
    await ctx.editMessageText(`✅ Added to queue. You'll be notified when processing starts.`);
});

bot.action(/^confirm_bulk_(.+)$/, async (ctx) => {
    const batchId = ctx.match[1];
    await ctx.answerCbQuery();
    const allDonors = ctx.session.batches && ctx.session.batches[batchId];
    if (!allDonors || allDonors.length === 0) return ctx.reply("No data found for this batch. It may have expired.");
    const selectedDonors = allDonors.filter(d => d.included !== false);
    if (selectedDonors.length === 0) return ctx.reply("⚠️ No donors selected. Please toggle at least one ✅. /new");
    if (ctx.session.skipReceipts) selectedDonors.forEach(d => d.skipReceipts = true);
    addToQueue(ctx, selectedDonors, 'bulk');
    await ctx.editMessageText(`✅ **${selectedDonors.length}** donors added to queue. You'll be notified when your turn comes!`);
    ctx.session.step = null;
    delete ctx.session.batches[batchId]; // cleanup
});

bot.action('cancel_process', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.step = null;
    return ctx.editMessageText("❌ Process cancelled. Use /new to start again. /new");
});

bot.action(/^canceltask_(.+)$/, async (ctx) => {
    const taskId = ctx.match[1];
    cancellationFlags[taskId] = true;
    
    const queueIndex = robotQueue.findIndex(item => item.taskId === taskId);
    if (queueIndex !== -1) {
        robotQueue.splice(queueIndex, 1);
        await ctx.editMessageText(`❌ Task cancelled from queue.`);
    } else {
        await ctx.editMessageText(`🛑 Cancellation requested. The robot will stop processing this batch shortly.`);
    }
});

// ==========================================
// WHATSAPP SEND / SKIP BUTTON HANDLERS
// ==========================================
bot.action(/^sendwa_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery('Sending to WhatsApp...');
    const waKey = ctx.match[1];
    const pending = pendingWhatsApp[waKey];
    if (!pending) return; // Already sent or expired — ignore duplicate click
    delete pendingWhatsApp[waKey]; // Delete immediately to prevent double-send

    let result;
    let successMsg;
    if (pending.personalPhone) {
        // Send to personal WhatsApp chat
        result = await sendReceiptToPersonal(pending.personalPhone, pending.imagePath, pending.caption);
        successMsg = `✅ Sent to personal WhatsApp (${pending.personalPhone}) /new`;
    } else {
        // Send to chapter group
        result = await sendReceiptToGroup(pending.chapter, pending.imagePath, pending.caption);
        successMsg = `✅ Sent to ${pending.chapter} WhatsApp group /new`;
    }

    if (result.success) {
        await ctx.editMessageCaption(
            `${ctx.callbackQuery.message.caption}\n\n${successMsg}`
        ).catch(() => ctx.reply(successMsg));
    } else {
        await ctx.reply(`❌ WhatsApp send failed: ${result.error} /new`);
    }
});

bot.action(/^customwa_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const waKey = ctx.match[1];
    if (!pendingWhatsApp[waKey]) {
        return ctx.editMessageCaption(
            `${ctx.callbackQuery.message.caption}\n\n❌ This receipt has expired.`
        ).catch(() => ctx.reply("❌ This receipt has expired."));
    }
    ctx.session.awaitingCustomNumber = waKey;
    return ctx.reply("📝 Please type the WhatsApp number to send this receipt to (with country code, e.g., 919876543210). To cancel, send /cancel_custom", Markup.forceReply());
});

bot.action(/^skipwa_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery('Skipped');
    const waKey = ctx.match[1];
    delete pendingWhatsApp[waKey];
    await ctx.editMessageCaption(
        `${ctx.callbackQuery.message.caption}\n\n⏭ WhatsApp send skipped /new`
    ).catch(() => { });
});

bot.command('stats', (ctx) => {
    const files = fs.readdirSync(receiptDir);
    return ctx.reply(`📊 **Daily Report**\nTotal Receipts today: ${files.length} /new`);
});

// ==========================================
// GRACEFUL LAUNCH — handles multi-instance conflicts
// Only ONE bot instance can poll Telegram at a time per token.
// This launch will forcefully take over from any other running instance.
// ==========================================
async function launchBot() {
    let retries = 0;
    const MAX_RETRIES = 5;

    while (retries < MAX_RETRIES) {
        try {
            // Force-clear any existing polling session before starting
            await bot.telegram.deleteWebhook({ drop_pending_updates: true });
            await bot.launch({ dropPendingUpdates: true });
            console.log('🤖 Bot Ready! (Native Download Mode)');
            console.log('⚠️  Remember: Only ONE instance of this bot can run at a time.');
            console.log('   If you start the bot on another PC, this one will stop receiving updates.');
            return; // Success — exit the retry loop
        } catch (err) {
            if (err.message && err.message.includes('409')) {
                retries++;
                const waitSec = Math.min(5 * retries, 30);
                console.log(`⚠️ Conflict (409): Another bot instance is running.`);
                console.log(`   Retry ${retries}/${MAX_RETRIES} in ${waitSec}s... (the other instance should stop soon)`);
                await new Promise(r => setTimeout(r, waitSec * 1000));
            } else {
                console.error('❌ Failed to launch bot:', err.message);
                process.exit(1);
            }
        }
    }

    console.error('❌ Could not start bot after multiple retries.');
    console.error('   Another instance is still running on a different PC.');
    console.error('   Please STOP the bot on the other PC first, then try again.');
    process.exit(1);
}

launchBot();

// ── MASTER SEND ALL ──
bot.action(/^sendall_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery('Sending all to WhatsApp...');
    const batchKey = ctx.match[1];
    const batch = pendingWhatsApp[batchKey];

    if (!batch || !batch.receipts) return; // Already sent or expired — ignore duplicate click

    // Delete immediately to prevent double-send on rapid clicks
    delete pendingWhatsApp[batchKey];
    for (const receipt of batch.receipts) delete pendingWhatsApp[receipt.key];

    await ctx.editMessageText(
        `⏳ Sending ${batch.receipts.length} receipt(s) to WhatsApp groups...`,
        { parse_mode: 'Markdown' }
    );

    let sent = 0;
    let failed = 0;
    const sentChapters = {};
    const failedChapters = {};

    for (const receipt of batch.receipts) {
        let result;
        let label;
        if (receipt.personalPhone) {
            result = await sendReceiptToPersonal(receipt.personalPhone, receipt.imagePath, receipt.caption);
            label = `Personal (${receipt.personalPhone})`;
        } else {
            result = await sendReceiptToGroup(receipt.chapter, receipt.imagePath, receipt.caption);
            label = receipt.chapter;
        }
        if (result.success) {
            sent++;
            sentChapters[label] = (sentChapters[label] || 0) + 1;
        } else {
            failed++;
            failedChapters[label] = (failedChapters[label] || 0) + 1;
        }
        await new Promise(r => setTimeout(r, 1000));
    }

    let summary;
    if (failed === 0) {
        const details = Object.entries(sentChapters).map(([ch, n]) => `${ch}: ${n}`).join(', ');
        summary = `✅ All ${sent} receipt(s) sent! (${details}) /new`;
    } else {
        const sentDetails = Object.entries(sentChapters).map(([ch, n]) => `✅ ${ch}: ${n}`).join('\n');
        const failDetails = Object.entries(failedChapters).map(([ch, n]) => `❌ ${ch}: ${n}`).join('\n');
        summary = `⚠️ Sent: ${sent} | Failed: ${failed}\n${sentDetails}\n${failDetails} /new`;
    }

    await ctx.editMessageText(summary, { parse_mode: 'Markdown' });
});

bot.action(/^skipall_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery('Skipped');
    const batchKey = ctx.match[1];
    const batch = pendingWhatsApp[batchKey];
    if (batch) {
        for (const receipt of batch.receipts) delete pendingWhatsApp[receipt.key];
        delete pendingWhatsApp[batchKey];
    }
    await ctx.editMessageText('⏭ WhatsApp send skipped for all receipts. /new');
});