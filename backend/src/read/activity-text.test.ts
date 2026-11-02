// UX audit F08: Activity never shows raw event names, grant ids, ISO times or bare cents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventLabel, readableText } from './models.ts';

test('F08 activity text is readable', () => {
  const tz = 'America/New_York';
  assert.equal(eventLabel('PayoutPaid'), 'Supplier paid');
  assert.equal(eventLabel('SomethingNewHappened'), 'Something new happened');
  assert.equal(readableText('Your permission rev1-68c356df#1#rev1-68c356df-a5#PAYOUT_AUTHORITY + rev1-68c356df#1#rev1-68c356df-a5#PAYOUT_EXCEPTION', tz),
    'Your payout authority and your one-time exception to the payment limits');
  assert.equal(readableText('Bank read: 2 accounts; checking available 633000, 180000', tz), 'Bank read: 2 accounts; checking available $6,330.00 and $1,800.00');
  assert.equal(readableText('PayPal reported available 606250 as of 2026-11-13T16:00:00.000Z (COMPLETE)', tz), 'PayPal reported available $6,062.50 as of Fri, Nov 13, 11:00 AM (COMPLETE)');
  assert.equal(readableText('lowest $4,442.50 on 2026-12-20', tz), 'lowest $4,442.50 on Sun, Dec 20');
});
