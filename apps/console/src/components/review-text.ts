// Wording shared by the verification pages of the console.
export const APPLICATION_STATUS: Record<string, string> = {
  submitted: 'Waiting for review',
  claim_review: 'Competing claim: waiting for an administrator-reviewer',
  withdrawn: 'Withdrawn by the applicant',
  verified: 'Verified',
  changes_requested: 'Changes requested',
  rejected: 'Rejected',
};
export const ORGANISATION_STATUS: Record<string, string> = {
  draft: 'Draft',
  submitted: 'Under review',
  changes_requested: 'Changes requested',
  rejected: 'Rejected',
  verified: 'Verified on demonstration evidence',
  verification_withdrawn: 'Verification withdrawn',
};
export const REASONS: Record<string, string> = {
  evidence_accepted: 'Evidence entries accepted',
  details_incomplete: 'Details incomplete',
  evidence_unclear: 'Evidence entries unclear',
  evidence_mismatch: 'Evidence entries do not match the details',
  not_eligible: 'Not eligible',
  evidence_not_accepted: 'Evidence entries not accepted',
  claim_not_upheld: 'Claim to the registration not upheld',
  verified_in_error: 'Verified in error',
  information_changed: 'Information changed',
  other: 'Other (a note is required)',
};
/** The decisions a reviewer can record, each with the reasons that belong to it. */
export const DECISIONS: [string, string, string[]][] = [
  ['verified', 'Verify', ['evidence_accepted']],
  [
    'changes_requested',
    'Request changes',
    ['details_incomplete', 'evidence_unclear', 'evidence_mismatch', 'other'],
  ],
  ['rejected', 'Reject', ['not_eligible', 'evidence_not_accepted', 'claim_not_upheld', 'other']],
];
export const REVIEW_ERRORS: Record<string, string> = {
  staff_privilege_required:
    'Your account does not hold the privilege this needs. The attempt was recorded.',
  link_not_declared:
    'It is not recorded whether you have a participant account. Until an administrator records your declaration you cannot decide. Nothing was changed.',
  connected:
    'Your declared participant account is connected with this organisation, so you cannot decide about it. Nothing was changed.',
  conflict_not_declared:
    'Tick the declaration that you have no connection with this organisation. Nothing was changed.',
  different_person_required:
    'A different staff member must do this: not the one who raised the claim or gave the verification. Nothing was changed.',
  application_changed:
    'The application changed after this page was loaded. Nothing was recorded. The current state is shown.',
  application_not_open: 'This application is no longer open. The current state is shown.',
  organisation_not_verified: 'That organisation is not verified, so there is nothing to withdraw.',
  validation_failed: 'Choose a reason that belongs to the decision. “Other” needs a note.',
  decision_missing: 'Choose a decision and its reason.',
  not_found: 'That was not found.',
  unconfirmed:
    'It was not confirmed that this was recorded. It may have been. The current state is shown. Recording the same decision again changes nothing twice.',
  refused: 'That was refused.',
};
