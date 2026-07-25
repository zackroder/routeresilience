const API_BASE = process.env.API_BASE || 'http://localhost:4000/api';
const API_KEY = process.env.API_KEY || 'dev-key';

async function verifySkippedStops() {
    console.log('🔍 Checking GTFS-RT feed for SKIPPED stop updates...\n');

    // 1. Fetch active detours
    const detoursRes = await fetch(`${API_BASE}/detours`, {
        headers: { 'X-API-Key': API_KEY }
    });
    if (!detoursRes.ok) throw new Error(`Failed to fetch detours: ${detoursRes.statusText}`);
    const detours: any = await detoursRes.json();
    console.log(`📌 Found ${detours.length} active detours in database.`);

    // 2. Fetch GTFS-RT JSON feed
    const feedRes = await fetch(`${API_BASE}/gtfs-rt/json`);
    if (!feedRes.ok) throw new Error(`Failed to fetch feed JSON: ${feedRes.statusText}`);
    const feedMessage: any = await feedRes.json();

    const entities = feedMessage.entity || [];
    console.log(`📦 Total feed entities: ${entities.length}\n`);

    let tripUpdatesWithSkipped = 0;
    let totalSkippedStopsFound = 0;

    for (const entity of entities) {
        if (!entity.tripUpdate) continue;

        const tu = entity.tripUpdate;
        const stopUpdates = tu.stopTimeUpdate || [];

        const skippedUpdates = stopUpdates.filter((st: any) => 
            st.scheduleRelationship === 1 || 
            st.scheduleRelationship === 'SKIPPED' || 
            st.scheduleRelationship === '1' ||
            st.schedule_relationship === 1 ||
            st.schedule_relationship === 'SKIPPED'
        );

        if (skippedUpdates.length > 0) {
            tripUpdatesWithSkipped++;
            totalSkippedStopsFound += skippedUpdates.length;

            if (tripUpdatesWithSkipped <= 5) {
                console.log(`🚌 Trip ID: ${tu.trip?.tripId || tu.trip?.trip_id || 'N/A'} (Route ${tu.trip?.routeId || tu.trip?.route_id || 'N/A'})`);
                console.log(`   Vehicle ID: ${tu.vehicle?.id || 'N/A'}`);
                console.log(`   Trip Schedule Relationship: ${tu.trip?.scheduleRelationship || tu.trip?.schedule_relationship}`);
                console.log(`   Skipped Stops Count: ${skippedUpdates.length}`);
                console.log(`   Bypassed Stops:`);
                skippedUpdates.forEach((st: any) => {
                    console.log(`      - Stop ID: ${st.stopId || st.stop_id} | Sequence: ${st.stopSequence || st.stop_sequence} | Status: ${st.scheduleRelationship || st.schedule_relationship}`);
                });
                console.log('--------------------------------------------------');
            }
        }
    }

    console.log(`\n==================================================`);
    console.log(`📊 Verification Summary:`);
    console.log(`   Total TripUpdates with SKIPPED stops: ${tripUpdatesWithSkipped}`);
    console.log(`   Total SKIPPED StopTimeUpdates found: ${totalSkippedStopsFound}`);
    console.log(`==================================================`);

    if (totalSkippedStopsFound > 0) {
        console.log(`\n✅ SUCCESS: SKIPPED stop updates are actively generated in the GTFS-RT feed!`);
    } else {
        console.log(`\n⚠️ No SKIPPED stop updates found in current feed snapshot.`);
    }
}

verifySkippedStops().catch(err => {
    console.error('❌ Error verifying skipped stops:', err.message);
    process.exit(1);
});
