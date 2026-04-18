const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
require('dotenv').config();

const USER_DATA_DIR = path.join(__dirname, 'user_session');

// Simple terminal prompter
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const ask = (question) => new Promise((resolve) => rl.question(question, resolve));

async function run() {
    console.log("=====================================");
    console.log("   TaaWun Bulk Receipt Downloader");
    console.log("=====================================\n");

    const chapterInput = await ask("Enter Chapter Name exactly as it appears on the website button (e.g., MANJERI): ");
    if (!chapterInput.trim()) {
        console.log("❌ Chapter cannot be empty.");
        process.exit(1);
    }
    const chapter = chapterInput.trim().toUpperCase();

    const startStr = await ask("Enter START Payment ID number (e.g., 12500 for #PAY12500): ");
    const startId = parseInt(startStr.replace(/[^0-9]/g, ''));

    const endStr = await ask("Enter END Payment ID number (e.g., 12600 for #PAY12600): ");
    const endId = parseInt(endStr.replace(/[^0-9]/g, ''));

    if (isNaN(startId) || isNaN(endId) || startId > endId) {
        console.log("❌ Invalid range. Start ID must be less than or equal to End ID.");
        process.exit(1);
    }

    console.log(`\n🚀 Preparing to download receipts from #PAY${startId} to #PAY${endId} for chapter [${chapter}]...\n`);

    const browser = await chromium.launchPersistentContext(USER_DATA_DIR, {
        headless: false, // Keep visible so user can see what's happening
        viewport: { width: 1280, height: 720 },
        acceptDownloads: true
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(30000);

    try {
        console.log("🔄 Navigating to Finance Page...");
        await page.goto('https://taawun.hadiacse.in/admin/finance', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000); // Let initial network requests cool down

        // Check if logged in
        if (await page.locator('input[type="email"]').count() > 0) {
            console.log("🔒 You are not logged in.");
            console.log("👉 Please log in manually in the browser window.");
            console.log("⏳ The script will wait until you reach the Finance dashboard...\n");
            await page.waitForTimeout(1000); // slight delay before waiting for selector
            await page.waitForURL('**/admin/finance', { timeout: 300000 }); // 5 minutes to log in
            console.log("\n✅ Login detected. Continuing...\n");
            await page.waitForTimeout(3000);
        }

        const searchBox = page.locator('input[placeholder*="Search"]');
        console.log(`⏳ Waiting for Search box to appear...`);
        await searchBox.waitFor({ state: 'visible', timeout: 60000 });
        console.log(`✅ Search box ready.`);

        let successCount = 0;
        let skipCount = 0;

        for (let currentId = startId; currentId <= endId; currentId++) {
            const payString = `#PAY${currentId}`;
            const searchString = `PAY${currentId}`; // Exclude the `#` for the search box input
            console.log(`\n🔍 Searching for ${searchString}...`);

            await searchBox.fill(''); // clear
            // Try clearing by selecting all and deleting (more robust for React inputs)
            await searchBox.press('Control+A');
            await searchBox.press('Backspace');
            await page.waitForTimeout(100);
            await searchBox.fill(searchString);

            // The table updates. Wait for a row that matches our payment ID.
            const rowLocator = page.locator(`tr:has-text("${payString}")`).first();

            // Wait up to 2.5 seconds for the row to appear. 
            // If it appears sooner, it proceeds immediately! (Huge speedup)
            try {
                await rowLocator.waitFor({ state: 'visible', timeout: 2500 });
            } catch (err) {
                console.log(`⏭️  Skipped: ${payString} not found (Might be missing or belongs to a different chapter).`);
                skipCount++;
                continue; // Move to next ID
            }

            // If we got here, the row exists.

            // Extract the location using the data-label attributes or column position.
            // Based on standard datatables, we can look for the cell containing the location.
            // In the screenshot, LOCATION is the 6th column (Type is 5th, Chapter is 7th).
            // Let's get the text content of the row to parse it safely.

            // A safer React-admin selection is often by finding the specific td if they have classes,
            // but we can just grab all `td` text from the row.
            const tds = await rowLocator.locator('td').allTextContents();

            // The structure looking at the image:
            // 0: # (e.g., "1")
            // 1: PAYMENT ID (e.g., "#PAY12769")
            // 2: SPONSOR ID
            // 3: SPONSOR (Name details)
            // 4: PHONE
            // 5: TYPE
            // 6: LOCATION (e.g., "Pulikkanni palappill...")
            // 7: CHAPTER (e.g., "MANJERI")

            if (tds.length < 8) {
                console.log(`⚠️  Warning: Unexpected table structure. Skipping.`);
                skipCount++;
                continue;
            }

            const rowChapter = tds[7].trim().toUpperCase();
            if (rowChapter !== chapter) {
                console.log(`⏭️  Skipped: Belongs to chapter [${rowChapter}], not [${chapter}].`);
                skipCount++;
                continue;
            }

            let locationName = "Unknown_Location";
            // Clean up the location name to be folder-safe
            locationName = tds[6].trim().replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_');
            // Trim trailing underscores
            locationName = locationName.replace(/_$/, '');
            if (locationName.length === 0) locationName = "Unknown_Location";

            console.log(`📍 Found in location: ${locationName}`);

            // 1. Click the download icon on the table row
            const downloadButtonSelectors = ['button:has(.lucide-download)', 'a:has(.lucide-download)', '[aria-label*="Download"]'];
            let tableDownloadBtn = null;
            for (const selector of downloadButtonSelectors) {
                const btn = rowLocator.locator(selector).first();
                if (await btn.isVisible().catch(() => false)) { tableDownloadBtn = btn; break; }
            }
            if (!tableDownloadBtn) {
                const buttons = await rowLocator.locator('button, a').all();
                if (buttons.length > 0) tableDownloadBtn = buttons[buttons.length - 1];
            }

            if (!tableDownloadBtn) {
                 console.log(`⚠️  Warning: Download button not found for ${payString}. Skipping.`);
                 skipCount++;
                 continue;
            }

            console.log(`📥 Opening receipt dialog...`);
            await tableDownloadBtn.click({ force: true });
            
            // 2. Wait for the modal dialog to appear
            const dialogElement = page.locator('div[role="dialog"]');
            try {
                await dialogElement.waitFor({ state: 'visible', timeout: 15000 });
            } catch (err) {
                 console.log(`⚠️  Warning: Dialog did not open for ${payString}. Skipping.`);
                 skipCount++;
                 continue;
            }

            // 3. Find the actual download button inside the dialog
            let downloadReceiptBtn = null;
            for (const selector of ['button:has(.lucide-download)', 'button:has-text("Download Receipt")']) {
                const btn = dialogElement.locator(selector).first();
                if (await btn.isVisible().catch(() => false)) { downloadReceiptBtn = btn; break; }
            }
            
            if (!downloadReceiptBtn) {
                 console.log(`⚠️  Warning: "Download Receipt" button not found inside dialog. Skipping.`);
                 await page.keyboard.press('Escape').catch(() => { }); // close dialog
                 skipCount++;
                 continue;
            }

            // Create the directory if it doesn't exist
            const baseDir = path.join(__dirname, 'Bulk_Downloads', chapter);
            const targetDir = path.join(baseDir, locationName);
            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
            }

            console.log(`📥 Downloading PDF...`);
            let dlSuccess = false;
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    const [download] = await Promise.all([
                        page.waitForEvent('download', { timeout: 15000 }),
                        downloadReceiptBtn.click({ force: true })
                    ]);

                    const suggestedName = download.suggestedFilename();
                    let finalPath = path.join(targetDir, suggestedName);
                    
                    // Add Payment ID to filename to prevent overwriting
                    if (!suggestedName.includes(currentId.toString())) {
                        finalPath = path.join(targetDir, `${payString.replace('#', '')}_${suggestedName}`);
                    }

                    // Playwright saves downloads to a temporary path, we must use download.saveAs
                    await download.saveAs(finalPath);
                    console.log(`✅ Saved: ${finalPath}`);
                    dlSuccess = true;
                    successCount++;
                    break; // Success, break retry loop

                } catch (e) {
                    console.log(`❌ Download attempt ${attempt} failed: ${e.message}`);
                    if (attempt < 3) await page.waitForTimeout(2000);
                }
            }

            if (!dlSuccess) {
                console.log(`🚨 Failed to download ${payString} after 3 attempts. Skipping.`);
                skipCount++;
            }

            // Close the dialog for the next iteration
            const closeBtn = dialogElement.locator('button[aria-label="Close"], button:has(.lucide-x)').first();
            if (await closeBtn.isVisible().catch(() => false)) await closeBtn.click().catch(() => { });
            else await page.keyboard.press('Escape').catch(() => { });
            await dialogElement.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => { });
        }

        console.log(`\n🎉 Bulk Download Complete!`);
        console.log(`✅ Successfully downloaded: ${successCount}`);
        console.log(`⏭️ Skipped/Not Found: ${skipCount}`);
        console.log(`📁 Files saved in: ${path.join(__dirname, 'Bulk_Downloads', chapter)}`);

    } catch (e) {
        console.error("❌ Fatal Error:", e);
    } finally {
        await browser.close();
        process.exit(0);
    }
}

run();
