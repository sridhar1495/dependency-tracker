// SPDX-License-Identifier: MIT
// Copyright (c) 2024 Dependency-Track Risk Dashboard contributors
'use strict';

// ── Concurrency primitives ────────────────────────────────────────────────────
// makeSemaphore is the single concurrency-limiting primitive in the codebase.
// Use it whenever spawning multiple async tasks against the external DT API
// (CLAUDE.md §6.4) — unbounded fan-out is what makes an upstream fall over.

/** Resolve after `ms` milliseconds. */
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Limit how many wrapped functions run at once.
 *
 *   const sem = makeSemaphore(5);
 *   await sem(() => doWork());
 *
 * @param {number} limit  maximum concurrent tasks
 * @returns {(fn: Function) => Promise<any>}
 */
function makeSemaphore(limit) {
  let active = 0;
  const queue = [];
  return function acquire(fn) {
    return new Promise((resolve, reject) => {
      const run = () => {
        active++;
        Promise.resolve().then(fn).then(
          v => { active--; if (queue.length) queue.shift()(); resolve(v); },
          e => { active--; if (queue.length) queue.shift()(); reject(e); }
        );
      };
      if (active < limit) run();
      else queue.push(run);
    });
  };
}

module.exports = { sleep, makeSemaphore };
