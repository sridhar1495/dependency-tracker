// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Image inspection ─────────────────────────────────────────────────────────
// Format and dimensions read from the file's own bytes. Pure: no I/O, no
// dependency (CLAUDE.md §3 allows no fourth npm package, and none is needed —
// every header below is a fixed-offset read).
//
// S32: the declared Content-Type is never trusted. A caller can put anything in
// a header, so the format is decided by the magic bytes and the response later
// serves back that sniffed type, not the claimed one.
//
// SVG is rejected by omission and that is deliberate: it is XML, it can carry
// <script>, and this image is served from our own origin to unauthenticated
// visitors on the sign-in page. There is no safe way to serve user-supplied SVG
// from the same origin as the session it protects.

const MAX_BYTES  = 5 * 1024 * 1024;   // 5 MB
const MIN_WIDTH  = 1280;
const MIN_HEIGHT = 720;
const MAX_WIDTH  = 5000;
const MAX_HEIGHT = 5000;

const ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp'];

/** Human-readable byte size for error messages. */
function humanSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

/**
 * The format a buffer actually is, from its leading bytes.
 * @returns {string|null} an allowed MIME type, or null when unrecognised
 */
function sniff(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  // WebP: "RIFF" .... "WEBP"
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

/** PNG: IHDR is always the first chunk, so width/height sit at fixed offsets. */
function pngSize(buf) {
  if (buf.length < 24) return null;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * JPEG: walk the segment chain to the start-of-frame marker, which is the only
 * place the dimensions appear. Segment lengths are big-endian and include their
 * own two bytes.
 */
function jpegSize(buf) {
  let off = 2;                                   // past SOI
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xff) { off++; continue; }  // resync on padding
    const marker = buf[off + 1];
    // Standalone markers carry no length payload.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      off += 2;
      continue;
    }
    const len = buf.readUInt16BE(off + 2);
    if (len < 2) return null;
    // SOF0..SOF15, excluding the non-frame markers that share the range.
    const isFrame = marker >= 0xc0 && marker <= 0xcf &&
                    marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (off + 9 > buf.length) return null;
      return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
    }
    off += 2 + len;
  }
  return null;
}

/** WebP: three container variants, each with the canvas size in a different place. */
function webpSize(buf) {
  if (buf.length < 30) return null;
  const chunk = buf.toString('ascii', 12, 16);

  if (chunk === 'VP8 ') {                        // lossy
    if (buf.length < 30 || buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {                        // lossless
    if (buf.length < 25 || buf[20] !== 0x2f) return null;
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {                        // extended
    if (buf.length < 30) return null;
    return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  }
  return null;
}

/** Dimensions for an already-sniffed buffer, or null when the header is unreadable. */
function dimensions(buf, mime) {
  if (mime === 'image/png')  return pngSize(buf);
  if (mime === 'image/jpeg') return jpegSize(buf);
  if (mime === 'image/webp') return webpSize(buf);
  return null;
}

/**
 * Validate an uploaded image and report what it is.
 *
 * There is no minimum file size: a small file that is a real image of an
 * acceptable resolution is fine, and byte count is a poor proxy for quality.
 * The resolution floor is what actually protects the page from a background
 * that renders blurred when stretched.
 *
 * @param {Buffer} buf
 * @returns {{ mimeType: string, width: number, height: number, byteSize: number }}
 * @throws {Error} code IMAGE_INVALID, with a message naming the specific problem
 */
function inspect(buf) {
  const fail = (msg) => { throw Object.assign(new Error(msg), { code: 'IMAGE_INVALID' }); };

  if (!Buffer.isBuffer(buf) || buf.length === 0) fail('No image was received.');
  if (buf.length > MAX_BYTES) {
    fail(`The image is ${humanSize(buf.length)}. The maximum is ${humanSize(MAX_BYTES)}.`);
  }

  const mimeType = sniff(buf);
  if (!mimeType) fail('That file is not a PNG, JPEG or WebP image. SVG is not accepted.');

  const size = dimensions(buf, mimeType);
  if (!size || !size.width || !size.height) {
    fail('The image could not be read — the file looks truncated or damaged.');
  }
  const { width, height } = size;

  if (width < MIN_WIDTH || height < MIN_HEIGHT) {
    fail(`The image is ${width}×${height}. The minimum is ${MIN_WIDTH}×${MIN_HEIGHT}, ` +
         'or it will look blurred stretched across the page.');
  }
  if (width > MAX_WIDTH || height > MAX_HEIGHT) {
    fail(`The image is ${width}×${height}. The maximum is ${MAX_WIDTH}×${MAX_HEIGHT}.`);
  }

  return { mimeType, width, height, byteSize: buf.length };
}

module.exports = {
  sniff, dimensions, inspect, humanSize,
  MAX_BYTES, MIN_WIDTH, MIN_HEIGHT, MAX_WIDTH, MAX_HEIGHT, ALLOWED_MIME,
};
