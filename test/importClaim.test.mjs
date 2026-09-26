// test/importClaim.test.mjs — the migrated-student claim link (#67).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLAIM_LINK_TTL_HOURS, CLAIM_TOKEN_TYPES, IMPORT_CLAIM_PATH, buildClaimUrl, buildSignInUrl, parseClaimHash,
} from '../src/lib/importClaim.js';
import { INVITE_LINK_TTL_HOURS, STAFF_INVITE_PATH, parseInviteHash } from '../src/lib/staffInvite.js';

test('build → parse round-trips, with the token in the fragment', () => {
  const url = buildClaimUrl({ appUrl: 'https://toolkits.example.test/', tokenHash: 'abc123/+=', type: 'magiclink' });
  assert.equal(url, 'https://toolkits.example.test/activate-account#claim=abc123%2F%2B%3D&t=magiclink');
  const u = new URL(url);
  assert.equal(u.search, '', 'never in the query — a query string reaches server logs and Referer headers');
  assert.deepEqual(parseClaimHash(u.hash), { token: 'abc123/+=', type: 'magiclink' });
});

test('only magiclink is minted or accepted', () => {
  assert.deepEqual([...CLAIM_TOKEN_TYPES], ['magiclink']);
  assert.equal(buildClaimUrl({ appUrl: 'https://a.test', tokenHash: 'x', type: 'recovery' }), null);
  assert.equal(parseClaimHash('#claim=x&t=recovery'), null, 'a crafted type cannot steer the exchange');
  assert.equal(parseClaimHash('#claim=x&t=invite'), null);
  assert.equal(parseClaimHash('#claim=&t=magiclink'), null);
});

test('a staff invitation and a student claim can never be read as each other', () => {
  assert.equal(parseClaimHash('#invite=tok&t=magiclink'), null);
  assert.equal(parseInviteHash('#claim=tok&t=magiclink'), null);
  assert.notEqual(IMPORT_CLAIM_PATH, STAFF_INVITE_PATH);
});

test('a missing or non-http origin builds nothing', () => {
  assert.equal(buildClaimUrl({ appUrl: '', tokenHash: 'x' }), null);
  assert.equal(buildClaimUrl({ appUrl: 'javascript:alert(1)', tokenHash: 'x' }), null);
  assert.equal(buildSignInUrl('ftp://a.test'), null);
  assert.equal(buildSignInUrl('https://a.test/'), 'https://a.test/');
});

test('the link lifetime mirrors the one Supabase setting both flows share', () => {
  assert.equal(CLAIM_LINK_TTL_HOURS, INVITE_LINK_TTL_HOURS);
});
