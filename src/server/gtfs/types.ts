// ─── GTFS Static Feed Types ───
// Mirrors the GTFS specification CSV column types

export interface Route {
  route_id: string;
  agency_id: string;
  route_short_name: string;
  route_long_name: string;
  route_type: number;
  route_color: string;
  route_text_color: string;
  directions?: { [id: number]: string };
}

export interface Trip {
  trip_id: string;
  route_id: string;
  service_id: string;
  direction_id: number;
  direction: string;
  trip_headsign: string;
  shape_id: string;
  block_id: string;
}

export interface Stop {
  stop_id: string;
  stop_name: string;
  stop_lat: number;
  stop_lon: number;
  stop_code: string;
  location_type: number;
  parent_station: string;
}

export interface StopTime {
  trip_id: string;
  arrival_time: string;       // HH:MM:SS (can be > 24:00)
  departure_time: string;     // HH:MM:SS
  stop_id: string;
  stop_sequence: number;
  pickup_type: number;
  drop_off_type: number;
  shape_dist_traveled: number;
}

export interface ShapePoint {
  shape_id: string;
  shape_pt_lat: number;
  shape_pt_lon: number;
  shape_pt_sequence: number;
  shape_dist_traveled: number;
}

export interface Calendar {
  service_id: string;
  monday: number;
  tuesday: number;
  wednesday: number;
  thursday: number;
  friday: number;
  saturday: number;
  sunday: number;
  start_date: string;   // YYYYMMDD
  end_date: string;      // YYYYMMDD
}

export interface CalendarDate {
  service_id: string;
  date: string;          // YYYYMMDD
  exception_type: number; // 1 = added, 2 = removed
}

// ─── Indexed GTFS Data ───

export interface GTFSData {
  routes: Map<string, Route>;
  trips: Map<string, Trip>;
  stops: Map<string, Stop>;
  stopTimesByTrip: Map<string, StopTime[]>;
  tripsByRoute: Map<string, string[]>;          // key: `${route_id}_${direction_id}`
  shapePoints: Map<string, ShapePoint[]>;
  calendars: Map<string, Calendar>;
  calendarDates: Map<string, CalendarDate[]>;   // key: service_id

  // Derived spatial index for nearby-stop queries
  stopSpatialGrid: Map<string, Stop[]>;         // key: `${gridX}_${gridY}`
}

// Utility: parse GTFS time string "HH:MM:SS" to seconds since midnight
export function parseGTFSTime(timeStr: string): number {
  const parts = timeStr.split(':');
  return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]);
}

// Utility: seconds since midnight to "HH:MM:SS"
export function formatGTFSTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Spatial grid cell size in degrees (~0.01 ≈ 1.1km)
export const GRID_CELL_SIZE = 0.01;

export function gridKey(lat: number, lon: number): string {
  const gx = Math.floor(lat / GRID_CELL_SIZE);
  const gy = Math.floor(lon / GRID_CELL_SIZE);
  return `${gx}_${gy}`;
}
