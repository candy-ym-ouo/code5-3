import type { EnvironmentCalibration, Season, SiteId } from '@shanhai/contracts';
import { SITES_BY_ID } from './catalog.ts';
import { SEASONAL_ENVIRONMENT_BASE, clamp, round } from './simulation.ts';
import type { SiteState } from './types.ts';

/**
 * 环境记录校准口径。
 *
 * v1（LEGACY_ENVIRONMENT_CALIBRATION_VERSION）：最初的硬阈值评分，
 * 只比较读数与环境站数据的差值，旧记录保持该口径不变。
 *
 * v2（ENVIRONMENT_CALIBRATION_VERSION）：在 v1 的权重体系上引入
 * 仪器误差（误差带内满分、带外线性衰减）、天气突变（与前一日相比
 * 天气剧变时放宽容差）和区域基线（实际环境偏离区域季节基线越多，
 * 容差越宽）。评分完全由输入决定，可按记录各自版本确定性重算。
 */
export const LEGACY_ENVIRONMENT_CALIBRATION_VERSION = 1;
export const ENVIRONMENT_CALIBRATION_VERSION = 2;

export interface EnvironmentReadings {
  temperatureC: number;
  humidity: number;
  soilMoisture: number;
  lightLux: number;
}

export interface EnvironmentCalibrationContext {
  season: Season;
  /** 记录时环境站的真实读数。 */
  site: SiteState;
  /** 前一日环境站读数，用于判定天气突变；季节首日没有前一日数据时为 null。 */
  previous?: SiteState | null;
}

type CalibrationMetric = 'temperatureC' | 'humidity' | 'soilMoisture' | 'lightLux';

interface MetricRule {
  label: string;
  weight: number;
  /** 基础容差，与 v1 阈值一致。 */
  tolerance: (expected: number) => number;
  /** 仪器固有误差，误差带内不扣分。 */
  instrumentError: (expected: number) => number;
  /** 区域基线漂移归一化到 0..0.5，用于放宽容差。 */
  baselineDrift: (expected: number, baseline: number) => number;
}

const METRIC_RULES: Record<CalibrationMetric, MetricRule> = {
  temperatureC: {
    label: '温度',
    weight: 30,
    tolerance: () => 1,
    instrumentError: () => 0.4,
    baselineDrift: (expected, baseline) => Math.min(0.5, Math.abs(expected - baseline) / 6)
  },
  humidity: {
    label: '湿度',
    weight: 25,
    tolerance: () => 5,
    instrumentError: () => 2,
    baselineDrift: (expected, baseline) => Math.min(0.5, Math.abs(expected - baseline) / 20)
  },
  soilMoisture: {
    label: '土壤含水量',
    weight: 25,
    tolerance: () => 5,
    instrumentError: () => 2,
    baselineDrift: (expected, baseline) => Math.min(0.5, Math.abs(expected - baseline) / 20)
  },
  lightLux: {
    label: '光照',
    weight: 20,
    tolerance: (expected) => Math.max(2500, expected * 0.2),
    instrumentError: (expected) => Math.max(750, expected * 0.06),
    baselineDrift: (expected, baseline) =>
      Math.min(0.5, Math.abs(expected - baseline) / Math.max(1, baseline) / 0.5)
  }
};

const METRIC_ORDER: CalibrationMetric[] = ['temperatureC', 'humidity', 'soilMoisture', 'lightLux'];

const UNSTABLE_WEATHER = new Set(['light_rain', 'heavy_rain', 'snow', 'fog']);

/** 天气突变系数：0 表示平稳，1 表示剧烈突变，用于放宽容差。 */
export function getWeatherAnomaly(
  previous: SiteState | null | undefined,
  current: SiteState
): NonNullable<EnvironmentCalibration['weatherAnomaly']> {
  if (!previous) {
    return { shift: 0, weatherChanged: false, temperatureJump: 0 };
  }
  const weatherChanged = previous.weather !== current.weather;
  const unstableInvolved = UNSTABLE_WEATHER.has(previous.weather) || UNSTABLE_WEATHER.has(current.weather);
  const temperatureJump = round(Math.abs(current.temperatureC - previous.temperatureC), 1);
  const humidityJump = Math.abs(current.humidity - previous.humidity);

  let shift = 0;
  if (weatherChanged) {
    shift += unstableInvolved ? 0.5 : 0.3;
  }
  shift += Math.min(0.3, temperatureJump / 12);
  shift += Math.min(0.2, humidityJump / 60);
  return { shift: round(clamp(shift, 0, 1), 3), weatherChanged, temperatureJump };
}

/** 区域季节基线：季节基准值叠加区域偏移，不含天气与噪声。 */
export function getRegionalBaseline(
  season: Season,
  siteId: SiteId
): NonNullable<EnvironmentCalibration['regionalBaseline']> {
  const site = SITES_BY_ID.get(siteId);
  if (!site) {
    throw new Error(`Unknown site: ${siteId}`);
  }
  const base = SEASONAL_ENVIRONMENT_BASE[season];
  return {
    temperatureC: round(base.temperatureC + site.temperatureOffset, 1),
    humidity: clamp(base.humidity + site.humidityOffset, 24, 98),
    soilMoisture: clamp(base.soilMoisture + site.soilMoistureOffset, 18, 96),
    lightLux: Math.round(base.lightLux * site.lightMultiplier)
  };
}

/** v1 原始口径：硬阈值二值评分。旧记录重算时必须复现该结果。 */
export function scoreEnvironmentLegacy(values: EnvironmentReadings, site: SiteState): number {
  let score = 0;
  if (Math.abs(values.temperatureC - site.temperatureC) <= 1) score += 30;
  if (Math.abs(values.humidity - site.humidity) <= 5) score += 25;
  if (Math.abs(values.soilMoisture - site.soilMoisture) <= 5) score += 25;
  if (Math.abs(values.lightLux - site.lightLux) <= Math.max(2500, site.lightLux * 0.2)) score += 20;
  return score;
}

/** v2 校准：仪器误差、天气突变与区域基线共同决定容差，误差带内满分、带外线性衰减。 */
export function calibrateEnvironment(
  values: EnvironmentReadings,
  context: EnvironmentCalibrationContext
): EnvironmentCalibration {
  const baseline = getRegionalBaseline(context.season, context.site.siteId);
  const anomaly = getWeatherAnomaly(context.previous, context.site);

  const components = METRIC_ORDER.map((key) => {
    const rule = METRIC_RULES[key];
    const expected = context.site[key];
    const actual = values[key];
    const delta = round(Math.abs(actual - expected), 2);
    const instrumentError = rule.instrumentError(expected);
    const drift = rule.baselineDrift(expected, baseline[key]);
    const tolerance = round(rule.tolerance(expected) * (1 + 0.6 * anomaly.shift + drift), 3);

    let score = 0;
    if (delta <= instrumentError) {
      score = rule.weight;
    } else if (delta < tolerance) {
      score = (rule.weight * (tolerance - delta)) / (tolerance - instrumentError);
    }

    return {
      metric: key,
      label: rule.label,
      expected,
      actual,
      delta,
      instrumentError: round(instrumentError, 2),
      tolerance,
      score: round(score, 2),
      maxScore: rule.weight
    };
  });

  return {
    version: ENVIRONMENT_CALIBRATION_VERSION,
    total: round(
      components.reduce((sum, component) => sum + component.score, 0),
      1
    ),
    components,
    weatherAnomaly: anomaly,
    regionalBaseline: baseline
  };
}

/** 按记录各自的校准版本确定性重算总分，用于新旧记录的一致性校验。 */
export function rescoreEnvironmentRecord(
  version: number,
  values: EnvironmentReadings,
  context: EnvironmentCalibrationContext
): number {
  if (version >= ENVIRONMENT_CALIBRATION_VERSION) {
    return calibrateEnvironment(values, context).total;
  }
  return scoreEnvironmentLegacy(values, context.site);
}
