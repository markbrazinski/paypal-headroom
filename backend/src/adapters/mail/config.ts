// The secret-free mail descriptor (S5-D26). No adapter imports: the API composition uses it to say what the channel is,
// and never gains the ability to send.
export const SIMULATED_ADDRESS = 'headroom@headroom.example';

/**
 * Gmail settings from the environment. QLOO-style lowercase names are accepted (google_oauth_client_id, google_oauth_client_secret,
 * gmail_test_recipient, gmail_test_sender). The sender defaults to the test inbox: the owner's Gmail sending to itself.
 */
export function gmailEnv(env: NodeJS.ProcessEnv = process.env) {
  const v = (...k: string[]) => k.map((x) => env[x]).find((x) => x && x.trim())?.trim();
  const inbox = v('GMAIL_TEST_INBOX', 'gmail_test_recipient');
  return { clientId: v('GOOGLE_OAUTH_CLIENT_ID', 'google_oauth_client_id'), clientSecret: v('GOOGLE_OAUTH_CLIENT_SECRET', 'google_oauth_client_secret'), inbox, sender: v('GMAIL_TEST_SENDER', 'gmail_test_sender') ?? inbox };
}

/** The secret-free descriptor every composition (API included) puts in Config, so screens can say what the channel is. */
export function mailConfig(env: NodeJS.ProcessEnv = process.env): NonNullable<import('../../deps.ts').Config['mail']> {
  if ((env.MAIL_CHANNEL ?? '').toLowerCase() === 'simulated') return { kind: 'SIMULATED', sender: SIMULATED_ADDRESS, inbox: null };
  const g = gmailEnv(env);
  return g.clientId && g.clientSecret && g.inbox ? { kind: 'GMAIL', sender: g.sender!, inbox: g.inbox } : { kind: 'NONE', sender: null, inbox: null };
}
