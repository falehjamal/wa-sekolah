import { getActiveGateways } from './services/database.js';
import { startSession } from './services/whatsapp.js';

/**
 * Restore koneksi WhatsApp untuk tenant yang statusnya aktif di database.
 */
export async function restoreConnections() {
    const gateways = await getActiveGateways();

    if (gateways.length === 0) {
        console.log('[Connection] Tidak ada sesi aktif untuk di-restore.');
        return;
    }

    console.log(`[Connection] Restore ${gateways.length} sesi aktif...`);

    for (const gateway of gateways) {
        const instanceKey = `sekolah_${gateway.tenant_id}`;
        try {
            await startSession(instanceKey);
        } catch (err) {
            console.error(`[Connection] Gagal restore ${instanceKey}:`, err.message);
        }
    }
}
