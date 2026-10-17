export interface OperatorNote {
  id: string;
  author: string;
  content: string;
  createdAt: Date;
  updatedAt?: Date;
}

export interface Incident {
  id: string;
  provider: string;
  severity: 'critical' | 'major' | 'minor';
  title: string;
  description: string;
  detectedAt: Date;
  resolvedAt?: Date;
  affectedRoutes: string[];
  operatorNotes?: OperatorNote[];
}

const incidents: Incident[] = [];

export function reportIncident(incident: Omit<Incident, 'id'>): Incident {
  const newIncident: Incident = {
    id: crypto.randomUUID(),
    operatorNotes: [],
    ...incident,
  };
  incidents.push(newIncident);
  return newIncident;
}

export function addOperatorNote(incidentId: string, author: string, content: string): OperatorNote {
  if (!author || !author.trim()) {
    throw new Error('Author is required to add an operator note');
  }
  if (!content || !content.trim()) {
    throw new Error('Content is required to add an operator note');
  }

  const incident = incidents.find(i => i.id === incidentId);
  if (!incident) {
    throw new Error(`Incident with ID "${incidentId}" not found`);
  }

  if (!incident.operatorNotes) {
    incident.operatorNotes = [];
  }

  const note: OperatorNote = {
    id: crypto.randomUUID(),
    author: author.trim(),
    content: content.trim(),
    createdAt: new Date(),
  };

  incident.operatorNotes.push(note);
  return note;
}

export function updateOperatorNote(
  incidentId: string,
  noteId: string,
  content: string,
): OperatorNote {
  if (!content || !content.trim()) {
    throw new Error('Content is required to update an operator note');
  }

  const incident = incidents.find(i => i.id === incidentId);
  if (!incident) {
    throw new Error(`Incident with ID "${incidentId}" not found`);
  }

  const note = (incident.operatorNotes || []).find(n => n.id === noteId);
  if (!note) {
    throw new Error(`Operator note with ID "${noteId}" not found on incident "${incidentId}"`);
  }

  note.content = content.trim();
  note.updatedAt = new Date();
  return note;
}

export function getOperatorNotes(incidentId: string): OperatorNote[] {
  const incident = incidents.find(i => i.id === incidentId);
  if (!incident) {
    throw new Error(`Incident with ID "${incidentId}" not found`);
  }
  return [...(incident.operatorNotes || [])];
}

export function deleteOperatorNote(incidentId: string, noteId: string): boolean {
  const incident = incidents.find(i => i.id === incidentId);
  if (!incident || !incident.operatorNotes) {
    return false;
  }

  const index = incident.operatorNotes.findIndex(n => n.id === noteId);
  if (index === -1) {
    return false;
  }

  incident.operatorNotes.splice(index, 1);
  return true;
}

export function resolveIncident(id: string): boolean {
  const incident = incidents.find(i => i.id === id);
  if (!incident || incident.resolvedAt) return false;
  incident.resolvedAt = new Date();
  return true;
}

export function getOpenIncidents(): Incident[] {
  return incidents.filter(i => !i.resolvedAt).sort((a, b) => b.detectedAt.getTime() - a.detectedAt.getTime());
}

export function getIncidentsByProvider(provider: string): Incident[] {
  return incidents.filter(i => i.provider === provider);
}

export function getIncidentTimeline(provider: string): Incident[] {
  return getIncidentsByProvider(provider).sort((a, b) => a.detectedAt.getTime() - b.detectedAt.getTime());
}

export function clearIncidents(): void {
  incidents.length = 0;
}
