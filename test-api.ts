

const BASE_URL = 'http://localhost:4000/api';

async function runTests() {
    console.log('🧪 Starting API Tests...');
    let passed = 0;
    let failed = 0;

    async function test(name: string, fn: () => Promise<void>) {
        try {
            await fn();
            console.log(`✅ ${name}`);
            passed++;
        } catch (err: any) {
            console.error(`❌ ${name}: ${err.message}`);
            failed++;
        }
    }

    await test('GET /status', async () => {
        const res = await fetch(`${BASE_URL}/status`);
        if (!res.ok) throw new Error(`Status ${res.status}`);
        const data = await res.json();
        if (typeof data.activeVehicles !== 'number') throw new Error('Invalid response structure');
    });

    await test('GET /routes', async () => {
        const res = await fetch(`${BASE_URL}/routes`);
        if (!res.ok) throw new Error(`Status ${res.status}`);
        const data = await res.json();
        if (!Array.isArray(data)) throw new Error('Response is not an array');
        if (data.length > 0 && !data[0].route_id) throw new Error('Invalid route object');
    });

    await test('GET /cancellations', async () => {
        const res = await fetch(`${BASE_URL}/cancellations`);
        if (!res.ok) throw new Error(`Status ${res.status}`);
        const data = await res.json();
        if (!Array.isArray(data)) throw new Error('Response is not an array');
        // Even if empty, it's valid
    });

    // Test a block fetch (might be empty/slow but ensures endpoint works)
    await test('GET /blocks (smoke test)', async () => {
        // Use today's date formatted YYYYMMDD
        const now = new Date();
        const yyyy = now.getFullYear();
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const dd = String(now.getDate()).padStart(2, '0');
        const dateStr = `${yyyy}${mm}${dd}`;

        const res = await fetch(`${BASE_URL}/blocks?date=${dateStr}`);
        if (!res.ok) throw new Error(`Status ${res.status}`);
        const data = await res.json();
        if (!Array.isArray(data)) throw new Error('Response is not an array');
    });

    console.log(`\n🏁 Tests Completed: ${passed} Passed, ${failed} Failed.`);
    if (failed > 0) process.exit(1);
}

runTests();
