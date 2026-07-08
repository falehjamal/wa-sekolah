import dns from 'dns/promises';
import https from 'https';
import WebSocket from 'ws';

const TARGET_HOST = 'web.whatsapp.com';
const TARGET_WSS = 'wss://web.whatsapp.com/ws/chat';

async function checkDns() {
    try {
        const addresses = await dns.resolve4(TARGET_HOST);
        console.log(`[OK] DNS ${TARGET_HOST} -> ${addresses.join(', ')}`);
        return true;
    } catch (err) {
        try {
            const result = await dns.lookup(TARGET_HOST);
            console.log(`[OK] DNS lookup ${TARGET_HOST} -> ${result.address}`);
            return true;
        } catch (lookupErr) {
            console.error(`[FAIL] DNS ${TARGET_HOST}: ${lookupErr.code} ${lookupErr.message}`);
            return false;
        }
    }
}

function checkHttps() {
    return new Promise((resolve) => {
        const req = https.get(`https://${TARGET_HOST}`, { timeout: 15000 }, (res) => {
            console.log(`[OK] HTTPS ${TARGET_HOST} -> status ${res.statusCode}`);
            res.resume();
            resolve(true);
        });

        req.on('timeout', () => {
            req.destroy();
            console.error(`[FAIL] HTTPS ${TARGET_HOST}: timeout`);
            resolve(false);
        });

        req.on('error', (err) => {
            console.error(`[FAIL] HTTPS ${TARGET_HOST}: ${err.code} ${err.message}`);
            resolve(false);
        });
    });
}

function checkWebSocket() {
    return new Promise((resolve) => {
        const ws = new WebSocket(TARGET_WSS);
        const timer = setTimeout(() => {
            ws.terminate();
            console.error(`[FAIL] WSS ${TARGET_WSS}: timeout 15s`);
            resolve(false);
        }, 15000);

        ws.on('open', () => {
            clearTimeout(timer);
            console.log(`[OK] WSS ${TARGET_WSS} -> connected`);
            ws.close();
            resolve(true);
        });

        ws.on('error', (err) => {
            clearTimeout(timer);
            console.error(`[FAIL] WSS ${TARGET_WSS}: ${err.code || 'ERROR'} ${err.message}`);
            resolve(false);
        });
    });
}

console.log('=== Cek koneksi ke WhatsApp Web ===\n');

const dnsOk = await checkDns();
const httpsOk = await checkHttps();
const wssOk = await checkWebSocket();

console.log('\n=== Ringkasan ===');
if (wssOk) {
    console.log('Koneksi WSS ke WhatsApp berhasil. Jaringan dasar OK.');
    process.exit(0);
}

if (!dnsOk) {
    console.log('DNS gagal resolve web.whatsapp.com.');
}
if (!httpsOk) {
    console.log('HTTPS ke web.whatsapp.com gagal.');
}
console.log('WSS ke WhatsApp gagal. Periksa firewall/DNS/outbound port 443 server.');
process.exit(1);
