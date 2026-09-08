// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── SMTP stub ─────────────────────────────────────────────────────────────────
// Speaks enough SMTP for nodemailer, and records the ENVELOPE rather than the
// object the application built.
//
// That distinction is the whole point of this stub. Asserting on the options
// passed to sendMail proves the code assembled a recipient list; asserting on
// `RCPT TO` proves the message is actually addressed to those people. The
// per-schedule recipient overrides (CLAUDE.md §6.8) are only meaningfully
// tested at this level — "copy nobody" means no CC command reaches the wire.
//
// AUTH LOGIN is implemented because nodemailer negotiates it whenever a
// username is configured, and a stub that ignores it hangs the send.

const net = require('net');

async function start(opts = {}) {
  /** @type {Array<{from: string, to: string[], data: string}>} */
  let messages = [];

  const server = net.createServer((sock) => {
    let buffer = '';
    let mode = null;
    let current = { from: '', to: [], data: '' };

    sock.write('220 e2e-smtp ESMTP\r\n');

    sock.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let i;
      while ((i = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);

        if (mode === 'data') {
          if (line === '.') {
            mode = null;
            messages.push(current);
            current = { from: '', to: [], data: '' };
            sock.write('250 2.0.0 Ok\r\n');
          } else {
            // Dot-stuffing: a line starting '..' is a literal '.' line.
            current.data += (line.startsWith('..') ? line.slice(1) : line) + '\n';
          }
          continue;
        }
        // AUTH LOGIN is a two-step base64 exchange; neither value is checked.
        if (mode === 'auth-user') { mode = 'auth-pass'; sock.write('334 UGFzc3dvcmQ6\r\n'); continue; }
        if (mode === 'auth-pass') { mode = null; sock.write('235 2.7.0 Accepted\r\n'); continue; }

        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          sock.write('250-e2e-smtp\r\n250-AUTH LOGIN PLAIN\r\n250-8BITMIME\r\n250 SIZE 52428800\r\n');
        } else if (upper.startsWith('AUTH LOGIN')) {
          mode = 'auth-user'; sock.write('334 VXNlcm5hbWU6\r\n');
        } else if (upper.startsWith('AUTH')) {
          sock.write('235 2.7.0 Accepted\r\n');
        } else if (upper.startsWith('MAIL FROM')) {
          current.from = line.replace(/^MAIL FROM:\s*/i, '').replace(/[<>]/g, '').split(' ')[0];
          sock.write('250 2.1.0 Ok\r\n');
        } else if (upper.startsWith('RCPT TO')) {
          current.to.push(line.replace(/^RCPT TO:\s*/i, '').replace(/[<>]/g, '').split(' ')[0]);
          sock.write('250 2.1.5 Ok\r\n');
        } else if (upper === 'DATA') {
          mode = 'data'; sock.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (upper === 'RSET') {
          current = { from: '', to: [], data: '' }; sock.write('250 2.0.0 Ok\r\n');
        } else if (upper === 'QUIT') {
          sock.write('221 2.0.0 Bye\r\n'); sock.end();
        } else {
          sock.write('250 2.0.0 Ok\r\n');
        }
      }
    });
    // A client that disappears mid-conversation is not this stub's problem.
    sock.on('error', () => {});
  });

  await new Promise((resolve) => server.listen(opts.port || 0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    port,
    host: '127.0.0.1',
    /** Everything delivered so far, envelope and body. */
    messages: () => messages.map(m => ({ ...m, to: [...m.to] })),
    reset: () => { messages = []; },
    /**
     * Wait for a message addressed to `marker`.
     *
     * Matching on a recipient rather than on arrival order is deliberate: a
     * scheduled run queues behind the account's claim, so messages can land
     * well after the call that triggered them and out of order with earlier
     * runs. Indexing into the list is how a test ends up asserting against
     * somebody else's mail.
     */
    waitFor: async (marker, timeoutMs = 60000) => {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        const hit = messages.find(m => m.to.join(',').includes(marker));
        if (hit) return { ...hit, to: [...hit.to] };
        await new Promise(r => setTimeout(r, 250));
      }
      return null;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = { start };
