/**
 * Mock IT Help Desk Tools.
 *
 * WHY MOCK TOOLS?
 * These simulate real enterprise integrations (ITSM, CMDB, license management)
 * without requiring external databases or APIs. The data is hardcoded but
 * realistic, enabling the orchestrator to demonstrate multi-step reasoning:
 *
 *   User: "I need Photoshop"
 *   → Orchestrator checks entitlement → finds user isn't entitled
 *   → searches IT handbook for software request process → returns instructions
 *
 * TO MAKE REAL: Replace each function body with actual API/DB calls.
 * The function signatures and return types would stay the same.
 */

import { logJson } from "./logger";

// ---------------------------------------------------------------------------
// Type Definitions
// ---------------------------------------------------------------------------

export interface Ticket {
    ticketId: string;
    employeeId: string;
    subject: string;
    description: string;
    priority: "P1" | "P2" | "P3" | "P4";
    status: "Open" | "In Progress" | "Resolved" | "Closed";
    createdAt: string;
}

export interface SoftwareEntitlement {
    softwareName: string;
    isEntitled: boolean;
    licenseType?: string;
    expiresAt?: string;
}

// ---------------------------------------------------------------------------
// Mock Data Store
// WHY IN-MEMORY? This project explicitly requires no external DBs.
// A Map simulates a ticket database; new tickets persist for the session.
// ---------------------------------------------------------------------------

const ticketStore: Map<string, Ticket[]> = new Map([
    [
        "EMP001",
        [
            {
                ticketId: "INC-1001",
                employeeId: "EMP001",
                subject: "VPN Connection Dropping",
                description: "VPN disconnects every 30 minutes when on home Wi-Fi.",
                priority: "P3",
                status: "Open",
                createdAt: "2024-01-15T10:30:00Z",
            },
            {
                ticketId: "INC-1002",
                employeeId: "EMP001",
                subject: "Laptop Battery Draining Fast",
                description: "Battery lasts only 2 hours. Asset tag: DL-5540-A1234.",
                priority: "P4",
                status: "In Progress",
                createdAt: "2024-01-10T08:15:00Z",
            },
        ],
    ],
    [
        "EMP002",
        [
            {
                ticketId: "INC-2001",
                employeeId: "EMP002",
                subject: "Cannot Access SharePoint",
                description: "Getting 403 error when accessing team SharePoint site.",
                priority: "P2",
                status: "Open",
                createdAt: "2024-01-14T14:00:00Z",
            },
        ],
    ],
    [
        "EMP003",
        [],  // Employee exists but has no tickets
    ],
]);

const entitlementStore: Map<string, SoftwareEntitlement[]> = new Map([
    [
        "EMP001",
        [
            { softwareName: "Microsoft 365", isEntitled: true, licenseType: "E3", expiresAt: "2025-12-31" },
            { softwareName: "Slack", isEntitled: true, licenseType: "Enterprise", expiresAt: "2025-06-30" },
            { softwareName: "Adobe Photoshop", isEntitled: false },
            { softwareName: "Zoom", isEntitled: true, licenseType: "Business", expiresAt: "2025-12-31" },
        ],
    ],
    [
        "EMP002",
        [
            { softwareName: "Microsoft 365", isEntitled: true, licenseType: "E5", expiresAt: "2025-12-31" },
            { softwareName: "Slack", isEntitled: true, licenseType: "Enterprise", expiresAt: "2025-06-30" },
            { softwareName: "Adobe Photoshop", isEntitled: true, licenseType: "Creative Cloud", expiresAt: "2025-03-31" },
            { softwareName: "IntelliJ IDEA", isEntitled: true, licenseType: "Ultimate", expiresAt: "2025-09-30" },
        ],
    ],
    [
        "EMP003",
        [
            { softwareName: "Microsoft 365", isEntitled: true, licenseType: "E3", expiresAt: "2025-12-31" },
            { softwareName: "Slack", isEntitled: true, licenseType: "Free", expiresAt: "2025-06-30" },
        ],
    ],
]);

// Ticket ID counter for new ticket creation
let ticketCounter = 4100;

// ---------------------------------------------------------------------------
// Tool Implementations
// ---------------------------------------------------------------------------

/**
 * Get all support tickets for an employee.
 *
 * WHY THIS TOOL? In a real IT help desk, agents need to check existing tickets
 * before creating duplicates. This lets the orchestrator say "You already have
 * an open ticket about this issue (INC-1001)."
 */
export async function getEmployeeTickets(employeeId: string): Promise<{
    success: boolean;
    tickets: Ticket[];
    message: string;
}> {
    logJson("tool_invoked", { tool: "getEmployeeTickets", employeeId });

    // Simulate network latency (50-150ms)
    await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 100));

    const tickets = ticketStore.get(employeeId);

    if (tickets === undefined) {
        logJson("tool_result", {
            tool: "getEmployeeTickets",
            employeeId,
            result: "employee_not_found",
        });
        return {
            success: false,
            tickets: [],
            message: `Employee ${employeeId} not found in the system.`,
        };
    }

    logJson("tool_result", {
        tool: "getEmployeeTickets",
        employeeId,
        ticketCount: tickets.length,
    });

    return {
        success: true,
        tickets,
        message: tickets.length > 0
            ? `Found ${tickets.length} ticket(s) for ${employeeId}.`
            : `No tickets found for ${employeeId}.`,
    };
}

/**
 * Create a new support ticket.
 *
 * WHY THIS TOOL? The core action of a help desk — when a user reports an issue,
 * the orchestrator can create a ticket on their behalf and return the ticket ID
 * for tracking.
 */
export async function createSupportTicket(
    employeeId: string,
    subject: string,
    description: string,
    priority: "P1" | "P2" | "P3" | "P4"
): Promise<{ success: boolean; ticket?: Ticket; message: string }> {
    logJson("tool_invoked", {
        tool: "createSupportTicket",
        employeeId,
        subject,
        priority,
    });

    // Simulate network latency
    await new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 150));

    // Validate the employee exists (or create an entry for unknown employees)
    if (!ticketStore.has(employeeId)) {
        // WHY AUTO-CREATE? In a real system, we'd validate against HR/AD. Here,
        // we're lenient to make the demo more forgiving.
        ticketStore.set(employeeId, []);
    }

    ticketCounter++;
    const newTicket: Ticket = {
        ticketId: `INC-${ticketCounter}`,
        employeeId,
        subject,
        description,
        priority,
        status: "Open",
        createdAt: new Date().toISOString(),
    };

    ticketStore.get(employeeId)!.push(newTicket);

    logJson("tool_result", {
        tool: "createSupportTicket",
        ticketId: newTicket.ticketId,
        employeeId,
        status: "created",
    });

    return {
        success: true,
        ticket: newTicket,
        message: `Ticket ${newTicket.ticketId} created successfully with priority ${priority}.`,
    };
}

/**
 * Check if an employee is entitled to a specific software license.
 *
 * WHY THIS TOOL? Before telling a user "go download Photoshop," the agent
 * should verify they actually have a license. This enables nuanced responses:
 * "You're not entitled to Photoshop. To request access, submit a Software
 * Access Request per the IT Handbook."
 */
export async function checkSoftwareEntitlement(
    employeeId: string,
    softwareName: string
): Promise<{
    success: boolean;
    entitlement?: SoftwareEntitlement;
    message: string;
}> {
    logJson("tool_invoked", {
        tool: "checkSoftwareEntitlement",
        employeeId,
        softwareName,
    });

    // Simulate network latency
    await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 100));

    const entitlements = entitlementStore.get(employeeId);

    if (!entitlements) {
        logJson("tool_result", {
            tool: "checkSoftwareEntitlement",
            employeeId,
            result: "employee_not_found",
        });
        return {
            success: false,
            message: `Employee ${employeeId} not found in the entitlement system.`,
        };
    }

    // Case-insensitive search for the software
    // WHY CASE-INSENSITIVE? Users might type "photoshop" or "Photoshop" or
    // "PHOTOSHOP". We normalize to avoid false negatives.
    const entitlement = entitlements.find(
        (e) => e.softwareName.toLowerCase() === softwareName.toLowerCase()
    );

    if (!entitlement) {
        logJson("tool_result", {
            tool: "checkSoftwareEntitlement",
            employeeId,
            softwareName,
            result: "software_not_found",
        });
        return {
            success: true,
            entitlement: { softwareName, isEntitled: false },
            message: `${softwareName} is not in the entitlement catalog for ${employeeId}. They may need to submit a Software Access Request.`,
        };
    }

    logJson("tool_result", {
        tool: "checkSoftwareEntitlement",
        employeeId,
        softwareName,
        isEntitled: entitlement.isEntitled,
    });

    return {
        success: true,
        entitlement,
        message: entitlement.isEntitled
            ? `${employeeId} is entitled to ${softwareName} (${entitlement.licenseType}, expires ${entitlement.expiresAt}).`
            : `${employeeId} is NOT entitled to ${softwareName}. They need to request access through the Software Access Portal.`,
    };
}
