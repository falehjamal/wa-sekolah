import dns from 'dns/promises';
import https from 'https';
import WebSocket from 'ws';
import { createWaAgent } from '../services/network.js';

const TARGET_HOST = 'web.whatsapp.com';
const TARGET_WSS = 'wss://web.whatsapp.com/ws/chat';
const agent = createWaAgent();

async function checkDns() {
    try {
        const result = await dns.lookup(TARGET_HOST, { family: 4 });
        console.log(`[OK] DNS IPv4 ${TARGET_HOST} -> ${result.address}`);
        return true;
    } catch (err) {
        console.error(`[FAIL] DNS ${TARGET_HOST}: ${err.code} ${err.message}`);
        return false;
    }
}

function checkHttps() {
    return new Promise((resolve) => {
        const req = https.get(`https://${TARGET_HOST}`, { agent, timeout: 20000 }, (res) => {
            console.log(`[OK] HTTPS ${TARGET_HOST} -> status ${res.statusCode}`);
            res.resume();
            resolve(true);
        });

        req.on('timeout', () => {
            req.destroy();
            console.error(`[FAIL] HTTPS ${TARGET_HOST}: timeout 20s`);
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
        const ws = new WebSocket(TARGET_WSS, { agent, handshakeTimeout: 20000 });
        const timer = setTimeout(() => {
            ws.terminate();
            console.error(`[FAIL] WSS ${TARGET_WSS}: timeout 20s (ETIMEDOUT)`);
            resolve(false);
        }, 20000);

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

console.log('=== Cek koneksi ke WhatsApp Web (IPv4) ===\n');
if (process.env.WA_PROXY_URL) {
    console.log(`Proxy aktif: ${process.env.WA_PROXY_URL.replace(/\/\/.*@/, '//***@')}\n`);
}

const dnsOk = await checkDns();
const httpsOk = await checkHttps();
const wssOk = await checkWebSocket();

console.log('\n=== Ringkasan ===');
if (wssOk) {
    console.log('Koneksi WSS ke WhatsApp berhasil.');
    process.exit(0);
}

console.log('WSS gagal (ETIMEDOUT = server tidak bisa reach WhatsApp).');
console.log('Solusi:');
console.log('  1. Cek firewall outbound port 443');
console.log('  2. Coba DNS: echo "nameserver 8.8.8.8" | sudo tee /etc/resolv.conf');
console.log('  3. Jika WhatsApp diblokir ISP, set WA_PROXY_URL di .env');
process.exit(1);
