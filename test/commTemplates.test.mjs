// test/commTemplates.test.mjs — the Communications renderer (#61). Pure; no database.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMM_TAGS, COMM_TEMPLATES, templatesFor, normalizeVars, fillTags, unknownTags,
  renderMessage, parseManualEmails, COMM_MANUAL_EMAIL_LIMIT, COMM_PREVIEW_VARS,
  renderPreviewDocument, subjectHasPaymentTag,
} from '../src/lib/commTemplates.js';

test('a subject never carries payment details', () => {
  assert.equal(subjectHasPaymentTag('Pay via {{ payment_instructions }}'), true);
  assert.equal(subjectHasPaymentTag('Hello {{first_name}}'), false);
  const { subject } = renderMessage({ subject: 'Details: {{payment_instructions}}', body: 'x', vars: { payment_instructions: 'Bank: test-value' } });
  assert.equal(subject, 'Details:', 'the tag fills with nothing in a subject');
});

test('the preview document escapes the subject and the brand, and carries no script', () => {
  const doc = renderPreviewDocument({
    subject: '<script>alert(1)</script> {{name}}', body: 'Hi {{name}}',
    vars: { name: '"><img src=x onerror=alert(2)>' }, brand: '<b>Brand</b>',
  });
  assert.ok(!/<script/i.test(doc), 'no script element may reach the preview');
  assert.ok(!doc.includes('<img'), 'a tag value must stay text in the preview');
  assert.ok(doc.includes('&lt;b&gt;Brand&lt;/b&gt;'));
  assert.ok(doc.startsWith('<!doctype html>'));
});

test('every template uses only known tags and has a unique key', () => {
  const keys = COMM_TEMPLATES.map((t) => t.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const t of COMM_TEMPLATES) {
    assert.deepEqual(unknownTags(`${t.subject} ${t.body}`), [], `${t.key} uses a tag the renderer cannot fill`);
  }
});

test('each kind offers its own templates plus a blank one', () => {
  assert.ok(templatesFor('student_email').some((t) => t.key === 'missing_proof'));
  assert.ok(templatesFor('payment_reminder').some((t) => t.key === 'payment_reminder'));
  assert.ok(!templatesFor('student_email').some((t) => t.key === 'payment_reminder'));
  for (const kind of ['announcement', 'student_email', 'payment_reminder', 'automation']) {
    assert.ok(templatesFor(kind).some((t) => t.key === 'custom'), `${kind} has no blank template`);
  }
});

test('a missing name reads "there", never undefined', () => {
  assert.equal(fillTags('Hi {{first_name}}', {}), 'Hi there');
  assert.equal(fillTags('Hi {{first_name}}', { name: 'Maria Santos' }), 'Hi Maria');
  assert.equal(normalizeVars({ days: 0 }).days, '0', 'zero days left is a real value');
});

test('an unknown tag stays visible so a typo shows in the preview', () => {
  assert.equal(fillTags('Hello {{nmae}}', { name: 'A' }), 'Hello {{nmae}}');
  assert.deepEqual(unknownTags('{{nmae}} {{plan}} {{nmae}}'), ['nmae']);
});

test('tag values are escaped in HTML, and only https is linked', () => {
  const { bodyHtml, text } = renderMessage({
    subject: 'Hi', body: 'Hello {{name}}\n\nSee https://example.com/path. Not javascript:alert(1) or http://plain.test',
    vars: { name: '<img src=x onerror=alert(1)>' },
  });
  assert.ok(!bodyHtml.includes('<img'), 'a tag value must never become markup');
  assert.ok(bodyHtml.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(bodyHtml.includes('<a href="https://example.com/path"'), 'an https URL is linked');
  assert.ok(!/href="https:\/\/example\.com\/path\."/.test(bodyHtml), 'trailing punctuation is not part of the link');
  assert.ok(!bodyHtml.includes('href="javascript'), 'javascript: is never linked');
  assert.ok(!bodyHtml.includes('href="http://plain.test'), 'plain http is not linked');
  assert.ok(text.includes('<img src=x onerror=alert(1)>'), 'the plain-text part carries the raw text, which is not HTML');
});

test('a URL carrying & or a quote cannot break out of its href', () => {
  const { bodyHtml } = renderMessage({ subject: 's', body: 'Open https://x.test/a?b=1&c="2" now', vars: {} });
  assert.ok(bodyHtml.includes('href="https://x.test/a?b=1&amp;c="'), 'the & is escaped and the URL stops at the quote');
  assert.ok(!/href="[^"]*"[^ >]*"/.test(bodyHtml.replace(/style="[^"]*"/g, '')), 'no attribute is broken open');
});

test('payment instructions inside a sentence are filled as escaped text', () => {
  const { bodyHtml, text } = renderMessage({ subject: 's', body: 'Pay via {{payment_instructions}} today', vars: { payment_instructions: '<b>BPI</b>' } });
  assert.ok(bodyHtml.includes('Pay via &lt;b&gt;BPI&lt;/b&gt; today'));
  assert.ok(text.includes('Pay via <b>BPI</b> today'));
});

test('a mis-cased tag is flagged, never silently dropped', () => {
  assert.deepEqual(unknownTags('Hi {{First_Name}} and {{first_name}}'), ['First_Name']);
  assert.equal(fillTags('Hi {{First_Name}}', { name: 'Ana Cruz' }), 'Hi {{First_Name}}');
});

test('the subject is one line and capped', () => {
  const { subject } = renderMessage({ subject: 'Line one\nLine two {{name}}', body: 'x', vars: { name: 'A' } });
  assert.equal(subject, 'Line one Line two A');
  assert.ok(renderMessage({ subject: 'x'.repeat(500), body: 'x' }).subject.length <= 200);
});

test('payment instructions render as their own block, and vanish when empty', () => {
  const body = 'Pay here:\n\n{{payment_instructions}}\n\nThanks';
  const withPay = renderMessage({ subject: 's', body, vars: { payment_instructions: 'Account: A\nGCash: B' } });
  assert.ok(withPay.bodyHtml.includes('Account: A<br>GCash: B'));
  assert.ok(withPay.text.includes('Account: A\nGCash: B'));
  const without = renderMessage({ subject: 's', body, vars: {} });
  assert.ok(!without.bodyHtml.includes('border:1px solid'), 'no empty payment box');
});

test('the preview never carries real payment values', () => {
  assert.match(COMM_PREVIEW_VARS.payment_instructions, /^\[.*\]$/);
});

test('a pasted address list is cleaned, deduplicated and capped', () => {
  const r = parseManualEmails('A@x.com, a@x.com; b@y.org\nnot-an-email  c@z.io');
  assert.deepEqual(r.emails, ['a@x.com', 'b@y.org', 'c@z.io']);
  assert.deepEqual(r.invalid, ['not-an-email']);
  assert.equal(r.overLimit, false);
  const many = Array.from({ length: COMM_MANUAL_EMAIL_LIMIT + 5 }, (_, i) => `u${i}@x.com`).join(' ');
  const capped = parseManualEmails(many);
  assert.equal(capped.emails.length, COMM_MANUAL_EMAIL_LIMIT);
  assert.equal(capped.overLimit, true);
});

test('the tag list is the documented one', () => {
  assert.deepEqual([...COMM_TAGS].sort(), ['amount_due', 'batch', 'days', 'expiry', 'first_name', 'name', 'payment_instructions', 'plan', 'week']);
});
