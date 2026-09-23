import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.ts';
import { useGame } from '../game-context.tsx';

export function ReportPage() {
  const { year: yearParam } = useParams();
  const { world } = useGame();
  const fallbackYear = world.phase === 'year_review' ? world.year : Math.max(1, world.year - 1);
  const requestedYear = Number(yearParam);
  const year = Number.isInteger(requestedYear) && requestedYear > 0 ? requestedYear : fallbackYear;
  const shouldQuery = world.phase === 'year_review' || world.year > 1;
  const report = useQuery({
    queryKey: ['report', world.saveId, year],
    queryFn: () => api.getReport(world.saveId, year),
    enabled: shouldQuery,
    retry: false
  });

  if (!shouldQuery) {
    return (
      <div className="document-page empty-document">
        <p className="eyebrow">ANNUAL REPORT</p>
        <h1>第一年报告尚未生成</h1>
        <p>完成春、夏、秋、冬四季结算后，这里会显示真实的种群、分布、物候与采集归因。</p>
        <Link className="button button-primary" to="/play">返回山林继续观察</Link>
      </div>
    );
  }

  if (report.isLoading) return <p className="empty-copy">正在生成年度观察报告…</p>;
  if (report.isError || !report.data) {
    return (
      <div className="document-page empty-document">
        <p className="eyebrow">ANNUAL REPORT</p>
        <h1>该年度报告不存在</h1>
        <p>只有完整结算的年度才会写入报告。</p>
        <Link className="button button-secondary" to="/play">返回山林</Link>
      </div>
    );
  }

  const data = report.data;
  const maxMagnitude = Math.max(5, ...data.speciesChanges.map((item) => Math.abs(item.populationChangePercent)));

  return (
    <div className="document-page report-document">
      <header className="report-header">
        <p className="eyebrow">ANNUAL ECOLOGICAL REPORT · YEAR {data.year}</p>
        <h1>{data.headline}</h1>
        <p>全图种群变化 <strong className={data.populationChangePercent < 0 ? 'negative' : 'positive'}>{formatPercent(data.populationChangePercent)}</strong>，错误采集记录 {data.incorrectSamples} 次。</p>
      </header>

      <section className="report-overview">
        <div className="big-number">
          <span>全图种群变化</span>
          <strong className={data.populationChangePercent < 0 ? 'negative' : 'positive'}>{formatPercent(data.populationChangePercent)}</strong>
        </div>
        <div className="report-callout">
          <span>修复状态</span>
          <strong>{data.restorationUnlocked ? '已解锁生态修复' : '暂不需要强制修复'}</strong>
          {data.restorationUnlocked && <Link to="/play">前往当前区域执行 →</Link>}
        </div>
      </section>

      {data.environmentCalibration && data.environmentCalibration.recordCount > 0 && (
        <section className="document-section">
          <div className="section-heading">
            <div><p className="eyebrow">ENVIRONMENT CALIBRATION</p><h2>环境记录校准</h2></div>
            <span>仪器误差 · 天气突变 · 区域基线已纳入评分</span>
          </div>
          <div className="report-overview">
            <div className="big-number">
              <span>环境记录平均评分</span>
              <strong className={data.environmentCalibration.averageScore < 60 ? 'negative' : 'positive'}>
                {data.environmentCalibration.averageScore.toFixed(1)}
              </strong>
            </div>
            <div className="report-callout">
              <span>校准口径</span>
              <strong>
                {data.environmentCalibration.recordCount} 条记录 · v2 校准 {data.environmentCalibration.calibratedRecordCount} 条
                {data.environmentCalibration.legacyRecordCount > 0 && ` · 旧口径 ${data.environmentCalibration.legacyRecordCount} 条`}
              </strong>
            </div>
          </div>
        </section>
      )}

      <section className="document-section">
        <div className="section-heading">
          <div><p className="eyebrow">POPULATION CHANGE</p><h2>物种年度变化</h2></div>
          <span>横轴以年度种群变化百分比表示</span>
        </div>
        <div className="bar-chart">
          {data.speciesChanges.map((change) => (
            <div className="bar-row" key={change.speciesId}>
              <Link to={`/play/species/${change.speciesId}`}>{change.name}</Link>
              <div className="bar-track">
                <span
                  className={change.populationChangePercent < 0 ? 'bar-negative' : 'bar-positive'}
                  style={{ width: `${Math.max(3, Math.abs(change.populationChangePercent) / maxMagnitude * 100)}%` }}
                />
              </div>
              <strong className={change.populationChangePercent < 0 ? 'negative' : 'positive'}>
                {formatPercent(change.populationChangePercent)}
              </strong>
              <small>健康 {signed(change.healthChange)} · {change.status}</small>
            </div>
          ))}
        </div>
      </section>

      <section className="document-section two-document-columns">
        <div>
          <p className="eyebrow">DISTRIBUTION EVENTS</p>
          <h2>分布变化</h2>
          <ul className="insight-list">
            {data.distributionChanges.map((change) => <li key={change}>{change}</li>)}
          </ul>
        </div>
        <div>
          <p className="eyebrow">NEXT YEAR</p>
          <h2>下一年度建议</h2>
          <ol className="recommendation-list">
            {data.recommendations.map((recommendation) => <li key={recommendation}>{recommendation}</li>)}
          </ol>
        </div>
      </section>
    </div>
  );
}

function formatPercent(value: number) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function signed(value: number) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}`;
}
