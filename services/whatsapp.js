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

// In-memory store: { instanceKey: { socket, qrCode, status, saveCreds } }
const sessions = new Map();

const logger = pino({ level: 'silent' });

function clearReconnectTimer(session) {
    if (session.reconnectTimer) {
        clearTimeout(session.reconnectTimer);
        session.reconnectTimer = null;
    }
}

function wipeSessionFiles(instanceKey) {
    const sessionDir = path.join(SESSIONS_DIR, instanceKey);
    if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
}

function resetSession(instanceKey, message) {
    const session = sessions.get(instanceKey);
    if (session) {
        clearReconnectTimer(session);
        try {
            session.socket?.end();
        } catch (_) {}
    }

    sessions.delete(instanceKey);
    wipeSessionFiles(instanceKey);
    console.log(`[${instanceKey}] ${message}`);
}

/**
 * Get or create a session for the given instance key.
 * Returns the session object.
 */
async function startSession(instanceKey) {
    // If already connected, return existing
    if (sessions.has(instanceKey)) {
        const existing = sessions.get(instanceKey);
        if (existing.status === 'connected' && existing.socket) {
            return existing;
        }
        if (existing.status === 'connecting' || existing.status === 'waiting_scan') {
            return existing;
        }
        // If not connected, clean up and recreate
        clearReconnectTimer(existing);
        try {
            existing.socket?.end();
        } catch (_) {}
        sessions.delete(instanceKey);
    }

    const sessionDir = path.join(SESSIONS_DIR, instanceKey);
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const session = {
        socket: null,
        qrCode: null,
        status: 'connecting',
        phone: null,
        saveCreds,
        instanceKey,
        reconnectAttempts: 0,
        reconnectTimer: null,
    };

    sessions.set(instanceKey, session);

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
            const errorMessage = error?.message || 'unknown';

            session.status = 'disconnected';
            session.qrCode = null;

            console.log(`[${instanceKey}] Connection closed. Code: ${statusCode ?? 'n/a'}, Reason: ${errorMessage}`);

            // Update DB status to disconnected
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
                clearReconnectTimer(session);
                sessions.delete(instanceKey);
                console.log(`[${instanceKey}] Koneksi diganti perangkat lain. Tidak reconnect otomatis.`);
                return;
            }

            session.reconnectAttempts += 1;

            if (session.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
                resetSession(
                    instanceKey,
                    `Gagal reconnect ${MAX_RECONNECT_ATTEMPTS}x. File sesi dihapus, silakan scan QR ulang.`
                );
                return;
            }

            const delayMs = Math.min(3000 * session.reconnectAttempts, 15000);
            console.log(
                `[${instanceKey}] Reconnecting... (${session.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}) dalam ${delayMs / 1000}s`
            );

            clearReconnectTimer(session);
            session.reconnectTimer = setTimeout(() => {
                session.reconnectTimer = null;
                startSession(instanceKey);
            }, delayMs);
        }

        if (connection === 'open') {
            session.status = 'connected';
            session.qrCode = null;
            session.reconnectAttempts = 0;
            clearReconnectTimer(session);

            // Extract connected phone number from socket
            const rawId = socket.user?.id || '';
            session.phone = rawId.split(':')[0].split('@')[0] || null;

            console.log(`[${instanceKey}] Connected! Phone: ${session.phone}`);

            // Update DB status to connected (with phone)
            const tenantId = extractTenantId(instanceKey);
            if (tenantId) {
                await updateGatewayStatus(tenantId, true, session.phone);
            }
        }
    });

    return session;
}

/**
 * Get session info without starting one.
 */
function getSession(instanceKey) {
    return sessions.get(instanceKey) || null;
}

/**
 * Logout and destroy a session.
 */
async function destroySession(instanceKey) {
    const session = sessions.get(instanceKey);

    if (session?.socket) {
        clearReconnectTimer(session);
        try {
            await session.socket.logout();
        } catch (_) {}
        try {
            session.socket.end();
        } catch (_) {}
    }

    sessions.delete(instanceKey);
    wipeSessionFiles(instanceKey);

    // Update DB status to disconnected
    const tenantId = extractTenantId(instanceKey);
    if (tenantId) {
        await updateGatewayStatus(tenantId, false);
    }

    return true;
}

/**
 * Send a text message.
 */
async function sendText(instanceKey, phone, message) {
    const session = sessions.get(instanceKey);

    if (!session || session.status !== 'connected' || !session.socket) {
        throw new Error('WhatsApp belum terhubung.');
    }

    const jid = formatJid(phone);
    await session.socket.sendMessage(jid, { text: message });

    return { success: true, message: 'Pesan berhasil dikirim.' };
}

/**
 * Send a media message (image, video, or document).
 */
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
            // Send text first if provided, then document
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

/**
 * Format phone number to WhatsApp JID.
 */
function formatJid(phone) {
    // Already a JID
    if (phone.includes('@')) return phone;

    // Remove non-numeric characters
    let cleaned = phone.replace(/[^0-9]/g, '');

    // Indonesian phone normalization
    if (cleaned.startsWith('0')) {
        cleaned = '62' + cleaned.substring(1);
    } else if (cleaned.startsWith('8')) {
        cleaned = '62' + cleaned;
    }

    return cleaned + '@s.whatsapp.net';
}

/**
 * Extract tenant ID from instance key (e.g., "sekolah_5" -> 5).
 */
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
