import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  applyWatchSnapshot,
  buildAutomintConfirmation,
  buildWatchSummary,
  createPriceInfo,
  createWatchRecord,
  formatNativeUsd,
  formatPriceStatus,
  parseTelegramText
} from '../controlShared.js';
import { buildResolutionMessage, loadStateFromFile, saveStateToFile } from '../scripts/control-server.mjs';

test('unknown mint is not shown as FREE', () => {
  const unknown = formatPriceStatus(createPriceInfo({ state: 'unknown', reason: 'no verified phase' }), {});
  const free = formatPriceStatus(createPriceInfo({ state: 'free', value: 0 }), {});
  assert.equal(unknown, 'unknown (no verified phase)');
  assert.equal(free, 'FREE');
});

test('mint and floor stay separate in summaries', () => {
  const watch = createWatchRecord({
    id: 'watch_test',
    input: 'https://www.tinyvalidators.xyz/mint',
    resolved: {
      name: 'Tiny Validators',
      contract: '0x1234567890123456789012345678901234567890',
      chain: 'ethereum',
      mintInfo: createPriceInfo({ state: 'known', value: 0.02, source: 'OpenSea drops', chain: 'ethereum' }),
      floorInfo: createPriceInfo({ state: 'known', value: 0.04, source: 'Reservoir floor ask', chain: 'ethereum' })
    }
  });
  const summary = buildWatchSummary(watch, { ethereum: { usdRate: 1735 } });
  assert.match(summary, /Mint price: 0\.02 ETH \(\$34\.70\)/);
  assert.match(summary, /Floor: 0\.04 ETH \(\$69\.40\)/);
});

test('USD formatting includes native and usd values', () => {
  assert.equal(formatNativeUsd(0.02, { symbol: 'ETH', usdRate: 1735 }), '0.02 ETH ($34.70)');
});

test('first valid floor becomes baseline and re-arms after falling below threshold', () => {
  let watch = createWatchRecord({
    id: 'watch_floor',
    input: 'https://www.tinyvalidators.xyz/mint',
    resolved: {
      name: 'Tiny Validators',
      contract: '0x1234567890123456789012345678901234567890',
      chain: 'ethereum'
    },
    options: { target: 2, basis: 'floor' }
  });

  let result = applyWatchSnapshot(watch, {
    floorInfo: createPriceInfo({ state: 'unknown', reason: 'No live floor ask yet', chain: 'ethereum' }),
    mintInfo: createPriceInfo({ state: 'unknown', reason: 'Unverified', chain: 'ethereum' })
  }, '2026-07-10T08:00:00.000Z');
  watch = result.watch;
  assert.equal(watch.status, 'waiting_baseline');
  assert.equal(watch.baselineValue, null);
  assert.equal(result.alert, null);

  result = applyWatchSnapshot(watch, {
    floorInfo: createPriceInfo({ state: 'known', value: 1, source: 'Reservoir', chain: 'ethereum' }),
    mintInfo: createPriceInfo({ state: 'unknown', reason: 'Unverified', chain: 'ethereum' })
  }, '2026-07-10T08:01:00.000Z');
  watch = result.watch;
  assert.equal(watch.baselineValue, 1);
  assert.equal(result.alert, null);

  result = applyWatchSnapshot(watch, {
    floorInfo: createPriceInfo({ state: 'known', value: 2.1, source: 'Reservoir', chain: 'ethereum' }),
    mintInfo: createPriceInfo({ state: 'unknown', reason: 'Unverified', chain: 'ethereum' })
  }, '2026-07-10T08:02:00.000Z');
  watch = result.watch;
  assert.equal(result.alert?.thresholdMultiple, 2);
  assert.equal(watch.notifiedLevels.join(','), '1');

  result = applyWatchSnapshot(watch, {
    floorInfo: createPriceInfo({ state: 'known', value: 2.2, source: 'Reservoir', chain: 'ethereum' }),
    mintInfo: createPriceInfo({ state: 'unknown', reason: 'Unverified', chain: 'ethereum' })
  }, '2026-07-10T08:03:00.000Z');
  watch = result.watch;
  assert.equal(result.alert, null);

  result = applyWatchSnapshot(watch, {
    floorInfo: createPriceInfo({ state: 'known', value: 1.9, source: 'Reservoir', chain: 'ethereum' }),
    mintInfo: createPriceInfo({ state: 'unknown', reason: 'Unverified', chain: 'ethereum' })
  }, '2026-07-10T08:04:00.000Z');
  watch = result.watch;
  assert.equal(result.alert, null);
  assert.equal(watch.notifiedLevels.length, 0);

  result = applyWatchSnapshot(watch, {
    floorInfo: createPriceInfo({ state: 'known', value: 2.05, source: 'Reservoir', chain: 'ethereum' }),
    mintInfo: createPriceInfo({ state: 'unknown', reason: 'Unverified', chain: 'ethereum' })
  }, '2026-07-10T08:05:00.000Z');
  assert.equal(result.alert?.thresholdMultiple, 2);
});

test('watch state persists across restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'metabot-state-'));
  const file = join(dir, 'state.json');
  const initial = loadStateFromFile(file);
  initial.watches.push(createWatchRecord({ id: 'watch_saved', input: 'https://www.tinyvalidators.xyz/mint' }));
  saveStateToFile(file, initial);
  const loaded = loadStateFromFile(file);
  assert.equal(loaded.watches.length, 1);
  assert.equal(loaded.watches[0].id, 'watch_saved');
  rmSync(dir, { recursive: true, force: true });
});

test('plain pasted links are parsed as watch requests', () => {
  const parsed = parseTelegramText('https://x.com/tinyvalidators/status/2075256991186833628?s=46');
  assert.equal(parsed.command, 'watch');
  assert.equal(parsed.isPlainUrl, true);
  assert.match(parsed.input, /x\.com\/tinyvalidators/);
});

test('resolution failure message is actionable', () => {
  const text = buildResolutionMessage('https://example.com', 'Mint page did not expose a contract or marketplace collection link.');
  assert.match(text, /Watch rejected/);
  assert.match(text, /Action: send a mint URL, OpenSea collection URL, contract address, or X post/);
});

test('auto-mint confirmation stays off when mint price is unknown or wallet is not ready', () => {
  const watch = createWatchRecord({
    id: 'watch_auto',
    input: 'https://www.tinyvalidators.xyz/mint',
    resolved: {
      name: 'Tiny Validators',
      contract: '0x1234567890123456789012345678901234567890',
      chain: 'ethereum',
      mintInfo: createPriceInfo({ state: 'unknown', reason: 'Unverified', chain: 'ethereum' })
    }
  });
  const confirmation = buildAutomintConfirmation(watch, {
    maxPrice: 0.02,
    quantity: 1,
    targetMultiple: 2,
    maxGas: 80,
    tip: 3
  }, {
    walletReady: false,
    signerReady: false
  });
  assert.equal(confirmation.canEnable, false);
  assert.match(confirmation.text, /Verified mint price is unknown/);
  assert.match(confirmation.text, /Auto-mint remains OFF/);
});
