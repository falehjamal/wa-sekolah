import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { updateGatewayStatus } from './database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSIONS_DIR = path.join(__dirname, '..', 'sessions');

const MAX_RECONNECT_ATTEMPTS = 5;
const FATAL_DISCONNECT_CODES = new Set([
    DisconnectReason.loggedOut,
    DisconnectReason.badSession,
    DisconnectReason.forbidden,
    DisconnectReason.multideviceMismatch,
]);
const NO_RECONNECT_CODES = new Set([
    DisconnectReason.connectionReplaced,
]);

const sessions = new Map();
const instanceMeta = new Map();

const logger = pino({ level: process.env.WA_LOG_LEVEL || 'silent' });

function getMeta(instanceKey) {
    if (!instanceMeta.has(instanceKey)) {
        instanceMeta.set(instanceKey, {
            reconnectAttempts: 0,
            reconnectTimer: null,
            isStarting: false,
        });
    }
    return instanceMeta.get(instanceKey);
}

function clearReconnectTimer(meta) {
    if (meta.reconnectTimer) {
        clearTimeout(meta.reconnectTimer);
        meta.reconnectTimer = null;
    }
}

function wipeSessionFiles(instanceKey) {
    const sessionDir = path.join(SESSIONS_DIR, instanceKey);
    if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
}

function formatDisconnectError(error) {
    const wsError = error?.data;
    const parts = [
        error?.message || 'unknown',
        wsError?.code ? `wsCode=${wsError.code}` : null,
        wsError?.errno ? `errno=${wsError.errno}` : null,
        wsError?.syscall ? `syscall=${wsError.syscall}` : null,
        wsError?.hostname ? `host=${wsError.hostname}` : null,
    ].filter(Boolean);

    return parts.join(' | ');
}

function resetSession(instanceKey, message) {
    const session = sessions.get(instanceKey);
    const meta = getMeta(instanceKey);

    clearReconnectTimer(meta);
    if (session) {
        try {
            session.socket?.end();
        } catch (_) {}
    }

    sessions.delete(instanceKey);
    instanceMeta.delete(instanceKey);
    wipeSessionFiles(instanceKey);
    console.log(`[${instanceKey}] ${message}`);
}

async function createSocket(instanceKey, session, meta) {
    const sessionDir = path.join(SESSIONS_DIR, instanceKey);
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    session.saveCreds = saveCreds;
    session.status = 'connecting';
    session.qrCode = null;

    const socket = makeWASocket({
        version,
        logger,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        browser: ['Sekolah App', 'Chrome', '10.0'],
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        getMessage: async () => undefined,
    });

    session.socket = socket;

    socket.ev.on('creds.update', saveCreds);

    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            session.qrCode = qr;
            session.status = 'waiting_scan';
        }

        if (connection === 'close') {
            const error = lastDisconnect?.error;
            const statusCode = error?.output?.statusCode;

            session.status = 'disconnected';
            session.qrCode = null;

            console.log(
                `[${instanceKey}] Connection closed. Code: ${statusCode ?? 'n/a'}, Detail: ${formatDisconnectError(error)}`
            );

            const tenantId = extractTenantId(instanceKey);
            if (tenantId) {
                await updateGatewayStatus(tenantId, false);
            }

            if (FATAL_DISCONNECT_CODES.has(statusCode)) {
                resetSession(
                    instanceKey,
                    'Sesi tidak valid. File sesi dihapus, silakan scan QR ulang.'
                );
                return;
            }

            if (NO_RECONNECT_CODES.has(statusCode)) {
                clearReconnectTimer(meta);
                sessions.delete(instanceKey);
                console.log(`[${instanceKey}] Koneksi diganti perangkat lain. Tidak reconnect otomatis.`);
                return;
            }

            meta.reconnectAttempts += 1;

            if (meta.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
                resetSession(
                    instanceKey,
                    `Gagal reconnect ${MAX_RECONNECT_ATTEMPTS}x. File sesi dihapus, silakan scan QR ulang.`
                );
                return;
            }

            const delayMs = Math.min(3000 * meta.reconnectAttempts, 15000);
            console.log(
                `[${instanceKey}] Reconnecting... (${meta.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}) dalam ${delayMs / 1000}s`
            );

            clearReconnectTimer(meta);
            meta.reconnectTimer = setTimeout(() => {
                meta.reconnectTimer = null;
                reconnectSession(instanceKey);
            }, delayMs);
        }

        if (connection === 'open') {
            session.status = 'connected';
            session.qrCode = null;
            meta.reconnectAttempts = 0;
            clearReconnectTimer(meta);

            const rawId = socket.user?.id || '';
            session.phone = rawId.split(':')[0].split('@')[0] || null;

            console.log(`[${instanceKey}] Connected! Phone: ${session.phone}`);

            const tenantId = extractTenantId(instanceKey);
            if (tenantId) {
                await updateGatewayStatus(tenantId, true, session.phone);
            }
        }
    });
}

async function reconnectSession(instanceKey) {
    const session = sessions.get(instanceKey);
    if (session) {
        try {
            session.socket?.end();
        } catch (_) {}
    }

    sessions.delete(instanceKey);
    await startSession(instanceKey, { fromReconnect: true });
}

/**
 * Get or create a session for the given instance key.
 */
async function startSession(instanceKey, options = {}) {
    const meta = getMeta(instanceKey);

    if (!options.fromReconnect) {
        meta.reconnectAttempts = 0;
        clearReconnectTimer(meta);
    }

    if (meta.isStarting) {
        return sessions.get(instanceKey) || { status: 'connecting', qrCode: null, phone: null };
    }

    if (sessions.has(instanceKey)) {
        const existing = sessions.get(instanceKey);
        if (existing.status === 'connected' && existing.socket) {
            return existing;
        }
        if (existing.status === 'connecting' || existing.status === 'waiting_scan') {
            return existing;
        }

        try {
            existing.socket?.end();
        } catch (_) {}
        sessions.delete(instanceKey);
    }

    meta.isStarting = true;

    const session = {
        socket: null,
        qrCode: null,
        status: 'connecting',
        phone: null,
        saveCreds: null,
        instanceKey,
    };

    sessions.set(instanceKey, session);

    try {
        await createSocket(instanceKey, session, meta);
    } catch (err) {
        sessions.delete(instanceKey);
        console.error(`[${instanceKey}] Gagal membuat socket: ${err.message}`);
        throw err;
    } finally {
        meta.isStarting = false;
    }

    return session;
}

function getSession(instanceKey) {
    return sessions.get(instanceKey) || null;
}

async function destroySession(instanceKey) {
    const session = sessions.get(instanceKey);
    const meta = getMeta(instanceKey);

    clearReconnectTimer(meta);

    if (session?.socket) {
        try {
            await session.socket.logout();
        } catch (_) {}
        try {
            session.socket.end();
        } catch (_) {}
    }

    sessions.delete(instanceKey);
    instanceMeta.delete(instanceKey);
    wipeSessionFiles(instanceKey);

    const tenantId = extractTenantId(instanceKey);
    if (tenantId) {
        await updateGatewayStatus(tenantId, false);
    }

    return true;
}

async function sendText(instanceKey, phone, message) {
    const session = sessions.get(instanceKey);

    if (!session || session.status !== 'connected' || !session.socket) {
        throw new Error('WhatsApp belum terhubung.');
    }

    const jid = formatJid(phone);
    await session.socket.sendMessage(jid, { text: message });

    return { success: true, message: 'Pesan berhasil dikirim.' };
}

async function sendMedia(instanceKey, phone, message, mediaUrl, mediaType) {
    const session = sessions.get(instanceKey);

    if (!session || session.status !== 'connected' || !session.socket) {
        throw new Error('WhatsApp belum terhubung.');
    }

    const jid = formatJid(phone);
    let content = {};

    switch (mediaType) {
        case 'image':
            content = { image: { url: mediaUrl }, caption: message || '' };
            break;
        case 'video':
            content = { video: { url: mediaUrl }, caption: message || '' };
            break;
        case 'document':
        default:
            if (message) {
                await session.socket.sendMessage(jid, { text: message });
            }
            const fileName = mediaUrl.split('/').pop() || 'document';
            content = { document: { url: mediaUrl }, fileName };
            break;
    }

    await session.socket.sendMessage(jid, content);
    return { success: true, message: 'Pesan media berhasil dikirim.' };
}

function formatJid(phone) {
    if (phone.includes('@')) return phone;

    let cleaned = phone.replace(/[^0-9]/g, '');

    if (cleaned.startsWith('0')) {
        cleaned = '62' + cleaned.substring(1);
    } else if (cleaned.startsWith('8')) {
        cleaned = '62' + cleaned;
    }

    return cleaned + '@s.whatsapp.net';
}

function extractTenantId(instanceKey) {
    const match = instanceKey.match(/^sekolah_(\d+)$/);
    return match ? parseInt(match[1], 10) : null;
}

export {
    startSession,
    getSession,
    destroySession,
    sendText,
    sendMedia,
};
