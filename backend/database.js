// database.js
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Inisialisasi database
const dbPath = path.join(__dirname, 'atlantic.db');
const db = new Database(dbPath);

// Buat tabel deposit jika belum ada
db.exec(`
    CREATE TABLE IF NOT EXISTS deposits (
        id TEXT PRIMARY KEY,
        reff_id TEXT NOT NULL,
        nominal INTEGER NOT NULL,
        user_name TEXT DEFAULT 'Customer',
        status TEXT DEFAULT 'pending',
        qr_string TEXT,
        created_at INTEGER NOT NULL,
        expired_at INTEGER NOT NULL,
        updated_at INTEGER,
        payment_time INTEGER,
        payment_method TEXT,
        payment_reference TEXT
    );
    
    CREATE INDEX IF NOT EXISTS idx_deposits_status ON deposits(status);
    CREATE INDEX IF NOT EXISTS idx_deposits_created_at ON deposits(created_at);
    CREATE INDEX IF NOT EXISTS idx_deposits_expired_at ON deposits(expired_at);
`);

// Helper functions untuk deposit
export const depositDB = {
    // Simpan deposit baru
    saveDeposit(deposit) {
        const stmt = db.prepare(`
            INSERT INTO deposits (id, reff_id, nominal, user_name, status, qr_string, created_at, expired_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        
        return stmt.run(
            deposit.id,
            deposit.reffId,
            deposit.nominal,
            deposit.userName || 'Customer',
            deposit.status || 'pending',
            deposit.qrString || '',
            deposit.createdAt,
            deposit.expiredAt,
            Date.now()
        );
    },
    
    // Update status deposit
    updateDepositStatus(id, status, paymentData = {}) {
        const updates = { status, updated_at: Date.now() };
        
        if (paymentData.payment_time) updates.payment_time = paymentData.payment_time;
        if (paymentData.payment_method) updates.payment_method = paymentData.payment_method;
        if (paymentData.payment_reference) updates.payment_reference = paymentData.payment_reference;
        
        const fields = Object.keys(updates).map(key => `${key} = ?`).join(', ');
        const values = Object.values(updates);
        values.push(id);
        
        const stmt = db.prepare(`UPDATE deposits SET ${fields} WHERE id = ?`);
        return stmt.run(...values);
    },
    
    // Get deposit by ID
    getDepositById(id) {
        const stmt = db.prepare('SELECT * FROM deposits WHERE id = ?');
        return stmt.get(id);
    },
    
    // Get all deposits (dengan filter)
    getAllDeposits(filters = {}) {
        let query = 'SELECT * FROM deposits WHERE 1=1';
        const params = [];
        
        if (filters.status && filters.status !== 'all') {
            query += ' AND status = ?';
            params.push(filters.status);
        }
        
        if (filters.search) {
            query += ' AND (id LIKE ? OR user_name LIKE ? OR reff_id LIKE ?)';
            const searchTerm = `%${filters.search}%`;
            params.push(searchTerm, searchTerm, searchTerm);
        }
        
        if (filters.dateFrom) {
            query += ' AND created_at >= ?';
            params.push(filters.dateFrom);
        }
        
        if (filters.dateTo) {
            query += ' AND created_at <= ?';
            params.push(filters.dateTo);
        }
        
        query += ' ORDER BY created_at DESC';
        
        if (filters.limit) {
            query += ' LIMIT ?';
            params.push(filters.limit);
        }
        
        const stmt = db.prepare(query);
        return stmt.all(...params);
    },
    
    // Get deposits by status
    getDepositsByStatus(status) {
        const stmt = db.prepare('SELECT * FROM deposits WHERE status = ? ORDER BY created_at DESC');
        return stmt.all(status);
    },
    
    // Get active deposits (pending and not expired)
    getActiveDeposits() {
        const now = Date.now();
        const stmt = db.prepare('SELECT * FROM deposits WHERE status = ? AND expired_at > ? ORDER BY created_at DESC');
        return stmt.all('pending', now);
    },
    
    // Get expired deposits
    getExpiredDeposits() {
        const now = Date.now();
        const stmt = db.prepare('SELECT * FROM deposits WHERE status = ? AND expired_at <= ?');
        return stmt.all('pending', now);
    },
    
    // Delete deposit by ID
    deleteDeposit(id) {
        const stmt = db.prepare('DELETE FROM deposits WHERE id = ?');
        return stmt.run(id);
    },
    
    // Get deposit statistics
    getStatistics() {
        const now = Date.now();
        
        const totalStmt = db.prepare('SELECT COUNT(*) as total, SUM(nominal) as total_nominal FROM deposits');
        const total = totalStmt.get();
        
        const successStmt = db.prepare('SELECT COUNT(*) as count, SUM(nominal) as total FROM deposits WHERE status = ?');
        const success = successStmt.get('success');
        
        const pendingStmt = db.prepare('SELECT COUNT(*) as count, SUM(nominal) as total FROM deposits WHERE status = ? AND expired_at > ?');
        const pending = pendingStmt.get('pending', now);
        
        const expiredStmt = db.prepare('SELECT COUNT(*) as count, SUM(nominal) as total FROM deposits WHERE status = ? OR (status = ? AND expired_at <= ?)');
        const expired = expiredStmt.get('expired', 'pending', now);
        
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayStmt = db.prepare('SELECT COUNT(*) as count, SUM(nominal) as total FROM deposits WHERE created_at >= ? AND status = ?');
        const todayStats = todayStmt.get(today.getTime(), 'success');
        
        return {
            total: total.total || 0,
            total_nominal: total.total_nominal || 0,
            success: {
                count: success.count || 0,
                total: success.total || 0
            },
            pending: {
                count: pending.count || 0,
                total: pending.total || 0
            },
            expired: {
                count: expired.count || 0,
                total: expired.total || 0
            },
            today: {
                count: todayStats.count || 0,
                total: todayStats.total || 0
            }
        };
    },
    
    // Update expired deposits
    updateExpiredDeposits() {
        const now = Date.now();
        const stmt = db.prepare('UPDATE deposits SET status = ?, updated_at = ? WHERE status = ? AND expired_at <= ?');
        return stmt.run('expired', now, 'pending', now);
    }
};

// Helper functions untuk transfer (jika perlu disimpan)
db.exec(`
    CREATE TABLE IF NOT EXISTS transfers (
        id TEXT PRIMARY KEY,
        reff_id TEXT NOT NULL,
        kode_bank TEXT NOT NULL,
        nomor_akun TEXT NOT NULL,
        nama_pemilik TEXT NOT NULL,
        nominal INTEGER NOT NULL,
        fee INTEGER,
        total INTEGER,
        status TEXT DEFAULT 'pending',
        note TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER,
        completed_at INTEGER
    );
`);

export const transferDB = {
    saveTransfer(transfer) {
        const stmt = db.prepare(`
            INSERT INTO transfers (id, reff_id, kode_bank, nomor_akun, nama_pemilik, nominal, fee, total, status, note, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        
        return stmt.run(
            transfer.id,
            transfer.reff_id,
            transfer.kode_bank,
            transfer.nomor_akun,
            transfer.nama_pemilik,
            transfer.nominal,
            transfer.fee || 0,
            transfer.total || transfer.nominal,
            transfer.status || 'pending',
            transfer.note || '',
            transfer.created_at,
            Date.now()
        );
    },
    
    updateTransferStatus(id, status, completed_at = null) {
        const stmt = db.prepare('UPDATE transfers SET status = ?, updated_at = ?, completed_at = COALESCE(?, completed_at) WHERE id = ?');
        return stmt.run(status, Date.now(), completed_at, id);
    },
    
    getAllTransfers(filters = {}) {
        let query = 'SELECT * FROM transfers WHERE 1=1';
        const params = [];
        
        if (filters.status && filters.status !== 'all') {
            query += ' AND status = ?';
            params.push(filters.status);
        }
        
        query += ' ORDER BY created_at DESC';
        
        if (filters.limit) {
            query += ' LIMIT ?';
            params.push(filters.limit);
        }
        
        const stmt = db.prepare(query);
        return stmt.all(...params);
    }
};

export default db;
