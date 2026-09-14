import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GTFSRepository } from '../../../server/gtfs/database.js'
import { loadMinimalFixture } from '../../helpers/fixtures.js'

// Validates the hand-authored `gtfs-minimal` fixture: it must import cleanly
// through the production loader and expose the exact topology, services, and
// times that the rest of the suite relies on.
describe('gtfs-minimal fixture', () => {
  let repo: GTFSRepository

  beforeAll(async () => {
    repo = await loadMinimalFixture()
  })

  afterAll(() => {
    repo.close()
  })

  it('imports through the production loader with exact counts', () => {
    expect(repo.getRouteCount()).toBe(2)
    expect(repo.getTripCount()).toBe(5)
    expect(repo.getStopCount()).toBe(6)
  })

  it('contains the known IDs', () => {
    expect(repo.getRoute('route-trunk')?.route_short_name).toBe('T')
    expect(repo.getRoute('route-branch')?.route_short_name).toBe('B')
    expect(repo.getTrip('trip-trunk-1')?.route_id).toBe('route-trunk')
    expect(repo.getTrip('trip-no-shape')?.route_id).toBe('route-trunk')
    expect(repo.getStop('stop-a')?.stop_lat).toBe(41.88)
    expect(repo.getStop('stop-f')?.stop_lon).toBe(-87.631)
  })

  it('returns ordered stop times for a known trip', () => {
    const st = repo.getStopTimes('trip-trunk-1')
    expect(st.map((s) => s.stop_sequence)).toEqual([1, 2, 3, 4, 5])
    expect(st.map((s) => s.stop_id)).toEqual(['stop-a', 'stop-b', 'stop-c', 'stop-d', 'stop-e'])
    expect(st[0].arrival_time).toBe(11 * 3600)
    expect(st[st.length - 1].arrival_time).toBe(11 * 3600 + 1200)
  })

  it('parses a cross-midnight trip with predictable times', () => {
    const st = repo.getStopTimes('trip-trunk-2')
    expect(st[0].arrival_time).toBe(23 * 3600 + 1800)
    expect(st[st.length - 1].arrival_time).toBe(24 * 3600 + 600)
  })

  it('loads shapes with ordered points', () => {
    const shape = repo.getShape('shape-trunk')
    expect(shape.map((p) => p.shape_pt_sequence)).toEqual([1, 2, 3, 4, 5])
    expect(shape.map((p) => p.shape_pt_lat)).toEqual([41.88, 41.881, 41.882, 41.883, 41.884])
    const branch = repo.getShape('shape-branch')
    expect(branch.map((p) => p.shape_pt_sequence)).toEqual([1, 2, 3, 4])
  })

  it('has a trip without a shape for the fallback path', () => {
    expect(repo.getTrip('trip-no-shape')?.shape_id).toBe('')
    expect(repo.getShape('')).toEqual([])
  })

  it('computes trip start/end bounds and terminal stop ids', () => {
    const t = repo.getTrip('trip-trunk-1')!
    expect(t.start_time).toBe(11 * 3600)
    expect(t.end_time).toBe(11 * 3600 + 1200)
    expect(t.start_stop_id).toBe('stop-a')
    expect(t.end_stop_id).toBe('stop-e')
  })

  it('respects calendar and calendar_dates exceptions', () => {
    // Wednesday — regular weekday service.
    expect(repo.isServiceActiveToday('service-weekday', '20260715')).toBe(true)
    // Saturday added via calendar_dates exception_type 1.
    expect(repo.isServiceActiveToday('service-weekday', '20260711')).toBe(true)
    // Tuesday removed via calendar_dates exception_type 2.
    expect(repo.isServiceActiveToday('service-weekday', '20260714')).toBe(false)
    // Sunday — not in calendar, no exception.
    expect(repo.isServiceActiveToday('service-weekday', '20260712')).toBe(false)
    // Outside the service range.
    expect(repo.isServiceActiveToday('service-weekday', '19990101')).toBe(false)
  })

  it('getActiveTrips returns the known set including exception cases', () => {
    expect(repo.getActiveTrips('20260715', 11 * 3600).map((t) => t.trip_id)).toEqual([
      'trip-trunk-1',
    ])
    const noonIds = repo
      .getActiveTrips('20260715', 12 * 3600)
      .map((t) => t.trip_id)
      .sort()
    expect(noonIds).toEqual(['trip-branch-1', 'trip-trunk-3'])
    // Saturday: service added via calendar_dates.
    expect(repo.getActiveTrips('20260711', 12 * 3600).length).toBeGreaterThan(0)
    // Tuesday: service removed via calendar_dates.
    expect(repo.getActiveTrips('20260714', 12 * 3600)).toEqual([])
    // Sunday: no service.
    expect(repo.getActiveTrips('20260712', 12 * 3600)).toEqual([])
  })

  it('streams blocks in block/time order', () => {
    const ids: string[] = []
    for (const t of repo.streamBlocks('20260715')) {
      ids.push(t.trip_id)
    }
    expect(ids).toEqual([
      'trip-trunk-1',
      'trip-trunk-2',
      'trip-branch-1',
      'trip-trunk-3',
      'trip-no-shape',
    ])
  })

  it('has consistent foreign-key-like references', () => {
    for (const tripId of [
      'trip-trunk-1',
      'trip-trunk-2',
      'trip-trunk-3',
      'trip-branch-1',
      'trip-no-shape',
    ]) {
      const trip = repo.getTrip(tripId)!
      expect(repo.getRoute(trip.route_id)).toBeDefined()
      for (const st of repo.getStopTimes(tripId)) {
        expect(repo.getStop(st.stop_id)).toBeDefined()
      }
    }
    // Every loaded shape id is referenced by at least one trip.
    for (const trip of ['trip-trunk-1', 'trip-trunk-2', 'trip-trunk-3', 'trip-branch-1']) {
      const shapeId = repo.getTrip(trip)!.shape_id
      expect(shapeId).not.toBe('')
      expect(repo.getShape(shapeId).length).toBeGreaterThanOrEqual(4)
    }
  })

  it('exposes a known detour corridor on the trunk', () => {
    const affected = repo
      .getTripsForRoute('route-trunk', 0)
      .filter((t) => {
        const ids = repo.getStopTimes(t.trip_id).map((st) => st.stop_id)
        return ids.includes('stop-a') && ids.includes('stop-e')
      })
      .map((t) => t.trip_id)
      .sort()
    expect(affected).toEqual(['trip-trunk-1', 'trip-trunk-2', 'trip-trunk-3'])
  })

  it('supports spawning a known simulation service set', () => {
    // Two shaped trips run through midday on a weekday; the rest are
    // spread across the day so no fixture volume or calendar date surprises.
    const atNoon = repo.getActiveTrips('20260715', 12 * 3600).map((t) => t.trip_id)
    expect(atNoon.length).toBeGreaterThanOrEqual(2)
    for (const tripId of atNoon) {
      const trip = repo.getTrip(tripId)!
      expect(trip.shape_id).not.toBe('')
    }
  })
})
