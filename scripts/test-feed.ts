import protobuf from 'protobufjs';
import path from 'path';
import fs from 'fs';

const FEED_URL = 'http://localhost:3001/api/gtfs-rt';
const PROTO_PATH = path.resolve(process.cwd(), 'proto', 'gtfs-realtime.proto');

async function main() {
    console.log(`Fetching GTFS-RT feed from ${FEED_URL}...`);

    try {
        const response = await fetch(FEED_URL);
        if (!response.ok) {
            throw new Error(`Failed to fetch feed: ${response.status} ${response.statusText}`);
        }

        const buffer = await response.arrayBuffer();
        const ui8 = new Uint8Array(buffer);

        console.log(`Downloaded ${ui8.length} bytes.`);

        // Load proto
        console.log(`Loading proto from ${PROTO_PATH}...`);
        const root = await protobuf.load(PROTO_PATH);
        const FeedMessage = root.lookupType('transit_realtime.FeedMessage');

        // Decode
        const message = FeedMessage.decode(ui8);
        const obj = FeedMessage.toObject(message, {
            longs: String,
            enums: String,
            bytes: String,
        });

        // Assertions
        console.log('\n--- Feed Header ---');
        console.log(JSON.stringify(obj.header, null, 2));

        if (!obj.entity || obj.entity.length === 0) {
            console.warn('WARNING: Feed contains no entities!');
        } else {
            console.log(`\nFound ${obj.entity.length} entities.`);

            let tripUpdates = 0;
            let vehiclePositions = 0;
            let alerts = 0;
            let others = 0;

            for (const entity of obj.entity) {
                if (entity.tripUpdate) tripUpdates++;
                else if (entity.vehicle) vehiclePositions++;
                else if (entity.alert) alerts++;
                else others++;
            }

            console.log(`- TripUpdates: ${tripUpdates}`);
            console.log(`- VehiclePositions: ${vehiclePositions}`);
            console.log(`- ServiceAlerts: ${alerts}`);
            console.log(`- Others (Shapes/Stops): ${others}`);

            if (process.env.SIMULATION_DEBUG_MODE === 'true' && vehiclePositions === 0) {
                console.error('ERROR: Expected vehicle positions in DEBUG mode, but found none.');
                process.exit(1);
            }

            // Sample entities
            if (tripUpdates > 0) {
                console.log('\nSample TripUpdate:');
                console.log(JSON.stringify(obj.entity.find((e: any) => e.tripUpdate).tripUpdate, null, 2));
            }
            if (vehiclePositions > 0) {
                console.log('\nSample VehiclePosition:');
                console.log(JSON.stringify(obj.entity.find((e: any) => e.vehicle).vehicle, null, 2));
            }
        }

        console.log('\n✅ Feed validation passed.');

    } catch (err) {
        console.error('❌ Error testing feed:', err);
        process.exit(1);
    }
}

main();
