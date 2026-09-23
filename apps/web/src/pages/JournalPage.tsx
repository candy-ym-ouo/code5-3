import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  SEASONS,
  SEASON_LABELS,
  SLOT_LABELS,
  type CalibrationView,
  type Season
} from '@shanhai/contracts';
import { api } from '../api.ts';
import { useGame } from '../game-context.tsx';

type EnvironmentMetricKey = 'temperatureC' | 'humidity' | 'soilMoisture' | 'lightLux';

const METRIC_LABELS: Record<EnvironmentMetricKey, string> = {
  temperatureC: '温度',
  humidity: '湿度',
  soilMoisture: '土壤',
  lightLux: '光照'
};

const METRIC_UNITS: Record<EnvironmentMetricKey, string> = {
  temperatureC: '°C',
  humidity: '%',
  soilMoisture: '%',
  lightLux: ' lux'
};

export function JournalPage() {
  const { world } = useGame();
  const [season, setSeason] = useState<Season | ''>('');
  const journal = useQuery({
    queryKey: ['journal', world.saveId, season],
    queryFn: () => api.getJournal(world.saveId, season ? { season } : {})
  });

  return (
    <div className="document-page">
      <header className="document-heading">
        <div>
          <p className="eyebrow">OBSERVATION JOURNAL</p>
          <h1>山林观察笔记</h1>
          <p>所有植物、环境与采集记录按真实游戏时间保存。</p>
        </div>
        <label className="filter-field">
          <span>季节筛选</span>
          <select value={season} onChange={(event) => setSeason(event.target.value as Season | '')}>
            <option value="">全部季节</option>
            {SEASONS.map((item) => <option key={item} value={item}>{SEASON_LABELS[item]}季</option>)}
          </select>
        </label>
      </header>

      {journal.isLoading && <p className="empty-copy">正在翻阅笔记…</p>}
      {journal.isError && <p className="form-error">笔记读取失败，请刷新重试。</p>}
      {journal.data?.entries.length === 0 && <p className="empty-copy">当前筛选下还没有记录。</p>}

      <div className="journal-grid">
        {journal.data?.entries.map((entry) => (
          <article className={`journal-card journal-${entry.kind}`} key={`${entry.kind}-${entry.id}`}>
            <div className="journal-meta">
              <span>{entry.year} 年 · {SEASON_LABELS[entry.season]}季 · 第 {entry.day} 日 {SLOT_LABELS[entry.slot - 1] ?? ''}</span>
              <span>{entry.siteName}</span>
            </div>
            <div className="journal-title">
              <h2>{entry.kind === 'sample' ? '采集记录' : entry.kind === 'environment' ? '环境记录' : entry.speciesName}</h2>
              {entry.score !== null && <strong>{entry.score.toFixed(0)} 分</strong>}
            </div>
            {entry.kind !== 'sample' && (
              <p className="calibration-badge">
                {entry.scoreVersion === 'v2' ? '校准口径 v2 · 仪器误差 / 天气突变 / 区域基线' : '旧口径 v1 · 固定阈值（保原口径）'}
              </p>
            )}
            {entry.kind === 'plant' && (
              <div className="journal-values">
                <span>物候 {String(entry.details.phenology ?? '—')}</span>
                <span>纹理 {String(entry.details.leafTexture ?? '—')}</span>
                <span>温度 {String(entry.details.temperatureC ?? '—')}°C</span>
              </div>
            )}
            {entry.kind === 'environment' && (
              <div className="journal-values">
                <span>{String(entry.details.temperatureC)}°C</span>
                <span>湿度 {String(entry.details.humidity)}%</span>
                <span>土壤 {String(entry.details.soilMoisture)}%</span>
              </div>
            )}
            {entry.kind === 'sample' && (
              <div className="journal-values">
                <span>{String(entry.details.methodLabel)}</span>
                <span className={entry.details.protocolMatch ? 'positive' : 'negative'}>
                  {entry.details.protocolMatch ? '符合协议' : '不符合协议'}
                </span>
              </div>
            )}
            {entry.calibration && <CalibrationDetail calibration={entry.calibration} />}
            {entry.note && <p>{entry.note}</p>}
            <footer>
              <time>{new Date(entry.createdAt).toLocaleString('zh-CN', { hour12: false })}</time>
              {entry.speciesId && <Link to={`/play/species/${entry.speciesId}`}>物种档案 →</Link>}
            </footer>
          </article>
        ))}
      </div>
    </div>
  );
}

function CalibrationDetail({ calibration }: { calibration: CalibrationView }) {
  const shockDrivers = calibration.weatherShock.drivers.map((driver) => METRIC_LABELS[driver.metric as EnvironmentMetricKey] ?? driver.metric);
  return (
    <div className="calibration-detail">
      <div className="calibration-flags">
        <span className={calibration.weatherShock.active ? 'cal-flag active' : 'cal-flag'}>
          天气突变{calibration.weatherShock.active ? `：${[...new Set(shockDrivers)].join('、')}${calibration.weatherShock.severeWeather ? '、剧烈天气' : ''}` : '：无'}
        </span>
        <span className={calibration.baselineAnchoredMetrics.length > 0 ? 'cal-flag active' : 'cal-flag'}>
          区域基线{calibration.baselineAnchoredMetrics.length > 0 ? `托底：${calibration.baselineAnchoredMetrics.map((metric) => METRIC_LABELS[metric as EnvironmentMetricKey]).join('、')}` : '：未触发'}
        </span>
      </div>
      <dl className="calibration-metrics">
        {calibration.metrics.map((metric) => {
          const key = metric.metric as EnvironmentMetricKey;
          const anchored = metric.baselineCloseness > metric.fieldCloseness;
          return (
            <div key={metric.metric} className={anchored ? 'cal-metric anchored' : 'cal-metric'}>
              <dt>{METRIC_LABELS[key] ?? metric.metric}</dt>
              <dd>
                读 {formatValue(metric.reading, key)} / 站 {formatValue(metric.station, key)} / 基线 {formatValue(metric.baseline, key)}
                {METRIC_UNITS[key]}
              </dd>
              <dd className="cal-tolerance">
                容差 ±{formatValue(metric.tolerance, key)}
                {metric.weatherShock && metric.weatherAllowance > 0 ? `（含突变放宽 +${formatValue(metric.weatherAllowance, key)}）` : ''}
              </dd>
              <dd className="cal-score">{metric.awarded.toFixed(1)} / {metric.weight} 分</dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

function formatValue(value: number, metric: EnvironmentMetricKey): string {
  return metric === 'lightLux' ? Math.round(value).toLocaleString() : value.toFixed(1);
}
