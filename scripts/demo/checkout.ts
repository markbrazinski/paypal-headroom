// npm run demo:checkout -- --stage local --invoice HR-xxxxxx-001
// Prints the PayPal payer link. A human pays it on PayPal's hosted page; browser automation is never proof.
import { arg, LOCAL } from './operator-client.ts';

const stage = arg('--stage');
const number = arg('--invoice');
if (stage !== 'local' || !number) { console.error('usage: npm run demo:checkout -- --stage local --invoice <number> (dev: open the payer link from the invoice panel)'); process.exit(2); }
const list: any = await (await fetch(`${LOCAL}/v1/receivables`)).json();
const inv = list.invoices.find((i: any) => i.invoiceNumber === number);
if (!inv) { console.error(`No invoice ${number} in the active run`); process.exit(1); }
const d: any = await (await fetch(`${LOCAL}/v1/invoices/${inv.invoiceId}`)).json();
console.log(d.payerUrl ?? `Invoice ${number} has no payer link yet (state ${d.invoice.state})`);
