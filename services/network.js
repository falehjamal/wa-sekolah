import dns from 'dns';
import https from 'https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

dns.setDefaultResultOrder('ipv4first');

/**
 * Agent untuk koneksi WhatsApp (WebSocket + fetch media).
 * Paksa IPv4 karena banyak VPS timeout di IPv6.
 * Opsional proxy via WA_PROXY_URL di .env
 */
export function createWaAgent() {
    const proxyUrl = process.env.WA_PROXY_URL?.trim();

    if (proxyUrl) {
        console.log(`[Network] Menggunakan proxy: ${proxyUrl.replace(/\/\/.*@/, '//***@')}`);
        if (proxyUrl.startsWith('socks')) {
            return new SocksProxyAgent(proxyUrl);
        }
        return new HttpsProxyAgent(proxyUrl);
    }

    return new https.Agent({
        family: 4,
        keepAlive: true,
    });
}
