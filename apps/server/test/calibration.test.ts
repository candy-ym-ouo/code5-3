import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type {
  CalibrationView,
  GameCommand,
  Season,
  WorldSnapshot
} from '@shanhai/contracts';
import { createApp } from '../src/app.ts';

describe('environment calibration (v2)', () => {
  let app: ReturnType<typeof createApp>['app'];
  let store: ReturnType<typeof createApp>['store'];
  let agent: ReturnType<typeof request.agent>;

  beforeAll(() => {
    const created = createApp({ databasePath: ':memory:', loggerEnabled: false });
    app = created.app;
    store = created.store;
    agent = request.agent(app);
  });

  afterAll(() => store.close());

  it('scores new environment records under v2 and links calibration into journal and reviews', async () => {
    const createResponse = await agent.post('/api/save').expect(201);
    let world = createResponse.body as WorldSnapshot;
    const saveId = world.saveId;

    // 记录环境：直接采用环境站读数，仪器误差范围内，应得高分且为 v2 口径。
    const foothill = world.sites.find((site) => site.id === 'foothill')!;
    world = await command(agent, world, {
      type: 'RECORD_ENVIRONMENT',
      values: {
        temperatureC: foothill.environment.temperatureC,
        humidity: foothill.environment.humidity,
        soilMoisture: foothill.environment.soilMoisture,
        lightLux: foothill.environment.lightLux,
        note: 'v2 环境记录'
      }
    });
    const envEvent = world.recentEvents[0]!;
    expect(envEvent.type).toBe('RECORD_ENVIRONMENT');

    const envRow = store.db
      .prepare('SELECT score, score_version, calibration_json FROM observations WHERE save_id = ? AND kind = ?')
      .get(saveId, 'environment') as unknown as { score: number; score_version: string; calibration_json: string };
    expect(envRow.score_version).toBe('v2');
    expect(envRow.score).toBeGreaterThan(95);
    const envCalibration = JSON.parse(envRow.calibration_json) as CalibrationView;
    expect(envCalibration.version).toBe('v2');
    expect(envCalibration.metrics).toHaveLength(4);
    expect(envCalibration.baseline.siteId).toBe('foothill');

    // 植物观察的环境子项同样是 v2 校准（本体辨识仍按原口径）。
    world = await command(agent, world, {
      type: 'OBSERVE_PLANT',
      speciesId: 'prunus-davidiana',
      values: {
        phenology: 'leafing',
        leafTexture: 'smooth',
        dominantColor: '#557a45',
        temperatureC: foothill.environment.temperatureC,
        humidity: foothill.environment.humidity,
        soilMoisture: foothill.environment.soilMoisture,
        lightLux: foothill.environment.lightLux,
        note: 'v2 植物观察'
      }
    });
    const plantRow = store.db
      .prepare('SELECT score_version, calibration_json FROM observations WHERE save_id = ? AND kind = ?')
      .get(saveId, 'plant') as unknown as { score_version: string; calibration_json: string };
    expect(plantRow.score_version).toBe('v2');
    const plantCalibration = JSON.parse(plantRow.calibration_json) as CalibrationView;
    // 植物观察环境子项权重合计 25
    expect(plantCalibration.metrics.reduce((sum, metric) => sum + metric.weight, 0)).toBe(25);

    // 日志联动：v2 记录带 scoreVersion 与 calibration，采集记录不带。
    const journal = await agent.get(`/api/save/${saveId}/journal`).expect(200);
    const entries = journal.body.entries as Array<{ kind: string; scoreVersion: string; calibration: CalibrationView | null }>;
    const environmentEntry = entries.find((entry) => entry.kind === 'environment')!;
    expect(environmentEntry.scoreVersion).toBe('v2');
    expect(environmentEntry.calibration?.version).toBe('v2');
    expect(environmentEntry.calibration?.metrics.length).toBe(4);
    const sampleEntries = entries.filter((entry) => entry.kind === 'sample');
    // 本用例尚未采集
    expect(sampleEntries.length).toBe(0);

    // 推进到第 8 日并结算春、夏两季，触发季节校准汇总。
    world = await advanceToDayEight(agent, world);
    world = await command(agent, world, { type: 'END_SEASON' });
    expect(world.phase).toBe('season_review');
    const springCalibration = world.seasonReview?.calibration;
    expect(springCalibration).toBeTruthy();
    expect(springCalibration!.calibratedCount).toBeGreaterThanOrEqual(2);
    expect(springCalibration!.legacyCount).toBe(0);
    expect(springCalibration!.bySite.some((site) => site.siteId === 'foothill')).toBe(true);
    world = await command(agent, world, { type: 'BEGIN_NEXT_SEASON' });

    // 夏、秋、冬结算到年报。
    for (const season of ['summer', 'autumn', 'winter'] as Season[]) {
      expect(world.season).toBe(season);
      world = await advanceToDayEight(agent, world);
      world = await command(agent, world, { type: 'END_SEASON' });
      if (season !== 'winter') {
        world = await command(agent, world, { type: 'BEGIN_NEXT_SEASON' });
      }
    }
    expect(world.phase).toBe('year_review');
    const annual = world.annualReview!;
    expect(annual.calibration).toBeTruthy();
    expect(annual.calibration!.calibratedCount).toBeGreaterThanOrEqual(2);
    // 年报建议中至少有一条来自校准（天气突变/基线托底/仪器核对），或保留基线建议。
    expect(Array.isArray(annual.recommendations)).toBe(true);

    const persistedReport = await agent.get(`/api/save/${saveId}/report/1`).expect(200);
    expect(persistedReport.body.calibration.calibratedCount).toBe(annual.calibration!.calibratedCount);
  });

  it('keeps legacy v1 records on their original caliber and recomputes v2 deterministically', async () => {
    const legacyAgent = request.agent(app);
    const createResponse = await legacyAgent.post('/api/save').expect(201);
    let world = createResponse.body as WorldSnapshot;
    const saveId = world.saveId;

    // 直接插入一条旧口径（v1）环境记录：不写 calibration_json，score_version 默认 v1。
    const foothill = world.sites.find((site) => site.id === 'foothill')!;
    const env = foothill.environment;
    store.db
      .prepare(
        `INSERT INTO observations
         (id, save_id, year, season, day, slot, site_id, species_id, kind, values_json,
          score, feedback_json, note, created_at)
         VALUES (?, ?, 1, 'spring', 2, 1, 'foothill', NULL, 'environment', ?, 72.5, '{"total":72.5}', '旧记录', ?)`
      )
      .run('legacy-1', saveId, JSON.stringify({ ...env, note: '旧记录' }), new Date().toISOString());

    // 再写一条 v2 记录。
    world = await command(legacyAgent, world, {
      type: 'RECORD_ENVIRONMENT',
      values: {
        temperatureC: env.temperatureC,
        humidity: env.humidity,
        soilMoisture: env.soilMoisture,
        lightLux: env.lightLux,
        note: '新记录'
      }
    });

    const rows = store.db
      .prepare('SELECT score, score_version, calibration_json FROM observations WHERE save_id = ? ORDER BY created_at ASC')
      .all(saveId) as unknown as Array<{ score: number; score_version: string; calibration_json: string }>;
    const legacy = rows[0]!;
    expect(legacy.score_version).toBe('v1');
    expect(legacy.score).toBeCloseTo(72.5, 5);
    expect(legacy.calibration_json ?? '').toBe('');
    expect(rows[1]!.score_version).toBe('v2');

    // 季节汇总：旧记录计入 legacyCount 但不参与 v2 平均；新记录参与。
    world = await advanceToDayEight(legacyAgent, world);
    world = await command(legacyAgent, world, { type: 'END_SEASON' });
    const calibration = world.seasonReview!.calibration!;
    expect(calibration.legacyCount).toBe(1);
    expect(calibration.calibratedCount).toBe(1);
    expect(calibration.averageScore).toBeGreaterThan(90);

    // 新旧重算结果一致：用同一输入再次计算 v2，得到完全相同的 JSON。
    const { getRegionalBaseline, scoreCalibratedEnvironment, ENVIRONMENT_WEIGHTS } = await import('@shanhai/game-core');
    const historyRows = store.db
      .prepare('SELECT * FROM environment_history WHERE save_id = ? ORDER BY day ASC')
      .all(saveId) as unknown as Array<Record<string, unknown>>;
    const history = historyRows.map((row) => ({
      saveId: saveId,
      year: 1,
      siteId: String(row.site_id) as never,
      weather: String(row.weather),
      temperatureC: Number(row.temperature_c),
      humidity: Number(row.humidity),
      soilMoisture: Number(row.soil_moisture),
      lightLux: Number(row.light_lux),
      windSpeed: Number(row.wind_speed),
      disturbance: Number(row.disturbance)
    }));
    const current = history.find((entry) => entry.siteId === 'foothill')!;
    const reading = {
      temperatureC: env.temperatureC,
      humidity: env.humidity,
      soilMoisture: env.soilMoisture,
      lightLux: env.lightLux
    };
    const first = scoreCalibratedEnvironment(reading, current, 'spring', ENVIRONMENT_WEIGHTS, history);
    const second = scoreCalibratedEnvironment(reading, current, 'spring', ENVIRONMENT_WEIGHTS, history);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(second.total).toBe(rows[1]!.score);

    // 区域基线确定性
    expect(getRegionalBaseline('foothill', 'spring').temperatureC).toBeDefined();
    expect(getRegionalBaseline('foothill', 'spring')).toEqual(getRegionalBaseline('foothill', 'spring'));
  });
});

async function command(
  agent: ReturnType<typeof request.agent>,
  world: WorldSnapshot,
  commandBody: GameCommand
): Promise<WorldSnapshot> {
  const response = await agent
    .post(`/api/save/${world.saveId}/commands`)
    .send({
      expectedRevision: world.revision,
      idempotencyKey: `cal-${world.revision}-${commandBody.type}-${Math.random().toString(16).slice(2)}`,
      command: commandBody
    });
  if (response.status !== 200) {
    throw new Error(`${commandBody.type} failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body.world as WorldSnapshot;
}

async function advanceToDayEight(
  agent: ReturnType<typeof request.agent>,
  initialWorld: WorldSnapshot
): Promise<WorldSnapshot> {
  let world = initialWorld;
  let guard = 0;
  while (world.day < 8) {
    world = await command(agent, world, { type: 'WAIT' });
    guard += 1;
    if (guard > 40) {
      throw new Error('Unable to advance to day 8');
    }
  }
  return world;
}
