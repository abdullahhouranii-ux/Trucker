# Trucker: final audit backlog (wording, translation, accessibility)

Version 0.3, 14 November 2026. Owner: Abdullah.

Repository copy: `docs/delivery/FINAL_AUDIT_BACKLOG.md`.

## 1. What goes here, and what does not

Rule set by Abdullah on 13 November 2026:

| Kind of finding | Handling |
|---|---|
| Wording and translation corrections | Collected here. Fixed together in the final audit, not one at a time |
| Accessibility observations that need a human or a device to judge | Collected here for the accessibility audit |
| Security, functionality and data-integrity defects | **Fixed immediately** in the slice where they are found, with a test. Never parked here |

An item leaves this list only when it is fixed and checked, or when Abdullah decides it will not be done. Every entry says where it was seen and what is and is not known.

## 2. Accessibility audit items

| ID | Finding | Where seen | What is known | What is not known | Proposed check |
|---|---|---|---|---|---|
| AX-01 | **For a moment after a form is sent, the page has no title.** Next.js swaps the page in place after a server action and the title arrives slightly after the content | Slice 4 (registration), commit `e554d94`. The automated rule `document-title` failed in 2 of 5 full runs of the browser checks; the one captured failure was on the code-entry page in English | The title does arrive. The automated check now waits for it. The same mechanism applies to every form in slice 5 | Whether a screen reader announces the new page without a title, late, or not at all. How long the gap is on a slow phone | Test with TalkBack, VoiceOver and NVDA on the sign-in, code, registration, account and organisation pages. If the announcement is wrong, make the title present with the first content |
| AX-02 | No screen-reader test has been run on any built page | Slices 3, 4, 5 | Automated rules report 0 violations; focus moves to the error summary after a refused form | Everything a screen reader actually says, in all three languages | Same sessions as AX-01 |
| AX-03 | No physical phone, Safari or Firefox test | Slices 3, 4, 5 | Emulated widths and doubled text size pass in Chrome | Real text shaping, system font scaling and touch behaviour, especially for Arabic and Urdu | Representative Android and iPhone devices; Safari and Firefox on desktop |
| AX-04 | A draft survives a language change only with scripts enabled | Slices 4, 5 | Without scripts the page works but typed values are lost on a language change | Whether that matters for the people who will use it | Decide after device testing |
| AX-05 | A long name in a single-line box is not fully visible on a narrow phone while it is being edited | Slice 5, organisation form at 320 px and with text doubled | The box scrolls, as text boxes do; the full name is shown above the form. The automated overflow check exempts single-line text boxes for this reason | Whether people find it hard to review a long legal name before saving | Consider a multi-line box for the legal name after device testing |
| AX-06 | The country list is a plain drop-down | Slice 5 | Works with keyboard and passes automated rules with two fixture entries | How it behaves with a real list of countries, in three languages, with a screen reader | Recheck when real countries are approved |
| AX-07 | Dates and times are typed as text, and the time-zone list is not filtered by the chosen country | Slice 7, shipment form | Works with keyboard; automated rules pass; a wrong zone is refused with a message | Whether people on phones manage year-month-day and 24-hour entry, in three languages | Device testing; then decide on native date and time controls |
| AX-08 | The choice between two clock times on the day the clocks go back is a drop-down showing offsets from UTC | Slice 7, shipment form | Neither is preselected; the choice is stored and shown again | Whether "UTC-04:00" and "UTC-05:00" mean anything to the people choosing | Consider "the first 01:30" and "the second 01:30" after user testing |

No accessibility conformance is claimed for any page.

## 3. Wording corrections (English source text)

| ID | Finding | Where seen | Note |
|---|---|---|---|
| WD-01 | The code page says "We sent a 6-digit code" in a build where no message is sent. A visitor who is not on the developer's machine sees that sentence and no code | Slice 4, code-entry page | Development builds only; production cannot start code delivery |
| WD-02 | After an unconfirmed "end all other sessions" that had in fact worked, a retry reports "Other sessions ended: 0" | Slice 4, account page | True, but reads oddly |
| WD-03 | After an unconfirmed "end this session" that had in fact worked, a retry reports "That session was not found. It may have ended already" | Slice 4, account page | True. Consider saying plainly that the session is no longer active |
| WD-04 | The header shows "Sign in" on every page, including when the person is signed in | Slices 4, 5, header | The header does not read the session. Decide what it should show |
| WD-05 | Homepage and footer copy is draft, and launch wording depends on decisions not yet made (D-001, D-003b) | Slice 3 | Marked as draft on the page |
| WD-06 | The details list reuses the form labels, so it shows "Trading name (optional)", "Address (optional)" and "Contact person (optional)" as headings of saved values | Slice 5, organisation page | Needs separate labels without "(optional)" |
| WD-07 | "Your role: Administrator" is shown for every organisation, because no other role exists yet | Slice 5, organisation page | Review when roles are designed |
| WD-08 | After a lost answer on create, changing the details and trying again reports "An earlier attempt may already have created this organisation. Check your organisations before trying again." | Slice 5, create form | Correct, but the next step could be clearer |
| WD-09 | The draft notice states what a draft does not give ("no ownership of the company's name or registration number and no right to trade") | Slice 5, create form and organisation page | Wording follows decision O-1. It is a statement with legal weight and needs review with the terms |
| WD-10 | "Verification is not available yet" | Slice 5, organisation page | True for this slice; must change when verification is built |
| WD-11 | The details list reuses form labels, so saved values are headed "Your reference (optional)", "Packaging (optional)" and so on | Slice 7, draft page | Same as WD-06 |
| WD-12 | "Earliest: date", "Latest: time" are built from two words with a colon | Slice 7, shipment form | Understandable, not natural, least so in Arabic and Urdu |
| WD-13 | The draft notice says a draft "gives no right to transport", and the route note says "not legal clearance" | Slice 7, draft page | Wording follows SD-1 and SD-3. Statements with legal weight; review with the terms |
| WD-14 | After a lost answer, changing the details and trying again reports "An earlier attempt may already have been saved. Check the draft before saving again." | Slice 7 | Correct, but the next step could be clearer (as WD-08) |
| WD-15 | The declaration of authority is demonstration wording | Slice 9, verification page | To be replaced by approved legal text |
| WD-16 | Console decision choices repeat the decision in each option ("Request changes: Details incomplete") | Slice 9, console application page | Clear but long |
| WD-17 | The withdrawal form asks for an organisation identifier | Slice 9, console | Functional; a search by name would read better |
| WD-18 | The console shows what carriers would see as raw data | Slice 10, console shipment page | Readable for staff, not presented |
| WD-19 | A publication window is written "from – until" across lines at phone width | Slice 10, carrier preview | Clear but not elegant |
| WD-20 | The console shows a carrier's declared countries and equipment as codes (XA, curtain_side), not names | Slice 11, console application page | Readable for staff, not presented |
| WD-21 | In Arabic and Urdu, an area written in English is followed by its comma on the next line in discovery cards ("North industrial / ,area") | Slice 11, discovery list | Correct order, awkward wrapping |
| WD-22 | The shipper's comparison labels the earliest pick-up "Earliest pick-up you can meet", the carrier's wording | Slice 12, shipper quotations page | Should read as the carrier's earliest pick-up |
| WD-23 | The shipper's comparison shows each inclusion as a row of the facts list, so three inclusions make a long card on phones | Slice 12, shipper quotations page | Readable; consider a compact table once the real register is known |
| WD-24 | The empty amount reuses the "Enter the amount with digits and a point" message rather than a "required" message | Slice 12, quotation form | Correct but indirect |
| WD-25 | After a lost answer the vehicle form is shown filled in again although the vehicle was registered | Slice 13, fleet page | Sending it again answers "already in your fleet"; clearer to empty the form once the list shows the vehicle |
| WD-26 | The console names fleet records by raw codes ("fictional rigid truck") and asks for an identifier to suspend | Slice 13, console fleet page | Readable for staff; names and a button per record would be better |
| WD-27 | A driver's status line and the eligibility line repeat each other ("Working with you", "Eligible now") and the reason for ineligibility is one short sentence | Slice 13, fleet and driver pages | Correct; could say which document is missing |
| WD-28 | "Expires" is followed by the date with no separator in right-to-left text | Slice 13, document lists | Readable; check with native readers |
| WD-29 | Booking times (assignment deadline, planned interval, accepted) are shown in UTC, not at the pick-up place | Slice 14, booking card | Correct; local time with the zone would read better |
| WD-30 | The shipment list has no filter for awarded shipments; they appear under "all" | Slice 14, shipments page | Add the filter with the list's other states |
| WD-31 | Inclusions on a booking are marked with ✓ and ✗ | Slice 14, booking card | Use the words "included" and "not included" |
| WD-32 | In the assignment lists a resource that cannot be chosen shows its reason in brackets after its name, and is disabled | Slice 15, booking page | Works with a screen reader; a separate explanation under the list would read better |
| WD-33 | A refusal reads "… Nothing was changed. Truck: reserved for another booking at this time" | Slice 15, booking page | Join into one sentence per language |
| WD-34 | The console lists dispatch blockers as their codes with underscores removed | Slice 15, console | Use sentences |

## 4. Translation corrections (Arabic and Urdu)

All Arabic and Urdu text in the repository is a draft written without a native reader. Per the Stage 4 rule, critical text needs human review before any real user sees it.

| ID | Scope | Where | Priority for review |
|---|---|---|---|
| TR-01 | Session and sign-out messages, including the "may still be active" wording | Slice 4, `auth.errors` and `auth.account` | High: the distinction between confirmed, not confirmed and browser-only must survive translation |
| TR-02 | Sign-in, code and registration messages and errors | Slice 4, `auth.signIn`, `auth.code`, `auth.register`, `auth.errors` | High |
| TR-03 | Demonstration terms notice in three languages | Slice 4, API terms text | Low: placeholder text, to be replaced by approved legal terms, which need professional translation in any case |
| TR-04 | Homepage, navigation, environment banner, not-found page | Slice 3 | Medium |
| TR-05 | Urdu typeface: Noto Sans Arabic is provisional for body text; Nastaliq for large display text is undecided | Design tokens 0.3.0 | Needs Urdu readers on phones |
| TR-06 | Terminology is not yet fixed across languages (for example "session", "sign out", "one-time code", "organisation", "draft", "verified") | All | Agree a short glossary before the review, so corrections are consistent |
| TR-07 | Organisation messages: the draft notice, the "not confirmed" messages for create and save, the changed-elsewhere message, field labels and errors | Slice 5, `org` | High: the draft notice and the uncertain-outcome messages carry meaning that must not shift |
| TR-08 | Names of the fictional countries | Slice 5, `db/fixtures/local-development/countries.json` | Low: development data only |
| TR-09 | All shipment messages (112 strings): the private-draft notice, route wording, conflict and "not confirmed" messages, time errors, field labels | Slice 7, `ship` | High: "not published", "not legal clearance", "not confirmed" and the clock-change messages carry meaning that must not shift |
| TR-10 | All verification messages (86 strings) and five changed organisation messages: the demonstration notice, statuses, reasons, the declaration, "not confirmed" messages | Slice 9, `verify`, `org` | High: "demonstration only", "declared, not verified" and the declaration of authority carry meaning that must not shift |
| TR-11 | Names of the fictional evidence requirements | Slice 9, `db/fixtures/local-development/countries.json` | Low: development data only |
| TR-12 | All publication messages (104 strings) and two new shipment errors: statuses, suspension causes, the preview caution, "not confirmed" messages | Slice 10, `pub` | High: the anonymity caution and "no carrier can see it yet" must not shift |
| TR-13 | Names of the fictional cargo categories and equipment types | Slice 10, fixtures | Low: development data only |
| TR-14 | All carrier and discovery messages (`carrier`, `disc`), the new verification labels, and the two corrected preview statements | Slice 11 | High: "matching criteria only, not verified vehicles, availability or permission to accept work" and "anonymity is not guaranteed" must not shift |
| TR-15 | The fictional haulage licence requirement name | Slice 11, fixtures | Low: development data only |
| TR-16 | All quotation messages (`quo`) and the corrected `disc.noQuotations` | Slice 12 | High: "nothing is accepted or booked", "Trucker does not determine how tax applies" and the "not confirmed" messages must not shift |
| TR-17 | Names of the fictional inclusions and the test currency | Slice 12, fixtures | Low: development data only |
| TR-18 | All fleet and driver messages (`fleet`) | Slice 13 | High: "reserves and assigns nothing", "a claim until staff verify it" and "not its number" must not shift |
| TR-21 | All assignment messages (`asg`) and the new booking state | Slice 15 | High: "confirmed does not mean dispatched", "the booking is not cancelled", "the price does not change" and "it cancels nothing and charges nothing" must not shift |
| TR-20 | All booking messages (`book`), the new quotation standings and errors, and three corrected statements about acceptance | Slice 14 | High: "not confirmed", "development values", "no tax is calculated" and "Trucker does not hold the transport money" must not shift |
| TR-19 | Names of the fictional vehicle categories, licence classes and document types | Slice 13, fixtures | Low: development data only |

## 5. How this list is used

- Each slice adds what it finds, with the slice and commit.
- The slice record in `docs/delivery/` keeps the evidence; this list keeps the open work.
- When the final audit is scheduled, sections 2 to 4 become its checklist.
