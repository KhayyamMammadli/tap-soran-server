# Render + Supabase ilə Production Deploy

Bu fayl TapSoran API-ni internetə (HTTPS) çıxarmaq üçün ən sadə “production” addımlarını göstərir.

## 1) Supabase Postgres
1. Supabase-də yeni project yaradın.
2. `Settings → Database → Connection string` bölməsindən **URI** formatında `DATABASE_URL` götürün.

## 2) Render Web Service
Render → New → **Web Service**

**Root Directory**: bu repo içində server qovluğu hardadırsa onu seçin (məs: `server`).

### Build Command
```bash
npm install
npx prisma generate
npm run build
```

### Start Command
```bash
npx prisma migrate deploy
node dist/index.js
```

### Environment Variables
Render-də “Environment” bölməsinə əlavə edin:

- `DATABASE_URL` = Supabase connection string
- `JWT_SECRET` = uzun random string (məs: `openssl rand -base64 48`)
- `NODE_ENV` = `production`
- `CORS_ORIGINS` = (istəyə bağlı) `https://admin.sizin-domaininiz.az` və s. (vergüllə ayrılır)
- `SEED_SUPERADMIN` = `true` (yalnız ilk deploy üçün), sonra `false` edin
- `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD`, `SUPER_ADMIN_NAME` (istəyə bağlı)

## 3) Health Check
API işləyirsə:
- `GET /health` → `{ ok: true, env, time }`

## 4) Qeyd
`uploads/` lokal diskə yazır. Production-da böyük fayl/şəkil üçün S3/Supabase Storage kimi “object storage” tövsiyə olunur.
