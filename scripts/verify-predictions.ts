
import fs from 'fs';
import path from 'path';

const API_BASE = 'http://localhost:3001/api';
const POLLING_INTERVAL_MS = 5000;
const DURATION_MS = 60000; // Run for 1 minute by default

interface ArrivalLog {
    vehicleId: string;
    tripId: string;
    stopId: string;
    timestamp: number; // epoch ms
}

async function main() {
    console.log('Starting Prediction Verification...');
    console.log(`Polling every ${POLLING_INTERVAL_MS}ms for ${DURATION_MS}ms...`);

    const predictionsMap = new Map<string, number>(); // key: tripId_stopId, value: arrivalTime (sec)
    const arrivals: ArrivalLog[] = [];

    const startTime = Date.now();

    const interval = setInterval(async () => {
        const now = Date.now();
        if (now - startTime > DURATION_MS) {
            clearInterval(interval);
            finish(predictionsMap, arrivals);
            return;
        }

        try {
            // 1. Fetch GTFS-RT (JSON for easier parsing)
            const feedRes = await fetch(`${API_BASE}/gtfs-rt/json`);
            if (feedRes.ok) {
                const feed = await feedRes.json();
                if (feed.entity) {
                    for (const entity of feed.entity) {
                        if (entity.tripUpdate && entity.tripUpdate.stopTimeUpdate) {
                            const tripId = entity.tripUpdate.trip.tripId;
                            for (const stu of entity.tripUpdate.stopTimeUpdate) {
                                if (stu.arrival) {
                                    const key = `${tripId}_${stu.stopId}`;
                                    // Store the LATEST prediction seen
                                    predictionsMap.set(key, stu.arrival.time);
                                }
                            }
                        }
                    }
                }
            }

            // 2. Fetch Arrivals
            const arrRes = await fetch(`${API_BASE}/arrivals`);
            if (arrRes.ok) {
                const logs = await arrRes.json() as ArrivalLog[];
                // Add new logs
                for (const log of logs) {
                    // Check if we already have this one (simple check based on timestamp/trip/stop)
                    if (!arrivals.find(a => a.tripId === log.tripId && a.stopId === log.stopId && a.timestamp === log.timestamp)) {
                        arrivals.push(log);
                        console.log(`Log: Bus ${log.vehicleId} (Trip ${log.tripId}) arrived at ${log.stopId}`);
                    }
                }
            }
        } catch (err) {
            console.error('Error fetching data:', err);
        }
    }, POLLING_INTERVAL_MS);
}

function finish(predictions: Map<string, number>, arrivals: ArrivalLog[]) {
    console.log('\n--- Verification Results ---');
    console.log(`Total Arrivals Recorded: ${arrivals.length}`);
    console.log(`Total Predictions Captured: ${predictions.size}`);

    let totalErrorSq = 0;
    let count = 0;
    let minError = Infinity;
    let maxError = -Infinity;

    for (const arrival of arrivals) {
        const key = `${arrival.tripId}_${arrival.stopId}`;
        const predictedTime = predictions.get(key);

        if (predictedTime !== undefined) {
            const actualTime = arrival.timestamp / 1000;
            const error = predictedTime - actualTime;

            totalErrorSq += error * error;
            count++;

            if (error < minError) minError = error;
            if (error > maxError) maxError = error;
        }
    }

    if (count > 0) {
        const rmse = Math.sqrt(totalErrorSq / count);
        console.log(`\nMatched Arrivals: ${count}`);
        console.log(`RMSE: ${rmse.toFixed(2)} seconds`);
        console.log(`Min Error: ${minError.toFixed(2)}s`);
        console.log(`Max Error: ${maxError.toFixed(2)}s`);

        if (Math.abs(rmse) > 300) { // Arbitrary threshold
            console.warn('WARNING: High RMSE. Predictions might be inaccurate.');
        } else {
            console.log('✅ Prediction accuracy within acceptable range.');
        }
    } else {
        console.log('\nNo matching predictions found for recorded arrivals.');
    }
}

main();
