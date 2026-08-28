# kaispace.io — setup VPS produksi

`45.76.191.249` · 4 vCPU / 12 GB · Ubuntu, kosong

Satu domain melayani dua aplikasi:

```
kaispace.io/              →  landing page  (kaispace_website)
kaispace.io/harga         →  landing page
kaispace.io/checkout      →  landing page

kaispace.io/login         →  KaiSpace app
kaispace.io/@kaitech      →  KaiSpace app
kaispace.io/_platform     →  KaiSpace app
kaispace.io/api/*         →  KaiSpace backend
kaispace.io/socket.io/*   →  KaiSpace backend
```

Pembagian itu dijaga di dua tempat yang **harus tetap sepakat**:
`deploy/kaispace/nginx-host.conf` di sini, dan
`kaispace_website/src/config/reservedPaths.js` di repo landing. Kalau berbeda,
sebuah path akan diklaim keduanya atau tidak sama sekali — dan gejalanya 404
yang sulit dilacak, karena masing-masing sisi mengira yang lain yang
menanganinya.

## ⚠️ Sebelum mulai: satu keputusan yang belum diambil

**Server ini menggantikan `danone-kaitech`, atau berjalan berdampingan?**

Jawabannya mengubah hampir segalanya:

- **Menggantikan** → data Kaitech harus dipindah: PostgreSQL (user, room,
  chat, kehadiran, cuti, kalender), volume `server_uploads` (lampiran chat,
  rekaman), dan `.env`. Butuh jendela downtime, dan tautan lama
  `office.dev-kaitech.com` perlu redirect.
- **Berdampingan** → server ini mulai dari database kosong, dipakai pelanggan
  baru, dan Kaitech tetap di tempatnya sampai siap pindah.

Untuk peluncuran kaispace.io, **berdampingan jauh lebih aman**: pelanggan
pertama menjadi kelinci percobaan, bukan tim kamu sendiri yang sedang bekerja.
Langkah di bawah menganggap berdampingan.

## 1. DNS — blokir semuanya sampai ini beres

Certbot tidak bisa jalan sebelum DNS mengarah ke sini, dan tanpa sertifikat
tidak ada yang bisa dites.

```
kaispace.io          A     45.76.191.249
www.kaispace.io      A     45.76.191.249
livekit.kaispace.io  A     45.32.121.66     ← server LiveKit, lihat ../livekit/
```

Tunggu propagasi sebelum lanjut:

```bash
dig +short kaispace.io
dig +short livekit.kaispace.io
```

## 2. Dasar

```bash
ssh root@45.76.191.249

apt update && apt upgrade -y
apt install -y ca-certificates curl gnupg git nginx certbot python3-certbot-nginx ufw

# Docker
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  > /etc/apt/sources.list.d/docker.list
apt update && apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
docker --version && docker compose version
```

Firewall — **`ufw allow OpenSSH` sebelum `ufw enable`**, kalau terbalik kamu
mengunci diri sendiri keluar:

```bash
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
ufw status
```

Port 8080 dan 8090 sengaja **tidak** dibuka. Keduanya hanya di-bind ke
`127.0.0.1` dan cuma dijangkau nginx host.

## 3. Sertifikat

```bash
certbot certonly --nginx -d kaispace.io -d www.kaispace.io \
  --agree-tos -m <email-kamu> -n
ls -l /etc/letsencrypt/live/kaispace.io/
```

## 4. Aplikasi

```bash
mkdir -p /var/www && cd /var/www
git clone git@github.com:gustieee/meetkai.git office
cd office
```

Buat `.env` — salin dari `.env.example`, lalu isi. Yang **wajib** ada:

| Variabel | Catatan |
|---|---|
| `JWT_SECRET` | Baru, jangan menyalin dari server lama |
| `VITE_TURN_*` | Sementara masih coturn lama; diganti LiveKit di fase berikutnya |
| `VITE_RUSTDESK_*` | Remote Help |
| `LARK_*`, `GOOGLE_*` | Redirect URI **harus** diperbarui ke `https://kaispace.io/...` |
| `BILLING_ENABLED` | Biarkan **kosong** sampai siap diluncurkan |

Lalu ubah domain di `docker-compose.yml` — `CLIENT_URL`, `CORS_ORIGIN`, dan
build arg `VITE_SERVER_URL` masih menunjuk `office.dev-kaitech.com`. Ketiganya
harus jadi `https://kaispace.io`, kalau tidak setiap checkout ditolak oleh
pemeriksaan origin dan cookie tidak akan tersimpan.

```bash
./deploy/deploy.sh
docker compose ps
curl -s http://127.0.0.1:8090/api/health; echo
```

## 4b. Deploy berikutnya, dari laptop

Setelah pemasangan awal selesai, rilis berikutnya tidak perlu SSH manual:

```bash
./deploy/ship.sh
```

Dijalankan dari klon lokalmu. Urutannya: pastikan branch benar dan working
tree bersih, jalankan typecheck dan seluruh tes, push, lalu SSH ke server dan
menjalankan `deploy/deploy.sh` di sana — dan terakhir membaca bundle yang
benar-benar dilayani situs untuk membuktikan isinya berubah.

Pemeriksaan terakhir itu bukan hiasan: pernah terjadi server melayani build
dari sebelum tiga commit ter-merge, semuanya melaporkan sukses, dan baru
ketahuan setelah membaca JavaScript yang tersaji.

Situs marketing ikut dalam perintah yang sama. Repo dan branch-nya berbeda
(`kaispace_website`, branch `dev-aga`), dan server menariknya langsung dari
GitHub — klon lokalmu tidak dilibatkan, jadi checkout lokal yang tertinggal di
branch lama tidak bisa ikut terkirim. Kalau tidak ada commit baru di sana,
tahapnya dilewati.

Branch-nya dipatok dan diperiksa, bukan dibetulkan otomatis: `main` di repo itu
tertinggal puluhan commit, dan `git checkout main` yang tak sengaja akan
memundurkan situs publik berminggu-minggu tanpa satu pun tanda kegagalan.

### Dari server, untuk yang tidak memakai WSL

`ship.sh` mengenali dirinya sedang di server dan berganti mode: menarik apa
yang sudah ada di origin lalu membangunnya. Tanpa push, tanpa tes — host ini
tidak punya dependensi dev sama sekali (semuanya dibangun di dalam Docker),
dan kode yang di-deploy sudah didorong dari tempat yang bisa menjalankan tes.

Ada symlink `ship` di PATH, jadi tidak perlu tahu di mana repo aplikasi
berada — berguna untuk yang hanya mengurus situs marketing:

```bash
ship            # aplikasi + landing
ship --landing  # situs marketing saja
```

Symlink-nya dipasang sekali dengan:

```bash
ln -sfn /var/www/office/deploy/ship.sh /usr/local/bin/ship
```

Karena symlink dan bukan salinan, dia ikut terbarui setiap kali repo aplikasi
ditarik — tidak ada versi kedua yang bisa tertinggal.

```bash
./deploy/ship.sh --dry-run      # tampilkan semua langkah, jalankan yang aman saja
./deploy/ship.sh --app          # repo ini saja
./deploy/ship.sh --landing      # situs marketing saja
./deploy/ship.sh -- --no-build  # sisanya diteruskan ke deploy.sh

SHIP_HOST=kaispace              # alias SSH tujuan (default: kaispace)
SHIP_LANDING_BRANCH=dev-aga     # branch situs marketing
```

## 5. Landing page

```bash
cd /var/www
# --branch dev-aga, NOT the default. The landing repo's `main` is a single
# commit from 16 Aug — the initial import, 67 commits behind. The branch the
# landing team treats as current is dev-aga, and cloning without naming it
# silently deploys the import instead: no /perusahaan, no /segera, no
# floorplan, and none of the console work.
git clone --branch dev-aga git@github.com:DingkyWingky/kaispace_website.git landing
cd landing
npm ci
npm run build          # → dist/, aset di dist/landing-assets/
```

Sudah terlanjur clone tanpa branch? Pindahkan tanpa clone ulang:

```bash
cd /var/www/landing
git fetch origin dev-aga
git checkout dev-aga
npm ci && npm run build
```

Sajikan `dist/` di `127.0.0.1:8080`. Paling sederhana lewat nginx host
langsung — tambahkan satu server block:

```nginx
server {
    listen 127.0.0.1:8080;
    root /var/www/landing/dist;
    index index.html;
    location / { try_files $uri $uri/ /index.html; }
}
```

`try_files ... /index.html` wajib: landing memakai React Router, jadi
`/checkout/success` harus dilayani `index.html`, bukan 404.

## 6. Reverse proxy

```bash
cp /var/www/office/deploy/kaispace/kaispace-app.conf /etc/nginx/snippets/
cp /var/www/office/deploy/kaispace/nginx-host.conf /etc/nginx/sites-available/kaispace.io
ln -s /etc/nginx/sites-available/kaispace.io /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

nginx -t && systemctl reload nginx
```

## 7. Verifikasi pembagiannya

Ini yang membuktikan kedua aplikasi tidak saling mencuri path:

```bash
curl -sI https://kaispace.io/            | head -1   # landing
curl -sI https://kaispace.io/harga       | head -1   # landing
curl -sI https://kaispace.io/login       | head -1   # app
curl -sI https://kaispace.io/@kaitech    | head -1   # app
curl -s  https://kaispace.io/api/health              # backend, JSON
```

Lalu di browser: buka `https://kaispace.io/harga`, klik sebuah paket, isi
form. Kalau `BILLING_ENABLED` masih kosong, checkout akan menjawab 404 — itu
**benar**, artinya penjaganya bekerja.

## 8. Kalau nanti Kaitech dipindah

Bukan sekarang, tapi ini yang dibutuhkan saat waktunya tiba:

```bash
# Di server lama
docker compose exec -T postgres pg_dump -U postgres virtualmeet | gzip > kaitech.sql.gz
docker run --rm -v office_server_uploads:/data -v $PWD:/backup alpine \
  tar czf /backup/uploads.tar.gz -C /data .

# Salin ke server baru, lalu restore
```

Plus redirect `office.dev-kaitech.com` → `kaispace.io/@kaitech`, dan
memperbarui redirect URI OAuth Lark/Google sekali lagi.

## Urutan yang saya sarankan

1. **LiveKit dulu** (`../livekit/README.md`) — tidak menyentuh apa pun yang
   berjalan, dan menjawab pertanyaan jaringan kantor yang menggantung sejak
   awal
2. **Server ini, tanpa data Kaitech** — kosong, untuk pelanggan baru
3. **Pindahkan Kaitech** hanya setelah keduanya terbukti stabil
