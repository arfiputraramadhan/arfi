// ==================== KONFIGURASI ====================
const API_BASE = window.location.origin;
let currentDepositId = null;
let autoCheckInterval = null;
let countdownInterval = null;

// QRIS Expired: 59 menit 28 detik
const QRIS_EXPIRY_SECONDS = 59 * 60 + 28;

// ==================== UTILITY FUNCTIONS ====================

function showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    if (!toast) {
        console.log(`${type.toUpperCase()}: ${message}`);
        return;
    }
    toast.className = `toast ${type}`;
    const toastMessage = toast.querySelector('.toast-message');
    if (toastMessage) toastMessage.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
}

function formatNumber(num) {
    if (!num && num !== 0) return '0';
    return new Intl.NumberFormat('id-ID').format(num);
}

function formatRupiah(num) {
    return `Rp ${formatNumber(num)}`;
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ==================== NAVIGATION ====================
function showSection(sectionName) {
    const sections = ['homeSection', 'paymentSection', 'statusSection'];
    sections.forEach(section => {
        const el = document.getElementById(section);
        if (el) el.style.display = 'none';
    });
    
    const activeSection = document.getElementById(`${sectionName}Section`);
    if (activeSection) activeSection.style.display = 'block';
    
    document.querySelectorAll('.nav-link').forEach(link => {
        link.classList.remove('active');
        const onclickAttr = link.getAttribute('onclick');
        if (onclickAttr && onclickAttr.includes(sectionName)) {
            link.classList.add('active');
        }
    });
    
    if (sectionName === 'status') {
        const inputEl = document.getElementById('checkDepositId');
        if (inputEl) inputEl.focus();
    }
}

function scrollToPayment() {
    showSection('payment');
    const paymentSection = document.getElementById('paymentSection');
    if (paymentSection) paymentSection.scrollIntoView({ behavior: 'smooth' });
}

// ==================== PROFILE & SALDO ====================
async function loadProfile() {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        
        const response = await fetch(`${API_BASE}/api/profile`, { signal: controller.signal });
        clearTimeout(timeoutId);
        
        const result = await response.json();
        const balanceElement = document.getElementById('balanceAmount');
        
        if (balanceElement) {
            if (result.success && result.data) {
                balanceElement.innerHTML = formatRupiah(result.data.balance || 0);
            } else {
                balanceElement.innerHTML = 'Rp 0';
            }
        }
    } catch (error) {
        console.error('Load profile error:', error);
        const balanceElement = document.getElementById('balanceAmount');
        if (balanceElement) balanceElement.innerHTML = 'Rp 0';
    }
}

// ==================== AUTO CHECK SYSTEM ====================
function stopAutoCheck() {
    if (autoCheckInterval) {
        clearInterval(autoCheckInterval);
        autoCheckInterval = null;
    }
    if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
    }
}

function startAutoCheck(depositId) {
    stopAutoCheck();
    
    autoCheckInterval = setInterval(async () => {
        try {
            const response = await fetch(`${API_BASE}/api/deposit/status/${depositId}`);
            const result = await response.json();
            
            if (result.success && result.data) {
                const status = result.data.status.toLowerCase();
                updateStatusUI(status);
                
                // status 'success' atau 'proses' (yang sudah dinormalisasi jadi success)
                if (status === 'success') {
                    showToast('✅ Pembayaran berhasil! Terima kasih.', 'success');
                    stopAutoCheck();
                    setTimeout(() => {
                        const qrCard = document.getElementById('qrcodeCard');
                        if (qrCard) qrCard.style.display = 'none';
                        currentDepositId = null;
                        loadProfile();
                    }, 2000);
                } else if (status === 'failed' || status === 'expired' || status === 'cancelled') {
                    showToast(`❌ Pembayaran ${status}`, 'error');
                    stopAutoCheck();
                    setTimeout(() => {
                        const qrCard = document.getElementById('qrcodeCard');
                        if (qrCard) qrCard.style.display = 'none';
                        currentDepositId = null;
                    }, 2000);
                }
            }
        } catch (error) {
            console.error('Auto check error:', error);
        }
    }, 10000);
}

function startCountdown(expiredAt) {
    if (countdownInterval) clearInterval(countdownInterval);
    
    const timerTextSpan = document.getElementById('timerText');
    const timerDiv = document.getElementById('countdownTimer');
    
    countdownInterval = setInterval(() => {
        const timeLeft = Math.max(0, Math.floor((expiredAt - Date.now()) / 1000));
        const minutes = Math.floor(timeLeft / 60);
        const seconds = timeLeft % 60;
        
        if (timerTextSpan) {
            timerTextSpan.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        }
        
        if (timerDiv) {
            timerDiv.classList.remove('warning', 'danger');
            if (timeLeft < 60) {
                timerDiv.classList.add('danger');
            } else if (timeLeft < 300) {
                timerDiv.classList.add('warning');
            }
        }
        
        if (timeLeft <= 0) {
            clearInterval(countdownInterval);
            showToast('⏰ Waktu pembayaran telah habis!', 'error');
            stopAutoCheck();
            const qrCard = document.getElementById('qrcodeCard');
            if (qrCard) qrCard.style.display = 'none';
            currentDepositId = null;
        }
    }, 1000);
}

function updateStatusUI(status) {
    const statusSpan = document.getElementById('depositStatus');
    if (!statusSpan) return;
    
    const statusLower = status.toLowerCase();
    
    if (statusLower === 'success') {
        statusSpan.textContent = 'SUCCESS ✅';
        statusSpan.className = 'status-badge success';
    } else if (statusLower === 'pending') {
        statusSpan.textContent = 'MENUNGGU ⏳';
        statusSpan.className = 'status-badge pending';
    } else if (statusLower === 'expired') {
        statusSpan.textContent = 'EXPIRED ❌';
        statusSpan.className = 'status-badge expired';
    } else if (statusLower === 'cancelled') {
        statusSpan.textContent = 'DIBATALKAN ❌';
        statusSpan.className = 'status-badge cancelled';
    } else {
        statusSpan.textContent = status.toUpperCase();
        statusSpan.className = 'status-badge failed';
    }
}

// ==================== CREATE DEPOSIT ====================
async function createDeposit() {
    const nominalInput = document.getElementById('nominal');
    const nominal = parseInt(nominalInput?.value || '0');
    const userName = document.getElementById('userName')?.value || 'Customer';
    
    if (isNaN(nominal) || nominal < 1000) {
        showToast('Nominal minimal Rp 1.000', 'error');
        return;
    }
    if (nominal > 10000000) {
        showToast('Nominal maksimal Rp 10.000.000', 'error');
        return;
    }
    
    const btn = document.getElementById('createDepositBtn');
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<div class="loading"></div> Membuat...';
    
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);
        
        const response = await fetch(`${API_BASE}/api/deposit/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nominal, user_name: userName }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        
        const result = await response.json();
        
        if (result.success && result.data) {
            const data = result.data;
            currentDepositId = data.id;
            
            const qrImage = document.getElementById('qrcodeImage');
            if (qrImage && data.qr_base64) qrImage.src = data.qr_base64;
            
            const depositIdSpan = document.getElementById('depositId');
            const depositNominalSpan = document.getElementById('depositNominal');
            if (depositIdSpan) depositIdSpan.textContent = data.id;
            if (depositNominalSpan) depositNominalSpan.innerHTML = formatRupiah(data.nominal);
            
            const qrCard = document.getElementById('qrcodeCard');
            if (qrCard) qrCard.style.display = 'block';
            
            updateStatusUI('pending');
            startAutoCheck(data.id);
            startCountdown(data.expired_at);
            
            showToast('✅ Deposit berhasil dibuat! Scan QR Code untuk membayar.', 'success');
            if (qrCard) qrCard.scrollIntoView({ behavior: 'smooth' });
        } else {
            showToast(result.message || 'Gagal membuat deposit', 'error');
        }
    } catch (error) {
        console.error('Create deposit error:', error);
        showToast('Gagal membuat deposit. Cek koneksi internet Anda.', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalText;
    }
}

// ==================== CHECK STATUS ====================
async function checkStatus(depositId) {
    if (!depositId) {
        const inputId = document.getElementById('checkDepositId')?.value;
        if (!inputId) {
            showToast('Masukkan ID transaksi', 'error');
            return;
        }
        depositId = inputId;
    }
    
    const resultDiv = document.getElementById('statusResult');
    if (resultDiv) {
        resultDiv.style.display = 'block';
        resultDiv.innerHTML = '<div style="text-align:center; padding: 1rem;"><div class="loading"></div><p>Memeriksa status...</p></div>';
    }
    
    try {
        const response = await fetch(`${API_BASE}/api/deposit/status/${depositId}`);
        const result = await response.json();
        
        if (resultDiv) {
            if (result.success && result.data) {
                const data = result.data;
                const statusClass = data.status;
                resultDiv.innerHTML = `
                    <div class="info-row"><span>ID Transaksi:</span><strong>${escapeHtml(data.id)}</strong></div>
                    <div class="info-row"><span>Nominal:</span><strong>${formatRupiah(data.nominal)}</strong></div>
                    <div class="info-row"><span>Status:</span><span class="status-badge ${statusClass}">${data.status.toUpperCase()}</span></div>
                    <div class="info-row"><span>Update:</span><span>${new Date().toLocaleString('id-ID')}</span></div>
                `;
                if (currentDepositId === depositId) updateStatusUI(data.status);
                
                if (data.status === 'success') {
                    showToast('✅ Pembayaran berhasil!', 'success');
                    if (currentDepositId === depositId) {
                        stopAutoCheck();
                        setTimeout(() => {
                            const qrCard = document.getElementById('qrcodeCard');
                            if (qrCard) qrCard.style.display = 'none';
                            currentDepositId = null;
                            loadProfile();
                        }, 2000);
                    }
                }
            } else {
                resultDiv.innerHTML = `<div class="info-row"><span>❌ ${escapeHtml(result.message || 'Deposit tidak ditemukan')}</span></div>`;
            }
        }
    } catch (error) {
        console.error('Check status error:', error);
        if (resultDiv) {
            resultDiv.innerHTML = `<div class="info-row"><span>❌ Gagal mengecek status. Periksa koneksi internet.</span></div>`;
        }
        showToast('Gagal mengecek status', 'error');
    }
}

// ==================== CANCEL DEPOSIT ====================
async function cancelDeposit() {
    if (!currentDepositId) {
        showToast('Tidak ada deposit aktif', 'error');
        return;
    }
    
    if (!confirm(`Batalkan deposit ${currentDepositId}?`)) return;
    
    const btn = document.getElementById('cancelDepositBtn');
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<div class="loading"></div>';
    
    try {
        const response = await fetch(`${API_BASE}/api/deposit/cancel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: currentDepositId })
        });
        
        const result = await response.json();
        
        if (result.success) {
            showToast('✅ Deposit berhasil dibatalkan', 'success');
            stopAutoCheck();
            const qrCard = document.getElementById('qrcodeCard');
            if (qrCard) qrCard.style.display = 'none';
            currentDepositId = null;
        } else {
            showToast(result.message || 'Gagal membatalkan', 'error');
        }
    } catch (error) {
        console.error('Cancel error:', error);
        showToast('Gagal membatalkan deposit', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalText;
    }
}

// ==================== EVENT LISTENERS ====================
document.addEventListener('DOMContentLoaded', () => {
    console.log('🚀 Atlantic QRIS Web v3.0 Loaded');
    console.log('⚡ Mode: Normal Check (tanpa Instant Check)');
    console.log('⏰ QRIS Expired: 59 menit 28 detik');
    console.log('📌 Status "PROSES" akan dianggap SUCCESS');
    
    loadProfile();
    setInterval(loadProfile, 60000);
    
    // Quick amount buttons
    document.querySelectorAll('.quick-amount').forEach(btn => {
        btn.addEventListener('click', () => {
            const amount = btn.getAttribute('data-amount');
            const nominalInput = document.getElementById('nominal');
            if (nominalInput && amount) {
                nominalInput.value = amount;
                nominalInput.dispatchEvent(new Event('input'));
            }
        });
    });
    
    // Button listeners with null checks
    const createBtn = document.getElementById('createDepositBtn');
    if (createBtn) createBtn.addEventListener('click', createDeposit);
    
    const checkStatusBtn = document.getElementById('checkStatusBtn');
    if (checkStatusBtn) checkStatusBtn.addEventListener('click', () => checkStatus(currentDepositId));
    
    const cancelDepositBtn = document.getElementById('cancelDepositBtn');
    if (cancelDepositBtn) cancelDepositBtn.addEventListener('click', cancelDeposit);
    
    const checkDepositBtn = document.getElementById('checkDepositBtn');
    if (checkDepositBtn) {
        checkDepositBtn.addEventListener('click', () => {
            const inputId = document.getElementById('checkDepositId');
            if (inputId) checkStatus(inputId.value);
        });
    }
    
    const checkDepositIdInput = document.getElementById('checkDepositId');
    if (checkDepositIdInput) {
        checkDepositIdInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') checkStatus(e.target.value);
        });
    }
    
    const nominalInput = document.getElementById('nominal');
    if (nominalInput) {
        nominalInput.addEventListener('input', (e) => {
            let value = e.target.value.replace(/\D/g, '');
            if (value) e.target.value = parseInt(value, 10);
        });
    }
});

// Global exports
window.showSection = showSection;
window.scrollToPayment = scrollToPayment;
window.loadProfile = loadProfile;
window.checkStatus = checkStatus;
window.cancelDeposit = cancelDeposit;
window.createDeposit = createDeposit;
