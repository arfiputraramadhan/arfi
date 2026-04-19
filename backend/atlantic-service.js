import axios from 'axios';
import QRCode from 'qrcode';
import dotenv from 'dotenv';

dotenv.config();

class AtlanticService {
    constructor() {
        this.apiKey = process.env.ATLANTIC_API_KEY;
        this.baseURL = process.env.ATLANTIC_API_URL || 'https://atlantich2h.com/';
        this.timeout = 30000;
        this.debug = process.env.ATLANTIC_DEBUG_MODE === 'true';
        
        // Store untuk tracking deposits (in-memory)
        this.activeDeposits = new Map();
        
        console.log('🔄 Atlantic Service Initialized');
        console.log('📌 Mode: Normal Check (Instant Check DISABLED)');
        console.log('📌 Status "PROSES" akan dianggap SUCCESS');
    }

    async generateQRCode(qrString, options = {}) {
        try {
            const defaultOptions = {
                errorCorrectionLevel: 'H',
                type: 'png',
                margin: 2,
                width: 400,
                color: {
                    dark: '#000000',
                    light: '#FFFFFF'
                }
            };
            
            const qrOptions = { ...defaultOptions, ...options };
            const qrBuffer = await QRCode.toBuffer(qrString, qrOptions);
            return qrBuffer;
        } catch (error) {
            console.error('❌ QR Code generation error:', error.message);
            throw new Error(`Gagal generate QR code: ${error.message}`);
        }
    }

    // Normalisasi status - proses dianggap success
    normalizeStatus(apiStatus) {
        if (!apiStatus) return 'pending';
        
        const statusLower = apiStatus.toLowerCase();
        
        // proses dianggap success
        if (statusLower === 'proses' || statusLower === 'process') {
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

    async createQRISDeposit(params) {
        try {
            const { reff_id, nominal, user_id } = params;
            
            console.log(`📤 Creating deposit: ${nominal} for ${user_id}`);
            
            const endpoint = '/deposit/create';
            const requestData = {
                api_key: this.apiKey,
                reff_id: reff_id,
                nominal: nominal,
                type: 'ewallet',
                metode: 'qris'
            };
            
            const requiredFields = ['reff_id', 'nominal'];
            for (const field of requiredFields) {
                if (!params[field]) {
                    throw new Error(`Field ${field} diperlukan`);
                }
            }
            
            if (params.nominal < 1000) {
                throw new Error('Nominal minimal Rp 1.000');
            }
            
            const response = await axios.post(
                `${this.baseURL}${endpoint}`,
                new URLSearchParams(requestData).toString(),
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    timeout: this.timeout
                }
            );
            
            if (!response.data.status) {
                throw new Error(response.data.message || 'Gagal membuat deposit');
            }
            
            const depositData = response.data.data;
            
            // Generate QR Code
            let qrBase64 = null;
            if (depositData.qr_string) {
                try {
                    const qrBuffer = await this.generateQRCode(depositData.qr_string);
                    qrBase64 = `data:image/png;base64,${qrBuffer.toString('base64')}`;
                } catch (qrError) {
                    console.warn('⚠️ Failed to generate QR:', qrError.message);
                }
            }
            
            // Simpan data deposit aktif
            this.activeDeposits.set(depositData.id, {
                id: depositData.id,
                reffId: reff_id,
                nominal: nominal,
                userId: user_id,
                status: 'pending',
                createdAt: Date.now(),
                qrString: depositData.qr_string,
                qrBase64: qrBase64
            });
            
            return {
                success: true,
                data: {
                    ...depositData,
                    qr_base64: qrBase64,
                    user_id: user_id,
                    reff_id: reff_id
                },
                message: 'Deposit berhasil dibuat'
            };
            
        } catch (error) {
            console.error('❌ Create deposit error:', error.message);
            
            let errorMessage = 'Terjadi kesalahan';
            if (error.response?.data?.message) {
                errorMessage = error.response.data.message;
            } else if (error.code === 'ECONNABORTED') {
                errorMessage = 'Timeout: Server tidak merespon';
            }
            
            return {
                success: false,
                message: errorMessage
            };
        }
    }

    async checkDepositStatus(depositId) {
        try {
            console.log(`🔍 Checking status: ${depositId}`);
            
            const endpoint = '/deposit/status';
            const requestData = {
                api_key: this.apiKey,
                id: depositId
            };
            
            const response = await axios.post(
                `${this.baseURL}${endpoint}`,
                new URLSearchParams(requestData).toString(),
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    timeout: this.timeout
                }
            );
            
            if (!response.data.status) {
                throw new Error(response.data.message || 'Deposit tidak ditemukan');
            }
            
            const apiRawStatus = response.data.data.status;
            const normalizedStatus = this.normalizeStatus(apiRawStatus);
            
            // Update status in memory dengan status yang sudah dinormalisasi
            const deposit = this.activeDeposits.get(depositId);
            if (deposit) {
                deposit.status = normalizedStatus;
                if (normalizedStatus === 'success') {
                    deposit.completedAt = Date.now();
                }
            }
            
            return {
                success: true,
                data: {
                    ...response.data.data,
                    status: normalizedStatus,
                    raw_status: apiRawStatus
                },
                message: 'Status berhasil dicek'
            };
            
        } catch (error) {
            console.error('❌ Status check error:', error.message);
            return {
                success: false,
                message: error.response?.data?.message || 'Gagal mengecek status'
            };
        }
    }

    // NOTE: Instant check dihapus - tidak digunakan lagi
    // Fungsi instantCheckDeposit telah dihapus karena tidak diperlukan
    
    async getProfile() {
        try {
            console.log('👤 Getting profile info...');
            
            const endpoint = '/get_profile';
            const requestData = {
                api_key: this.apiKey
            };
            
            const response = await axios.post(
                `${this.baseURL}${endpoint}`,
                new URLSearchParams(requestData).toString(),
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    timeout: this.timeout
                }
            );
            
            if (!response.data.status) {
                throw new Error(response.data.message || 'Gagal mendapatkan profile');
            }
            
            return {
                success: true,
                data: response.data.data,
                message: 'Profile berhasil didapatkan'
            };
            
        } catch (error) {
            console.error('❌ Get profile error:', error.message);
            return {
                success: false,
                message: error.response?.data?.message || 'Gagal mendapatkan profile'
            };
        }
    }

    async getBalance() {
        try {
            console.log('💰 Getting balance...');
            
            const endpoint = '/get_balance';
            const requestData = {
                api_key: this.apiKey
            };
            
            const response = await axios.post(
                `${this.baseURL}${endpoint}`,
                new URLSearchParams(requestData).toString(),
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    timeout: this.timeout
                }
            );
            
            if (!response.data.status) {
                // Fallback ke get_profile jika get_balance tidak tersedia
                return await this.getProfile();
            }
            
            return {
                success: true,
                data: response.data.data,
                message: 'Saldo berhasil didapatkan'
            };
            
        } catch (error) {
            console.error('❌ Get balance error:', error.message);
            // Fallback ke get_profile
            return await this.getProfile();
        }
    }

    async transfer(params) {
        try {
            const {
                ref_id,
                kode_bank,
                nomor_akun,
                nama_pemilik,
                nominal,
                email,
                phone,
                note
            } = params;
            
            console.log(`📤 Transfer: ${nominal} to ${kode_bank} - ${nomor_akun}`);
            
            // Tentukan tipe transfer
            const ewalletCodes = ['dana', 'ovo', 'gopay', 'shopeepay', 'linkaja', 'qris', 'sakuku'];
            const isEwallet = ewalletCodes.includes(kode_bank.toLowerCase());
            
            const endpoint = '/transfer/create';
            const requestData = {
                api_key: this.apiKey,
                ref_id: ref_id,
                kode_bank: kode_bank.toLowerCase(),
                nomor_akun: nomor_akun,
                nama_pemilik: nama_pemilik,
                nominal: nominal.toString(),
                amount: nominal.toString(),
                email: email || '',
                phone: phone || '',
                note: note || `Transfer via Atlantic Service - ${new Date().toLocaleString('id-ID')}`,
                type: isEwallet ? 'ewallet' : 'bank'
            };
            
            const response = await axios.post(
                `${this.baseURL}${endpoint}`,
                new URLSearchParams(requestData).toString(),
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    timeout: this.timeout
                }
            );
            
            if (!response.data.status) {
                throw new Error(response.data.message || 'Gagal melakukan transfer');
            }
            
            return {
                success: true,
                data: response.data.data,
                message: 'Transfer berhasil diproses'
            };
            
        } catch (error) {
            console.error('❌ Transfer error:', error.message);
            return {
                success: false,
                message: error.response?.data?.message || 'Gagal melakukan transfer'
            };
        }
    }

    async getBankList() {
        try {
            console.log('🏦 Getting bank list...');
            
            const endpoint = '/transfer/bank_list';
            const requestData = {
                api_key: this.apiKey
            };
            
            const response = await axios.post(
                `${this.baseURL}${endpoint}`,
                new URLSearchParams(requestData).toString(),
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    timeout: this.timeout
                }
            );
            
            if (!response.data.status) {
                throw new Error(response.data.message || 'Gagal mendapatkan daftar bank');
            }
            
            return {
                success: true,
                data: response.data.data || [],
                message: 'Daftar bank berhasil didapatkan'
            };
            
        } catch (error) {
            console.error('❌ Get bank list error:', error.message);
            return {
                success: false,
                message: error.response?.data?.message || 'Gagal mendapatkan daftar bank'
            };
        }
    }

    async checkAccount(bankCode, accountNumber) {
        try {
            console.log(`🔍 Checking account: ${bankCode} - ${accountNumber}`);
            
            const endpoint = '/transfer/cek_rekening';
            const requestData = {
                api_key: this.apiKey,
                bank_code: bankCode.toLowerCase(),
                account_number: accountNumber
            };
            
            const response = await axios.post(
                `${this.baseURL}${endpoint}`,
                new URLSearchParams(requestData).toString(),
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    timeout: this.timeout
                }
            );
            
            if (!response.data.status) {
                throw new Error(response.data.message || 'Gagal mengecek rekening');
            }
            
            return {
                success: true,
                data: response.data.data,
                message: 'Rekening valid'
            };
            
        } catch (error) {
            console.error('❌ Check account error:', error.message);
            return {
                success: false,
                message: error.response?.data?.message || 'Gagal mengecek rekening'
            };
        }
    }

    getActiveDeposit(depositId) {
        return this.activeDeposits.get(depositId);
    }

    getAllActiveDeposits() {
        return Array.from(this.activeDeposits.values());
    }

    removeActiveDeposit(depositId) {
        this.activeDeposits.delete(depositId);
    }

    getStatistics() {
        const deposits = Array.from(this.activeDeposits.values());
        const total = deposits.length;
        const pending = deposits.filter(d => d.status === 'pending').length;
        const success = deposits.filter(d => d.status === 'success').length;
        const totalNominal = deposits.reduce((sum, d) => sum + (d.nominal || 0), 0);
        
        return {
            total,
            pending,
            success,
            totalNominal
        };
    }
}

export default AtlanticService;
