require('dotenv').config();
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Polyfill fetch for older Node versions if needed
if (!global.fetch) {
    global.fetch = require('node-fetch');
}

const rl = readline.createInterface({
    input: process.stdin,
    
    output: process.stdout
});

const ask = (query) => new Promise(resolve => rl.question(query, resolve));

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function sendMsg(target, isPersonal, caption, imagePath = null) {
    const payload = {
        caption
    };
    if (imagePath) {
        payload.imagePath = imagePath;
    }
    
    if (isPersonal) {
        payload.phone = target;
    } else {
        payload.chapter = target;
    }

    const endpoint = isPersonal ? '/send-personal' : '/send';

    try {
        const response = await fetch(`http://localhost:3210${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        const data = await response.json();
        return data.success;
    } catch (e) {
        console.error(`❌ HTTP Error contacting wa-sender.js: ${e.message}`);
        return false;
    }
}

async function run() {
    console.log("=====================================");
    console.log("   TaaWun Bulk WhatsApp Sender");
    console.log("=====================================\n");

    const chapter = (await ask("Enter Chapter Name (exactly as folder name, e.g., MANJERI): ")).trim().toUpperCase();

    const baseDir = path.join(__dirname, 'Bulk_Downloads', chapter);

    if (!fs.existsSync(baseDir)) {
        console.log(`\n❌ Error: Folder not found at ${baseDir}`);
        console.log("Please make sure you have run the bulk downloader for this chapter first.");
        rl.close();
        return;
    }

    // Get all location folders
    const items = fs.readdirSync(baseDir);
    const locations = [];
    for (const item of items) {
        const itemPath = path.join(baseDir, item);
        if (fs.statSync(itemPath).isDirectory()) {
            locations.push(item);
        }
    }

    if (locations.length === 0) {
        console.log(`\n⚠️ No location folders found inside ${chapter}. Nothing to send.`);
        rl.close();
        return;
    }

    console.log(`\nFound ${locations.length} locations to process.`);
    const testModeAns = (await ask(`Do you want to run a TEST DEMO to a personal phone number first? (yes/no): `)).trim().toLowerCase();
    const isTestMode = (testModeAns === 'y' || testModeAns === 'yes');
    
    let target = chapter;
    if (isTestMode) {
        target = (await ask(`Enter the test WhatsApp phone number (e.g. 9747591225): `)).trim();
        console.log(`\n🚀 Starting TEST mode: sending to ${target}...\n`);
    } else {
        const confirm = (await ask(`Ready to start sending to the [${chapter}] WhatsApp group (LIVE)? (yes/no): `)).trim().toLowerCase();
        if (confirm !== 'y' && confirm !== 'yes') {
            console.log("Aborted.");
            rl.close();
            return;
        }
        console.log(`\n🚀 Starting LIVE mode: sending to [${chapter}] group...\n`);
    }

    for (const location of locations) {
        const locationPath = path.join(baseDir, location);
        const files = fs.readdirSync(locationPath).filter(f => f.toLowerCase().endsWith('.pdf') || f.toLowerCase().endsWith('.png'));

        if (files.length === 0) continue;

        console.log(`\n==============================================`);
        console.log(`📍 Processing Location: ${location} (${files.length} receipts)`);
        console.log(`==============================================`);

        // 1. Send opening text marker
        const openerMsg = `_____________________________\nAll receipts from ${location}`;
        console.log(`[WA] Sending opening marker...`);
        let openerSuccess = await sendMsg(target, isTestMode, openerMsg);
        if (!openerSuccess) {
            console.log(`⚠️ Failed to send opening marker, but continuing...`);
        }
        await sleep(2000); // Wait 2s to prevent message overlap

        // 2. Loop through files and send
        for (let i = 0; i < files.length; i++) {
            const fileName = files[i];
            const filePath = path.join(locationPath, fileName);
            const caption = fileName.replace('.png', '').replace('.pdf', ''); 

            console.log(`   [WA] Sending: ${fileName} ...`);
            
            let sent = await sendMsg(target, isTestMode, caption, filePath);
            
            // simple retry logic
            if (!sent) {
                console.log(`   ⚠️ Failed, retrying in 3 seconds...`);
                await sleep(3000);
                sent = await sendMsg(target, isTestMode, caption, filePath);
                if (!sent) console.log(`   ❌ Final failure for ${fileName}`);
            }

            if (sent) console.log(`   ✅ Sent!`);

            // Small delay between images so WA doesn't ban or fail entirely
            await sleep(3000); 
        }

        // 3. Send closing text marker
        const closerMsg = `this is from ${location}\n__________________________________`;
        console.log(`[WA] Sending closing marker...`);
        await sendMsg(target, isTestMode, closerMsg);
        
        console.log(`✅ Finished location: ${location}`);
        
        // Wait longer between different locations
        await sleep(5000);
    }

    console.log("\n🎉 All locations processed successfully!");
    rl.close();
}

run();
