// Mail channel selection (S5-D26), shared by the local server, the worker and scripts.
//   MAIL_CHANNEL=gmail      real Gmail (test-mode OAuth), every send redirected to GMAIL_TEST_INBOX; needs the OAuth client + both addresses
//   MAIL_CHANNEL=simulated  the labelled test double (keyless local runs and browser scenarios)
//   unset                   gmail when its settings exist, otherwise no channel: messages wait as drafts (never faked)
import type { Store } from '../store/port.ts';
import type { Vault } from '../vault.ts';
import type { Deps } from '../../deps.ts';
import { GmailChannel } from './gmail.ts';
import { SimulatedMailbox } from './simulated.ts';

import { gmailEnv, SIMULATED_ADDRESS } from './config.ts';
export { SIMULATED_ADDRESS };

export function mailFromEnv(store: Store, vault: Vault | undefined, now: () => string, env: NodeJS.ProcessEnv = process.env): Deps['mail'] {
  const want = (env.MAIL_CHANNEL ?? '').toLowerCase();
  const g = gmailEnv(env);
  const gmailReady = !!(g.clientId && g.clientSecret && g.sender && g.inbox && vault);
  if (want === 'simulated') return { channel: new SimulatedMailbox(store, SIMULATED_ADDRESS, now), address: SIMULATED_ADDRESS, redirectTo: null };
  if (want === 'gmail' && !gmailReady) throw new Error('MAIL_CHANNEL=gmail needs google_oauth_client_id, google_oauth_client_secret, gmail_test_recipient (and a vault)');
  if (!gmailReady) return undefined;
  return { channel: new GmailChannel({ store, vault: vault!, sender: g.sender!, clientId: g.clientId!, clientSecret: g.clientSecret!, now }), address: g.sender!, redirectTo: g.inbox! };
}
