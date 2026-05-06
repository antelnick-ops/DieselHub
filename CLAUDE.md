# CLAUDE.md — Black Stack Diesel

## Project Identity

Black Stack Diesel (BSD) is a mobile-first web application for diesel truck owners. It provides AI-powered diagnostics, a vehicle-specific parts marketplace, and photo-based troubleshooting. Core principle: **once a user selects their vehicle (year/make/model/engine), every screen filters to show ONLY content relevant to that exact truck.**

**Owner:** Dynamic Innovative Solutions LLC
**Domain:** black-stack-diesel.com
**Repo:** github.com/antelnick-ops/BlackStackDiesel

---

## Tech Stack

- **Framework:** Next.js 14 (App Router)
- **Language:** TypeScript (strict mode)
- **Styling:** Tailwind CSS v4 + CSS custom properties
- **Database:** PostgreSQL via Supabase
- **Auth:** Supabase Auth (email/password + Google + Apple OAuth)
- **ORM:** Drizzle ORM
- **State Management:** Zustand
- **AI:** Anthropic Claude API (claude-sonnet-4-20250514) for diagnostics chat
- **Payments:** Stripe (checkout sessions + webhooks)
- **File Storage:** Supabase Storage (diagnostic photos)
- **Deployment:** Vercel
- **Domain/DNS:** Cloudflare
- **Email:** Cloudflare Email Routing

---

## Project Structure

```
BlackStackDiesel/
├── index.html                           # Early access landing page (LIVE)
├── app/
│   └── index.html                       # Full BSD app prototype
├── src/                                 # (Future Next.js app)
│   ├── app/
│   │   ├── (auth)/login/page.tsx
│   │   ├── (auth)/register/page.tsx
│   │   ├── (app)/vehicle-setup/page.tsx
│   │   ├── (app)/ai/page.tsx
│   │   ├── (app)/marketplace/page.tsx
│   │   ├── (app)/orders/page.tsx
│   │   ├── (app)/profile/page.tsx
│   │   └── api/
│   ├── components/
│   ├── lib/
│   ├── stores/
│   └── types/
├── ARCHITECTURE.md
├── CLAUDE.md
├── README.md
├── LICENSE
├── package.json
└── .gitignore
```

---

## Engine Family Keys

| Key | Engines | Trucks |
|-----|---------|--------|
| `cummins59` | 5.9L 12V, 24V, ISB 325 | Ram 2500/3500 1994–2007 |
| `cummins67` | 6.7L ISB, ISB 385, HO 420 | Ram 2500/3500 2007–2024 |
| `ps73` | 7.3L Power Stroke | F-250/350 1999–2003 |
| `ps60` | 6.0L Power Stroke | F-250/350 2003–2007 |
| `ps64` | 6.4L Power Stroke | F-250/350 2008–2010 |
| `ps67` | 6.7L Power Stroke (all gens) | F-250/350 2011–2024 |
| `dmax` | 6.6L Duramax LB7–L5P | Silverado/Sierra 2500/3500 2001–2024 |

## Vehicle Selection Flow
```
Year → Make (only makes with models for that year)
  → Model (only models produced that year)
    → Engine (only engines for that year+make+model)
      → Engine Family resolved → app filters everything
```

---

## Design System

### Aesthetic: Industrial / Dark / Tough

Colors:
```css
--bg: #08090B; --bg2: #0E1014; --bg3: #151820; --bg4: #1C2029;
--ember: #FF6B2C; --ember2: #E85A1E;
--amber: #F5A623;
--text-primary: #F2EDE6; --text-secondary: #A0A4B0; --text-muted: #5E6270;
```

Typography: Rajdhani (display/headings), Archivo (body)

Mobile-first: 393×852 viewport, bottom nav (AI / Shop / Profile), 44px minimum touch targets.

---

## Critical Rules

1. **Products MUST be filtered by engine_family at the database level.** Never show parts that don't fit the user's truck.
2. **AI responses must reference the user's exact truck and engine.** Generic responses are not acceptable.
3. **Vehicle setup is cascading.** Each selection narrows the next — no orphan options.

---

## Implementation Order

1. Project scaffold (Next.js, TypeScript, Tailwind, Supabase)
2. Auth (login/register, Supabase Auth, protected routes)
3. Database (Drizzle schema, migrations, seed vehicles + products)
4. Vehicle Setup (cascading selector, Zustand store, save to DB)
5. Layout Shell (mobile shell, bottom nav)
6. AI Chat (Anthropic API, engine-specific prompts, photo upload)
7. Marketplace (filtered product grid, categories, search)
8. Cart + Checkout (Zustand cart, Stripe checkout)
9. Orders (Stripe webhooks, order list, tracking)
10. Profile (vehicle display, stats, settings)

---

## Environment Variables

```env
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
ANTHROPIC_API_KEY=
STRIPE_SECRET_KEY=
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=
STRIPE_WEBHOOK_SECRET=
NEXT_PUBLIC_APP_URL=http://localhost:3000
APG_API_KEY=
APG_AUTH_URL=https://api.premierwd.com/api/v5/authenticate
APG_API_BASE_URL=https://api.premierwd.com/api/v5
APG_FALLBACK_PHONE=
APG_AUTO_ORDER_ENABLED=false
APG_TRACKING_POLL_ENABLED=false
RESEND_API_KEY=
CRON_SECRET=
```

`APG_AUTO_ORDER_ENABLED`: Feature flag. Set to `'true'` to enable automatic
APG order forwarding from the Stripe webhook. Defaults to false (manual
fulfillment). Flip to `true` only after Stage 2 + Stage 3 are tested.

`APG_TRACKING_POLL_ENABLED`: Feature flag. Set to `'true'` to enable APG
tracking polling. Trigger manually via authenticated POST/GET to
`/api/poll-apg-tracking` with `Authorization: Bearer <CRON_SECRET>`.
Defaults to false. Vercel cron not used (Hobby plan doesn't support
crons; can be enabled by upgrading to Pro and re-adding the `crons`
block to `vercel.json`, or by configuring an external cron service like
cron-job.org to hit the endpoint with the bearer token).

`CRON_SECRET`: Optional but recommended. When set, `/api/poll-apg-tracking`
requires `Authorization: Bearer <CRON_SECRET>` header. Vercel cron provides
this automatically. Without it, anyone with the URL can trigger the function
(not destructive but consumes API quota).

---

## Code Style

- Functional components only
- Server Components by default, `"use client"` only when needed
- Zod for all API input validation
- Prices stored as cents in DB, displayed as dollars in UI
- Error boundaries on every route segment

---

## Gotchas

### PostgREST schema cache

After any DDL change to the `public` schema (`ALTER TABLE`, `CREATE TABLE`, `ADD COLUMN`, etc.), the PostgREST API layer caches the old schema and will return `PGRST204` errors on writes referencing new columns. Always run the following in the Supabase SQL editor immediately after any DDL change:

```sql
NOTIFY pgrst, 'reload schema';
```

This applies whether the change is via Supabase migrations, the dashboard SQL editor, or `psql`.
