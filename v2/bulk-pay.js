// ==========================================
// TaaWun Bulk Payment Recorder
// Reads an Excel file and records payments
// on the Mahallu/Community sponsorship panel
// Run: node bulk-pay.js
// ==========================================
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const XLSX = require('xlsx');
require('dotenv').config();

const USER_DATA_DIR = path.join(__dirname, 'user_session');
const BASE_URL = 'https://taawun.hadiacse.in';

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});
const ask = (question) => new Promise((resolve) => rl.question(question, resolve));
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ── Color helpers for terminal output ──
const C = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    gray: '\x1b[90m',
    bgRed: '\x1b[41m',
    bgGreen: '\x1b[42m',
};

function printHeader() {
    console.log(`\n${C.cyan}${C.bright}${'='.repeat(55)}`);
    console.log(`   TaaWun Bulk Payment Recorder`);
    console.log(`${'='.repeat(55)}${C.reset}\n`);
}

function printRow(idx, total, name, status, color = C.reset) {
    const progress = `[${String(idx).padStart(String(total).length, ' ')}/${total}]`;
    console.log(`${C.bright}${progress}${C.reset} ${color}${status}${C.reset} ${C.bright}${name}${C.reset}`);
}

// ── Normalize strings for comparison ──
function normalize(str) {
    return (str || '').trim().toUpperCase().replace(/\s+/g, ' ');
}

function normalizePhone(phone) {
    // Strip all non-digit chars, drop leading country codes (91 for India)
    let digits = (phone || '').replace(/[^\d]/g, '');
    if (digits.length > 10 && digits.startsWith('91')) digits = digits.substring(2);
    return digits;
}

// ── Fuzzy Mahallu matching ──
// Malayalam place names vary in spelling (Thayyilakkadav vs THEYYILAKKADAVU)
// Strip vowels to create consonant skeletons and compare
function consonantSkeleton(str) {
    return normalize(str).replace(/[AEIOU\s]/g, '');
}

function fuzzyPlaceMatch(excelPlace, webPlace) {
    const a = normalize(excelPlace);
    const b = normalize(webPlace);
    // Exact or substring match
    if (a.includes(b) || b.includes(a)) return true;
    // One starts with the other (handles trailing suffixes like 'U')
    if (a.startsWith(b.substring(0, 5)) || b.startsWith(a.substring(0, 5))) return true;
    // Consonant skeleton match (handles vowel differences)
    const skelA = consonantSkeleton(excelPlace);
    const skelB = consonantSkeleton(webPlace);
    if (skelA.length >= 4 && skelB.length >= 4) {
        if (skelA.includes(skelB) || skelB.includes(skelA)) return true;
    }
    return false;
}

// Check if an error indicates the browser/page crashed
function isCrashError(msg) {
    const m = (msg || '').toLowerCase();
    return m.includes('target page') || m.includes('context or browser') || m.includes('has been closed') ||
           m.includes('target closed') || m.includes('session closed') || m.includes('connection closed');
}

// ── Read & parse Excel ──
function readExcel(filePath) {
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    // Map columns — support flexible column names
    const entries = [];
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const keys = Object.keys(row);

        // Try to find columns by common names
        const findCol = (patterns) => {
            for (const key of keys) {
                const k = key.trim().toLowerCase();
                for (const p of patterns) {
                    if (k.includes(p)) return row[key];
                }
            }
            return '';
        };

        const name = String(findCol(['name', 'sponsor'])).trim();
        const phone = String(findCol(['phone', 'mobile', 'number', 'whatsapp'])).trim();
        const amount = String(findCol(['amount', 'payment', 'paid'])).trim();
        const place = String(findCol(['place', 'mahallu', 'location'])).trim();

        if (!name) {
            console.log(`${C.yellow}⚠️  Row ${i + 2}: Skipping — no name found${C.reset}`);
            continue;
        }
        if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
            console.log(`${C.yellow}⚠️  Row ${i + 2}: Skipping "${name}" — invalid amount "${amount}"${C.reset}`);
            continue;
        }

        entries.push({
            rowNum: i + 2, // Excel row number (1-indexed header + data)
            name,
            phone,
            amount: String(parseFloat(amount)), // Clean number
            place,
        });
    }
    return entries;
}

// ── Print a preview table ──
function printPreview(entries) {
    console.log(`\n${C.cyan}${C.bright}Found ${entries.length} entries to process:${C.reset}\n`);

    // Simple table
    const nameW = Math.min(30, Math.max(10, ...entries.map(e => e.name.length)));
    const phoneW = 12;
    const amountW = 10;
    const placeW = Math.min(20, Math.max(8, ...entries.map(e => e.place.length)));

    const header = `${'#'.padEnd(4)} ${'Name'.padEnd(nameW)} ${'Phone'.padEnd(phoneW)} ${'Amount'.padEnd(amountW)} ${'Place/Mahallu'.padEnd(placeW)}`;
    console.log(`${C.bright}${header}${C.reset}`);
    console.log(`${'-'.repeat(header.length)}`);

    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        console.log(
            `${String(i + 1).padEnd(4)} ` +
            `${e.name.substring(0, nameW).padEnd(nameW)} ` +
            `${e.phone.padEnd(phoneW)} ` +
            `${('₹' + e.amount).padEnd(amountW)} ` +
            `${e.place.substring(0, placeW).padEnd(placeW)}`
        );
    }
    console.log();
}

// ── Main automation ──
async function processEntry(page, entry, idx, total) {
    const { name, phone, amount, place } = entry;

    // 1. Clear search and search by PHONE NUMBER (more unique than name)
    const searchBox = page.locator('input[placeholder*="Search"]');
    await searchBox.fill('');
    await sleep(300);

    const searchTerm = phone ? normalizePhone(phone) : name;
    const searchType = phone ? 'phone' : 'name';
    console.log(`${C.gray}   Searching by ${searchType}: "${searchTerm}"${C.reset}`);
    await searchBox.fill(searchTerm);
    await sleep(2500); // Wait for search debounce + results

    // 2. Look through all table rows for a match
    let rows = await page.locator('table tbody tr').all();

    if (rows.length === 0) {
        // Fallback: If we searched by phone and found nothing, try searching by name instead
        if (searchType === 'phone') {
            console.log(`${C.yellow}   ⚠️ Phone search found nothing. Retrying with name: "${name}"${C.reset}`);
            await searchBox.fill('');
            await sleep(300);
            await searchBox.fill(name);
            await sleep(2500); // 1.5s is usually enough for debounce, but being safe
            
            rows = await page.locator('table tbody tr').all();
            if (rows.length === 0) {
                return { success: false, reason: `No search results found for phone "${phone}" OR name "${name}"` };
            }
        } else {
            return { success: false, reason: `No search results found when searching by ${searchType}: "${searchTerm}"` };
        }
    }

    let matchedRow = null;
    let matchDetails = '';

    for (const row of rows) {
        const cells = await row.locator('td').allTextContents();
        if (cells.length < 6) continue;

        // Actual table columns (from screenshot):
        // 0: expand arrow, 1: #, 2: ID, 3: SPONSOR (name + c/o merged), 4: PHONE, 5: MAHALLU
        // 6: CHAPTER, 7: PLEDGED, 8: COLLECTED, 9: BALANCE, 10: PROGRESS, 11: STATUS, 12: DATE
        const rawSponsor = (cells[3] || '').trim();
        const rowPhone = normalizePhone(cells[4] || '');
        const rowMahallu = normalize(cells[5] || '');

        // The SPONSOR cell includes "c/o ..." text concatenated, extract just the name
        const sponsorName = normalize(rawSponsor.split(/c\/o/i)[0]);

        // Name matching — compare the sponsor name part (before c/o)
        const excelName = normalize(name);
        const nameMatch = sponsorName.includes(excelName) || excelName.includes(sponsorName);
        
        // If we fell back to name search, phone might not match, so we rely on Name + Mahallu
        const isNameFallback = (searchType === 'phone' && rows.length > 0 && normalizePhone(phone) !== rowPhone);
        
        let phoneMatch = true;
        if (phone && !isNameFallback) {
            phoneMatch = (normalizePhone(phone) === rowPhone || rowPhone.includes(normalizePhone(phone)) || normalizePhone(phone).includes(rowPhone));
        }
        
        const placeMatch = place ? fuzzyPlaceMatch(place, cells[5] || '') : true;

        if (nameMatch && phoneMatch && placeMatch) {
            matchedRow = row;
            matchDetails = `Sponsor: ${rawSponsor.split(/c\/o/i)[0].trim()}, Phone: ${cells[4]?.trim()}, Mahallu: ${cells[5]?.trim()}`;
            break;
        }
    }

    if (!matchedRow) {
        // Gather what we did find for debugging
        const firstRowCells = rows.length > 0 ? await rows[0].locator('td').allTextContents() : [];
        const found = firstRowCells.length > 5
            ? `Found: "${firstRowCells[3]?.split(/c\/o/i)[0]?.trim()}" | Phone: ${firstRowCells[4]?.trim()} | Mahallu: ${firstRowCells[5]?.trim()}`
            : `Found ${rows.length} row(s) but none matched`;
            
        return { success: false, reason: `No matching row. Expected: Name="${name}", Mahallu="${place}". ${found}` };
    }

    console.log(`${C.gray}   Matched: ${matchDetails}${C.reset}`);

    // 3. Check if already paid — STATUS is at column index 11
    const statusCells = await matchedRow.locator('td').allTextContents();
    const statusText = normalize(statusCells[11] || '');
    if (statusText === 'PAID') {
        return { success: false, reason: '⚡ ALREADY PAID — this sponsorship is already fully paid', alreadyPaid: true };
    }

    // 4. Click the green cash button (banknote icon with emerald color)
    // Exact selector from the page HTML: button with .lucide-banknote SVG and text-emerald-600 class
    let cashButton = matchedRow.locator('button:has(.lucide-banknote)').first();
    
    let cashButtonVisible = false;
    try {
        cashButtonVisible = await cashButton.isVisible({ timeout: 3000 });
    } catch (e) {
        cashButtonVisible = false;
    }

    // Fallback: try by emerald class
    if (!cashButtonVisible) {
        cashButton = matchedRow.locator('button.text-emerald-600').first();
        try {
            cashButtonVisible = await cashButton.isVisible({ timeout: 2000 });
        } catch (e) {
            cashButtonVisible = false;
        }
    }

    if (!cashButtonVisible) {
        return { success: false, reason: 'Could not find the green cash (banknote) button in the matched row' };
    }

    await cashButton.click({ force: true });

    // 4. Wait for the "Record Payment" modal
    const dialog = page.locator('div[role="dialog"]');
    try {
        await dialog.waitFor({ state: 'visible', timeout: 10000 });
    } catch (e) {
        // Sometimes need a retry click
        await cashButton.click({ force: true });
        try {
            await dialog.waitFor({ state: 'visible', timeout: 10000 });
        } catch (e2) {
            return { success: false, reason: 'Record Payment modal did not open' };
        }
    }

    // Verify it's the Record Payment dialog
    const dialogText = await dialog.textContent().catch(() => '');
    if (!dialogText.includes('Record Payment') && !dialogText.includes('Payment Amount')) {
        // Close whatever opened and fail
        await page.keyboard.press('Escape').catch(() => {});
        await sleep(500);
        return { success: false, reason: `Unexpected dialog opened: "${dialogText.substring(0, 80)}..."` };
    }

    // 5. Enter the payment amount
    const amountInput = dialog.locator('input[placeholder*="amount"], input[type="number"]').first();
    try {
        await amountInput.waitFor({ state: 'visible', timeout: 5000 });
        await amountInput.fill(amount);
    } catch (e) {
        await page.keyboard.press('Escape').catch(() => {});
        await sleep(500);
        return { success: false, reason: 'Could not find amount input in the modal' };
    }

    // 6. Click "Record Payment" button
    const recordBtn = dialog.locator('button:has-text("Record Payment")');
    try {
        await recordBtn.waitFor({ state: 'visible', timeout: 5000 });
        await recordBtn.click({ force: true });
    } catch (e) {
        await page.keyboard.press('Escape').catch(() => {});
        await sleep(500);
        return { success: false, reason: 'Could not find or click "Record Payment" button' };
    }

    // 7. Wait for modal to close (indicates success)
    try {
        await dialog.waitFor({ state: 'hidden', timeout: 15000 });
    } catch (e) {
        // Check if there's an error message in the dialog
        const errorText = await dialog.locator('.text-red, .error, [class*="error"], [class*="destructive"]')
            .textContent().catch(() => '');
        if (errorText) {
            await page.keyboard.press('Escape').catch(() => {});
            await sleep(500);
            return { success: false, reason: `Payment error: ${errorText}` };
        }
        // Modal might still be visible but payment went through — force close
        await page.keyboard.press('Escape').catch(() => {});
        await sleep(500);
    }

    await sleep(1000); // Brief cooldown
    return { success: true };
}

// ── Entry point ──
async function run() {
    printHeader();

    // 1. Ask for Excel/JSON file path
    const rawPath = await ask(`📁 Enter path to Excel OR JSON file (e.g., ./payments.xlsx or ./failed_payments.json): `);
    let filePath = path.resolve(rawPath.trim().replace(/^["']+|["']+$/g, ''));

    if (!fs.existsSync(filePath)) {
        console.log(`\n${C.red}❌ File not found: ${filePath}${C.reset}`);
        rl.close();
        process.exit(1);
    }

    // If user gave a directory, find .xlsx or .json files inside it
    if (fs.statSync(filePath).isDirectory()) {
        const validFiles = fs.readdirSync(filePath).filter(f => 
            (f.toLowerCase().endsWith('.xlsx') || f.toLowerCase().endsWith('.json')) && !f.startsWith('~$')
        );
        
        if (validFiles.length === 0) {
            console.log(`\n${C.red}❌ No .xlsx or .json files found in: ${filePath}${C.reset}`);
            rl.close();
            process.exit(1);
        }
        if (validFiles.length === 1) {
            filePath = path.join(filePath, validFiles[0]);
            console.log(`${C.green}📄 Auto-selected: ${validFiles[0]}${C.reset}`);
        } else {
            console.log(`\n${C.cyan}Found ${validFiles.length} valid files:${C.reset}`);
            validFiles.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
            const pick = await ask(`\nEnter number (1-${validFiles.length}): `);
            const idx = parseInt(pick) - 1;
            if (idx < 0 || idx >= validFiles.length) {
                console.log(`${C.red}❌ Invalid choice.${C.reset}`);
                rl.close();
                process.exit(1);
            }
            filePath = path.join(filePath, validFiles[idx]);
        }
    }

    // 2. Ask which panel to process
    console.log(`\n${C.cyan}Select target panel:${C.reset}`);
    console.log(`  1. Community (Mahallu Pledges)`);
    console.log(`  2. Donors (Individual Pledges)`);
    const panelChoice = await ask(`\nEnter number (1-2): `);
    let targetUrl = `${BASE_URL}/admin/community`;
    let panelName = 'Community';
    
    if (panelChoice.trim() === '2') {
        targetUrl = `${BASE_URL}/admin/donors`;
        panelName = 'Donors';
    }

    // 3. Read & parse file
    const ext = path.extname(filePath).toLowerCase();
    console.log(`\n📊 Reading ${ext} file for ${panelName} panel...`);
    
    let entries;
    try {
        if (ext === '.json') {
            const fileData = fs.readFileSync(filePath, 'utf8');
            entries = JSON.parse(fileData);
            // Ensure they have the expected structure
            if (!Array.isArray(entries) || (entries.length > 0 && !entries[0].name)) {
                throw new Error("Invalid format. Expected an array of payment entries.");
            }
        } else if (ext === '.xlsx') {
            entries = readExcel(filePath);
        } else {
            throw new Error(`Unsupported file type: ${ext}. Please provide an xlsx or json file.`);
        }
    } catch (e) {
        console.log(`${C.red}❌ Failed to read file: ${e.message}${C.reset}`);
        rl.close();
        process.exit(1);
    }

    if (entries.length === 0) {
        console.log(`${C.yellow}⚠️  No valid entries found in the Excel file.${C.reset}`);
        rl.close();
        process.exit(0);
    }

    // 3. Show preview
    printPreview(entries);

    const confirm = (await ask(`${C.cyan}▶ Proceed with ${entries.length} payments? (yes/no): ${C.reset}`)).trim().toLowerCase();
    if (confirm !== 'y' && confirm !== 'yes') {
        console.log('Aborted.');
        rl.close();
        process.exit(0);
    }

    // 4. Launch browser
    console.log(`\n🌐 Launching browser...`);
    let browser = await chromium.launchPersistentContext(USER_DATA_DIR, {
        headless: false,
        viewport: { width: 1280, height: 900 },
    });

    let page = await browser.newPage();
    page.setDefaultTimeout(30000);

    // Helper: recover page if browser crashed
    async function ensurePage() {
        try {
            await page.url(); // health check
            return;
        } catch (e) {
            console.log(`${C.yellow}🔄 Page died, recovering...${C.reset}`);
        }
        // Try to create new page in existing browser
        try {
            page = await browser.newPage();
            page.setDefaultTimeout(30000);
            await page.goto(COMMUNITY_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await sleep(3000);
            console.log(`${C.green}✅ Page recovered.${C.reset}`);
            return;
        } catch (e2) {
            console.log(`${C.yellow}🔄 Browser died, relaunching...${C.reset}`);
        }
        // Relaunch entire browser
        try { await browser.close(); } catch (_) {}
        browser = await chromium.launchPersistentContext(USER_DATA_DIR, {
            headless: false,
            viewport: { width: 1280, height: 900 },
        });
        page = await browser.newPage();
        page.setDefaultTimeout(30000);
        await page.goto(COMMUNITY_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(3000);
        console.log(`${C.green}✅ Browser relaunched and ready.${C.reset}`);
    }

    const results = { success: [], failed: [], alreadyPaid: [] };

    try {
        // 5. Navigate to target page
        console.log(`🔄 Navigating to ${panelName} page...`);
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(3000);

        // 6. Handle login if needed
        const currentUrl = page.url();
        if (currentUrl.includes('/login') || currentUrl.includes('/signin') || currentUrl.includes('/auth')) {
            console.log(`\n${C.yellow}🔒 You are not logged in.`);
            console.log(`👉 Please log in manually in the browser window.`);
            console.log(`⏳ Waiting up to 5 minutes...${C.reset}\n`);
            await page.waitForURL(`**${targetUrl.replace(BASE_URL, '')}`, { timeout: 300000 });
            console.log(`${C.green}✅ Login detected! Continuing...${C.reset}\n`);
            await sleep(3000);
        }

        // Wait for search box to be ready
        const searchBox = page.locator('input[placeholder*="Search"]');
        await searchBox.waitFor({ state: 'visible', timeout: 30000 });
        console.log(`${C.green}✅ ${panelName} page ready.${C.reset}\n`);

        console.log(`${C.bright}${'─'.repeat(55)}`);
        console.log(`   Processing ${entries.length} payments...`);
        console.log(`${'─'.repeat(55)}${C.reset}\n`);

        // 7. Process each entry
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            printRow(i + 1, entries.length, `${entry.name} (₹${entry.amount})`, '⏳', C.yellow);

            let result;
            try {
                result = await processEntry(page, entry, i + 1, entries.length);
            } catch (e) {
                // If page/browser crashed, try to recover and retry this entry
                if (isCrashError(e.message)) {
                    console.log(`${C.yellow}   ⚠️ Browser crashed, recovering and retrying...${C.reset}`);
                    await ensurePage();
                    try {
                        result = await processEntry(page, entry, i + 1, entries.length);
                    } catch (e2) {
                        result = { success: false, reason: `Crashed twice: ${e2.message}`, crashError: true };
                    }
                } else {
                    result = { success: false, reason: `Unexpected error: ${e.message}` };
                }
            }

            if (result.success) {
                printRow(i + 1, entries.length, `${entry.name} (₹${entry.amount})`, '✅ SUCCESS', C.green);
                results.success.push(entry);
            } else if (result.alreadyPaid) {
                printRow(i + 1, entries.length, `${entry.name} (₹${entry.amount})`, '⚡ ALREADY PAID', C.yellow);
                results.alreadyPaid.push(entry);
            } else {
                printRow(i + 1, entries.length, `${entry.name} (₹${entry.amount})`, '❌ FAILED', C.red);
                console.log(`${C.red}   └─ Reason: ${result.reason}${C.reset}`);
                results.failed.push({ ...entry, reason: result.reason });
            }

            // Rate limit — wait between entries
            if (i < entries.length - 1) {
                await sleep(2000);
            }
        }

        // 8. Print summary
        printSummary(results, entries.length);

    } catch (e) {
        console.error(`\n${C.red}❌ Fatal Error: ${e.message}${C.reset}`);
    } finally {
        try { await browser.close(); } catch (_) {}
        rl.close();
        process.exit(0);
    }
}

function printSummary(results, total) {
    console.log(`\n${C.cyan}${C.bright}${'='.repeat(55)}`);
    console.log(`   SUMMARY`);
    console.log(`${'='.repeat(55)}${C.reset}`);
    console.log(`${C.green}${C.bright}   ✅ Successful:   ${results.success.length}${C.reset}`);
    console.log(`${C.yellow}${C.bright}   ⚡ Already Paid: ${results.alreadyPaid.length}${C.reset}`);
    console.log(`${C.red}${C.bright}   ❌ Failed:       ${results.failed.length}${C.reset}`);
    console.log(`${C.bright}   📊 Total:        ${total}${C.reset}`);

    if (results.alreadyPaid.length > 0) {
        console.log(`\n${C.yellow}${C.bright}Already paid (skipped):${C.reset}`);
        console.log(`${C.yellow}${'─'.repeat(55)}${C.reset}`);
        for (const ap of results.alreadyPaid) {
            console.log(`${C.yellow}  Row ${ap.rowNum}: ${ap.name} (₹${ap.amount}) — ${ap.place}${C.reset}`);
        }
    }

    if (results.failed.length > 0) {
        console.log(`\n${C.red}${C.bright}Failed entries:${C.reset}`);
        console.log(`${C.red}${'─'.repeat(55)}${C.reset}`);
        for (const f of results.failed) {
            console.log(`${C.red}  Row ${f.rowNum}: ${f.name} (₹${f.amount}) — ${f.place}${C.reset}`);
            console.log(`${C.red}    └─ ${f.reason}${C.reset}`);
        }

        // Save failed entries to a file
        const failedPath = path.join(__dirname, `failed_payments_${Date.now()}.json`);
        fs.writeFileSync(failedPath, JSON.stringify(results.failed, null, 2));
        console.log(`\n${C.yellow}📋 Failed entries saved to: ${failedPath}${C.reset}`);
    }

    if (results.success.length > 0) {
        console.log(`\n${C.green}${C.bright}Successful entries:${C.reset}`);
        console.log(`${C.green}${'─'.repeat(55)}${C.reset}`);
        for (const s of results.success) {
            console.log(`${C.green}  Row ${s.rowNum}: ${s.name} — ₹${s.amount} — ${s.place}${C.reset}`);
        }
    }

    console.log(`\n${C.cyan}${C.bright}🎉 Bulk payment processing complete!${C.reset}\n`);
}

run();
