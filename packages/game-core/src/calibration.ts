import type { Season, SiteId } from '@shanhai/contracts';
import { SITES_BY_ID } from './catalog.ts';
import {
  BASE_HUMIDITY,
  BASE_SOIL,
  BASE_TEMPERATURE,
  SEASON_LIGHT_BASE,
  WEATHER_LIGHT_FACTOR,
  clamp,
  round
} from './simulation.ts';
import type { SiteState } from './types.ts';

/**
 * 环境记录校准（v2 口径）。
 *
 * 旧记录继续使用 v1 的固定阈值口径（写入时即定分，此后不再重算），新记录统一走
 * 本模块的 v2 口径。三个校准来源各自独立、可追溯，并完整写入
 * observations.calibration_json：
 *
 * - 仪器误差 instrument：每类传感器的允许误差，构成读数相对环境站真值的基础容差带；
 * - 天气突变 weatherShock：当本时次相对上一记录时次发生剧烈天气切换或要素跃变时，
 *   在仪器容差之外放宽判定（现场仪器对突变的响应滞后不可视为读错）；
 * - 区域基线 baseline：用站点季节气候学基线解释"真值本身偏离常年值"的情况，
 *   即便读数离环境站瞬时值较远，只要贴近区域季节基线，仍给予封顶的基线分。
 *
 * 该模块为纯函数，相同输入恒定得到相同输出，因此任何时次都能用同一套历史重新
 * 复算并得到一致结果。
 */

export const CALIBRATION_VERSION = 'v2' as const;
export type ScoreVersion = 'v1' | 'v2';

export type EnvironmentMetricKey = 'temperatureC' | 'humidity' | 'soilMoisture' | 'lightLux';

export interface InstrumentSpec {
  /** 传感器系统误差（与读数同量纲）。 */
  bias: number;
  /** 传感器随机误差（与读数同量纲）。 */
  precision: number;
  label: string;
  unit: string;
}

/** 仪器误差带 = bias + precision，即读数落在真值 ±该范围内视为仪器正常。 */
export const INSTRUMENT_SPECS: Record<EnvironmentMetricKey, InstrumentSpec> = {
  temperatureC: { bias: 0.3, precision: 0.5, label: '温度传感器', unit: '°C' },
  humidity: { bias: 2, precision: 3, label: '湿度传感器', unit: '%' },
  soilMoisture: { bias: 2, precision: 4, label: '土壤水分传感器', unit: '%' },
  lightLux: { bias: 1200, precision: 2200, label: '光照传感器', unit: 'lux' }
};

/** 天气突变时容差带在仪器误差之外再放宽的倍数。 */
export const WEATHER_SHOCK_TOLERANCE_FACTOR = 1.7;

/** 区域基线锚定分的封顶比例（只能托底，不能超过现场贴近真值的得分）。 */
export const BASELINE_CREDIT_CAP = 0.55;

/** 剧烈天气类型：本身即视为一次天气突变。 */
const SEVERE_WEATHER = new Set(['heavy_rain', 'snow', 'fog']);

/** 相邻时次天气要素跃变阈值（达到任一即视为天气突变）。 */
const WEATHER_SHOCK_THRESHOLDS = {
  temperatureC: 4.5,
  humidity: 14,
  soilMoisture: 12,
  lightLux: 16000
} as const;

export interface RegionalBaseline {
  siteId: SiteId;
  season: Season;
  temperatureC: number;
  humidity: number;
  soilMoisture: number;
  lightLux: number;
}

export interface WeatherShock {
  active: boolean;
  severeWeather: boolean;
  transition: boolean;
  /** 触发突变的要素及其相对上一时次的变化量。 */
  drivers: Array<{ metric: EnvironmentMetricKey; delta: number; threshold: number }>;
}

export interface CalibratedMetric {
  metric: EnvironmentMetricKey;
  /** 观察者读数。 */
  reading: number;
  /** 环境站真值（本时次）。 */
  station: number;
  /** 区域季节气候学基线。 */
  baseline: number;
  /** 仪器允许误差（bias + precision）。 */
  instrumentTolerance: number;
  /** 天气突变放宽量（无突变时为 0）。 */
  weatherAllowance: number;
  /** 实际采用的总容差带。 */
  tolerance: number;
  /** 读数与环境站真值偏差。 */
  deviation: number;
  weatherShock: boolean;
  /** 现场贴近真值得到的归一化分（0-1）。 */
  fieldCloseness: number;
  /** 贴近区域基线得到的归一化分（0-1，封顶 BASELINE_CREDIT_CAP）。 */
  baselineCloseness: number;
  /** 归一化系数（0-1）。 */
  factor: number;
  weight: number;
  /** 该要素加权后的得分。 */
  awarded: number;
}

export interface CalibrationResult {
  version: typeof CALIBRATION_VERSION;
  total: number;
  metrics: CalibratedMetric[];
  weatherShock: WeatherShock;
  instrument: Record<EnvironmentMetricKey, { bias: number; precision: number }>;
  baseline: RegionalBaseline;
  /** 本次评分中真正发挥托底作用的要素（baselineCloseness > fieldCloseness）。 */
  baselineAnchoredMetrics: EnvironmentMetricKey[];
}

/**
 * 重建某区域在某季节的气候学基线（与 generateSiteState 的多年平均口径一致：
 * 取第 1 年、零日噪声、中性天气因子）。这是确定性的纯函数。
 */
export function getRegionalBaseline(siteId: SiteId, season: Season): RegionalBaseline {
  const site = SITES_BY_ID.get(siteId);
  if (!site) {
    throw new Error(`Unknown site: ${siteId}`);
  }
  return {
    siteId,
    season,
    temperatureC: round(BASE_TEMPERATURE[season] + site.temperatureOffset, 1),
    humidity: round(clamp(BASE_HUMIDITY[season] + site.humidityOffset, 24, 98), 1),
    soilMoisture: round(clamp(BASE_SOIL[season] + site.soilMoistureOffset, 18, 96), 1),
    lightLux: Math.round(SEASON_LIGHT_BASE[season] * site.lightMultiplier * (WEATHER_LIGHT_FACTOR.sunny ?? 1.2))
  };
}

/**
 * 判定本时次相对上一记录时次是否构成天气突变。
 * 上一时次缺省时（季首），仅以剧烈天气类型判定。
 */
export function detectWeatherShock(current: SiteState, previous: SiteState | null): WeatherShock {
  const severeWeather = SEVERE_WEATHER.has(current.weather);
  const drivers: WeatherShock['drivers'] = [];

  if (previous) {
    (Object.keys(WEATHER_SHOCK_THRESHOLDS) as EnvironmentMetricKey[]).forEach((metric) => {
      const delta = Math.abs(current[metric] - previous[metric]);
      const threshold = WEATHER_SHOCK_THRESHOLDS[metric];
      if (delta >= threshold) {
        drivers.push({ metric, delta: round(delta, metric === 'lightLux' ? 0 : 1), threshold });
      }
    });
  }

  const transition = drivers.length > 0;
  return {
    active: severeWeather || transition,
    severeWeather,
    transition,
    drivers
  };
}

/**
 * v2 校准评分。
 *
 * @param reading 观察者记录的四个环境要素
 * @param site    本时次环境站状态（真值）
 * @param season  当前季节（SiteState 不携带季节，由调用方传入）
 * @param weights 各要素权重（环境记录与植物观察的环境子项权重不同）
 * @param history 同一季内按日升序的环境站历史（用于天气突变判定），可跨区域
 */
export function scoreCalibratedEnvironment(
  reading: Record<EnvironmentMetricKey, number>,
  site: SiteState,
  season: Season,
  weights: Record<EnvironmentMetricKey, number>,
  history: SiteState[] = []
): CalibrationResult {
  const previous = pickPreviousSnapshot(history, site.siteId);
  const weatherShock = detectWeatherShock(site, previous);
  const baseline = getRegionalBaseline(site.siteId, season);

  const metrics = (Object.keys(weights) as EnvironmentMetricKey[]).map((metric) => {
    const spec = INSTRUMENT_SPECS[metric];
    const instrumentTolerance = spec.bias + spec.precision;
    const weatherAllowance = weatherShock.active
      ? instrumentTolerance * (WEATHER_SHOCK_TOLERANCE_FACTOR - 1)
      : 0;
    const tolerance = instrumentTolerance + weatherAllowance;

    const station = site[metric];
    const value = reading[metric];
    const deviation = Math.abs(value - station);

    // 现场贴近真值：偏差在仪器容差（含天气放宽）内满分，超出后按容差线性衰减到 0。
    const fieldCloseness = clamp(1 - Math.max(0, deviation - tolerance) / Math.max(tolerance, 1), 0, 1);

    // 区域基线锚定：读数相对季节气候学基线的贴合度，封顶托底。
    const baselineDeviation = Math.abs(value - baseline[metric]);
    const baselineScale = baselineScaleFor(metric);
    const baselineCloseness =
      clamp(1 - Math.max(0, baselineDeviation - instrumentTolerance) / baselineScale, 0, 1) *
      BASELINE_CREDIT_CAP;

    const factor = Math.max(fieldCloseness, baselineCloseness);
    const weight = weights[metric];
    return {
      metric,
      reading: round(value, metric === 'lightLux' ? 0 : 1),
      station: round(station, metric === 'lightLux' ? 0 : 1),
      baseline: round(baseline[metric], metric === 'lightLux' ? 0 : 1),
      instrumentTolerance: round(instrumentTolerance, metric === 'lightLux' ? 0 : 1),
      weatherAllowance: round(weatherAllowance, metric === 'lightLux' ? 0 : 1),
      tolerance: round(tolerance, metric === 'lightLux' ? 0 : 1),
      deviation: round(deviation, metric === 'lightLux' ? 0 : 1),
      weatherShock: weatherShock.active,
      fieldCloseness: round(fieldCloseness, 3),
      baselineCloseness: round(baselineCloseness, 3),
      factor: round(factor, 3),
      weight,
      awarded: round(factor * weight, 2)
    } satisfies CalibratedMetric;
  });

  const total = round(
    metrics.reduce((sum, item) => sum + item.awarded, 0),
    1
  );
  const baselineAnchoredMetrics = metrics
    .filter((item) => item.baselineCloseness > item.fieldCloseness)
    .map((item) => item.metric);

  return {
    version: CALIBRATION_VERSION,
    total,
    metrics,
    weatherShock,
    instrument: Object.fromEntries(
      (Object.keys(INSTRUMENT_SPECS) as EnvironmentMetricKey[]).map((key) => [
        key,
        { bias: INSTRUMENT_SPECS[key].bias, precision: INSTRUMENT_SPECS[key].precision }
      ])
    ) as CalibrationResult['instrument'],
    baseline,
    baselineAnchoredMetrics
  };
}

/** 环境记录（RECORD_ENVIRONMENT）四要素权重，合计 100。 */
export const ENVIRONMENT_WEIGHTS: Record<EnvironmentMetricKey, number> = {
  temperatureC: 30,
  humidity: 25,
  soilMoisture: 25,
  lightLux: 20
};

/** 植物观察（OBSERVE_PLANT）中环境子项的权重，合计 25（其余 75 为物候/纹理/颜色）。 */
export const PLANT_ENVIRONMENT_WEIGHTS: Record<EnvironmentMetricKey, number> = {
  temperatureC: 8,
  humidity: 7,
  soilMoisture: 5,
  lightLux: 5
};

/**
 * 区域基线线性衰减尺度：用于把"偏离基线多远"映射到 0-1。
 * 光照量纲大，单独给一个较宽的尺度，其余沿用仪器容差的若干倍。
 */
function baselineScaleFor(metric: EnvironmentMetricKey): number {
  switch (metric) {
    case 'temperatureC':
      return 4;
    case 'humidity':
      return 18;
    case 'soilMoisture':
      return 18;
    case 'lightLux':
      return 22000;
  }
}

function pickPreviousSnapshot(history: SiteState[], siteId: SiteId): SiteState | null {
  // history 由调用方限定为同一季并按"日"升序给出，每天每区域只有一帧，
  // 最后一帧即本时次（今天）环境站状态，因此上一记录时次取倒数第二帧。
  const sameSite = history.filter((entry) => entry.siteId === siteId);
  return sameSite.length >= 2 ? sameSite[sameSite.length - 2]! : null;
}
