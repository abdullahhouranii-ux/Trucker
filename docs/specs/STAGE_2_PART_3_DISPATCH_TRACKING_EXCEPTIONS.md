# Trucker — Stage 2, Part 3: dispatch, tracking and exceptions (provisional)

Version 0.3, 13 Nov 2026. Owner: Abdullah. Changes in 0.3: border milestones are per border and include transit borders (REGIONAL_GEOGRAPHY.md). Builds on the Stage 1 baseline, Stage 2 Part 1 (v0.3) and Part 2 (v0.3). Authoritative copy: `docs/specs` in the repository; Claude-project copies are synchronised references. Changes in 0.2 after review: dispatch authorisation is invalidated by later changes and re-checked at trip start; event ordering is defined across devices and recorders; bad timestamps are flagged, not rejected; consent cannot be overridden and live subscriptions end with access; restricted trip mode has its own operations-only channel; an occupied resource blocks dispatch of its next booking.

**Status.** Provisional design; nothing is implemented and no application tests were run. D-001 (commercial model) and D-002 (payment approach) remain **TBD**; D-003 has a confirmed target geography (Middle East, GCC first) with initial countries, lanes and eligibility **TBD** (REGIONAL_GEOGRAPHY.md); section 10 shows where they change this part. No supplier is selected (maps, messaging, push, GPS devices) and no legal, safety or privacy compliance is asserted. Location, consent and retention rules need qualified review. POD and disputes are Part 4.

## 1. Surfaces in this part

All seven surfaces remain in scope.

| Surface | Role in this part |
|---|---|
| A. Public website | Explains tracking and what participants can expect; opens an expiring tracking link if that feature is approved (C-21). No sign-in role |
| B. Shipper portal | Follows the trip, sees milestones and exceptions, messages on the trip |
| C. Carrier portal | Assigns, requests dispatch, follows trips, handles exceptions, messages |
| D. Vehicle-owner portal | Same as carrier for assets the owner controls; an owner who drives uses surface E for the trip itself |
| E. Driver application | Acknowledges assignments, follows instructions, records milestones, reports exceptions, messages; works with limited connectivity |
| F. Operations console | Oversees dispatch, blocks or withdraws authorisation, handles exceptions and intervention cases |
| G. Partner integration | Reads trip status and milestones for the organisation's own bookings; receives signed event notifications. No wider location access |

## 2. Separate state models

| Object | States | Notes |
|---|---|---|
| **Assignment** (a driver put forward for a booking) | `proposed` → `acknowledged`; or `declined`, `expired`, `replaced`, `withdrawn` | Creating an assignment needs the eligibility in Part 1, 3.6 and a driver reservation (Part 2) |
| **Dispatch authorisation** | `pending` → `authorised` → `used` at trip start; or `blocked`, `withdrawn`, `invalidated`, `lapsed` | The gate between a booking and a moving trip. Valid only for the exact facts it was checked against (section 3) |
| **Trip** | `planned` → `dispatched` → `at_pickup` → `loaded` → `in_transit` → `at_delivery` → `delivered`; side states `on_hold`, `aborted` | The server decides every transition. After `delivered` the POD process starts (Part 4) |
| **Exception** | `reported` → `acknowledged` → `in_progress` → `resolved` or `escalated` | Linked to a trip; may open an intervention case (Part 1, 3.7) |
| **Location consent** | `not_asked` → `granted` → `withdrawn` | Per driver, with the version and language of the text shown |

## 3. Journey J6: assignment and dispatch authorisation

| Aspect | Specification |
|---|---|
| Actors and permissions | Carrier `admin` or `dispatcher`; owner or a delegate holding `assign_drivers`; the driver; operations staff (oversight). Holding operating control does not replace any check below (Part 1, 3.5) |
| Assignment fields | Booking; driver; truck; trailer; reporting time and place; instructions; acknowledgement deadline |
| Dispatch preconditions (system) | Booking `confirmed`; truck, trailer and driver reservations active for the period; driver assignment `acknowledged`; documents of driver, truck and trailer valid through the period; no open intervention case blocking the booking; **none of the truck, trailer or driver is still occupied by another trip in progress**, whatever that trip's reserved period says (Part 2, 7.3); location consent recorded as granted **or** the approved rule for its absence satisfied (R-303); fixed GPS device reporting, only if C-10 is adopted |
| Who authorises | The operating controller's dispatcher requests dispatch. Whether each dispatch also needs approval by Trucker operations, only some, or none, is an **approved rule TBD** (R-301) |
| What an authorisation covers | It records the booking version, truck, trailer, driver, assignment, and the documents, affiliation, driver authorisation and operating control it was checked against. It is valid for those facts only and lapses if the trip has not started by a set time (parameter) |
| Invalidation | An authorisation becomes `invalidated` automatically, and a new one is required, when any of these happens before the trip starts: a substitution takes effect; the assignment is replaced, declined or withdrawn; the affiliation, driver authorisation, delegation or ownership behind it ends or changes; a required document expires or is rejected; any party or resource is suspended; an intervention case opens; the booking is amended or cancelled; the location-consent position changes where the approved rule (R-303) depends on it |
| Re-check at trip start | The trip starts only when the driver's start event is confirmed by the server. At that moment the server runs every precondition again and requires a current authorisation for the same facts. If anything fails, the trip does not start, the authorisation is invalidated and the dispatcher and operations are told why |
| Start without a connection | A start recorded offline is not applied until the server has re-checked. If the re-check fails when it arrives, the start is kept as a late observation and operations is alerted |
| Operations powers | Block before start; withdraw an authorisation before `dispatched`; after that, act only through an intervention case |
| Validation | Every precondition is re-checked on the server at the moment of authorisation; the earliest dispatch time relative to the pick-up window is a parameter |
| Failure paths | Driver declines or does not acknowledge by the deadline (assignment `declined` or `expired`; booking shows "needs driver"; rule for a missed deadline is P-204 in Part 2). Driver does not report (exception "no-show"; operations case). Vehicle fails before start (substitution under Part 2, 7.2). A document expires between booking and dispatch (authorisation `blocked`; renewal or substitution). Driver's reservation refused for overlap (assignment cannot be created) |
| Notifications | Assignment to the driver in their language; acknowledgement and decline to the dispatcher; authorisation, block and withdrawal to both parties; "dispatch at risk" to operations at a lead time |
| Audit events | `assignment.proposed`, `assignment.acknowledged`, `assignment.declined`, `assignment.expired`, `assignment.replaced`, `dispatch.requested`, `dispatch.authorised`, `dispatch.blocked` (with failed precondition), `dispatch.withdrawn`, `dispatch.invalidated` (with cause), `dispatch.lapsed`, `trip.start_refused` |
| Acceptance | AT-301 dispatch is refused while any precondition fails, and the refusal names it. AT-302 a driver sees only trips assigned to them. AT-303 an expired assignment cannot be acknowledged. AT-304 authorisation checked on stale data is refused: a document that expired a minute earlier blocks it. AT-305 a staff member without the operations privilege cannot block or withdraw. AT-306 a repeated dispatch request with the same key has one effect. AT-307 an authorisation given before a substitution, an ended affiliation or an expired document cannot be used to start the trip. AT-308 the start is refused when a precondition fails between authorisation and start, even with a valid-looking authorisation. AT-309 an unused authorisation lapses at its time limit. AT-310 a booking cannot be dispatched while its truck, trailer or driver is occupied by an overrunning trip, including under simultaneous start requests |

## 4. Journey J7: trip execution and milestones

| Aspect | Specification |
|---|---|
| Actors and permissions | The assigned driver records milestones. A dispatcher of the operating controller, or operations staff, may record one on the driver's behalf with a reason; it is marked as recorded by someone else. Shipper and partner clients read only |
| Milestones | Departed for pick-up; arrived at pick-up; loading started; loaded and departed; arrived at delivery; unloading started; delivered. On cross-border lanes, once enabled (D-003c), each border adds an exit and an entry milestone, including borders of transit countries |
| Event fields | Event identifier; trip; **assignment** under which it was recorded; recorder (the user); **device installation** identifier, or "console" for staff and dispatchers; sequence number within its stream (section 5); milestone type; time it happened (device clock); position at that moment, only if consent is granted; optional note and photos; time received by the server |
| Server authority | The server holds the trip state. An event is applied only if it is an allowed next step for the current state; the device shows a pending mark until the server confirms |
| Validation | Grounds for rejection: recorder is not entitled (not the current assignment, no valid session), or the step is not an allowed transition, or a file is of the wrong type or size. **An implausible time is not a ground for rejection**; it is flagged (section 5) |
| Waiting time (C-22) | Arrival and departure times at each site are kept as evidence. Waiting duration is derived from them; any charge depends on the approved policy (D-008) and is not calculated here |
| Failure paths | Out-of-order step (rejected with the reason and the current state); trip cancelled or reassigned meanwhile (section 5); wrong site (recorded with a mismatch mark for operations, not silently accepted or refused: tolerance is a parameter) |
| Notifications | Each applied milestone to the shipper, the operating controller and partner subscribers; late-running alerts to operations |
| Audit events | `trip.dispatched`, `trip.milestone_applied`, `trip.milestone_rejected`, `trip.milestone_recorded_on_behalf`, `trip.on_hold`, `trip.aborted`, `trip.delivered` |
| Acceptance | AT-311 a milestone that skips a step is rejected and the state is unchanged. AT-312 a milestone recorded on behalf shows who recorded it and why. AT-313 a driver removed from the trip cannot record further milestones. AT-314 arrival and departure times for each site are retrievable as waiting-time evidence |

## 5. Offline working, ordering and reconciliation

### 5.1 Offline working

| Rule | Detail |
|---|---|
| What works without a connection | Reading the cached trip and instructions; recording milestones after the trip has started; taking photos; reporting an exception; writing messages. All are stored durably on the device and survive an app restart or a reboot |
| What needs a connection | Acknowledging a new assignment; starting the trip (section 3); receiving changes to the trip; confirmation that an event was applied |
| Identity of an event | The event identifier is unique **permanently** on the server. A repeated upload is recognised whenever it arrives; this does not depend on the time-limited retry keys of Part 2, 3.2 |
| Upload | In batches when a connection returns. The server answers per event: `applied`, `duplicate`, `held`, `rejected` (with reason) or `late_observation` |
| Exactly-once | Not promised for the network. Promised for the effect: one event identifier changes the trip at most once |
| Photos | Uploaded separately and resumably; a milestone is applied without waiting for its photos, which attach when they arrive |
| Session expired while offline | Queued events stay on the device and upload after the driver signs in again |
| Session revoked as compromised | Uploads are rejected and held for review (Part 1, 3.7); nothing is applied |

### 5.2 Streams, devices and recorders

| Rule | Detail |
|---|---|
| Stream | Events are numbered within a **stream**: one assignment on one device installation. A sequence number means nothing outside its stream |
| Device installation | Each installation of the app registers an identifier at sign-in. A driver has one active installation at a time; signing in on another device ends the session on the previous one and opens a new stream |
| Staff and dispatcher entries | Recorded on a console stream, numbered by the server on receipt, always marked "recorded on behalf" with a reason |
| Order inside a stream | By sequence number |
| Order between streams | None is assumed. Each event is tested against the trip's state at the time the server processes it and applied only if it is a valid next step |
| Sequence gap | If a later event arrives before an earlier one from the same stream, it is `held` for a limited time (parameter). If the gap is not filled, the held events go to reconciliation; they are not applied automatically |
| Same milestone from two streams | The first valid one is applied. The second is stored as a duplicate observation with its own time and recorder. If the two times differ by more than a tolerance, the milestone is marked for reconciliation because waiting-time evidence depends on it |
| Events from a previous device | Events left on an old device may still be uploaded after the driver signs in on it again. Once a newer stream has applied events for the trip, they are stored as late observations and never applied automatically |
| Events under an ended assignment | Stored as late observations; never applied |
| Trip changed while offline | The server state wins. If the trip was cancelled, reassigned or put on hold, the driver's events are late observations and the driver is told plainly what changed on reconnecting |

### 5.3 Times that cannot be trusted

One rule replaces the earlier contradiction: **a doubtful time never causes rejection and never becomes evidence unchecked.**

| Case | Treatment |
|---|---|
| Time in the future beyond a tolerance, earlier than the previous applied milestone, or far from the server receipt time for an event sent while online | The event is accepted and, if otherwise valid, applied. Its time is marked **unverified** |
| Use of an unverified time | Shown with the server receipt time alongside; **excluded from waiting-time evidence and from on-time measures** until reconciled |
| What may support a corrected time | A position fix taken with the event (satellite time), adjacent events, a duplicate observation from another stream, or a recorded statement |

### 5.4 Controlled reconciliation

| Aspect | Specification |
|---|---|
| What goes to reconciliation | Unfilled sequence gaps; duplicate milestones with differing times; unverified times that affect evidence; late observations that contradict the applied record |
| Who | Operations staff only. The dispatcher and driver may add statements |
| What can be done | Confirm the applied record; apply a held event; set a corrected effective time; mark an observation as disregarded. Each needs a reason |
| What cannot be done | No original event is edited or deleted. A correction is a new reconciliation entry that refers to the events it relies on |
| Effect | The effective times after reconciliation are the ones used as evidence (Part 4); the original values remain visible |
| Audit events | `trip.event_held`, `trip.late_observation_stored`, `trip.time_unverified`, `reconciliation.opened`, `reconciliation.entry_recorded`, `reconciliation.closed` |

Acceptance for section 5: AT-321 with the device in flight mode after the trip has started, pick-up and delivery milestones are recorded and, after reconnecting, each is applied once in stream order. AT-322 the same batch uploaded three times changes the trip once. AT-323 a later event arriving before an earlier one from the same stream is held, then applied in order when the earlier one arrives. AT-324 events for a trip cancelled while offline are stored as late observations and the trip stays cancelled. AT-325 queued events survive an app restart. AT-326 events from a revoked session are not applied. AT-327 after a driver moves to a second device, events from the first device are stored as late observations and do not change the trip. AT-328 a milestone recorded by the driver and by a dispatcher is applied once; differing times open a reconciliation. AT-329 an event with a time in the future is applied with its time marked unverified and is absent from waiting-time evidence until reconciled. AT-330 reconciliation leaves every original event unchanged and records who decided and why.

## 6. Location, consent and tracking

| Aspect | Specification |
|---|---|
| Purpose | To show the parties of a booking where the vehicle is during that trip and to evidence arrival and departure. Any other use (C-31 data business) is outside this design until decided |
| Consent | Asked in the driver's language before the first tracked trip, with the text version recorded. Shown: what is collected, when, who sees it, how long it is kept. The driver can withdraw in the app |
| Consent is absolute | No phone position is collected or stored without granted consent. **No staff reason, hold, exception or intervention can override a missing or withdrawn consent** |
| When collected | With consent, only between `dispatched` and `delivered` for an assigned trip. While a trip is `on_hold` collection pauses; operations may continue it by recording a reason, and only if consent is still granted. Never outside a trip |
| Source | The driver's phone. A fixed GPS device is a second possible source only if C-10 is adopted; each position records its source |
| Samples around a withdrawal | The device stops sampling at once and deletes samples it has not yet sent. The server refuses any phone position received after the withdrawal is recorded, whenever it was captured, and removes the position from any milestone or exception event received after that point. This is the provisional, most cautious rule; treatment of positions already stored follows R-305 and legal review |
| Live subscriptions end with access | Access is checked on every update sent, not only when a screen subscribes. Existing live subscriptions are closed immediately when consent is withdrawn; the trip is delivered, aborted, cancelled or reassigned; a membership or session ends; an organisation is suspended; or a tracking link expires. Polling then returns nothing |
| If consent is absent or withdrawn | Phone tracking stops at once. Whether the driver may then be dispatched, and what the parties see instead, is an **approved rule TBD** needing legal review (R-303). Milestones still work |
| What each party sees | Operating controller and operations: positions and freshness. Shipper: **rule TBD** (R-304), either live position or milestones with an estimated arrival. Receiver: only through an expiring single-trip link, if C-21 is approved. Partner clients: status and milestones of their own bookings |
| Freshness | Every display shows the time of the last position; a position older than a threshold is marked stale and never drawn as current |
| Delivery to screens | Authenticated live updates where justified, with a polling fallback; a subscriber can receive only trips it may see |
| Retention | Detailed positions are kept for a limited period and then deleted; milestone times stay with the trip. The period is an **approved rule TBD** with legal review (R-305) |
| Safety | The app does not ask the driver to read or type while the vehicle is moving. How this is enforced (prompts only when stopped, larger single-action controls, spoken prompts) is **TBD** with a safety review (R-306) |
| Audit events | `consent.granted`, `consent.withdrawn`, `location.tracking_started`, `location.tracking_stopped`, `location.viewed_by_staff`, `tracking_link.created`, `tracking_link.expired` |
| Acceptance | AT-331 no position is stored for a driver without granted consent. AT-332 no position is stored outside `dispatched` to `delivered`. AT-333 withdrawal stops collection from the next sample. AT-334 a user of an organisation outside the booking cannot read or subscribe to the trip's positions. AT-335 a stale position is labelled stale. AT-336 an expired tracking link shows nothing. AT-337 with consent withdrawn, an operations reason on a held trip does not start or continue collection. AT-338 positions queued on the device before a withdrawal and uploaded after it are not stored. AT-339 a screen already showing a live trip stops receiving positions the moment consent is withdrawn or the viewer loses access. AT-354 putting a trip on hold pauses phone tracking unless a reason is recorded and consent is granted |

## 7. Messaging on a trip (C-12)

| Aspect | Specification |
|---|---|
| Participants | The driver, the operating controller's dispatchers, the shipper's users on that booking, operations and support staff. Nobody else |
| Content | Text and attachments, displayed safely as text; the sender's language is kept. Translation (C-20) and driver-to-driver chat (C-13) are not designed: both await your decision |
| Offline | Messages written offline are queued and sent once; history is fetched on reconnecting without duplicates |
| After the trip | The thread becomes read-only when the trip is closed; retention follows the approved rule (R-305) |
| Restricted trip mode | An operationally suspended driver does **not** keep this thread. They get a separate **operations channel** for that trip with operations staff only, plus the instructions operations chooses to issue and exception reporting (Part 1, 3.7). They cannot read or post in the thread with the shipper and carrier, and its history is hidden. Operations relays what the other parties need. A compromised account keeps nothing |
| Audit events | `message.sent`, `message.delivered`, `thread.closed`; staff reading a thread is recorded |
| Acceptance | AT-341 a user who is not a participant cannot read or subscribe to the thread. AT-342 a message sent twice by a retry appears once. AT-343 message text containing markup is shown as plain text. AT-344 a driver in restricted trip mode can exchange messages with operations only and cannot read or post in the trip thread or see its history |

## 8. Journey J7b: exceptions during a trip

| Aspect | Specification |
|---|---|
| Who reports | The driver (works offline); a dispatcher; the shipper; operations; the system (late running, long silence, wrong-site mismatch) |
| Types | Delay; breakdown; accident; cargo damage or shortage; refused or blocked at a site; receiver absent; document problem; road closed; safety concern; no-show; other |
| Fields | Trip; type; severity; description; time and position if available; photos; reporter |
| Handling | Operations acknowledges and owns it until resolved. Possible actions: inform the parties; record a revised arrival time; put the trip `on_hold`; propose a substitution (Part 2, 7.2); open an intervention case (Part 1, 3.7); record an overrun (Part 2, 7.3); hand to the dispute process (Part 4) |
| Emergencies | The app shows the country's emergency number and tells the driver to call it directly. Trucker does not dispatch emergency services. An urgent-help feature that alerts other drivers (C-14) awaits your decision |
| Severity and time targets | Which types are urgent and the time allowed to acknowledge are operating parameters; what operations **may** do for each type is an approved rule (R-302) |
| Failure paths | Report made offline and delivered late (shown with both times); duplicate reports for one event (merged by operations, both kept); reporter loses access (report stays) |
| Notifications | Operations queue at once; the operating controller and shipper according to type; the driver when it is acknowledged and when instructions are issued |
| Audit events | `exception.reported`, `exception.acknowledged`, `exception.action_recorded`, `exception.escalated`, `exception.resolved` |
| Acceptance | AT-351 an exception reported offline reaches operations after reconnecting with its original time. AT-352 every action taken on an exception records who, when and why. AT-353 an overrun that collides with the resource's next booking marks that booking at risk, blocks its dispatch and notifies its parties. |

## 9. Approved rules and operating parameters in this part

A setting holds a value inside an approved rule; it does not replace the rule.

**A. Approved rules required (your decision, review where noted, and tests)**

| ID | Rule |
|---|---|
| R-301 | Who authorises dispatch: the operating controller alone, or with Trucker operations approval for all or for defined cases. Depends on D-001 and the verification and dispatch responsibilities in Stage 1 |
| R-302 | What operations may do for each exception type and each intervention cause (safety and legal review) |
| R-303 | Whether a driver without location consent may be dispatched, and what replaces tracking (legal review) |
| R-304 | What the shipper sees: live position or milestones with estimated arrival |
| R-305 | Retention of positions, messages and photos (legal review) |
| R-306 | How the no-interaction-while-driving requirement is enforced (safety review) |
| C-10, C-13, C-14, C-21 | Carry-over items awaiting your decision: mandatory fixed GPS device, driver-to-driver chat, urgent help, receiver tracking link |

**B. Operating parameters (within the rules, changed with history)**

Acknowledgement deadline; earliest dispatch time before pick-up; position sampling interval; stale-position threshold; wrong-site distance tolerance; clock tolerance; authorisation time limit; sequence-gap holding time; duplicate-milestone time tolerance; late-running and silence thresholds; exception time targets.

## 10. Where D-001, D-002 and D-003 change this part

Illustrative only; the final rules follow the approved contracts and professional review.

| Decision | Effect |
|---|---|
| **D-001 Commercial model** | Decides who is answerable to the shipper for performance and therefore who holds dispatch authority (R-301), who instructs the driver in an exception, and whose staff the shipper talks to. Under an agent arrangement the carrier or owner typically runs the trip with Trucker overseeing; under a principal arrangement Trucker operations would typically direct it. The milestone, offline and tracking mechanics do not change |
| **D-002 Payment approach** | A prepayment or deposit approach could add "payment condition met" to the dispatch preconditions. Not designed |
| **D-003 Geography** | Cross-border lanes add an exit and entry milestone pair for every border on the route, including transit borders; document checks at dispatch for each country crossed; longer offline periods; and more than one emergency number and named time zone. Dispatch is refused if a transit country on the lane is no longer transit-ready |

## 11. Requirements and traceability

| Requirement | Summary | Carry-over items | Tests |
|---|---|---|---|
| REQ-ASG-01 | Assignment with driver acknowledgement | — | AT-302, AT-303 |
| REQ-DSP-01 | Dispatch authorisation gate with server-side preconditions, invalidation, re-check at start and occupancy block | C-10 (awaiting decision), C-11 | AT-301, AT-304 to AT-310 |
| REQ-TRP-01 | Server-authoritative trip states and milestones | C-17 (automatic detection, deferred) | AT-311 to AT-313 |
| REQ-TRP-02 | Arrival and departure evidence for waiting time | C-22 | AT-314 |
| REQ-OFF-01 | Durable offline queue, permanent event identity, streams per assignment and device, flagged times, controlled reconciliation | — | AT-321 to AT-330 |
| REQ-LOC-01 | Consented, trip-limited location with freshness and access limits | C-33, C-21 (awaiting decision), C-31 and C-32 (awaiting decision, nothing collected) | AT-331 to AT-339, AT-354 |
| REQ-MSG-01 | Participant-only trip messaging; operations-only channel in restricted trip mode | C-12; C-13 and C-20 not designed | AT-341 to AT-344 |
| REQ-EXC-01 | Exception reporting and recorded operations handling | C-14 (awaiting decision), C-19 (deferred) | AT-351 to AT-353 |

The 39-item carry-over register in the Stage 1 baseline is unchanged.

## 12. What can proceed and what waits

| Work | Status |
|---|---|
| Foundation-only setup: repository structure, configuration, database connectivity, CI | Can proceed now; it waits for no decision |
| Sign-in, organisations, verification | Constrained by group A in Part 2, section 12 |
| Milestone, offline queue and messaging mechanics | Can be specified in detail now; they hold under either commercial model |
| Booking implementation | Waits for D-001 and the approved rules in Part 2, section 10 A |
| Dispatch authority and exception powers | Wait for R-301 and R-302 |
| Location collection | Waits for R-303 to R-305 and legal review |
