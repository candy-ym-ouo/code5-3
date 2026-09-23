import { describe, expect, it } from 'vitest';
import {
  calibrateEnvironment,
  ENVIRONMENT_CALIBRATION_VERSION,
  getRegionalBaseline,
  getWeatherAnomaly,
  LEGACY_ENVIRONMENT_CALIBRATION_VERSION,
  rescoreEnvironmentRecord,
  scoreEnvironmentLegacy
} from './calibration.ts';
import { generateSiteState } from './simulation.ts';
import type { SiteState } from './types.ts';

const site = generateSiteState('save', 'seed-calibration', 1, 'spring', 3, 'foothill');
const perfect = {
  temperatureC: site.temperatureC,
  humidity: site.humidity,
  soilMoisture: site.soilMoisture,
  lightLux: site.lightLux
};
const calmContext = { season: 'spring' as const, site, previous: null };

describe('legacy environment scoring (v1)', () => {
  it('keeps the original hard thresholds unchanged', () => {
    expect(scoreEnvironmentLegacy(perfect, site)).toBe(100);
    expect(scoreEnvironmentLegacy({ ...perfect, temperatureC: perfect.temperatureC + 1 }, site)).toBe(100);
    expect(scoreEnvironmentLegacy({ ...perfect, temperatureC: perfect.temperatureC + 1.1 }, site)).toBe(70);
    expect(scoreEnvironmentLegacy({ ...perfect, humidity: perfect.humidity + 6 }, site)).toBe(75);
    expect(scoreEnvironmentLegacy({ ...perfect, lightLux: 0 }, site)).toBe(80);
  });

  it('rescores v1 records to identical results', () => {
    const values = { ...perfect, temperatureC: perfect.temperatureC + 0.6, humidity: perfect.humidity - 7 };
    const stored = scoreEnvironmentLegacy(values, site);
    expect(rescoreEnvironmentRecord(LEGACY_ENVIRONMENT_CALIBRATION_VERSION, values, calmContext)).toBe(stored);
  });
});

describe('environment calibration v2', () => {
  it('awards full marks for perfect readings', () => {
    const result = calibrateEnvironment(perfect, calmContext);
    expect(result.version).toBe(ENVIRONMENT_CALIBRATION_VERSION);
    expect(result.total).toBe(100);
    expect(result.components).toHaveLength(4);
  });

  it('treats deviations inside the instrument error band as full marks', () => {
    const result = calibrateEnvironment(
      { ...perfect, temperatureC: perfect.temperatureC + 0.3, humidity: perfect.humidity - 1.5 },
      calmContext
    );
    expect(result.components[0]?.score).toBe(30);
    expect(result.components[1]?.score).toBe(25);
    expect(result.total).toBe(100);
  });

  it('decays linearly beyond the instrument band and zeroes beyond tolerance', () => {
    const partial = calibrateEnvironment({ ...perfect, temperatureC: perfect.temperatureC + 0.7 }, calmContext);
    const temperature = partial.components[0]!;
    expect(temperature.score).toBeGreaterThan(0);
    expect(temperature.score).toBeLessThan(30);

    const missed = calibrateEnvironment({ ...perfect, temperatureC: perfect.temperatureC + 5 }, calmContext);
    expect(missed.components[0]?.score).toBe(0);
  });

  it('widens tolerance when the weather changes suddenly', () => {
    const previous: SiteState = {
      ...site,
      weather: 'heavy_rain',
      temperatureC: site.temperatureC - 6,
      humidity: Math.min(98, site.humidity + 20)
    };
    const anomaly = getWeatherAnomaly(previous, site);
    expect(anomaly.weatherChanged).toBe(true);
    expect(anomaly.shift).toBeGreaterThan(0);

    const readings = { ...perfect, temperatureC: perfect.temperatureC + 1.2 };
    const calm = calibrateEnvironment(readings, calmContext);
    const stormy = calibrateEnvironment(readings, { season: 'spring', site, previous });
    expect(stormy.components[0]?.tolerance).toBeGreaterThan(calm.components[0]!.tolerance);
    expect(stormy.components[0]!.score).toBeGreaterThan(calm.components[0]!.score);
  });

  it('widens tolerance when the day drifts from the regional baseline', () => {
    const baseline = getRegionalBaseline('spring', 'ridge');
    const normalSite: SiteState = { ...site, siteId: 'ridge', temperatureC: baseline.temperatureC };
    const driftedSite: SiteState = { ...site, siteId: 'ridge', temperatureC: baseline.temperatureC + 5 };

    const normal = calibrateEnvironment(
      { ...perfect, temperatureC: baseline.temperatureC + 1.2 },
      { season: 'spring', site: normalSite, previous: null }
    );
    const drifted = calibrateEnvironment(
      { ...perfect, temperatureC: baseline.temperatureC + 6.2 },
      { season: 'spring', site: driftedSite, previous: null }
    );
    expect(drifted.components[0]?.delta).toBeCloseTo(normal.components[0]!.delta, 5);
    expect(drifted.components[0]!.tolerance).toBeGreaterThan(normal.components[0]!.tolerance);
    expect(drifted.components[0]!.score).toBeGreaterThan(normal.components[0]!.score);
  });

  it('exposes the regional baseline for every site and season', () => {
    for (const siteId of ['foothill', 'mixed_forest', 'stream_valley', 'ridge'] as const) {
      for (const season of ['spring', 'summer', 'autumn', 'winter'] as const) {
        const baseline = getRegionalBaseline(season, siteId);
        expect(Number.isFinite(baseline.temperatureC)).toBe(true);
        expect(baseline.lightLux).toBeGreaterThan(0);
      }
    }
    const valley = getRegionalBaseline('summer', 'stream_valley');
    const ridge = getRegionalBaseline('summer', 'ridge');
    expect(valley.soilMoisture).toBeGreaterThan(ridge.soilMoisture);
  });

  it('is deterministic and rescores v2 records to identical results', () => {
    const previous: SiteState = { ...site, weather: 'fog', temperatureC: site.temperatureC - 3 };
    const context = { season: 'spring' as const, site, previous };
    const values = { ...perfect, humidity: perfect.humidity + 3.4, lightLux: perfect.lightLux + 1800 };
    const first = calibrateEnvironment(values, context);
    const second = calibrateEnvironment(values, context);
    expect(first).toEqual(second);
    expect(rescoreEnvironmentRecord(ENVIRONMENT_CALIBRATION_VERSION, values, context)).toBe(first.total);
  });
});
