
const BASE_URL = 'http://localhost:4000/api';

async function runTests() {
    console.log('🧪 Starting Detailed Block Tests...');

    // Use today's date formatted YYYYMMDD
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const dateStr = `${yyyy}${mm}${dd}`;

    console.log(`Fetching blocks for date: ${dateStr}`);

    try {
        const res = await fetch(`${BASE_URL}/blocks?date=${dateStr}`);
        if (!res.ok) throw new Error(`Status ${res.status}`);
        const data = await res.json();

        if (!Array.isArray(data) || data.length === 0) {
            console.warn('⚠️ No blocks returned. Cannot verify fields.');
            return;
        }

        const firstBlock = data[0];
        console.log('First Block ID:', firstBlock.block_id);

        if (firstBlock.trips && firstBlock.trips.length > 0) {
            const firstTrip = firstBlock.trips[0];
            console.log('First Trip Details:');
            console.log('  Trip ID:', firstTrip.trip_id);
            console.log('  Start Time:', firstTrip.start_time);
            console.log('  End Time:', firstTrip.end_time);
            console.log('  Start Stop Name:', firstTrip.start_stop_name);
            console.log('  End Stop Name:', firstTrip.end_stop_name);

            if (!firstTrip.start_stop_name) console.error('❌ Missing start_stop_name');
            else console.log('✅ start_stop_name present');

            if (!firstTrip.end_stop_name) console.error('❌ Missing end_stop_name');
            else console.log('✅ end_stop_name present');

        } else {
            console.warn('⚠️ First block has no trips.');
        }

    } catch (err: any) {
        console.error(`❌ Error: ${err.message}`);
    }
}

runTests();
