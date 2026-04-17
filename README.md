# BestMart

BestMart is a full-stack online ordering and delivery app built with React 19, TypeScript, Vite, plain CSS, Express 5, PostgreSQL, `pg`, JWT auth, and `bcryptjs`.

## What is included

- Public storefront with category filters, cart, checkout, and order confirmation
- Delivery tracking page using manual hash/path handling in `src/App.tsx`
- Staff dashboard with role-based access for `admin`, `editor`, and `viewer`
- Product management, image upload via `multer` + `sharp`, and delivery status updates
- PostgreSQL auto-migrations and seeded demo data on server startup
- QR-based order tracking and GeoIP region capture for placed orders
- Mobile bootstrap API at `/api/mobile/bootstrap` for future Flutter clients

## Seeded accounts

- `admin@bestmart.local` / `BestMart123!`
- `ops@bestmart.local` / `BestMart123!`
- `viewer@bestmart.local` / `BestMart123!`

## Run locally

1. Copy `.env.example` to `.env` and set your PostgreSQL credentials.
2. Install dependencies with `npm install`.
3. Start both apps with `npm run dev`.
4. Open `http://localhost:5173`.

The API runs on `http://localhost:3001` by default and seeds the `BestMart` company plus starter products on first boot.

## Flutter readiness

The backend is now structured so a future Flutter app can reuse the same:

- JWT login flow
- product listing and order placement APIs
- order tracking statuses and payment method enums
- seeded company bootstrap config from `/api/mobile/bootstrap`

The mobile integration notes are in `docs/flutter-mobile-plan.md`.
