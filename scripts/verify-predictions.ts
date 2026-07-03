/**
 * GTFS-RT Prediction Accuracy Test
 *
 * Compares GTFS-RT predictions against actual simulated arrival times.
 * Polls the feed and arrivals endpoint for a configurable duration,
 * then computes RMSE, median error, and per-bucket breakdown.
 *
 * Usage:  npx tsx scripts/verify-predictions.ts [--duration 120]
 * Requires: Server running on localhost:4000 with SIMULATION_DEBUG_MODE=true
 */

const API_BASE = process.env.API_BASE || 'http://localhost:4000/api';
const POLLING_INTERVAL_MS = 5000;

// Parse --duration argument (default 120 seconds)
const durationArg = process.argv.find((_, i, arr) => arr[i - 1] === '--duration');
const DURATION_MS = (durationArg ? parseInt(durationArg) : 120) * 1000;

interface ArrivalLog {
    vehicleId: string;
    tripId: string;
    stopId: string;
    timestamp: number; // epoch ms
}

interface PredictionSnapshot {
    predictedTime: number;  // epoch seconds
    capturedAt: number;     // epoch ms when we captured this prediction
}

async function main() {
    console.log('═══════════════════════════════════════════════════');
    console.log('  GTFS-RT Prediction Accuracy Test');
    console.log('═══════════════════════════════════════════════════');
    console.log(`\nPolling: ${API_BASE}`);
    console.log(`Duration: ${DURATION_MS / 1000}s`);
    console.log(`Interval: ${POLLING_INTERVAL_MS}ms\n`);

    // key: tripId_stopId → latest prediction
    const predictionsMap = new Map<string, PredictionSnapshot>();
    const arrivals: ArrivalLog[] = [];
    const seenArrivals = new Set<string>();

    const startTime = Date.now();
    let pollCount = 0;

    const interval = setInterval(async () => {
        const now = Date.now();
        if (now - startTime > DURATION_MS) {
            clearInterval(interval);
            finish(predictionsMap, arrivals);
            return;
        }

        pollCount++;
        const elapsed = Math.round((now - startTime) / 1000);
        process.stdout.write(`\r  Polling... ${elapsed}s / ${DURATION_MS / 1000}s | Predictions: ${predictionsMap.size} | Arrivals: ${arrivals.length}`);

        try {
            // 1. Fetch GTFS-RT (JSON)
            const feedRes = await fetch(`${API_BASE}/gtfs-rt/json`, {
                headers: { 'X-API-Key': 'dev-key' }
            });
            if (feedRes.ok) {
                const feed = await feedRes.json();
                if (feed.entity) {
                    for (const entity of feed.entity) {
                        if (entity.tripUpdate?.stopTimeUpdate) {
                            const tripId = entity.tripUpdate.trip.tripId;
                            for (const stu of entity.tripUpdate.stopTimeUpdate) {
                                if (stu.arrival?.time) {
                                    const key = `${tripId}_${stu.stopId}`;
                                    predictionsMap.set(key, {
                                        predictedTime: stu.arrival.time,
                                        capturedAt: now,
                                    });
                                }
                            }
                        }
                    }
                }
            }

            // 2. Fetch Arrivals
            const arrRes = await fetch(`${API_BASE}/arrivals`, {
                headers: { 'X-API-Key': 'dev-key' }
            });
            if (arrRes.ok) {
                const logs = await arrRes.json() as ArrivalLog[];
                for (const log of logs) {
                    const key = `${log.tripId}_${log.stopId}_${log.timestamp}`;
                    if (!seenArrivals.has(key)) {
                        seenArrivals.add(key);
                        arrivals.push(log);
                    }
                }
            }
        } catch (err) {
            // Silently continue
        }
    }, POLLING_INTERVAL_MS);
}

function finish(predictions: Map<string, PredictionSnapshot>, arrivals: ArrivalLog[]) {
    console.log('\n\n═══════════════════════════════════════════════════');
    console.log('  Results');
    console.log('═══════════════════════════════════════════════════\n');

    console.log(`  Total Arrivals Recorded: ${arrivals.length}`);
    console.log(`  Total Predictions Captured: ${predictions.size}\n`);

    const errors: number[] = [];
    const buckets: { [range: string]: number[] } = {
        '0-30s ahead': [],
        '30-60s ahead': [],
        '1-5min ahead': [],
        '5min+ ahead': [],
    };

    for (const arrival of arrivals) {
        const key = `${arrival.tripId}_${arrival.stopId}`;
        const pred = predictions.get(key);

        if (pred !== undefined) {
            const actualTime = arrival.timestamp / 1000;
            const error = pred.predictedTime - actualTime; // positive = predicted late
            errors.push(error);

            // Bucket by how far ahead the prediction was made
            const leadTime = (arrival.timestamp - pred.capturedAt) / 1000;
            if (leadTime < 30) buckets['0-30s ahead'].push(error);
            else if (leadTime < 60) buckets['30-60s ahead'].push(error);
            else if (leadTime < 300) buckets['1-5min ahead'].push(error);
            else buckets['5min+ ahead'].push(error);
        }
    }

    if (errors.length === 0) {
        console.log('  ⚠️  No matching predictions found for recorded arrivals.');
        console.log('     This may be normal if the run was too short or no stops were reached.\n');
        return;
    }

    // Compute metrics
    const rmse = Math.sqrt(errors.reduce((sum, e) => sum + e * e, 0) / errors.length);
    const sorted = [...errors].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const meanError = errors.reduce((sum, e) => sum + e, 0) / errors.length;
    const minError = sorted[0];
    const maxError = sorted[sorted.length - 1];

    console.log(`  Matched Arrivals: ${errors.length}\n`);
    console.log('  ─── Overall Metrics ───');
    console.log(`  RMSE:          ${rmse.toFixed(2)}s`);
    console.log(`  Mean Error:    ${meanError.toFixed(2)}s`);
    console.log(`  Median Error:  ${median.toFixed(2)}s`);
    console.log(`  Min Error:     ${minError.toFixed(2)}s`);
    console.log(`  Max Error:     ${maxError.toFixed(2)}s\n`);

    // Per-bucket breakdown
    console.log('  ─── Error by Prediction Lead Time ───');
    for (const [bucket, errs] of Object.entries(buckets)) {
        if (errs.length === 0) {
            console.log(`  ${bucket}: (no data)`);
            continue;
        }
        const bucketRmse = Math.sqrt(errs.reduce((s, e) => s + e * e, 0) / errs.length);
        const bucketSorted = [...errs].sort((a, b) => a - b);
        const bucketMedian = bucketSorted[Math.floor(bucketSorted.length / 2)];
        console.log(`  ${bucket}: RMSE=${bucketRmse.toFixed(1)}s  Median=${bucketMedian.toFixed(1)}s  (n=${errs.length})`);
    }

    // Pass/fail
    const THRESHOLD_SECONDS = 120;
    console.log(`\n  ─── Verdict ───`);
    if (rmse <= THRESHOLD_SECONDS) {
        console.log(`  ✅ PASS — RMSE ${rmse.toFixed(1)}s is within ${THRESHOLD_SECONDS}s threshold\n`);
    } else {
        console.log(`  ❌ FAIL — RMSE ${rmse.toFixed(1)}s exceeds ${THRESHOLD_SECONDS}s threshold\n`);
        process.exit(1);
    }
}

main();
