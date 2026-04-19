
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import axios from 'axios';
import QRCode from 'qrcode';
import session from 'express-session';
import { depositDB, transferDB } from './database.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Konfigurasi
const ATLANTIC_API_KEY = process.env.ATLANTIC_API_KEY;
const ATLANTIC_API_URL = process.env.ATLANTIC_API_URL || 'https://atlantich2h.com';
const QRIS_EXPIRY_SECONDS = 59 * 60 + 28; // 59 menit 28 detik
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'arfi';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'arfiputra1234';

// In-memory storage untuk caching (opsional)
const activeDepositsCache = new Map();
const adminSessions = new Map();

// Middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

// Session middleware
app.use(session({
    secret: process.env.SESSION_SECRET || 'atlantic-qris-secret-key-2024',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: false,
        maxAge: 24 * 60 * 60 * 1000 // 24 jam
    }
}));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
app.use('/api/', limiter);

// Serve static files
app.use(express.static(path.join(__dirname, '../frontend')));

// Helper functions
function generateReffId() {
    return `WEB${Date.now()}${Math.floor(Math.random() * 10000)}`;
}

function generateTransferRefId() {
    return `TRF${Date.now()}${Math.floor(Math.random() * 10000)}`;
}

async function generateQRCodeBase64(qrString) {
    try {
        const qrBuffer = await QRCode.toBuffer(qrString, {
            errorCorrectionLevel: 'H',
            margin: 2,
            width: 400,
            color: { dark: '#000000', light: '#FFFFFF' }
        });
        return `data:image/png;base64,${qrBuffer.toString('base64')}`;
    } catch (error) {
        console.error('QR Error:', error.message);
        return null;
    }
}

// Normalisasi status - proses dianggap success
function normalizeStatus(apiStatus) {
    if (!apiStatus) return 'pending';
    
    const statusLower = apiStatus.toLowerCase();
    
    // proses dianggap success
    if (statusLower === 'processing' || statusLower === 'processing') {
        return 'success';
    }
    
    // status lainnya
    if (statusLower === 'success' || statusLower === 'paid' || statusLower === 'complete') {
        return 'success';
    }
    if (statusLower === 'pending' || statusLower === 'waiting') {
        return 'pending';
    }
    if (statusLower === 'expired') {
        return 'expired';
    }
    if (statusLower === 'cancelled' || statusLower === 'cancel') {
        return 'cancelled';
    }
    if (statusLower === 'failed') {
        return 'failed';
    }
    
    return 'pending';
}

async function callAtlanticAPI(endpoint, data) {
    try {
        console.log(`📤 API Request to ${endpoint}:`, JSON.stringify(data, null, 2));
        
        const formData = new URLSearchParams();
        formData.append('api_key', ATLANTIC_API_KEY);
        
        for (const [key, value] of Object.entries(data)) {
            if (value !== undefined && value !== null && value !== '') {
                formData.append(key, value);
            }
        }
        
        const response = await axios.post(`${ATLANTIC_API_URL}${endpoint}`, formData.toString(), {
            headers: { 
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json',
                'User-Agent': 'Atlantic-Web-Client/1.0'
            },
            timeout: 30000
        });
        
        console.log(`📥 API Response from ${endpoint}:`, JSON.stringify(response.data, null, 2));
        
        return { success: true, data: response.data };
    } catch (error) {
        console.error(`❌ API Error (${endpoint}):`, error.message);
        
        if (error.response) {
            console.error('Response status:', error.response.status);
            console.error('Response data:', error.response.data);
            
            if (error.response.status === 403) {
                return { 
                    success: false, 
                    message: 'API Key tidak memiliki izin untuk endpoint ini.',
                    statusCode: 403,
                    data: error.response.data
                };
            }
            
            return { 
                success: false, 
                message: error.response.data?.message || `HTTP ${error.response.status}`,
                statusCode: error.response.status,
                data: error.response.data
            };
        }
        
        return { success: false, message: error.message };
    }
}

// Admin authentication middleware
function requireAdmin(req, res, next) {
    if (req.session.isAdmin) {
        next();
    } else {
        res.status(401).json({ success: false, message: 'Unauthorized: Admin login required' });
    }
}

// ==================== PUBLIC API ROUTES ====================

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Admin Login
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        req.session.isAdmin = true;
        req.session.loginTime = Date.now();
        
        res.json({ 
            success: true, 
            message: 'Login berhasil',
            data: { username: ADMIN_USERNAME }
        });
    } else {
        res.status(401).json({ success: false, message: 'Username atau password salah' });
    }
});

// Admin Logout
app.post('/api/admin/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true, message: 'Logout berhasil' });
});

// Check admin session
app.get('/api/admin/check', (req, res) => {
    res.json({ 
        success: true, 
        isAdmin: req.session.isAdmin || false 
    });
});

// CREATE DEPOSIT (Public - with database save)
app.post('/api/deposit/create', async (req, res) => {
    try {
        const { nominal, user_name } = req.body;
        
        if (!nominal || nominal < 1000) {
            return res.status(400).json({ success: false, message: 'Nominal minimal Rp 1.000' });
        }
        if (nominal > 10000000) {
            return res.status(400).json({ success: false, message: 'Nominal maksimal Rp 10.000.000' });
        }

        const reffId = generateReffId();
        const expiredAt = Date.now() + (QRIS_EXPIRY_SECONDS * 1000);
        
        const result = await callAtlanticAPI('/deposit/create', {
            reff_id: reffId,
            nominal: nominal,
            type: 'ewallet',
            metode: 'qris'
        });

        if (!result.success || !result.data.status) {
            return res.status(400).json({ success: false, message: result.data?.message || 'Gagal membuat deposit' });
        }

        const depositData = result.data.data;
        const qrBase64 = await generateQRCodeBase64(depositData.qr_string);

        // Simpan ke database
        const depositRecord = {
            id: depositData.id,
            reffId: reffId,
            nominal: nominal,
            userName: user_name || 'user',
            status: 'pending',
            createdAt: Date.now(),
            expiredAt: expiredAt,
            qrString: depositData.qr_string
        };
        
        depositDB.saveDeposit(depositRecord);
        
        // Simpan ke cache untuk akses cepat
        activeDepositsCache.set(depositData.id, depositRecord);

        res.json({
            success: true,
            data: {
                id: depositData.id,
                reff_id: reffId,
                nominal: depositData.nominal,
                qr_string: depositData.qr_string,
                qr_base64: qrBase64,
                status: 'pending',
                expired_at: expiredAt,
                expired_seconds: QRIS_EXPIRY_SECONDS
            }
        });
    } catch (error) {
        console.error('Create deposit error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// CHECK STATUS (Public - dengan normalisasi status)
app.get('/api/deposit/status/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Cek dari database dulu
        let deposit = depositDB.getDepositById(id);
        
        if (deposit && deposit.expired_at < Date.now() && deposit.status === 'pending') {
            depositDB.updateDepositStatus(id, 'expired');
            deposit = depositDB.getDepositById(id);
            return res.json({ success: true, data: { id, nominal: deposit.nominal, status: 'expired' } });
        }
        
        const result = await callAtlanticAPI('/deposit/status', { id });
        
        if (!result.success || !result.data.status) {
            return res.status(404).json({ success: false, message: result.data?.message || 'Deposit tidak ditemukan' });
        }

        const apiRawStatus = result.data.data.status;
        const normalizedStatus = normalizeStatus(apiRawStatus);
        
        // Update status di database jika berbeda
        if (deposit && deposit.status !== normalizedStatus) {
            const paymentData = {};
            if (normalizedStatus === 'success') {
                paymentData.payment_time = Date.now();
            }
            depositDB.updateDepositStatus(id, normalizedStatus, paymentData);
            
            // Update cache
            if (activeDepositsCache.has(id)) {
                const cached = activeDepositsCache.get(id);
                cached.status = normalizedStatus;
                activeDepositsCache.set(id, cached);
            }
        }

        res.json({ 
            success: true, 
            data: { 
                id: result.data.data.id, 
                nominal: result.data.data.nominal, 
                status: normalizedStatus,
                raw_status: apiRawStatus
            } 
        });
    } catch (error) {
        console.error('Status check error:', error);
        res.status(500).json({ success: false, message: 'Gagal mengecek status' });
    }
});

// CANCEL DEPOSIT (Public)
app.post('/api/deposit/cancel', async (req, res) => {
    try {
        const { id } = req.body;
        
        const result = await callAtlanticAPI('/deposit/cancel', { id });
        
        if (!result.success || !result.data.status) {
            return res.status(400).json({ success: false, message: result.data?.message || 'Gagal membatalkan' });
        }

        // Update database
        depositDB.updateDepositStatus(id, 'cancelled');
        
        // Update cache
        if (activeDepositsCache.has(id)) {
            activeDepositsCache.delete(id);
        }
        
        res.json({ success: true, message: 'Deposit berhasil dibatalkan' });
    } catch (error) {
        console.error('Cancel error:', error);
        res.status(500).json({ success: false, message: 'Gagal membatalkan' });
    }
});

// GET ALL ACTIVE DEPOSITS (Public)
app.get('/api/deposits/active', (req, res) => {
    const deposits = depositDB.getActiveDeposits();
    res.json({ success: true, data: deposits, count: deposits.length });
});

// GET PROFILE (Public)
app.get('/api/profile', async (req, res) => {
    try {
        const result = await callAtlanticAPI('/get_profile', {});
        
        if (!result.success || !result.data.status) {
            return res.status(400).json({ success: false, message: result.data?.message || 'Gagal mengambil profile' });
        }
        
        res.json({ 
            success: true, 
            data: {
                balance: result.data.data?.balance || '0'
            }
        });
    } catch (error) {
        console.error('Profile error:', error);
        res.status(500).json({ success: false, message: 'Gagal mengambil profile' });
    }
});

// ==================== ADMIN ONLY API ROUTES ====================

// GET PROFILE (Admin only)
app.get('/api/admin/profile', requireAdmin, async (req, res) => {
    try {
        const result = await callAtlanticAPI('/get_profile', {});
        
        if (!result.success || !result.data.status) {
            return res.status(400).json({ success: false, message: result.data?.message || 'Gagal mengambil profile' });
        }
        
        res.json({ 
            success: true, 
            data: {
                name: result.data.data?.name || 'N/A',
                username: result.data.data?.username || 'N/A',
                email: result.data.data?.email || 'N/A',
                phone: result.data.data?.phone || 'N/A',
                balance: result.data.data?.balance || '0',
                status: result.data.data?.status || 'active'
            }
        });
    } catch (error) {
        console.error('Profile error:', error);
        res.status(500).json({ success: false, message: 'Gagal mengambil profile' });
    }
});

// GET ALL DEPOSITS (Admin only - from database)
app.get('/api/admin/deposits/all', requireAdmin, (req, res) => {
    const { status, search, limit } = req.query;
    const filters = {};
    
    if (status && status !== 'all') filters.status = status;
    if (search) filters.search = search;
    if (limit) filters.limit = parseInt(limit);
    
    const deposits = depositDB.getAllDeposits(filters);
    res.json({ success: true, data: deposits, count: deposits.length });
});

// GET DEPOSIT STATISTICS (Admin only)
app.get('/api/admin/deposits/stats', requireAdmin, (req, res) => {
    const stats = depositDB.getStatistics();
    res.json({ success: true, data: stats });
});

// UPDATE DEPOSIT EXPIRED (Admin only - background job)
app.post('/api/admin/deposits/update-expired', requireAdmin, (req, res) => {
    const result = depositDB.updateExpiredDeposits();
    res.json({ success: true, message: 'Expired deposits updated', changes: result.changes });
});

// DELETE DEPOSIT (Admin only)
app.delete('/api/admin/deposit/:id', requireAdmin, (req, res) => {
    const { id } = req.params;
    const result = depositDB.deleteDeposit(id);
    
    if (result.changes > 0) {
        if (activeDepositsCache.has(id)) {
            activeDepositsCache.delete(id);
        }
        res.json({ success: true, message: 'Deposit dihapus' });
    } else {
        res.status(404).json({ success: false, message: 'Deposit tidak ditemukan' });
    }
});

// GET BALANCE DETAIL (Admin only)
app.get('/api/admin/balance', requireAdmin, async (req, res) => {
    try {
        const result = await callAtlanticAPI('/get_balance', {});
        
        if (!result.success) {
            const profileResult = await callAtlanticAPI('/get_profile', {});
            if (profileResult.success && profileResult.data.status) {
                return res.json({ 
                    success: true, 
                    data: { balance: profileResult.data.data?.balance || '0' }
                });
            }
            return res.status(400).json({ success: false, message: result.message });
        }
        
        res.json({ success: true, data: result.data.data });
    } catch (error) {
        console.error('Balance error:', error);
        res.status(500).json({ success: false, message: 'Gagal mengambil saldo' });
    }
});

// TRANSFER (Admin only)
app.post('/api/admin/transfer', requireAdmin, async (req, res) => {
    try {
        const { ref_id, kode_bank, nomor_akun, nama_pemilik, nominal, email, phone, note } = req.body;
        
        if (!ref_id) return res.status(400).json({ success: false, message: 'Reference ID diperlukan' });
        if (!kode_bank) return res.status(400).json({ success: false, message: 'Kode bank diperlukan' });
        if (!nomor_akun) return res.status(400).json({ success: false, message: 'Nomor rekening diperlukan' });
        if (!nama_pemilik) return res.status(400).json({ success: false, message: 'Nama pemilik diperlukan' });
        if (!nominal || nominal < 10000) return res.status(400).json({ success: false, message: 'Nominal minimal Rp 10.000' });
        
        const nominalInt = parseInt(nominal);
        if (isNaN(nominalInt)) return res.status(400).json({ success: false, message: 'Nominal harus berupa angka' });
        
        const fee = Math.min(25000, Math.max(2000, Math.round(nominalInt * 0.02)));
        const total = nominalInt + fee;
        
        const profileResult = await callAtlanticAPI('/get_profile', {});
        let currentBalance = 0;
        
        if (profileResult.success && profileResult.data.status) {
            currentBalance = parseInt(profileResult.data.data?.balance || '0');
            console.log(`💰 Current Balance: ${formatRupiah(currentBalance)}`);
            console.log(`💰 Needed: ${formatRupiah(total)}`);
            
            if (currentBalance < total) {
                return res.status(400).json({ 
                    success: false, 
                    message: `Saldo tidak mencukupi! Saldo: ${formatRupiah(currentBalance)}, Dibutuhkan: ${formatRupiah(total)} (termasuk fee ${formatRupiah(fee)})`,
                    balance: currentBalance,
                    needed: total,
                    fee: fee
                });
            }
        }
        
        const ewalletCodes = ['dana', 'ovo', 'gopay', 'shopeepay', 'linkaja', 'qris', 'sakuku'];
        const isEwallet = ewalletCodes.includes(kode_bank.toLowerCase());
        
        const transferData = {
            ref_id: ref_id,
            kode_bank: kode_bank.toLowerCase(),
            nomor_akun: nomor_akun,
            nama_pemilik: nama_pemilik,
            nominal: nominalInt.toString(),
            amount: nominalInt.toString(),
            email: email || '',
            phone: phone || '',
            note: note || `Transfer via Web Admin - ${new Date().toLocaleString('id-ID')}`,
            type: isEwallet ? 'ewallet' : 'bank'
        };
        
        console.log('📤 Admin Transfer Data:', transferData);
        
        const endpoints = [
            '/transfer/create',
            '/trx/create', 
            '/transfer/send',
            '/transaction/transfer',
            '/send/transfer'
        ];
        
        let result = null;
        let lastError = null;
        
        for (const endpoint of endpoints) {
            console.log(`🔄 Trying endpoint: ${endpoint}`);
            result = await callAtlanticAPI(endpoint, transferData);
            
            if (result.success && result.data.status === true) {
                console.log(`✅ Success with endpoint: ${endpoint}`);
                break;
            } else if (result.statusCode === 403) {
                console.log(`⚠️ Endpoint ${endpoint} returned 403, trying next...`);
                lastError = result;
                result = null;
            } else if (result.success && result.data.status === false) {
                console.log(`⚠️ Endpoint ${endpoint} returned false: ${result.data.message}`);
                lastError = result;
                result = null;
            } else {
                lastError = result;
                result = null;
            }
        }
        
        if (!result) {
            const errorMessage = lastError?.statusCode === 403 
                ? 'API Key tidak memiliki izin untuk melakukan transfer.'
                : (lastError?.message || 'Gagal melakukan transfer.');
            
            return res.status(400).json({ 
                success: false, 
                message: errorMessage
            });
        }
        
        const transferResult = result.data.data || result.data;
        
        // Simpan transfer ke database
        const transferRecord = {
            id: transferResult.id || transferResult.transaction_id || generateTransferRefId(),
            reff_id: ref_id,
            kode_bank: kode_bank,
            nomor_akun: nomor_akun,
            nama_pemilik: nama_pemilik,
            nominal: nominalInt,
            fee: fee,
            total: total,
            status: transferResult.status || 'pending',
            note: note || '',
            created_at: Date.now()
        };
        
        transferDB.saveTransfer(transferRecord);
        
        res.json({
            success: true,
            message: 'Transfer berhasil diproses',
            data: {
                id: transferRecord.id,
                reff_id: ref_id,
                status: transferRecord.status,
                name: nama_pemilik,
                nomor_tujuan: nomor_akun,
                nominal: nominalInt,
                fee: fee,
                total: total,
                created_at: new Date().toISOString()
            }
        });
        
    } catch (error) {
        console.error('❌ Transfer error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Terjadi kesalahan saat transfer: ' + error.message 
        });
    }
});

// GET ALL TRANSFERS (Admin only)
app.get('/api/admin/transfers/all', requireAdmin, (req, res) => {
    const { status, limit } = req.query;
    const filters = {};
    
    if (status && status !== 'all') filters.status = status;
    if (limit) filters.limit = parseInt(limit);
    
    const transfers = transferDB.getAllTransfers(filters);
    res.json({ success: true, data: transfers, count: transfers.length });
});

// CHECK TRANSFER STATUS (Admin only)
app.post('/api/admin/transfer/status', requireAdmin, async (req, res) => {
    try {
        const { id } = req.body;
        
        if (!id) {
            return res.status(400).json({ success: false, message: 'ID transaksi diperlukan' });
        }
        
        const endpoints = ['/transfer/status', '/trx/status', '/transaction/status'];
        let result = null;
        
        for (const endpoint of endpoints) {
            result = await callAtlanticAPI(endpoint, { id });
            if (result.success && result.data.status) {
                break;
            }
        }
        
        if (!result || !result.success || !result.data.status) {
            return res.status(404).json({ success: false, message: result?.data?.message || 'Transaksi tidak ditemukan' });
        }
        
        // Update status di database
        const apiStatus = result.data.data?.status;
        if (apiStatus) {
            transferDB.updateTransferStatus(id, apiStatus, Date.now());
        }
        
        res.json({
            success: true,
            data: result.data.data
        });
        
    } catch (error) {
        console.error('Transfer status error:', error);
        res.status(500).json({ success: false, message: 'Gagal mengecek status transfer' });
    }
});

// GET BANK LIST (Admin only)
app.get('/api/admin/banks', requireAdmin, async (req, res) => {
    try {
        const result = await callAtlanticAPI('/transfer/bank_list', {});
        
        if (!result.success || !result.data.status) {
            return res.status(400).json({ success: false, message: result.data?.message || 'Gagal mengambil daftar bank' });
        }
        
        res.json({
            success: true,
            data: result.data.data || []
        });
        
    } catch (error) {
        console.error('Bank list error:', error);
        res.status(500).json({ success: false, message: 'Gagal mengambil daftar bank' });
    }
});

// CHECK ACCOUNT (Admin only)
app.post('/api/admin/check-account', requireAdmin, async (req, res) => {
    try {
        const { bank_code, account_number } = req.body;
        
        if (!bank_code || !account_number) {
            return res.status(400).json({ success: false, message: 'Kode bank dan nomor rekening diperlukan' });
        }
        
        const result = await callAtlanticAPI('/transfer/cek_rekening', {
            bank_code: bank_code.toLowerCase(),
            account_number: account_number
        });
        
        if (!result.success || !result.data.status) {
            return res.status(400).json({ success: false, message: result.data?.message || 'Gagal mengecek rekening' });
        }
        
        res.json({
            success: true,
            data: {
                bank_code: bank_code,
                account_number: account_number,
                account_name: result.data.data?.account_name || 'Tidak diketahui',
                valid: true
            }
        });
        
    } catch (error) {
        console.error('Check account error:', error);
        res.status(500).json({ success: false, message: 'Gagal mengecek rekening' });
    }
});

// Format Rupiah helper
function formatRupiah(amount) {
    return new Intl.NumberFormat('id-ID', {
        style: 'currency',
        currency: 'IDR',
        minimumFractionDigits: 0
    }).format(amount);
}

// Fallback route
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

app.listen(PORT, () => {
    console.log(`
    
                    WEB ATLANTIC
          Running on http://localhost:${PORT}       
                🔐 ADMIN LOGIN:                     
              Username: ${ADMIN_USERNAME}   
              Password: ${ADMIN_PASSWORD}
    `);
});
