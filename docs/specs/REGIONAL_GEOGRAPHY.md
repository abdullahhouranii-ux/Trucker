# Trucker — Regional geography: D-003 and D-014 (provisional)

Version 0.3, 13 Nov 2026. Owner: Abdullah. Authoritative copy: `docs/specs` in the repository; Claude-project copies are synchronised references. Changes in 0.3: adopted into the authoritative set; D-014 preferred direction recorded; section 8 lists the changes made to the other specifications. Changes in 0.2: transit countries and named time zones. This is a document; no code, supplier or registration is changed by it.

**Status.** Records the direction you confirmed on 13 Nov 2026 and splits decision D-003 into separate parts. Every choice below marked **open** is yours. Nothing here states a legal, licensing, tax or customs requirement; those are listed as matters for qualified review.

## 1. Confirmed direction (13 Nov 2026)

| ID | Confirmed |
|---|---|
| F-08 | Trucker targets the Middle East, prioritising the six GCC countries: Oman, UAE, Saudi Arabia, Qatar, Kuwait and Bahrain. The platform is not scoped as Oman-only |
| F-09 | The platform is designed for country-specific configuration: international phone numbers, currencies, time zones, document requirements, domestic routes and cross-border journeys |
| F-10 | Adding a country is **not** assumed to be only a matter of catalogue rows |
| F-11 | The business base is a separate decision (D-014) from launch countries and routes. Business registration and launch-market permissions are separate |
| F-04, F-01 (unchanged) | English, Arabic and Urdu remain required. Trucker remains separate from TruckLink |

This supersedes my earlier recommendation to launch "Oman domestic" (Stage 1 baseline, section 7.3) and the wording that more countries are "catalogue rows, not tables".

## 2. D-003 split into five parts

| Part | Question | Status |
|---|---|---|
| **D-003a Full target geography** | Where Trucker intends to operate | **Confirmed:** Middle East, six GCC countries first |
| **D-003b Initial enabled countries** | Which countries are operational at first launch | **Open** (section 3) |
| **D-003c Initial lanes** | Which domestic and cross-border lanes are enabled first | **Open** (section 4) |
| **D-003d Participant eligibility** | Who may register and operate where | **Open** (section 5) |
| **D-003e Country launch dependencies** | What must be true before a country is switched on | Framework proposed (section 6); content needs qualified review |
| **D-014 Business base** (separate) | Where the operating company is established | **Preferred direction recorded 13 Nov 2026: Dubai, UAE, with a free-zone company.** The specific free zone is undecided. This is not a registration instruction and nothing is registered. Supporting research (base comparison, free-zone shortlist) is kept in the Claude project, outside this set, and is not a statement of legal requirements |

## 3. D-003b Initial enabled countries: two ways to reach the full target

Both keep all six countries as the target. They differ in what must be ready on the first day.

| | GCC-wide first launch | Phased GCC rollout |
|---|---|---|
| Countries operational on day one | All six | A chosen first group, the rest switched on in a planned order |
| Readiness needed before launch | Every dependency in section 6, for six countries at once | The same dependencies, for the first group only |
| Legal and tax review | Six jurisdictions before any revenue | Fewer first; the rest before each is enabled |
| Supply and demand | Carriers and shippers recruited in six markets at once | Concentrated where recruitment starts |
| Support and operations | Six named time zones, six sets of local rules from the start | Grows with each country |
| Learning | Problems appear in six places at once | Early countries inform later ones |
| What is built | The same platform in both cases: the country is a configuration with its own readiness record |

"Enabled" is recorded per country and per lane, so a phased rollout is switching on, not rebuilding.

## 4. D-003c Initial lanes

A lane is an origin country, a destination country, the ordered list of **transit countries** between them, and the border crossings used. It can be enabled only when the origin and destination are enabled, every transit country is transit-ready (section 4.1), and the cross-border rules for each border on the route are settled.

| Choice | Meaning | Extra requirements |
|---|---|---|
| Domestic only | Pick-up and delivery in the same country | That country's readiness (section 6) |
| Cross-border only | Between two enabled countries | Both countries' readiness plus the pair's border documents, responsibilities and milestones |
| Both | Domestic lanes in enabled countries and selected country pairs | All of the above |

Which country pairs and corridors come first is **open**. The corridor and border-crossing list carried over from the reference material (C-02) is unverified and is input only.

### 4.1 Transit countries

Many GCC journeys cross a third country. By road, Oman to Qatar, Kuwait or Bahrain passes through Saudi Arabia (and possibly the UAE); the UAE to Qatar, Kuwait or Bahrain passes through Saudi Arabia. A transit country is neither origin nor destination, but its rules still apply to the truck, driver and cargo while they are inside it.

A country therefore has separate states, each switched on independently:

| State | Meaning |
|---|---|
| Target | In the planned geography (all six GCC countries) |
| Registration-enabled | Organisations or drivers of that country may register |
| Booking-enabled | Shipments may start or end there |
| Transit-ready | Journeys may pass through it |

What transit readiness must record, per transit country. The content is for qualified review; the examples show why each item exists and are not a statement of the current rules.

| Item | Example of evidence that the item matters |
|---|---|
| Whether foreign trucks may transit, and under which permit or electronic document | Saudi Arabia is reported to require an electronic transport document for foreign trucks |
| What a transiting truck may not do | Saudi Arabia is reported to bar foreign trucks from carrying goods between Saudi cities |
| Maximum stay and extension permits | Oman's transport platform lists a permit for foreign vehicles staying more than seven days |
| Vehicle equipment rules that apply in transit | Oman's regulation is reported to extend tracking-device duties to vehicles transiting its territory |
| Customs transit regime and guarantee | The TIR system is reported as operational in five GCC countries |
| Driver entry: visa, licence recognition, crew nationality rules | To be established per country |
| Motor and cargo insurance valid in the transit country | To be established per country |
| Border crossings permitted for the cargo and vehicle type, and their working hours | To be established per crossing |

Consequences for the design:
- A journey carries one milestone pair (exit and entry) for **each** border, not one for the whole trip.
- Carrier, vehicle and driver eligibility is checked against every country on the route, including transit countries.
- Transit documents and who must provide them belong in the cross-border responsibilities decision (question 7).
- Estimated times account for each border and for the time-zone change on the route.
- A lane through a country that is not transit-ready cannot be published, even when both ends are enabled.

## 5. D-003d Participant eligibility: four separate facts

These are different things and must not be merged into one "country" field.

| Fact | Belongs to | Example of what it decides |
|---|---|---|
| **Registration country** | An organisation (shipper, carrier, owner business) | Which company documents are required; which legal terms apply; tax identity |
| **Residence and licence country** | A driver | Which identity, residence and licence documents are required |
| **Phone number country** | A user's sign-in identity | Only how the person is reached. It grants nothing and proves nothing about residence or permission |
| **Permission to operate on a route** | A carrier, a vehicle and a driver, per country or lane | Whether this party, vehicle and driver may be offered or assigned on a given lane |

Consequences for the design:
- A user with a phone number from one country can belong to an organisation registered in another.
- An organisation registered in one country is not thereby permitted to carry in another; that is a separate, verified permission.
- Eligibility to quote on a lane is checked against permissions for **every country on the route** (origin, transit and destination) and, for the vehicle and driver, again at assignment.

**Open:** in which countries each participant type may register at first launch, and whether registration is allowed in a target country before that country is enabled for bookings (for example, to build supply).

## 6. D-003e What a country needs before it is enabled

A country readiness record, one per country, with each item marked not started, in review, or approved. A country cannot be enabled while a required item is not approved. The items are the same for every country; their content is not.

| Area | Item | Who must establish it |
|---|---|---|
| Legal | Whether and how Trucker may operate there from its business base; local terms and consumer or commercial rules | Qualified legal review |
| Licensing | Any platform, transport or brokerage licence | Qualified legal review; regulator |
| Tax and invoicing | Tax registration, invoice content and format, any electronic invoicing obligation | Accountant or tax adviser |
| Verification | The document matrix for each participant type | Qualified review (see question 6) |
| Data | Where personal data may be hosted and transferred; retention | Legal review |
| Currency | Currency, decimal places, rounding | Platform configuration |
| Identity and messaging | Phone format; delivery of one-time codes and notifications, including any sender registration | Supplier, once chosen |
| Payments | How shippers pay and carriers are paid there | Gated on D-002; supplier onboarding |
| Language | Reviewed English, Arabic and Urdu text, including local terms | Human reviewers |
| Operations | Support hours, working week and public holidays, emergency number shown to drivers | Operations |
| Cross-border (per country pair) | Documents, who provides and verifies them, border milestones | Qualified review (see question 7) |
| Transit (per country) | The transit-readiness items in section 4.1 | Qualified review (see question 7) |

Fixed facts that are already safe to configure: the six currencies and their decimal places (OMR, KWD and BHD use three; AED, SAR and QAR use two), international dialling codes, and the named time zones below.

| Country | Time zone name | Current offset |
|---|---|---|
| Oman | `Asia/Muscat` | UTC+4 |
| UAE | `Asia/Dubai` | UTC+4 |
| Saudi Arabia | `Asia/Riyadh` | UTC+3 |
| Qatar | `Asia/Qatar` | UTC+3 |
| Kuwait | `Asia/Kuwait` | UTC+3 |
| Bahrain | `Asia/Bahrain` | UTC+3 |

Every location stores its zone **name**, never a fixed offset. Instants are stored in UTC and converted for display with the named zone. Offsets are shown here for orientation only: a government can change its offset or adopt seasonal time, and the name keeps past and future times correct when the zone data is updated. A country with more than one zone would simply have locations with different names.

## 7. What "not only catalogue rows" means

Adding a country can require each of the following, so the design treats a country as configuration **plus** rules **plus** a readiness process.

| Kind of change | Examples |
|---|---|
| Data (catalogue rows) | Country, currency, time zones, document types, holidays |
| Rules that may need code | Document validation formats; invoice numbering and layout; tax calculation; eligibility for cross-border lanes; address formats |
| Integrations | Messaging delivery, payment methods, possibly regulator or invoicing systems |
| Content | Legal terms, consent texts and translations per jurisdiction |
| Process | Legal and tax review, supplier onboarding, support cover |

## 8. Effect on the existing specifications and foundation

### Specifications: changes made with this revision

| Document | Change |
|---|---|
| Stage 1 baseline (0.2) | F-08 to F-11 added; D-003 split into D-003a to D-003e; D-014 added; A-02 corrected; geography row in section 4 restated; section 7.3 replaced and the "Oman domestic" recommendation withdrawn |
| Stage 2 Part 1 (0.4) | D-003 row in section 8: phone numbers from any country, registration country from enabled countries, document requirements by country and participant type, four separate eligibility facts, "catalogue rows, not tables" withdrawn |
| Stage 2 Part 2 (0.4) | Named time zones in 3.1; lane definition with transit countries, currencies and route-wide eligibility in the D-003 table; group A decision restated |
| Stage 2 Part 3 (0.3) | One exit and entry milestone pair per border including transit borders; dispatch refused when a transit country is not transit-ready |
| Stage 2 Part 4 (0.3) | Transit documents named in delivery evidence |
| Stage 3 (0.5) | "Matter of catalogue rows" withdrawn; country readiness, enabled states and lanes with transit countries added to section 4; gates name D-003b to D-003d |

The journeys in Stage 2 Part 1 (J1.1 to J1.3) are not rewritten; the section 8 row above governs where they differ.

### Foundation code (checked on `staging` at `5d574d0`)

I searched the merged code, migrations, helper scripts, CI configuration and environment example for country, currency, time zone, locale and Oman-specific values. **There are none.** The foundation contains configuration validation, health checks, the migration runner, the error body, request identifiers and local helpers; the only migration creates an empty schema.

**No change to working foundation code is required by the regional direction.** Three things to carry into the first functional work, none of which is a change to what exists:
- Money needs per-currency decimal places from the start (three and two decimals both occur in the GCC).
- Error bodies return a stable `code` and an English `message`; translated messages for Arabic and Urdu are not built yet.
- Phone numbers must be stored in international format with their country code, never as local numbers.

## 9. First functional journey: provisional scope outline

Registration → organisation → shipment creation. This is an outline against the regional direction. It is **not** a final scope: the items marked "depends on" must be answered first, and the full scope and acceptance criteria are presented separately for approval before any implementation.

| Part | In scope | Regional requirement | Depends on |
|---|---|---|---|
| Identity | Register and sign in; sessions; sign out everywhere | International mobile numbers from any country; language choice EN, AR, UR | Question 4 (sign-in) |
| Organisation | Create a shipper organisation; first admin; invite a member | Registration country chosen from enabled countries; the four eligibility facts kept separate | Questions 1 and 3 |
| Verification | Upload required documents; staff decision; unverified organisations cannot publish | Requirements looked up by country and participant type; development list clearly marked provisional | Question 6 |
| Locations | Pick-up and delivery locations with country and time zone | Locations in any enabled country | Question 1 |
| Shipment | Create a draft, list own shipments, view one | Lane check against enabled lanes; windows in each location's time zone | Question 2 |
| Not in this journey | Quotations, bookings, pricing, payments, dispatch | Gated on D-001 and later decisions | — |

Draft acceptance criteria (to be completed):

| ID | Criterion |
|---|---|
| J-01 | A user can register with a mobile number from any of the six GCC countries and from a non-GCC country; the number is stored in international format |
| J-02 | A phone number's country grants no permission and does not set the organisation's registration country |
| J-03 | An organisation can be created only in a country enabled for registration; the list comes from configuration, not code |
| J-04 | Document requirements shown to an organisation are those configured for its registration country and participant type; changing the configuration changes the form without a code change |
| J-05 | An organisation of one country cannot see or change another organisation's records (tenant isolation tests on the real database) |
| J-06 | A location carries its country and a named time zone (for example `Asia/Muscat`), never a fixed offset; a shipment window is stored as a UTC instant and shown in the location's named zone, tested with a pick-up in `Asia/Dubai` and a delivery in `Asia/Riyadh` |
| J-07 | A shipment draft is refused when its origin or destination country, the lane between them, or any transit country on the lane is not enabled; the refusal uses the standard error body and names which part is not enabled |
| J-11 | A lane records its ordered transit countries and border crossings as configuration; adding or removing a transit country changes which drafts are accepted without a code change |
| J-08 | Every screen and validation message in the journey exists in English, Arabic and Urdu, with right-to-left layout for Arabic and Urdu |
| J-09 | Every change in the journey is recorded in the audit history with who and when |
| J-10 | Repeating a create request with the same key creates one record |

J-09 and J-10 need the audit log and idempotency store (foundation items F-07 and F-09), which are not built. They would be part of the scope I bring for approval.

## 10. Questions, in batches

| Batch | Questions |
|---|---|
| A | Founder details for the business base (D-014); tracked outside this set |
| B | 1 Launch sequence; 2 Initial routes; 3 Participants |
| C | 4 Sign-in; 5 Currencies |
| D | 6 Verification matrix; 7 Cross-border responsibilities; 8 Suppliers and hosting |
