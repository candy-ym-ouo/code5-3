import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { GameCommand, Season, WorldSnapshot } from '@shanhai/contracts';
import { scoreEnvironmentLegacy } from '@shanhai/game-core';
import { createApp } from '../src/app.ts';

describe('closed-loop API', () => {
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

  it('accepts configured browser origins and rejects unknown origins', async () => {
    await request(app)
      .post('/api/save')
      .set('Origin', 'http://127.0.0.1:5173')
      .expect(201);
    await request(app)
      .post('/api/save')
      .set('Origin', 'https://attacker.example')
      .expect(403);
  });

  it('returns a client error for malformed JSON', async () => {
    await request(app)
      .post('/api/save/import')
      .set('Content-Type', 'application/json')
      .send('{"token":')
      .expect(400)
      .expect((response) => {
        expect(response.body.code).toBe('INVALID_JSON');
      });
  });

  it('creates, observes, samples, evolves and continues into the next year', async () => {
    const createResponse = await agent.post('/api/save').expect(201);
    let world = createResponse.body as WorldSnapshot;
    expect(world.year).toBe(1);
    expect(world.season).toBe('spring');
    expect(world.sites.length).toBe(4);
    const baseline = store.db
      .prepare('SELECT year_start_species_json FROM saves WHERE id = ?')
      .get(world.saveId) as unknown as { year_start_species_json: string };
    expect(JSON.parse(baseline.year_start_species_json).length).toBeGreaterThan(0);

    world = await command(agent, world, {
      type: 'OBSERVE_PLANT',
      speciesId: 'prunus-davidiana',
      values: {
        phenology: 'leafing',
        leafTexture: 'smooth',
        dominantColor: '#557a45',
        temperatureC: 16,
        humidity: 60,
        soilMoisture: 50,
        lightLux: 30000,
        note: '自动化闭环观察'
      }
    });
    expect(world.recentEvents[0]?.type).toBe('OBSERVE_PLANT');

    const currentSite = world.sites.find((site) => site.current)!;
    const environmentResponse = await agent
      .post(`/api/save/${world.saveId}/commands`)
      .send({
        expectedRevision: world.revision,
        idempotencyKey: `test-env-${Math.random().toString(16).slice(2)}`,
        command: {
          type: 'RECORD_ENVIRONMENT',
          values: {
            temperatureC: currentSite.environment.temperatureC,
            humidity: currentSite.environment.humidity,
            soilMoisture: currentSite.environment.soilMoisture,
            lightLux: currentSite.environment.lightLux,
            note: '自动化环境校准记录'
          }
        }
      })
      .expect(200);
    expect(environmentResponse.body.evaluation.version).toBe(2);
    expect(environmentResponse.body.evaluation.components).toHaveLength(4);
    expect(environmentResponse.body.evaluation.total).toBe(100);
    expect(environmentResponse.body.evaluation.regionalBaseline).toBeTruthy();
    world = environmentResponse.body.world as WorldSnapshot;

    // 模拟一条 v1 旧口径环境记录：保持原评分，重算时必须按 v1 复现。
    const historyRow = store.db
      .prepare(
        `SELECT * FROM environment_history
         WHERE save_id = ? AND year = 1 AND season = 'spring' AND day = 1 AND site_id = 'foothill'`
      )
      .get(world.saveId) as unknown as {
      weather: string;
      temperature_c: number;
      humidity: number;
      soil_moisture: number;
      light_lux: number;
      wind_speed: number;
      disturbance: number;
    };
    const legacyValues = {
      temperatureC: historyRow.temperature_c + 0.4,
      humidity: historyRow.humidity - 7,
      soilMoisture: historyRow.soil_moisture,
      lightLux: historyRow.light_lux,
      note: '旧口径环境记录'
    };
    const legacyScore = scoreEnvironmentLegacy(legacyValues, {
      saveId: world.saveId,
      year: 1,
      siteId: 'foothill',
      weather: historyRow.weather,
      temperatureC: historyRow.temperature_c,
      humidity: historyRow.humidity,
      soilMoisture: historyRow.soil_moisture,
      lightLux: historyRow.light_lux,
      windSpeed: historyRow.wind_speed,
      disturbance: historyRow.disturbance
    });
    expect(legacyScore).toBe(75);
    store.db
      .prepare(
        `INSERT INTO observations
         (id, save_id, year, season, day, slot, site_id, species_id, kind, values_json,
          score, feedback_json, note, created_at)
         VALUES (?, ?, 1, 'spring', 1, 1, 'foothill', NULL, 'environment', ?, ?, '{}', '旧口径环境记录', ?)`
      )
      .run(randomUUID(), world.saveId, JSON.stringify(legacyValues), legacyScore, new Date().toISOString());

    const beforeSample = world.sites
      .flatMap((site) => site.species)
      .find((species) => species.id === 'prunus-davidiana')!;
    world = await command(agent, world, {
      type: 'TAKE_SAMPLE',
      speciesId: 'prunus-davidiana',
      method: 'litter'
    });
    const afterSample = world.sites
      .flatMap((site) => site.species)
      .find((species) => species.id === 'prunus-davidiana')!;
    expect(afterSample.health).toBeLessThan(beforeSample.health);
    expect(world.recentEvents[0]?.message).toContain('不符合采集协议');

    const requestBody = {
      expectedRevision: world.revision,
      idempotencyKey: 'idempotency-test-key-001',
      command: { type: 'WAIT' as const }
    };
    const first = await agent.post(`/api/save/${world.saveId}/commands`).send(requestBody).expect(200);
    const second = await agent.post(`/api/save/${world.saveId}/commands`).send(requestBody).expect(200);
    expect(second.body.world.revision).toBe(first.body.world.revision);
    expect(second.body.event.id).toBe(first.body.event.id);
    world = first.body.world as WorldSnapshot;

    for (const season of ['spring', 'summer', 'autumn', 'winter'] as Season[]) {
      expect(world.season).toBe(season);
      world = await advanceToDayEight(agent, world);
      world = await command(agent, world, { type: 'END_SEASON' });
      if (season !== 'winter') {
        expect(world.phase).toBe('season_review');
        world = await command(agent, world, { type: 'BEGIN_NEXT_SEASON' });
      }
    }

    expect(world.phase).toBe('year_review');
    expect(world.annualReview?.year).toBe(1);
    expect(world.annualReview?.incorrectSamples).toBeGreaterThan(0);
    expect(world.annualReview?.speciesChanges.length).toBeGreaterThan(0);
    expect(world.annualReview?.speciesChanges.some((item) => item.populationChangePercent === 100)).toBe(false);
    expect(world.annualReview?.populationChangePercent).not.toBe(100);
    expect(world.annualReview?.speciesChanges.every((item) => Number.isFinite(item.populationChangePercent))).toBe(true);
    expect(world.annualReview?.speciesChanges.every((item) => Number.isFinite(item.healthChange))).toBe(true);
    expect(world.annualReview?.environmentCalibration?.recordCount).toBe(2);
    expect(world.annualReview?.environmentCalibration?.calibratedRecordCount).toBe(1);
    expect(world.annualReview?.environmentCalibration?.legacyRecordCount).toBe(1);

    world = await command(agent, world, { type: 'BEGIN_NEXT_YEAR' });
    expect(world.year).toBe(2);
    expect(world.season).toBe('spring');
    expect(world.phase).toBe('active');

    const journal = await agent.get(`/api/save/${world.saveId}/journal`).expect(200);
    expect(journal.body.entries.length).toBeGreaterThan(0);
    expect(journal.body.entries.find((entry: { kind: string }) => entry.kind === 'sample').slot).toBeGreaterThan(0);
    const environmentEntries = journal.body.entries.filter(
      (entry: { kind: string }) => entry.kind === 'environment'
    ) as Array<{ calibration?: { version: number; components: unknown[] } | null }>;
    expect(environmentEntries.some((entry) => entry.calibration?.version === 2)).toBe(true);
    expect(environmentEntries.some((entry) => entry.calibration?.version === 1)).toBe(true);
    expect(environmentEntries.find((entry) => entry.calibration?.version === 2)?.calibration?.components).toHaveLength(4);
    expect(environmentEntries.find((entry) => entry.calibration?.version === 1)?.calibration?.components).toHaveLength(0);
    const historyCount = store.db
      .prepare('SELECT COUNT(*) AS count FROM environment_history WHERE save_id = ?')
      .get(world.saveId) as unknown as { count: number };
    expect(Number(historyCount.count)).toBeGreaterThan(0);
    const report = await agent.get(`/api/save/${world.saveId}/report/1`).expect(200);
    expect(report.body.year).toBe(1);
    expect(report.body.environmentCalibration.recordCount).toBe(2);

    const verification = await agent.get(`/api/save/${world.saveId}/calibration/verify`).expect(200);
    expect(verification.body.consistent).toBe(true);
    expect(verification.body.checked).toBe(2);
    expect(verification.body.byVersion['1']).toBe(1);
    expect(verification.body.byVersion['2']).toBe(1);
    expect(verification.body.mismatches).toHaveLength(0);

    const firstExport = await agent.post(`/api/save/${world.saveId}/export`).expect(200);
    expect(firstExport.body.token).toHaveLength(43);
    const latestExport = await agent.post(`/api/save/${world.saveId}/export`).expect(200);
    await agent.post('/api/save/import').send({ token: firstExport.body.token }).expect(400);
    const imported = await agent.post('/api/save/import').send({ token: latestExport.body.token }).expect(200);
    expect(imported.body.saveId).toBe(world.saveId);
    expect(imported.body.year).toBe(2);
    expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  }, 30_000);
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
      idempotencyKey: `test-${world.revision}-${commandBody.type}-${Math.random().toString(16).slice(2)}`,
      command: commandBody
    });
  if (response.status !== 200) {
    throw new Error(
      `${commandBody.type} failed at year ${world.year} ${world.season} day ${world.day}: ${response.status} ${JSON.stringify(response.body)}`
    );
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
