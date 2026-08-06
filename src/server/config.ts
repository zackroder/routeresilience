import fs from 'fs'
import path from 'path'

export type VehicleSourceMode = 'simulation' | 'gtfs-rt'

export interface ServerConfig {
  vehicleSource: VehicleSourceMode
  gtfsRtUrl: string
  gtfsRtApiKey: string
  gtfsRtPollIntervalMs: number
}

const ENV_FILE = path.resolve(process.cwd(), '.env')

/**
 * Load environment variables from a gitignored `.env` file at the repo root
 * (if present) using Node's built-in loader — no dotenv dependency.
 */
export function loadEnvFile(): void {
  if (fs.existsSync(ENV_FILE)) {
    try {
      process.loadEnvFile(ENV_FILE)
    } catch (err) {
      console.error('Failed to load .env:', err)
    }
  }
}

export function getServerConfig(): ServerConfig {
  loadEnvFile()
  const mode = process.env.VEHICLE_SOURCE === 'gtfs-rt' ? 'gtfs-rt' : 'simulation'
  return {
    vehicleSource: mode,
    gtfsRtUrl: process.env.GTFS_RT_URL ?? '',
    gtfsRtApiKey: process.env.GTFS_RT_API_KEY ?? '',
    gtfsRtPollIntervalMs: parseInt(process.env.GTFS_RT_POLL_INTERVAL_MS ?? '15000', 10) || 15000,
  }
}
