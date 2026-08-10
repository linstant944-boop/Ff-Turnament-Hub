# FF Tournament Hub
Professional mobile-style tournament starter with registration/login, match details, join system, wallet, Razorpay payment capture via verified webhook, withdrawal requests, room ID/password access endpoint, results, notifications, Firebase and Render.

### Important production hardening
- Replace demo plaintext passwords with Firebase Auth or bcrypt/argon2.
- Add real admin authentication/authorization before exposing admin APIs.
- Prize distribution must be authorized server-side after verified results; never trust client-submitted prize amounts.
- Withdrawal is recorded as PENDING; actual payout should use a compliant payout provider and manual/automated verification.
- Keep Razorpay secrets/webhook secret only in Render environment variables.
- Follow Free Fire/Garena rules, payment-provider terms and applicable laws.

### Render
Build: `npm install`
Start: `npm start`
Environment: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `FIREBASE_DATABASE_URL`, `FIREBASE_SERVICE_ACCOUNT_JSON`

Webhook:
`https://YOUR-RENDER-DOMAIN.onrender.com/api/razorpay/webhook`

### Firebase paths
users, matches, matchJoins, payments, withdrawals, notifications, events

## V2 Join + Slot System
- JOIN MATCH opens a form for Game Name and Team Name (Duo/Squad).
- User selects Slot 1 through Slot 50 (based on maxPlayers).
- Occupied slots are locked server-side and shown as used.
- A user can join a match only once.
- Selected slot, game name and team name are stored in Firebase under `matchJoins` and `matchSlots`.
- Entry fee is deducted only after server-side slot/user/wallet validation.

## V3 Admin + User Panels
Admin login is separate from the user login. Configure `ADMIN_EMAIL` and `ADMIN_PASSWORD` in Render environment variables; do not commit real credentials to GitHub.
Admin features: dashboard, create/edit/delete match, match image upload preview, room ID/password update, result posting, user block/unblock, withdrawal approve/reject, notification, support settings.

## .env.example
The ZIP includes `.env.example` in the project root. Copy it to `.env` for local development and fill in your real Firebase, Razorpay and Admin credentials.

**Never upload `.env` or Firebase service-account private keys to GitHub.**
For Render, add the same values under Environment Variables.
