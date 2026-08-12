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
curl -fsS http://127.0.0.1:8090/api/health
```

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
curl -fsS http://127.0.0.1:8090/api/health
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
proxy_pass http://127.0.0.1:8090;
```

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
curl -I http://127.0.0.1:8090
curl -fsS http://127.0.0.1:8090/api/health
```

Jika asset masih belum gzip/cache setelah deploy:

```bash
docker compose build nginx
docker compose up -d nginx
```

Lalu ulangi cek header asset.
