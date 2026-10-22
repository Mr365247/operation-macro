// Invite-only mode. When true, the app asks for an email + invite code (checked against
// invites.json, managed with scripts/invite.mjs) before anything else.
window.OPMACRO_CONFIG = {
  inviteOnly: true,
  // Free key from api.data.gov/signup for USDA barcode lookups (blank = shared demo key, ~30 lookups/hour).
  // Not a secret: it only allows free food lookups and isn't tied to any payment.
  usdaKey: 'wGJnfbGNwhdrtfMKLhbdDkgNJkNN8WfMLdbCkdPf',
};
