const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const { updateGatewayStatus } = require('./database');

const SESSIONS_DIR = path.join(__dirname, '..', 'sessions');

// In-memory store: { instanceKey: { socket, qrCode, status, saveCreds } }
const sessions = new Map();

const logger = pino({ level: 'silent' });

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
        // If not connected, clean up and recreate
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
    };

    sessions.set(instanceKey, session);

    const socket = makeWASocket({
        version,
        logger,
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        browser: ['Sekolah App', 'Chrome', '10.0'],
        generateHighQualityLinkPreview: false,
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
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            session.status = 'disconnected';
            session.qrCode = null;

            // Update DB status to disconnected
            const tenantId = extractTenantId(instanceKey);
            if (tenantId) {
                await updateGatewayStatus(tenantId, false);
            }

            if (shouldReconnect) {
                console.log(`[${instanceKey}] Reconnecting...`);
                // Small delay before reconnect to avoid rapid loops
                setTimeout(() => startSession(instanceKey), 3000);
            } else {
                console.log(`[${instanceKey}] Logged out. Cleaning up session files.`);
                sessions.delete(instanceKey);

                // Auto-delete session folder so fresh QR is generated next time
                const sessionDir = path.join(SESSIONS_DIR, instanceKey);
                if (fs.existsSync(sessionDir)) {
                    fs.rmSync(sessionDir, { recursive: true, force: true });
                }
            }
        }

        if (connection === 'open') {
            session.status = 'connected';
            session.qrCode = null;

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
        try {
            await session.socket.logout();
        } catch (_) {}
        try {
            session.socket.end();
        } catch (_) {}
    }

    sessions.delete(instanceKey);

    // Remove auth files
    const sessionDir = path.join(SESSIONS_DIR, instanceKey);
    if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }

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

module.exports = {
    startSession,
    getSession,
    destroySession,
    sendText,
    sendMedia,
};
