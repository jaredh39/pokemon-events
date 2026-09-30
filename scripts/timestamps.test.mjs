// Guards the one piece of logic that fails silently: the locator publishes
// tournament times as naive venue wall-clock with a fake Z, and play_session
// times as genuine UTC. Run with: node --test scripts/
import test from 'node:test';
import assert from 'node:assert/strict';
import { localStart } from './collect.mjs';

const LA = 'America/Los_Angeles';

test('tournament rows keep their wall-clock time', () => {
  // "6 PM in Milpitas" is published as 18:00:00Z.
  assert.equal(localStart('2026-09-29T18:00:00Z', 'tournament', LA), '2026-09-29T18:00:00');
});

test('tournament registration uses +00:00 for the same fake UTC', () => {
  assert.equal(localStart('2026-09-29T17:00:00+00:00', 'tournament', LA), '2026-09-29T17:00:00');
});

test('play_session rows convert from real UTC to venue local', () => {
  // 01:00Z on Sep 30 is 6 PM Pacific on Sep 29 -- league night, not 1 AM.
  assert.equal(localStart('2026-09-30T01:00:00Z', 'play_session', LA), '2026-09-29T18:00:00');
  assert.equal(localStart('2026-09-30T01:30:00Z', 'play_session', 'US/Pacific'), '2026-09-29T18:30:00');
});

test('play_session conversion honours standard time after the DST change', () => {
  // Pacific leaves DST on 2026-11-01, so the same UTC instant lands an hour earlier.
  assert.equal(localStart('2026-11-05T02:00:00Z', 'play_session', LA), '2026-11-04T18:00:00');
});

test('an unusable timezone degrades to naive rather than dropping the row', () => {
  assert.equal(localStart('2026-09-30T01:00:00Z', 'play_session', 'Not/AZone'), '2026-09-30T01:00:00');
  assert.equal(localStart('2026-09-30T01:00:00Z', 'play_session', ''), '2026-09-30T01:00:00');
});

test('empty input stays empty', () => {
  assert.equal(localStart('', 'tournament', LA), '');
  assert.equal(localStart(null, 'play_session', LA), '');
});
