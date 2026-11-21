# Shared experience redesign and native mobile, 19 November 2026

Local branch: `codex/unified-experience-mobile`, based on `9deb039` (POD slice 18b).
The preceding POD storage/attachment fixes remain in the working tree. Nothing is committed,
pushed, merged, published or deployed. TruckLink and Odoo were not touched.

## Web and console

The shared layout/styles apply to all **28 web page files** (EN/AR/UR) and **19 staff page
files**, plus not-found states. This is shared-design coverage, not a claim that every page
was manually reviewed or that the product is WCAG-conformant.

- Design tokens 0.4.0 retain the Signage blue/green identity with lighter backgrounds,
  clearer card boundaries, quieter notices, consistent fields/buttons and clearer hierarchy.
- Route-aware participant workspace navigation and selected states. It grants no permission;
  the existing server checks remain in force for every linked route.
- Staff sidebar on large screens; wrapping navigation on small screens. No hidden menu or
  new client-side navigation framework. Staff privileges still determine visible links.
- Operations summary shows actual open cases, cargo cases, holds and dispatch blocks,
  linking to the corresponding sections; no fabricated metrics or map.
- Cost tables become fully labelled definition-list cards below 75rem. All cost, payer,
  held-state and liability content remains available, without sideways scrolling at 200%.
- Self-hosted `next/font/local` Barlow/Arabic script files, four weights each, `display: swap`,
  no font CDN and no speculative preload of every language/weight. Variables are applied
  on `html`, where inherited design tokens resolve, not only on `body`.
- Visible focus, 44px web targets, logical RTL spacing, scalable text, forced-colour rules,
  reduced-motion handling, print styles, and recoverable loading/error boundaries.
- Staff rendering is explicitly request-scoped (including enrolment/error pages). No staff
  identity/data is added to public caches. `.next-review` permits an isolated console build.

Performance mechanisms were changed, but there is no before/after Core Web Vitals baseline
and no percentage speedup claim. No data-fetch caching was added to private records.

## Checks

| Check | Evidence |
|---|---|
| Web unit tests | 24 pass, including all 22 declared contrast pairs and language catalogue rules |
| Web production build | Pass |
| Web browser suite | 2,614 checks pass, real API/PostgreSQL: responsive layouts, doubled text, keyboard, targets, axe rules, roles and existing business journeys |
| Console production build | Pass in `.next-review` |
| Console browser suite | 362 checks pass, including keyboard, permissions, layouts and operations |
| Mobile | TypeScript and six client tests pass; Android/iOS Metro/Hermes exports pass |
| Android installable build | Attempted; blocked by Java filesystem write checks, not passed; no APK |

The first web run found two font failures, three hero clipping failures and six trip-cost
overflow failures. Root font variables, the hero decoration and responsive cost cards were
corrected; the subsequent complete browser run passed. Existing tests were not relaxed.

The final loading/error boundaries were added after those browser suites; they are included
in final builds/type checks, with no injected runtime-error browser test claimed.

`tools/dev/browser-review.mjs` reuses the existing browser suites with a disposable database.
The original web browser runner uses the configured development database; use the wrapper
for review runs. Console already creates its own database. No local application service
was restarted. Temporary test servers use their own ports.

## Native delivery and remaining work

See `apps/mobile/README.md` for the actual screens, setup, exact boundaries and build limit.
This is a new connected native participant/driver implementation, **not** complete mobile
parity with all web workflows. Its company pages are read-only first/default-page lists.
No physical Android/iOS device, screen reader, signed store build or native end-to-end
journey has passed here. No offline queue, supplier integration or launch gate is implied.

Arabic/Urdu copy and new native labels remain drafts for the previously requested final
language audit. Screen-reader/native-speaker/Safari/Firefox validation remains open.

## Sources used to select implementation tools

- https://nextjs.org/docs/app/getting-started/fonts
- https://docs.expo.dev/versions/latest/
- https://docs.expo.dev/versions/latest/sdk/securestore/
- https://www.w3.org/TR/WCAG22/

Expo template 58.0.35, Expo SDK 58.0.26 and React Native 0.88.1 were checked against the
registry and supported bundled-module list. Dependencies are pinned, with a separate mobile
lockfile. Existing Next.js/API tool versions were retained.

## ImageGen direction and shipment entry

The public EN/AR/UR home pages use an original ImageGen freight image, an explicit sign-in
action and the existing sample shipment timeline. Shipment create, draft edit and published
change use the same grouped form with jump links for cargo, pickup and delivery, plus paired
fields where width permits. Date and time remain editable text with format examples and
screen-reader guidance. The web action, validation, draft retry and permission checks are
shared with the existing routes.

The layout patterns were reviewed against Odoo 20 Sales and Inventory documentation:
https://www.odoo.com/documentation/20.0/applications/inventory_and_mrp/inventory/shipping_receiving/daily_operations/receipts_delivery_one_step.html

Prompt for the shipped image: a photorealistic Gulf highway at dawn with an unbranded
silver tractor-trailer, a quiet skyline, warm amber light and no text or logos. The image
was exported as WebP for the web landing page.

Verification for this update: the isolated web build and 24 web unit tests passed. Chrome
showed the home page at 1440px in English and 390px in Arabic. A focused browser check
against a simulated API passed 24 layout combinations (three languages, four widths,
normal and doubled text), section links, and retaining typed cargo after a refused save.

The real browser suite initially found four HTTP status assertions returning 200 after the
shared locale loading boundary streamed its fallback. The loading UI is now scoped to the
account page so the affected routes can send their 404 before any fallback is rendered.
Five focused HTTP status checks passed on the rebuilt site with the simulated API.
The final full Chrome run passed all 2,614 checks against the real API and a disposable database.

## Shipment entry and review follow-up

The shipment editor starts with pickup and delivery, each with a grouped local appointment
window. Selecting a country fills a blank time zone only when there is one configured choice.
An explicit time zone is left editable. The browser retains restored optional notes and opens
their sections. Existing draft date/time inputs and server validation still support partial
drafts and ambiguous local times.

The draft's publication area shows its saved route, time windows and cargo with links back
to the editor. Saving and publishing remain separate actions. Expired and withdrawn shipments
link directly to the existing copy-to-draft action, which retains its current eligibility rules.

Verification: 24 web unit tests and all 2,617 Chrome checks passed against the real API and a disposable database. A focused simulated-API run also verified 24 viewport/language/text-size combinations and optional-note restoration.

## Participant workspace design reference

The owner's TruckLink investor Site screenshot supplied the visual direction for Trucker's
participant web workspace. The work uses Trucker's current navigation and organisation
record. Desktop gets a teal sidebar and the organisation overview gets a status card with
links to existing workflows. Narrow layouts keep the workspace navigation above the page.
The public landing page, staff console and native application retain their own layouts.

The workspace preview passed 36 width, locale and text-size combinations in Chrome with
a simulated API. The web build and 24 web unit tests passed.
All 2,617 Chrome checks also passed against the real API and a disposable database.

The approved workspace menu now puts Overview first, followed by Shipping (shipments, quotations, bookings), Transport (discovery, fleet, cargo cases), and Organisation (authorities, contracts) in EN/AR/UR.
All 24 web unit tests and 36 focused Chrome layout combinations passed, including grouped order and current-page navigation in three languages using simulated data. This run used the isolated development server because Windows refused writes during production prerender.

## Shared workspace across roles

The participant web workspace and staff console share the grouped navigation renderer and
petrol/teal active-state treatment. The staff navigation retains its privilege-based links
and groups the available pages into Freight operations, Verification and staff, and Finance.
The Operations introduction uses the same overview surface as the organisation page.
The native app applies the same palette and selection treatment to its bottom tabs, keeping
native navigation and right-to-left behavior.

Verification: both web builds passed, along with 24 web unit tests, 2,617 participant Chrome checks and 362 console Chrome checks on disposable databases. Native TypeScript and six client tests passed. No device installation was performed.

## Compact data and form styling

The shared web and staff stylesheet reduces form and record spacing while preserving input
target sizes and validation states. The cargo cost table has distinct headers, banded rows,
and emphasized totals. Narrow screens keep the existing labeled cost cards. Shipment
status filters and section links use the same segmented styling, with active and focus states
and wrapping at narrow widths. All routes and submissions keep their existing behavior.

The final web build and 24 web unit tests passed. The staff build and 362 Chrome checks
passed. The final mobile-width tab refinement passed 24 focused layout combinations and
section-link checks in Chrome with a simulated API.
The full 2,617-check Chrome suite passed against the disposable database before the final mobile tab width adjustment, which was then checked on the final build.

## Consistent page styling across both portals

Both layouts import the shared stylesheet. Page titles use a common inset heading surface,
section headings use a quieter divider, and primary actions use the workspace palette.
The staff Operations counters fit two across on a typical phone and reflow as needed.
Both builds, 24 web unit tests and 362 staff Chrome checks passed. The Docker Compose
configuration validated, but Windows denied this session access to the Docker daemon.
All 2,617 user-portal Chrome checks passed against the real API and a disposable database.
