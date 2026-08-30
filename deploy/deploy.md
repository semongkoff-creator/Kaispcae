# Office VPS Deploy

Dokumen ini menjelaskan cara deploy project Office di VPS menggunakan Docker Compose.

## Struktur

- `deploy/deploy.sh` — script deploy utama untuk VPS.
- `docker-compose.yml` — definisi service `postgres`, `redis`, `server`, dan `nginx`.
- `nginx/nginx.conf` — konfigurasi Nginx di dalam container client.
- `/etc/nginx/sites-enabled/<domain-anda>` — konfigurasi Nginx host VPS, dikelola manual di server.

## Prasyarat VPS

Pastikan ini sudah tersedia di VPS:

- Docker dan Docker Compose plugin, atau `docker-compose`.
- Git.
- Curl.
- File `.env` di root project, atau environment variable yang dibutuhkan sudah diekspor.
- `JWT_SECRET` wajib tersedia karena `docker-compose.yml` memakai `${JWT_SECRET:?JWT_SECRET must be set}`.

Contoh lokasi project:

```bash
cd /var/www/office
```

## Pindah ke Domain / Server Baru

Alamat publik tidak di-hardcode di mana pun. Cukup satu variabel di `.env`:

```bash
PUBLIC_URL=https://<domain-anda>
```

Itu mengisi tiga hal sekaligus: `CLIENT_URL` dan `CORS_ORIGIN` untuk server, plus
`VITE_SERVER_URL` yang **dipanggang ke dalam bundle frontend saat build**. Karena
yang terakhir itu build-time, ganti domain **wajib** disertai rebuild —
`./deploy/deploy.sh` sudah melakukannya (`docker compose build server nginx`), tapi
restart saja tidak cukup.

Yang tidak ikut otomatis dan harus disesuaikan manual:

- **Nginx host VPS** — buat `/etc/nginx/sites-enabled/<domain-anda>` yang
  `proxy_pass` ke `http://127.0.0.1:8091` (contoh lengkap di bagian Nginx di bawah),
  lalu terbitkan sertifikat TLS untuk domain baru.
- **Google OAuth** — `GOOGLE_REDIRECT_URI` di `.env` harus jadi
  `https://<domain-anda>/api/auth/google/callback`, **dan** URI yang sama harus
  didaftarkan di Google Cloud Console. Kalau salah satu tertinggal, login Google
  gagal dengan `redirect_uri_mismatch`.
- **Database** — server baru berarti Postgres baru dan kosong. `deploy.sh` sudah
  menjalankan `prisma migrate deploy`, jadi skema terbentuk sendiri. Akun pertama
  yang mendaftar otomatis jadi admin workspace.

## Deploy Normal

Jalankan dari root project:

```bash
./deploy/deploy.sh
```

Flow default script:

```bash
git pull --ff-only
docker compose up -d postgres redis
docker compose build server nginx
docker compose run --rm server npx prisma migrate deploy --schema=server/prisma/schema.prisma
docker compose up -d server nginx
docker compose ps
curl -fsS http://127.0.0.1:8091/api/health
```

## Menambahkan akun DCM setelah deploy

`DCM_Password_List.xlsx` sengaja diabaikan Git dan tidak ikut Docker image,
karena memuat password. Setelah deploy aplikasi selesai, salin file itu secara
sementara dari root proyek di VPS ke container `server`, jalankan seed, lalu
hapus lagi dari container:

```bash
cd /var/www/office
SERVER_ID="$(docker compose ps -q server)"
test -n "$SERVER_ID"
docker cp DCM_Password_List.xlsx "$SERVER_ID:/app/DCM_Password_List.xlsx"
docker compose exec -T server npx tsx server/scripts/seedDcmAccounts.ts
docker compose exec -T server rm -f /app/DCM_Password_List.xlsx
```

Jalankan ini hanya setelah build yang membawa `server/scripts` sudah aktif.
Script bersifat idempoten: akun yang sudah ada tidak dibuat ulang atau password-
nya tidak diubah. Jangan memasukkan spreadsheet ke `git add` atau ke Dockerfile.

Deploy ini rebuild `server` dan `nginx`, jadi perubahan backend Socket.IO, build frontend Vite, dan `nginx/nginx.conf` ikut naik.

## Dry Run

Untuk melihat command tanpa menjalankan deploy:

```bash
./deploy/deploy.sh --dry-run
```

Kalau sedang test di server yang belum siap `.env`, bisa pakai:

```bash
./deploy/deploy.sh --dry-run --no-pull --skip-migrate --skip-health
```

## Opsi Script

```bash
./deploy/deploy.sh --help
```

Opsi yang tersedia:

- `--dry-run` — print command tanpa menjalankan.
- `--no-pull` — skip `git pull`, berguna kalau deploy dari perubahan lokal.
- `--no-build` — skip build image.
- `--skip-migrate` — skip Prisma migration.
- `--skip-health` — skip health check.
- `--health-url URL` — override health check URL.

Contoh override health check:

```bash
./deploy/deploy.sh --health-url https://<domain-anda>/api/health
```

## Setelah Deploy

Cek service:

```bash
docker compose ps
```

Cek log:

```bash
docker compose logs --tail=100 server
docker compose logs --tail=100 nginx
```

Cek health endpoint lokal:

```bash
curl -fsS http://127.0.0.1:8091/api/health
```

Cek header asset setelah perubahan gzip/cache:

```bash
curl -I -H 'Accept-Encoding: gzip' https://<domain-anda>/assets/<nama-file-hashed>.js
```

Yang diharapkan untuk JS/CSS hashed:

- Ada `Content-Encoding: gzip` saat client mendukung gzip.
- Ada `Cache-Control: public, max-age=31536000, immutable`.

## Nginx Host VPS

Script ini hanya deploy Docker stack project. Konfigurasi Nginx host VPS tetap dikelola manual di:

```bash
/etc/nginx/sites-enabled/<domain-anda>
```

Setelah mengubah Nginx host:

```bash
nginx -t
systemctl reload nginx
```

Nginx host saat ini perlu tetap proxy ke container client:

```nginx
proxy_pass http://127.0.0.1:8091;
```

## TURN Relay (coturn)

Sama seperti Nginx host, coturn **tidak** dikelola script ini dan tidak ada di
`docker-compose.yml` — dia service host:

```bash
systemctl status coturn          # /usr/bin/turnserver -c /etc/turnserver.conf
```

Tanpa TURN, dua orang yang tidak bisa menemukan jalur langsung (NAT simetris,
firewall kantor yang men-drop UDP, CGNAT seluler) **tidak akan pernah saling
terdengar** — tanpa error di mana pun, selamanya, karena jaringan mereka sama
setiap hari. Gejalanya: "beberapa orang tertentu selalu tidak ada suara".

### Tiga variabel yang harus terisi bersamaan

`VITE_TURN_URL`, `VITE_TURN_USERNAME`, `VITE_TURN_CREDENTIAL` di `.env`. Klien
menolak entri TURN yang tidak lengkap dan **membuang ketiganya** — dua dari tiga
terisi sama saja dengan nol. Produksi pernah berjalan berbulan-bulan seperti itu
(URL kosong), karena tidak ada yang memberi tahu; sekarang console browser
memperingatkannya.

Ketiganya **build arg**, bukan runtime env:

```bash
docker compose build nginx     # WAJIB — `restart` tidak mengubah apa pun
```

Nilainya dijahit ke dalam file JS saat `vite build`. Verifikasi:

```bash
docker compose exec nginx sh -c "grep -o 'turn:[^\"]*' /usr/share/nginx/html/assets/index-*.js"
```

### Yang wajib ada di /etc/turnserver.conf

```
min-port=49152
max-port=65535        # tiap alokasi TURN memakan satu port; range sempit = gagal acak
total-quota=0

no-multicast-peers    # kredensial ikut ke bundle JS, jadi PUBLIK — tanpa blok
denied-peer-ip=0.0.0.0-0.255.255.255        # di bawah ini, siapa pun yang
denied-peer-ip=10.0.0.0-10.255.255.255      # membacanya bisa memakai server ini
denied-peer-ip=127.0.0.0-127.255.255.255    # sebagai relay ke jaringan internal
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
```

### Jebakan: aturan ufw tertimpa Docker

Port bisa terdaftar `ALLOW` di `ufw status` tapi tetap **di-drop dari luar** —
Docker menyisipkan aturannya sendiri ke iptables dan menggeser chain ufw setiap
daemon-nya restart. Gejalanya khas: dari luar **timeout**, bukan
*connection refused*, padahal `ss` menunjukkan servicenya listening.

Obatnya cukup memicu reload ufw:

```bash
ufw allow 3478/udp && ufw allow 3478/tcp && ufw allow 49152:65535/udp
```

Jalankan walaupun ufw menjawab `Skipping adding existing rule` — reload-nya
itulah yang memperbaiki, bukan penambahan aturannya. Port lain di VPS ini
(8080/8081, 21115-21117 RustDesk) diketahui pernah kena hal yang sama.

### Verifikasi dari luar VPS

Cek sampai ke **alokasi**, bukan cuma STUN binding — alokasi butuh autentikasi
DAN port dari range relay, jadi hanya itu yang membuktikan jalurnya utuh. Paling
mudah lewat [Trickle ICE](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/):
isi URI/username/password, lalu **harus muncul baris `Type = relay`**.

Di aplikasi, `webrtcDiag()` di console menampilkan jalur kandidat terpilih per
peer: `relay` berarti TURN dipakai, `host`/`srflx` berarti mereka tersambung
langsung dan masalah lain (mis. isolasi zona) yang menyenyapkan mereka.

## Troubleshooting

Jika deploy gagal karena `.env` atau `JWT_SECRET`:

```bash
cp .env.example .env
```

Lalu isi minimal secret yang wajib, terutama `JWT_SECRET`.

Jika migration gagal, cek log server dan status database:

```bash
docker compose logs --tail=100 postgres
docker compose run --rm server npx prisma migrate status --schema=server/prisma/schema.prisma
```

Jika health check gagal:

```bash
docker compose ps
docker compose logs --tail=100 server nginx
curl -I http://127.0.0.1:8091
curl -fsS http://127.0.0.1:8091/api/health
```

Jika asset masih belum gzip/cache setelah deploy:

```bash
docker compose build nginx
docker compose up -d nginx
```

Lalu ulangi cek header asset.
