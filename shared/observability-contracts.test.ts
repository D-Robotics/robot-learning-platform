import { describe, expect, it } from 'vitest';
import {
  OBSERVABILITY_CONTEXT_SCHEMA_VERSION,
  OBSERVABILITY_EVENT_SCHEMA_VERSION,
  OBSERVABILITY_METRIC_SCHEMA_VERSION,
  OBSERVABILITY_TELEMETRY_SCHEMA_VERSION,
  validateEdgeCommandRequest,
  validateEvidenceManifest,
  validateObservabilityContext,
  validateObservabilityEvent,
  validateObservabilityMetric,
  validateTelemetryChunk,
} from './observability-contracts.js';

const CONTEXT = {
  schemaVersion: OBSERVABILITY_CONTEXT_SCHEMA_VERSION,
  projectId: 'project-1',
  caseId: 'case-1',
  runId: 'run-1',
  deviceId: 'device-1',
  bootId: 'boot-1',
};

describe('cloud/edge observability contracts', () => {
  it('requires a versioned context and preserves optional correlation fields', () => {
    expect(validateObservabilityContext(CONTEXT).valid).toBe(true);
    expect(validateObservabilityContext({ projectId: 'project-1' }).valid).toBe(false);
  });

  it('accepts an event and rejects unscoped malformed events', () => {
    const valid = validateObservabilityEvent({
      schemaVersion: OBSERVABILITY_EVENT_SCHEMA_VERSION,
      eventId: 'event-1',
      eventType: 'device.heartbeat',
      eventVersion: '1.0',
      occurredAt: '2026-09-18T00:00:00.000Z',
      producer: 'edge-agent',
      source: 'edge-agent',
      context: CONTEXT,
      payload: { online: true },
      idempotencyKey: 'event-1',
    });
    expect(valid).toEqual({ valid: true, errors: [] });
    expect(validateObservabilityEvent({ eventType: 'device.heartbeat' }).valid).toBe(false);
  });

  it('requires units and finite values for metrics', () => {
    expect(
      validateObservabilityMetric({
        schemaVersion: OBSERVABILITY_METRIC_SCHEMA_VERSION,
        metric: 'rdk_temperature_c',
        type: 'gauge',
        timestamp: '2026-09-18T00:00:00.000Z',
        value: 54.2,
        unit: 'degC',
        source: 'board-agent',
        context: CONTEXT,
      }).valid,
    ).toBe(true);
    expect(
      validateObservabilityMetric({
        schemaVersion: OBSERVABILITY_METRIC_SCHEMA_VERSION,
        metric: 'rdk_temperature_c',
        type: 'gauge',
        timestamp: '2026-09-18T00:00:00.000Z',
        value: Number.NaN,
        source: 'board-agent',
        context: CONTEXT,
      }).valid,
    ).toBe(false);
  });

  it('checks ordered telemetry sequence ranges for cloud deduplication', () => {
    const base = {
      schemaVersion: OBSERVABILITY_TELEMETRY_SCHEMA_VERSION,
      chunkId: 'chunk-1',
      deviceId: 'device-1',
      bootId: 'boot-1',
      sequenceStart: 10,
      sequenceEnd: 11,
      sha256: 'a'.repeat(64),
      context: CONTEXT,
      samples: [
        {
          sequence: 10,
          sampleTime: '2026-09-18T00:00:00.000Z',
          sampleMonotonicNs: 100,
          source: 'board-agent',
          bootId: 'boot-1',
          signals: { temperature: { value: 50, unit: 'degC' } },
          context: CONTEXT,
        },
        {
          sequence: 11,
          sampleTime: '2026-09-18T00:00:00.020Z',
          sampleMonotonicNs: 120,
          source: 'board-agent',
          bootId: 'boot-1',
          signals: { temperature: { value: 51, unit: 'degC' } },
          context: CONTEXT,
        },
      ],
    };
    expect(validateTelemetryChunk(base).valid).toBe(true);
    expect(validateTelemetryChunk({ ...base, sequenceEnd: 12 }).valid).toBe(false);
  });

  it('requires immutable, hashed evidence files', () => {
    const result = validateEvidenceManifest({
      schemaVersion: 'rdk.observability.evidence.v1',
      evidenceId: 'evidence-1',
      kind: 'runtime-benchmark',
      context: CONTEXT,
      source: { type: 'board-agent', deviceId: 'device-1', bootId: 'boot-1' },
      files: [{ role: 'metrics', uri: 'object://metrics.json', sha256: 'b'.repeat(64), bytes: 10 }],
      createdAt: '2026-09-18T00:00:00.000Z',
      immutable: true,
    });
    expect(result.valid).toBe(true);
    expect(validateEvidenceManifest({ ...result, immutable: false }).valid).toBe(false);
  });

  it('does not permit controlled writes without an approval reference', () => {
    const request = {
      schemaVersion: 'rdk.observability.command.v1',
      commandId: 'command-1',
      capabilityId: 'device.health.read',
      deviceId: 'device-1',
      projectId: 'project-1',
      requestedBy: 'user-1',
      issuedAt: '2026-09-18T00:00:00.000Z',
      expiresAt: '2099-09-18T00:00:00.000Z',
      sideEffect: 'controlled-write',
      parameters: {},
    };
    expect(validateEdgeCommandRequest(request, Date.parse('2026-09-18T00:00:00.000Z')).valid).toBe(
      false,
    );
    expect(
      validateEdgeCommandRequest(
        { ...request, approvalRef: 'approval-1' },
        Date.parse('2026-09-18T00:00:00.000Z'),
      ).valid,
    ).toBe(true);
  });
});
