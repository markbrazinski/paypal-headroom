// RFC 5322 build/parse for the mail port. Built bytes are what the channel sends; parsed messages feed the sender and reply gates.
// ponytail: no MIME library. Multipart limited to text/plain + PDF attachments (nested multipart is walked, other parts ignored),
// text assumed UTF-8, no RFC 2047 encoded words, 8bit body lines assumed < 998 octets. Upgrade when Gmail brings richer mail.
import { createHash } from 'node:crypto';

export const b64url = {
  encode: (x: string | Buffer) => (typeof x === 'string' ? Buffer.from(x, 'utf8') : x).toString('base64url'),
  decode: (s: string) => Buffer.from(s, 'base64url'),
};

export interface Attachment { name: string; mime: string; bytes: Buffer }

export interface OutMessage {
  from: string;
  to: string[];
  subject: string;
  text: string;
  /** With angle brackets, e.g. `<send.ROOT.3@headroom>`. */
  messageId: string;
  inReplyTo?: string | null;
  references?: string[];
  /** ISO instant. */
  date: string;
  attachments?: (Attachment & { mime: 'application/pdf' })[];
}

export interface ParsedMessage {
  /** Every From header value, raw. More than one is itself a red flag (sender gate). */
  from: string[];
  /** addr-spec of every mailbox in every From header, lowercased. */
  fromAddresses: string[];
  to: string[];
  subject: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  /** ISO instant, null when absent or unparseable. */
  date: string | null;
  text: string;
  attachments: Attachment[];
}

const CRLF = '\r\n';
const header = (name: string, v: string) => {
  if (/[\r\n]/.test(v)) throw new Error(`header ${name} contains a line break`);
  return `${name}: ${v}`;
};
const wrap = (b: Buffer) => b.toString('base64').replace(/.{76}(?=.)/g, `$&${CRLF}`);
const TEXT_HEADERS = `Content-Type: text/plain; charset=utf-8${CRLF}Content-Transfer-Encoding: 8bit`;

export function buildMessage(m: OutMessage): string {
  const d = new Date(m.date);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid date ${m.date}`);
  const h = [
    header('From', m.from),
    header('To', m.to.join(', ')),
    header('Subject', m.subject),
    header('Date', d.toUTCString().replace('GMT', '+0000')),
    header('Message-ID', m.messageId),
  ];
  if (m.inReplyTo) h.push(header('In-Reply-To', m.inReplyTo));
  if (m.references?.length) h.push(header('References', m.references.join(' ')).replace(/> </g, `>${CRLF} <`)); // folded
  h.push('MIME-Version: 1.0');
  const text = m.text.replace(/\r?\n/g, CRLF);
  if (!m.attachments?.length) return [...h, TEXT_HEADERS, '', text].join(CRLF);
  // Deterministic boundary: the same message always builds the same bytes.
  const b = `hr-${createHash('sha256').update(m.messageId).digest('hex').slice(0, 24)}`;
  const parts = [
    `${TEXT_HEADERS}${CRLF}${CRLF}${text}`,
    ...m.attachments.map((a) => {
      const n = a.name.replace(/["\\\r\n]/g, '_');
      return [`Content-Type: ${a.mime}; name="${n}"`, `Content-Disposition: attachment; filename="${n}"`, 'Content-Transfer-Encoding: base64', '', wrap(a.bytes)].join(CRLF);
    }),
  ];
  return [...h, `Content-Type: multipart/mixed; boundary="${b}"`, '', ...parts.map((p) => `--${b}${CRLF}${p}`), `--${b}--`, ''].join(CRLF);
}

type Entity = { headers: [string, string][]; body: string };

/** Headers (unfolded, names lowercased) and body of an entity whose lines end in \n. */
function entity(s: string): Entity {
  const i = s.indexOf('\n\n');
  const head = i < 0 ? s : s.slice(0, i);
  const headers: [string, string][] = [];
  for (const line of head.split('\n')) {
    if (/^[ \t]/.test(line) && headers.length) headers[headers.length - 1][1] += line;
    else {
      const c = line.indexOf(':');
      if (c > 0) headers.push([line.slice(0, c).trim().toLowerCase(), line.slice(c + 1)]);
    }
  }
  return { headers: headers.map(([k, v]) => [k, v.trim()]), body: i < 0 ? '' : s.slice(i + 2) };
}
const all = (e: Entity, name: string) => e.headers.filter(([k]) => k === name).map(([, v]) => v);
const one = (e: Entity, name: string) => all(e, name)[0] ?? null;
const param = (v: string, name: string) => {
  const m = new RegExp(`;\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i').exec(v);
  return m ? (m[1] ?? m[2]) : null;
};

/** addr-specs in an address-list header. Quoted display names and comments are dropped first, so a name that looks like an address never counts. */
function addresses(v: string): string[] {
  const s = v.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\([^()]*\)/g, '');
  return s.split(',').flatMap((p) => {
    const angles = [...p.matchAll(/<([^<>]*)>/g)].map((m) => m[1].trim());
    return angles.length ? angles : [p.trim()];
  }).filter(Boolean);
}

function decode(body: string, cte: string | null): Buffer {
  const enc = (cte ?? '').toLowerCase();
  if (enc === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64');
  if (enc === 'quoted-printable') return Buffer.from(body.replace(/=\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
  return Buffer.from(body, 'utf8');
}

function walk(e: Entity, out: { text: string | null; attachments: Attachment[] }) {
  const ct = one(e, 'content-type') ?? 'text/plain';
  const type = ct.split(';')[0].trim().toLowerCase();
  if (type.startsWith('multipart/')) {
    const b = param(ct, 'boundary');
    if (!b) return;
    for (const chunk of `\n${e.body}`.split(`\n--${b}`).slice(1)) {
      if (chunk.startsWith('--')) break;
      walk(entity(chunk.slice(chunk.indexOf('\n') + 1)), out);
    }
    return;
  }
  const disp = one(e, 'content-disposition') ?? '';
  const bytes = decode(e.body, one(e, 'content-transfer-encoding'));
  const name = param(disp, 'filename') ?? param(ct, 'name');
  if (type === 'text/plain' && !/^attachment/i.test(disp) && out.text === null) out.text = bytes.toString('utf8');
  else if (name) out.attachments.push({ name, mime: type, bytes });
}

export function parseMessage(raw: string): ParsedMessage {
  const top = entity(raw.replace(/\r\n/g, '\n'));
  const out = { text: null as string | null, attachments: [] as Attachment[] };
  walk(top, out);
  const from = all(top, 'from');
  const date = one(top, 'date');
  const d = date === null ? null : new Date(date);
  const irt = one(top, 'in-reply-to');
  return {
    from,
    fromAddresses: from.flatMap(addresses).map((a) => a.toLowerCase()),
    to: all(top, 'to').flatMap(addresses),
    subject: one(top, 'subject') ?? '',
    messageId: one(top, 'message-id'),
    inReplyTo: irt === null ? null : (/<[^<>]*>/.exec(irt)?.[0] ?? irt),
    references: all(top, 'references').flatMap((v) => v.match(/<[^<>]*>/g) ?? []),
    date: d && !Number.isNaN(d.getTime()) ? d.toISOString() : null,
    text: out.text ?? '',
    attachments: out.attachments,
  };
}
