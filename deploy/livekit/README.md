# LiveKit SFU — setup

Server media untuk KaiSpace. **Mesin terpisah**, bukan di box aplikasi.

Dokumen ini hanya soal menaikkan server dan membuktikannya sehat. Tidak ada
kode klien yang berubah, dan tidak ada risiko apa pun ke produksi yang sedang
berjalan — sampai fase berikutnya, aplikasi tidak tahu server ini ada.

## Kenapa mesin terpisah

Box `danone-kaitech` punya 8 GB RAM dan menjalankan ~20 container: lima
PostgreSQL, empat Redis, coturn, rustdesk, n8n, plus stack tenant kedua. SFU
terikat pada CPU dan interrupt jaringan — persis yang paling sedikit tersedia
di sana.

Bandwidth bukan alasannya. Pool Vultr terpakai 6,6% (2,79 dari 44,38 TB), dan
SFU menambah sekitar 1 TB per bulan.

## Prasyarat

- VPS baru, Ubuntu/Debian, **4 vCPU / 8 GB**
- Docker + Docker Compose plugin
- Sebuah subdomain yang A-record-nya menunjuk ke IP mesin ini
  (mis. `livekit.kaispace.io`)
- Port yang harus terbuka di firewall:

| Port | Protokol | Untuk |
|---|---|---|
| 443 | TCP | API/WebSocket (lewat Caddy) |
| 80 | TCP | Hanya saat certbot memperbarui sertifikat |
| 5349 | TCP | TURN over TLS |
| 7881 | TCP | Fallback media saat UDP diblokir |
| 50000–50200 | UDP | Media |

Rentangnya 200 port, bukan 10.000 seperti default LiveKit. Satu port dipakai
per peserta, jadi 200 menampung jauh lebih banyak dari 30 yang ditargetkan —
sambil tetap jadi aturan firewall yang bisa dibaca manusia dan disetujui tim
infra.

## Langkah

### 1. Salin folder ini ke server

```bash
scp -r deploy/livekit root@45.32.121.66:/opt/livekit
ssh root@45.32.121.66
cd /opt/livekit
```

### 2. Isi domain

Ganti `LIVEKIT_DOMAIN_PLACEHOLDER` di **dua** file:

```bash
DOMAIN=livekit.kaispace.io
sed -i "s/LIVEKIT_DOMAIN_PLACEHOLDER/$DOMAIN/g" livekit.yaml Caddyfile
grep -rn "$DOMAIN" livekit.yaml Caddyfile   # harus muncul 4x
```

### 3. Sertifikat

Satu certbot, dua pemakai — Caddy untuk API, LiveKit untuk TURN. Sengaja
begitu: dua klien ACME yang memperebutkan domain yang sama, atau menyalin file
dari penyimpanan internal Caddy (yang layout-nya berubah antar versi dan gagal
diam-diam), dua-duanya lebih rapuh.

```bash
apt update && apt install -y certbot
certbot certonly --standalone -d $DOMAIN --agree-tos -m <email-kamu> -n
ls -l /etc/letsencrypt/live/$DOMAIN/     # fullchain.pem + privkey.pem
```

Perpanjangan otomatis butuh container membaca ulang file barunya:

```bash
echo '#!/bin/sh
cd /opt/livekit && docker compose restart' > /etc/letsencrypt/renewal-hooks/deploy/livekit.sh
chmod +x /etc/letsencrypt/renewal-hooks/deploy/livekit.sh
```

### 4. Kunci API

```bash
KEY=$(openssl rand -hex 8)
SECRET=$(openssl rand -base64 36)
echo "LIVEKIT_KEYS=$KEY: $SECRET" > .env
chmod 600 .env
cat .env
```

**Simpan keduanya.** Backend KaiSpace membutuhkannya untuk mencetak token
(fase berikutnya, `XENDIT`-style env: `LIVEKIT_API_KEY` dan
`LIVEKIT_API_SECRET`). Tidak pernah masuk git.

### 5. Jalankan

```bash
docker compose up -d
docker compose logs -f livekit
```

Yang dicari di log: `starting LiveKit server`, dan tidak ada baris yang
mengeluh soal sertifikat atau port yang sudah dipakai.

### 6. Buktikan sebelum menulis kode apa pun

Ini langkah yang paling sering dilewati, dan paling berharga. Kalau ada yang
salah di server, temukan sekarang dengan alat orang lain — bukan berminggu-minggu
kemudian lewat adapter 700 baris yang belum pernah jalan.

**a. API hidup dan TLS-nya benar**

```bash
curl -sI https://$DOMAIN | head -3
```

**b. TURN/TLS benar-benar mendengar**

```bash
openssl s_client -connect $DOMAIN:5349 -servername $DOMAIN </dev/null 2>&1 | head -5
```

Harus menampilkan rantai sertifikat. Kalau `connection refused`, LiveKit tidak
berhasil memuat sertifikatnya — cek log-nya.

**c. Sambungan sungguhan, dari jaringan kantor**

Buat token uji, lalu buka LiveKit Meet / playground resmi dan masuk memakai
token itu **dari WiFi kantor**, dengan dua perangkat.

```bash
docker run --rm livekit/livekit-cli token create \
  --api-key <KEY> --api-secret <SECRET> \
  --join --room uji --identity orang-1 --valid-for 24h
```

Yang dibuktikan: audio dua arah, video, dan — paling penting — **apakah
jaringan kantor mengizinkan jalurnya**. Ini pertanyaan yang menggantung sejak
awal, dan hanya bisa dijawab dari sana.

**d. Laju egress**

```bash
apt install -y speedtest-cli && speedtest-cli --secure
```

Syarat kelulusan: **upload ≥300 Mbps**. Kebutuhan puncak all-hands ~93 Mbps;
di bawah 150 Mbps, plan instance-nya perlu dibicarakan lagi.

## Kalau 5349 diblokir jaringan kantor

Kemungkinan yang harus diperiksa di langkah 6c, karena firewall korporat
memang sering hanya mengizinkan 443.

443 sudah dipakai Caddy untuk API, dan keduanya tidak bisa berbagi port TCP.
API yang menang karena tanpa itu klien bahkan tidak bisa mencoba masuk.

Kalau terbukti diblokir, dua jalan: **IP kedua** untuk mesin ini sehingga TURN
punya 443 sendiri, atau **demultiplexing berbasis SNI** di satu IP. Keduanya
menambah bagian bergerak — jangan dikerjakan sebelum ada buktinya.

## Yang TIDAK ada di sini, sengaja

**Redis.** LiveKit hanya membutuhkannya untuk mengoordinasi beberapa node.
Satu node melayani satu kantor tidak, dan menambahkannya sekarang berarti satu
container lagi untuk dijalankan, dipantau, dan di-backup — ditukar dengan nol
manfaat. Tambahkan di hari node kedua ada.

**Egress recording.** Perekaman sisi server butuh headless Chrome plus
encoder, dengan kebutuhan CPU dan penyimpanan sendiri. Rekaman sisi klien yang
sekarang tetap berfungsi setelah migrasi; ini bisa menyusul kapan saja.

## Setelah semua langkah 6 lolos

Fase berikutnya adalah endpoint pencetak token di Express — sekitar 80 baris,
memakai auth yang sudah ada, dan masih tanpa perubahan klien sama sekali.
