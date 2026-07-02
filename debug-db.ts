
import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = path.resolve(process.cwd(), 'data', 'gtfs.db');
const db = new Database(DB_PATH);

console.log('Opening DB:', DB_PATH);

// Helper to get day column
function getDayColumnName(dateStr: string): string {
    const year = parseInt(dateStr.substring(0, 4));
    const month = parseInt(dateStr.substring(4, 6)) - 1;
    const day = parseInt(dateStr.substring(6, 8));
    const date = new Date(year, month, day);
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    return days[date.getDay()];
}

const dateStr = '20260218'; // Today/User's date
const dayOfWeek = getDayColumnName(dateStr);

const sql = `
            WITH active_trips AS (
                SELECT t.*
                FROM trips t
                JOIN (
                    SELECT service_id FROM calendar 
                    WHERE start_date <= ? AND end_date >= ? AND ${dayOfWeek} = 1
                    UNION
                    SELECT service_id FROM calendar_dates 
                    WHERE date = ? AND exception_type = 1
                    EXCEPT
                    SELECT service_id FROM calendar_dates 
                    WHERE date = ? AND exception_type = 2
                ) active_services ON t.service_id = active_services.service_id
                WHERE t.block_id IS NOT NULL AND t.block_id != ''
            )
            SELECT 
                at.trip_id,
                at.block_id,
                s_start.stop_name as start_stop_name,
                s_end.stop_name as end_stop_name
            FROM active_trips at
            JOIN stop_times st_start ON at.trip_id = st_start.trip_id AND st_start.stop_sequence = (
                SELECT MIN(stop_sequence) FROM stop_times WHERE trip_id = at.trip_id
            )
            JOIN stops s_start ON st_start.stop_id = s_start.stop_id
            JOIN stop_times st_end ON at.trip_id = st_end.trip_id AND st_end.stop_sequence = (
                SELECT MAX(stop_sequence) FROM stop_times WHERE trip_id = at.trip_id
            )
            JOIN stops s_end ON st_end.stop_id = s_end.stop_id
            ORDER BY at.block_id, at.start_time
            LIMIT 5
`;

try {
    const rows = db.prepare(sql).all(dateStr, dateStr, dateStr, dateStr);
    console.log('Query Result Sample:');
    console.log(JSON.stringify(rows, null, 2));
} catch (err: any) {
    console.error('Query Failed:', err.message);
}

db.close();
