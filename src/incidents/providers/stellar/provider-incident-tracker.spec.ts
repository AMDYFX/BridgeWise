import {
  reportIncident,
  addOperatorNote,
  updateOperatorNote,
  getOperatorNotes,
  deleteOperatorNote,
  clearIncidents,
  resolveIncident,
  getOpenIncidents,
  getIncidentsByProvider,
  getIncidentTimeline,
} from './provider-incident-tracker';

describe('ProviderIncidentTracker - Operator Notes', () => {
  beforeEach(() => {
    clearIncidents();
  });

  it('should report an incident with empty operatorNotes array', () => {
    const incident = reportIncident({
      provider: 'AllBridge',
      severity: 'major',
      title: 'RPC Timeout',
      description: 'Stellar RPC endpoint unreachable',
      detectedAt: new Date(),
      affectedRoutes: ['xlm-eth'],
    });

    expect(incident.id).toBeDefined();
    expect(incident.operatorNotes).toEqual([]);
  });

  it('should add an operator note to an incident', () => {
    const incident = reportIncident({
      provider: 'StellarBridge',
      severity: 'minor',
      title: 'High latency',
      description: 'Latency exceeds threshold',
      detectedAt: new Date(),
      affectedRoutes: ['xlm-usdc'],
    });

    const note = addOperatorNote(incident.id, 'Alice', 'Investigating upstream validator node');

    expect(note.id).toBeDefined();
    expect(note.author).toBe('Alice');
    expect(note.content).toBe('Investigating upstream validator node');
    expect(note.createdAt).toBeInstanceOf(Date);

    const notes = getOperatorNotes(incident.id);
    expect(notes.length).toBe(1);
    expect(notes[0].id).toBe(note.id);
  });

  it('should throw when adding note to non-existent incident or with invalid params', () => {
    expect(() => addOperatorNote('non-existent', 'Alice', 'Note')).toThrow(
      'Incident with ID "non-existent" not found',
    );
    expect(() => addOperatorNote('id', '', 'Note')).toThrow('Author is required');
    expect(() => addOperatorNote('id', 'Alice', '   ')).toThrow('Content is required');
  });

  it('should update an existing operator note', () => {
    const incident = reportIncident({
      provider: 'StellarBridge',
      severity: 'minor',
      title: 'High latency',
      description: 'Latency exceeds threshold',
      detectedAt: new Date(),
      affectedRoutes: ['xlm-usdc'],
    });

    const note = addOperatorNote(incident.id, 'Alice', 'Initial investigation note');
    const updated = updateOperatorNote(incident.id, note.id, 'Updated investigation findings');

    expect(updated.id).toBe(note.id);
    expect(updated.content).toBe('Updated investigation findings');
    expect(updated.updatedAt).toBeInstanceOf(Date);

    const notes = getOperatorNotes(incident.id);
    expect(notes[0].content).toBe('Updated investigation findings');
  });

  it('should throw when updating non-existent note or empty content', () => {
    const incident = reportIncident({
      provider: 'StellarBridge',
      severity: 'minor',
      title: 'High latency',
      description: 'Latency exceeds threshold',
      detectedAt: new Date(),
      affectedRoutes: ['xlm-usdc'],
    });

    expect(() => updateOperatorNote(incident.id, 'bad-note-id', 'content')).toThrow(
      'Operator note with ID "bad-note-id" not found',
    );
    expect(() => updateOperatorNote(incident.id, 'bad-note-id', '')).toThrow(
      'Content is required',
    );
  });

  it('should delete an operator note', () => {
    const incident = reportIncident({
      provider: 'StellarBridge',
      severity: 'minor',
      title: 'High latency',
      description: 'Latency exceeds threshold',
      detectedAt: new Date(),
      affectedRoutes: ['xlm-usdc'],
    });

    const note1 = addOperatorNote(incident.id, 'Alice', 'First note');
    const note2 = addOperatorNote(incident.id, 'Bob', 'Second note');

    expect(getOperatorNotes(incident.id).length).toBe(2);

    const deleted = deleteOperatorNote(incident.id, note1.id);
    expect(deleted).toBe(true);

    const remaining = getOperatorNotes(incident.id);
    expect(remaining.length).toBe(1);
    expect(remaining[0].id).toBe(note2.id);

    expect(deleteOperatorNote(incident.id, 'unknown-id')).toBe(false);
  });

  it('should resolve incident and filter open incidents', () => {
    const inc1 = reportIncident({
      provider: 'ProviderA',
      severity: 'critical',
      title: 'Down',
      description: 'Total outage',
      detectedAt: new Date(Date.now() - 5000),
      affectedRoutes: [],
    });
    const inc2 = reportIncident({
      provider: 'ProviderB',
      severity: 'minor',
      title: 'Degraded',
      description: 'Slow responses',
      detectedAt: new Date(),
      affectedRoutes: [],
    });

    expect(getOpenIncidents().length).toBe(2);

    expect(resolveIncident(inc1.id)).toBe(true);
    expect(resolveIncident(inc1.id)).toBe(false);

    const open = getOpenIncidents();
    expect(open.length).toBe(1);
    expect(open[0].id).toBe(inc2.id);
    expect(getIncidentsByProvider('ProviderA').length).toBe(1);
    expect(getIncidentTimeline('ProviderA').length).toBe(1);
  });
});
