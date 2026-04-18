// Simulate Telegram bot response
require('dotenv').config();

function extractDonorData(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    let data = {
        name: lines[0]?.trim() || "Unknown",
        place: lines[1]?.trim() || "Unknown",
        careOf: "",
        amount: "",
        currency: "₹ INR",
        phone: ""
    };

    lines.forEach(line => {
        // ========== C/O EXTRACTION (AGGRESSIVE) ==========
        // Try multiple patterns to extract C/o
        if (!data.careOf) {
            // Pattern 1: "C/o - Name" or "C/O: Name"
            let careMatch = line.match(/(?:C\/o|C\/O|c\/o|care\s+of|Care\s+of)[:\s\-]*(.*?)$/i);
            if (careMatch && careMatch[1]) {
                data.careOf = careMatch[1].trim();
                console.log(`[C/O] Extracted: ${data.careOf}`);
            }
        }

        // ========== PHONE NUMBER DETECTION (PRIORITY 1) ==========
        if (!data.phone) {
            let phoneMatch = line.match(/\+[\d\s\-]{9,14}\d/);
            if (phoneMatch) {
                data.phone = phoneMatch[0].replace(/[\s\-]/g, '');
            } else {
                phoneMatch = line.match(/\b(91\d{10})\b/);
                if (phoneMatch) {
                    data.phone = phoneMatch[1];
                } else {
                    phoneMatch = line.match(/\b([6-9]\d{9})\b/);
                    if (phoneMatch) {
                        data.phone = phoneMatch[1];
                    }
                }
            }
        }

        // ========== AMOUNT DETECTION (PRIORITY 2: WITH CURRENCY MARKERS) ==========
        const currencyMappings = [
            { keywords: 'rs|inr|rupee|rupees', currency: '₹ INR' },
            { keywords: 'aed|dirham|dirhams', currency: 'إ.د AED' },
            { keywords: 'sar|riyal|riyals', currency: 'ريال SAR' },
            { keywords: 'kwd|kd|dinar|dinars', currency: 'د.ك KWD' },
            { keywords: 'bhd|bd|baisa|balochi', currency: 'د.ب. BHD' },
            { keywords: 'omr|or|rial|rials', currency: 'ر.ع. OMR' },
            { keywords: 'qar|qr|qatari', currency: 'ر.ق QAR' },
            { keywords: 'gbp|pound|pounds|£', currency: '£ GBP' },
            { keywords: 'eur|euro|euros|€', currency: '€ EUR' },
            { keywords: 'cad|canadian', currency: 'C$ CAD' },
            { keywords: 'aud|australian', currency: 'A$ AUD' },
            { keywords: '\\$|usd|dollar|dollars', currency: 'USD' }
        ];

        if (!data.amount) {
            for (const { keywords, currency } of currencyMappings) {
                const amountMatch = line.match(new RegExp(`(\\d+(?:\\.\\d{1,2})?)\\s*(?:${keywords})`, 'i'));
                if (amountMatch) {
                    data.amount = amountMatch[1];
                    data.currency = currency;
                    break;
                }
            }
        }

        // ========== FALLBACK: LOOK FOR $ OR ₹ SYMBOL ==========
        if (!data.amount) {
            const symbolMatch = line.match(/(₹|\$)\s*(\d+(?:\.\d{1,2})?)/);
            if (symbolMatch) {
                data.amount = symbolMatch[2];
                data.currency = symbolMatch[1] === '₹' ? '₹ INR' : 'USD';
            }
        }
    });

    // ========== VALIDATION ==========
    if (data.amount && data.amount.length > 6) {
        data.amount = "";
    }

    return data;
}

// ========== SIMULATE TELEGRAM BOT RESPONSE ==========
const whatsappMessage = `ശൗകത്ത് വാക്കയിൽ
ഇരിങ്ങാട്ടിരി
1000 rs
C/o - സാലിം ഹുദവി
+919446197258`;

console.log("📱 WHATSAPP MESSAGE RECEIVED:");
console.log("─".repeat(70));
console.log(whatsappMessage);
console.log("─".repeat(70));

const extracted = extractDonorData(whatsappMessage);

console.log("\n🤖 BOT RESPONSE (Telegram Message):");
console.log("─".repeat(70));

const summary = `📝 *Review Details:*
👤 Name: ${extracted.name}
📍 Place: ${extracted.place}
💰 Amt: ${extracted.amount} (${extracted.currency})
📞 Mob: ${extracted.phone}
${extracted.careOf ? `\n👥 C/o: ${extracted.careOf}` : ''}`;

console.log(summary);
console.log("─".repeat(70));

console.log("\n✅ VERIFICATION:");
console.log(`   ✓ Name extracted: ${extracted.name === "ശൗകത്ത് വാക്കയിൽ" ? "✅" : "❌"}`);
console.log(`   ✓ Amount is "1000" not "919446197258": ${extracted.amount === "1000" ? "✅" : "❌"}`);
console.log(`   ✓ Currency correctly identified as "INR" from "rs": ${extracted.currency === "₹ INR" ? "✅" : "❌"}`);
console.log(`   ✓ Phone number extracted: ${extracted.phone === "+919446197258" ? "✅" : "❌"}`);
console.log(`   ✓ C/o extracted: ${extracted.careOf === "സാലിം ഹുദവി" ? "✅" : "❌"}`);
