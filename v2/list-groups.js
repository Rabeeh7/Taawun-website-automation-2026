// Quick script to list all WhatsApp groups and their IDs
require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const path = require('path');

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(__dirname, 'wa_session') }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    }
});

client.on('ready', async () => {
    console.log('✅ Connected! Fetching groups...\n');
    const chats = await client.getChats();
    const groups = chats.filter(c => c.isGroup);

    console.log(`Found ${groups.length} groups:\n`);
    console.log('─'.repeat(80));
    groups.forEach((g, i) => {
        console.log(`${i + 1}. ${g.name}`);
        console.log(`   ID: ${g.id._serialized}`);
        console.log('─'.repeat(80));
    });

    console.log('\nDone! You can close this with Ctrl+C');
    process.exit(0);
});

client.on('auth_failure', () => console.error('❌ Auth failed'));
console.log('🔄 Connecting to WhatsApp...');
client.initialize();
