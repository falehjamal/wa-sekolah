const express = require('express');
const QRCode = require('qrcode');
const { startSession, getSession, destroySession, sendText, sendMedia } = require('../services/whatsapp');

const sessionRouter = express.Router();
const messageRouter = express.Router();

// ============================================================
// SESSION ROUTES
// ============================================================

/**
 * POST /sessions/start
 * Start a new session and return QR code.
 * Body: { instance_key: "sekolah_5" }
 */
sessionRouter.post('/start', async (req, res) => {
    try {
        const { instance_key } = req.body;

        if (!instance_key || typeof instance_key !== 'string') {
            return res.status(400).json({ success: false, message: 'instance_key wajib diisi.' });
        }

        const session = await startSession(instance_key);

        // Wait a moment for QR to generate
        let qrBase64 = null;
        const maxWait = 10000; // 10 seconds
        const interval = 500;
        let waited = 0;

        while (!session.qrCode && session.status !== 'connected' && waited < maxWait) {
            await new Promise(resolve => setTimeout(resolve, interval));
            waited += interval;
        }

        if (session.status === 'connected') {
            return res.json({
                success: true,
                message: 'WhatsApp sudah terhubung.',
                data: {
                    state: 'connected',
                    state_label: 'Terhubung',
                    qr_code: null,
                    instance_key,
                    phone: session.phone || null,
                },
            });
        }

        if (session.qrCode) {
            qrBase64 = await QRCode.toDataURL(session.qrCode);
        }

        return res.json({
            success: true,
            message: qrBase64 ? 'QR code berhasil diambil. Silakan scan dari aplikasi WhatsApp.' : 'Menunggu QR code...',
            data: {
                state: session.status,
                state_label: session.status === 'waiting_scan' ? 'Menunggu Scan QR' : 'Menghubungkan...',
                qr_code: qrBase64,
                instance_key,
            },
        });
    } catch (err) {
        console.error('[POST /sessions/start]', err.message);
        return res.status(500).json({ success: false, message: 'Gagal memulai sesi: ' + err.message });
    }
});

/**
 * GET /sessions/status/:instanceKey
 * Get connection status for an instance.
 */
sessionRouter.get('/status/:instanceKey', async (req, res) => {
    try {
        const { instanceKey } = req.params;
        const session = getSession(instanceKey);

        if (!session) {
            return res.json({
                success: true,
                message: 'Sesi tidak ditemukan.',
                data: {
                    state: 'disconnected',
                    state_label: 'Tidak Terhubung',
                    qr_code: null,
                    instance_key: instanceKey,
                },
            });
        }

        let qrBase64 = null;
        if (session.qrCode && session.status === 'waiting_scan') {
            qrBase64 = await QRCode.toDataURL(session.qrCode);
        }

        const stateMap = {
            connected: 'Terhubung',
            waiting_scan: 'Menunggu Scan QR',
            connecting: 'Menghubungkan...',
            disconnected: 'Tidak Terhubung',
        };

        return res.json({
            success: true,
            message: 'Status koneksi berhasil diambil.',
            data: {
                state: session.status,
                state_label: stateMap[session.status] || session.status,
                qr_code: qrBase64,
                instance_key: instanceKey,
                phone: session.phone || null,
            },
        });
    } catch (err) {
        console.error('[GET /sessions/status]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * GET /sessions/qr/:instanceKey
 * Get the current QR code for an instance.
 */
sessionRouter.get('/qr/:instanceKey', async (req, res) => {
    try {
        const { instanceKey } = req.params;
        const session = getSession(instanceKey);

        if (!session || !session.qrCode) {
            return res.json({
                success: false,
                message: 'QR code tidak tersedia.',
                data: { qr_code: null },
            });
        }

        const qrBase64 = await QRCode.toDataURL(session.qrCode);

        return res.json({
            success: true,
            message: 'QR code berhasil diambil.',
            data: { qr_code: qrBase64 },
        });
    } catch (err) {
        console.error('[GET /sessions/qr]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * DELETE /sessions/:instanceKey
 * Logout and destroy a session.
 */
sessionRouter.delete('/:instanceKey', async (req, res) => {
    try {
        const { instanceKey } = req.params;
        await destroySession(instanceKey);

        return res.json({
            success: true,
            message: 'Sesi WhatsApp berhasil direset.',
            data: {
                state: 'disconnected',
                state_label: 'Tidak Terhubung',
                qr_code: null,
                instance_key: instanceKey,
            },
        });
    } catch (err) {
        console.error('[DELETE /sessions]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ============================================================
// MESSAGE ROUTES
// ============================================================

/**
 * POST /messages/send-text
 * Body: { instance_key, phone, message }
 */
messageRouter.post('/send-text', async (req, res) => {
    try {
        const { instance_key, phone, message } = req.body;

        if (!instance_key || !phone || !message) {
            return res.status(400).json({
                success: false,
                message: 'instance_key, phone, dan message wajib diisi.',
            });
        }

        const result = await sendText(instance_key, phone, message);
        return res.json(result);
    } catch (err) {
        console.error('[POST /messages/send-text]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * POST /messages/send-media
 * Body: { instance_key, phone, message, media_url, media_type }
 * media_type: "image" | "video" | "document"
 */
messageRouter.post('/send-media', async (req, res) => {
    try {
        const { instance_key, phone, message, media_url, media_type } = req.body;

        if (!instance_key || !phone || !media_url) {
            return res.status(400).json({
                success: false,
                message: 'instance_key, phone, dan media_url wajib diisi.',
            });
        }

        const result = await sendMedia(instance_key, phone, message || '', media_url, media_type || 'document');
        return res.json(result);
    } catch (err) {
        console.error('[POST /messages/send-media]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = { sessionRouter, messageRouter };
