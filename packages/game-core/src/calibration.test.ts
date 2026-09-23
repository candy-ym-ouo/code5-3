import { describe, expect, it } from 'vitest';
import { SITES_BY_ID } from './catalog.ts';
import {
  BASELINE_CREDIT_CAP,
  CALIBRATION_VERSION,
  ENVIRONMENT_WEIGHTS,
  getRegionalBaseline,
  detectWeatherShock,
  INSTRUMENT_SPECS,
  PLANT_ENVIRONMENT_WEIGHTS,
  scoreCalibratedEnvironment,
  WEATHER_SHOCK_TOLERANCE_FACTOR,
  type EnvironmentMetricKey
} from './calibration.ts';
import { generateSiteState } from './simulation.ts';
import type { SiteState } from './types.ts';

const SEED = 'calibration-test';

function siteAt(season: 'spring' | 'summer' | 'autumn' | 'winter', day: number, siteId: 'foothill' | 'mixed_forest' | 'stream_valley' | 'ridge' = 'foothill'): SiteState {
  return generateSiteState('save', SEED, 1, season, day, siteId);
}

function readingFrom(site: SiteState): Record<EnvironmentMetricKey, number> {
  return {
    temperatureC: site.temperatureC,
    humidity: site.humidity,
    soilMoisture: site.soilMoisture,
    lightLux: site.lightLux
  };
}

describe('regional baseline', () => {
  it('matches the deterministic climatology used by environment generation', () => {
    const baseline = getRegionalBaseline('foothill', 'spring');
    // 山麓春温 = 基准 16 + 偏移 1.2
    expect(baseline.temperatureC).toBeCloseTo(17.2, 5);
    // 确定性：重复调用一致
    expect(getRegionalBaseline('foothill', 'spring')).toEqual(baseline);
    // 四个区域基线互不相同
    const ids = ['foothill', 'mixed_forest', 'stream_valley', 'ridge'] as const;
    const temps = ids.map((id) => getRegionalBaseline(id, 'spring').temperatureC);
    expect(new Set(temps).size).toBe(4);
  });

  it('applies the stream valley humidity and soil offsets to the baseline', () => {
    const baseline = getRegionalBaseline('stream_valley', 'spring');
    expect(baseline.humidity).toBeCloseTo(62 + 14, 5);
    expect(baseline.soilMoisture).toBeCloseTo(58 + 18, 5);
  });
});

describe('instrument error', () => {
  it('awards full credit when the reading is within instrument tolerance of the station', () => {
    const site = siteAt('spring', 2);
    const perfect = scoreCalibratedEnvironment(readingFrom(site), site, 'spring', ENVIRONMENT_WEIGHTS);
    expect(perfect.total).toBeCloseTo(100, 5);
    expect(perfect.version).toBe(CALIBRATION_VERSION);

    // 温度读数偏离真值 0.8°C：仍在温度仪器容差 0.8 内 -> 温度满分
    const within = scoreCalibratedEnvironment(
      { ...readingFrom(site), temperatureC: site.temperatureC + 0.8 },
      site,
      'spring',
      ENVIRONMENT_WEIGHTS
    );
    const temperature = within.metrics.find((item) => item.metric === 'temperatureC')!;
    expect(temperature.factor).toBeCloseTo(1, 5);
  });

  it('exposes instrument tolerance as bias plus precision for every metric', () => {
    const result = scoreCalibratedEnvironment(readingFrom(siteAt('spring', 2)), siteAt('spring', 2), 'spring', ENVIRONMENT_WEIGHTS);
    for (const metric of Object.keys(INSTRUMENT_SPECS) as EnvironmentMetricKey[]) {
      const spec = INSTRUMENT_SPECS[metric];
      const found = result.metrics.find((item) => item.metric === metric)!;
      expect(found.instrumentTolerance).toBeCloseTo(spec.bias + spec.precision, 5);
    }
  });
});

describe('weather shock', () => {
  it('flags severe weather as a shock even without history', () => {
    const snowy = { ...siteAt('winter', 1, 'ridge'), weather: 'snow' as const };
    const shock = detectWeatherShock(snowy, null);
    expect(shock.active).toBe(true);
    expect(shock.severeWeather).toBe(true);
  });

  it('flags a large temperature swing between recorded frames', () => {
    const calm: SiteState = { ...siteAt('spring', 1), weather: 'sunny', temperatureC: 16, humidity: 60, soilMoisture: 55, lightLux: 38000 };
    const shifted: SiteState = { ...siteAt('spring', 2), weather: 'sunny', temperatureC: 22, humidity: 60, soilMoisture: 55, lightLux: 38000 };
    const shock = detectWeatherShock(shifted, calm);
    expect(shock.active).toBe(true);
    expect(shock.transition).toBe(true);
    expect(shock.drivers.some((driver) => driver.metric === 'temperatureC')).toBe(true);
  });

  it('widens the tolerance band by the weather shock factor during a shock', () => {
    const calm: SiteState = { ...siteAt('spring', 1), weather: 'sunny', temperatureC: 16, humidity: 60, soilMoisture: 55, lightLux: 38000 };
    const shockFrame: SiteState = { ...siteAt('spring', 2), weather: 'heavy_rain', temperatureC: 16, humidity: 60, soilMoisture: 55, lightLux: 38000 };
    const result = scoreCalibratedEnvironment(readingFrom(shockFrame), shockFrame, 'spring', ENVIRONMENT_WEIGHTS, [calm, shockFrame]);
    for (const metric of result.metrics) {
      expect(metric.weatherShock).toBe(true);
      // 容差按要素精度四舍五入（温度保留 1 位），用 1 位小数比较。
      expect(metric.tolerance).toBeCloseTo(metric.instrumentTolerance * WEATHER_SHOCK_TOLERANCE_FACTOR, 0);
      expect(metric.weatherAllowance).toBeGreaterThan(0);
    }
  });

  it('does not flag stable conditions as a shock', () => {
    const calm: SiteState = { ...siteAt('spring', 1), weather: 'sunny', temperatureC: 16, humidity: 60, soilMoisture: 55, lightLux: 38000 };
    const stable: SiteState = { ...siteAt('spring', 2), weather: 'sunny', temperatureC: 16.4, humidity: 61, soilMoisture: 56, lightLux: 37500 };
    expect(detectWeatherShock(stable, calm).active).toBe(false);
  });
});

describe('regional baseline anchoring', () => {
  it('gives partial credit to a reading near the seasonal baseline but far from the station', () => {
    // 构造一个显著偏离季节基线的"暖日"环境站真值，读数则贴近基线。
    const site: SiteState = {
      ...siteAt('spring', 3, 'ridge'),
      weather: 'sunny',
      temperatureC: getRegionalBaseline('ridge', 'spring').temperatureC + 9,
      humidity: 40,
      soilMoisture: 40,
      lightLux: 40000
    };
    const baseline = getRegionalBaseline('ridge', 'spring');
    const reading = {
      temperatureC: baseline.temperatureC,
      humidity: baseline.humidity,
      soilMoisture: baseline.soilMoisture,
      lightLux: baseline.lightLux
    };
    const result = scoreCalibratedEnvironment(reading, site, 'spring', ENVIRONMENT_WEIGHTS, [site]);
    const temperature = result.metrics.find((item) => item.metric === 'temperatureC')!;
    // 现场贴近真值应接近 0（读数远离暖日真值），基线托底给封顶部分分。
    expect(temperature.fieldCloseness).toBeLessThan(0.2);
    expect(temperature.baselineCloseness).toBeCloseTo(BASELINE_CREDIT_CAP, 5);
    expect(temperature.factor).toBeCloseTo(BASELINE_CREDIT_CAP, 5);
    expect(result.baselineAnchoredMetrics).toContain('temperatureC');
    expect(result.total).toBeGreaterThan(0);
    expect(result.total).toBeLessThan(100);
  });

  it('never lets baseline credit exceed the cap', () => {
    const site = siteAt('spring', 3, 'stream_valley');
    const baseline = getRegionalBaseline('stream_valley', 'spring');
    const result = scoreCalibratedEnvironment(
      { ...readingFrom(site), temperatureC: baseline.temperatureC, humidity: baseline.humidity },
      { ...site, temperatureC: baseline.temperatureC + 10, humidity: baseline.humidity - 30 },
      'spring',
      ENVIRONMENT_WEIGHTS
    );
    for (const metric of result.metrics) {
      expect(metric.baselineCloseness).toBeLessThanOrEqual(BASELINE_CREDIT_CAP + 1e-9);
      expect(metric.factor).toBeLessThanOrEqual(1);
    }
  });
});

describe('deterministic recomputation', () => {
  it('returns identical results when recomputed with the same history', () => {
    const frames = [siteAt('spring', 1), siteAt('spring', 2), siteAt('spring', 3)];
    const current = frames[2]!;
    const reading = {
      temperatureC: current.temperatureC + 1.2,
      humidity: current.humidity + 4,
      soilMoisture: current.soilMoisture - 3,
      lightLux: current.lightLux - 4000
    };
    const first = scoreCalibratedEnvironment(reading, current, 'spring', ENVIRONMENT_WEIGHTS, frames);
    const second = scoreCalibratedEnvironment(reading, current, 'spring', ENVIRONMENT_WEIGHTS, frames);
    expect(second).toEqual(first);
  });

  it('uses different environment weight allocations for plant and environment records', () => {
    const weights = Object.values(PLANT_ENVIRONMENT_WEIGHTS).reduce((sum, value) => sum + value, 0);
    expect(weights).toBe(25);
    expect(Object.values(ENVIRONMENT_WEIGHTS).reduce((sum, value) => sum + value, 0)).toBe(100);
  });

  it('keeps every awarded metric contribution bounded and the total within 0-100', () => {
    for (const siteId of ['foothill', 'mixed_forest', 'stream_valley', 'ridge'] as const) {
      for (const season of ['spring', 'summer', 'autumn', 'winter'] as const) {
        const site = siteAt(season, 5, siteId);
        const result = scoreCalibratedEnvironment(readingFrom(site), site, season, ENVIRONMENT_WEIGHTS, [site]);
        expect(result.total).toBeGreaterThanOrEqual(0);
        expect(result.total).toBeLessThanOrEqual(100);
        for (const metric of result.metrics) {
          expect(metric.awarded).toBeLessThanOrEqual(metric.weight + 1e-9);
        }
      }
    }
  });
});
