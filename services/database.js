const mysql = require('mysql2/promise');

let pool = null;

function getPool() {
    if (!pool) {
        pool = mysql.createPool({
            host: process.env.DB_HOST || '127.0.0.1',
            port: parseInt(process.env.DB_PORT || '3306', 10),
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            database: process.env.DB_NAME || 'sekolah_gateway',
            waitForConnections: true,
            connectionLimit: 5,
        });
    }
    return pool;
}

/**
 * Update or create whatsapp_gateway record for a tenant.
 */
async function updateGatewayStatus(tenantId, connected, phone = null) {
    try {
        const db = getPool();
        const status = connected ? 1 : 0;
        const now = new Date();

        await db.execute(
            `INSERT INTO whatsapp_gateway (tenant_id, status, phone, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE status = VALUES(status), phone = VALUES(phone), updated_at = VALUES(updated_at)`,
            [tenantId, status, phone, now, now]
        );
    } catch (err) {
        console.error(`[DB] Failed to update gateway status for tenant ${tenantId}:`, err.message);
    }
}

module.exports = { updateGatewayStatus };
