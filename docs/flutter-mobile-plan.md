# Flutter Mobile Plan

This project is prepared so a future Flutter app for iOS and Android can sit on the same backend instead of needing a second API.

## Reuse from current backend

- `POST /api/auth/login` for JWT authentication
- `GET /api/auth/me` to restore the session on app launch
- `GET /api/products` for the storefront catalog
- `POST /api/orders` for checkout
- `GET /api/orders/track/:publicId` for delivery tracking
- `GET /api/mobile/bootstrap` for mobile-safe enums and app config

## Recommended Flutter structure

- `lib/core/api/` for the HTTP client and token injection
- `lib/features/auth/` for login and secure token storage
- `lib/features/catalog/` for products and cart state
- `lib/features/orders/` for checkout, order history, and live tracking
- `lib/features/dashboard/` for staff-facing admin views if you later want mobile operations tools

## Flutter packages to consider

- `dio` for API requests
- `flutter_secure_storage` for JWT persistence
- `go_router` or manual route handling for app navigation
- `riverpod` or `bloc` for state management
- `json_serializable` for API model generation

## Suggested next step when mobile work starts

1. Generate Dart models from the existing JSON response shapes.
2. Build login, storefront, cart, and tracking first.
3. Keep staff dashboard screens as a later phase unless mobile operations are a priority.
