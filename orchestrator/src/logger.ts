/**
 * Structured JSON Logger for the Orchestrator Service.
 *
 * WHY STRUCTURED LOGGING?
 * In a microservices architecture, structured logs (JSON) enable:
 *   1. Centralized log aggregation (ELK, Datadog, Splunk)
 *   2. Programmatic log filtering and alerting
 *   3. Correlation across services using request IDs
 *
 * This logger wraps console.log with a consistent JSON format that includes
 * timestamps, service name, event type, and arbitrary metadata.
 */

export interface LogEntry {
    service: string;
    event: string;
    timestamp: string;
    [key: string]: unknown;
}

export function logJson(event: string, metadata: Record<string, unknown> = {}): void {
    const entry: LogEntry = {
        service: "orchestrator",
        event,
        timestamp: new Date().toISOString(),
        ...metadata,
    };
    console.log(JSON.stringify(entry));
}
