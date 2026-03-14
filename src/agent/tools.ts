import Anthropic from '@anthropic-ai/sdk';

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'create_task',
    description: 'Creates a task in Vikunja, assigns it to a team member, applies the correct job type label, and links it to a ServiceM8 job. Always call get_job_status first to get the SM8 job UUID before calling this tool.',
    input_schema: {
      type: 'object',
      properties: {
        sm8_client_name: {
          type: 'string',
          description: 'Client name exactly as it appears in ServiceM8',
        },
        task_description: {
          type: 'string',
          description: 'What needs to be done — plain English, full detail',
        },
        assigned_to: {
          type: 'string',
          description: 'First name of the team member who will do the task (e.g. mark, erick, marcin)',
        },
        job_type: {
          type: 'string',
          enum: ['lawn_care', 'hardscape', 'snow_removal', 'irrigation', 'cleanup', 'other'],
          description: 'Job type classification for Vikunja label',
        },
        sm8_job_id: {
          type: 'string',
          description: 'ServiceM8 job UUID — include if known from get_job_status',
        },
        due_date: {
          type: 'string',
          description: 'ISO 8601 date e.g. 2026-04-15 — defaults to 7 days if omitted',
        },
        priority: {
          type: 'string',
          enum: ['normal', 'high'],
          description: 'Use high only for URGENT escalations',
        },
        notes: {
          type: 'string',
          description: 'Additional context for the assignee — site access, materials, etc.',
        },
      },
      required: ['task_description', 'assigned_to', 'job_type'],
    },
  },
  {
    name: 'update_task_status',
    description: 'Updates the status of an existing task in Vikunja. When status is done, triggers the billing notification workflow automatically.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'number',
          description: 'Vikunja task ID from the task notification or task_history',
        },
        status: {
          type: 'string',
          enum: ['open', 'in_progress', 'done', 'cancelled'],
          description: 'New status for the task',
        },
        completion_notes: {
          type: 'string',
          description: 'What was done — included in the billing notification when status is done',
        },
      },
      required: ['task_id', 'status'],
    },
  },
  {
    name: 'get_job_status',
    description: 'Retrieves full job and client details from ServiceM8. Always call this before creating or updating tasks to get the correct job UUID and current status.',
    input_schema: {
      type: 'object',
      properties: {
        client_name: {
          type: 'string',
          description: 'Client name — partial match supported, agent will confirm if ambiguous',
        },
        sm8_job_id: {
          type: 'string',
          description: 'ServiceM8 job UUID — use for exact job lookup when known',
        },
        include_tasks: {
          type: 'boolean',
          description: 'Include open Vikunja tasks for this client — default true',
        },
      },
      required: ['client_name'],
    },
  },
  {
    name: 'update_job_status',
    description: 'Updates the status of a ServiceM8 job through the workflow stages: Work Order → In Progress → Invoice → Completed.',
    input_schema: {
      type: 'object',
      properties: {
        sm8_job_id: {
          type: 'string',
          description: 'ServiceM8 job UUID — required for all updates',
        },
        new_status: {
          type: 'string',
          enum: ['Work Order', 'In Progress', 'Invoice', 'Completed'],
          description: 'New status for the ServiceM8 job',
        },
        notes: {
          type: 'string',
          description: 'Optional status note added to the SM8 job activity log',
        },
      },
      required: ['sm8_job_id', 'new_status'],
    },
  },
  {
    name: 'notify_user',
    description: 'Sends a Telegram direct message to a registered team member or posts to the Sunset Ops group chat. Use this after every task creation, task completion, and invoice event.',
    input_schema: {
      type: 'object',
      properties: {
        recipient: {
          type: 'string',
          description: "Team member first name (goran, erick, marcin, mark, hristina, gordana) or 'group' to post to Sunset Ops group chat",
        },
        message: {
          type: 'string',
          description: 'Message text — plain English, under 200 characters for notifications',
        },
        notification_type: {
          type: 'string',
          enum: ['task_assigned', 'task_completed', 'invoice_ready', 'payment_received', 'urgent'],
          description: 'Notification type for formatting',
        },
        related_task_id: {
          type: 'number',
          description: 'Vikunja task ID if the notification is about a specific task',
        },
      },
      required: ['recipient', 'message'],
    },
  },
  {
    name: 'query_xero_invoices',
    description: 'Read-only query of Xero accounting system. Use to answer questions about invoice payment status, outstanding invoices, client account balances, and overdue invoices. This tool NEVER creates, modifies, or deletes anything in Xero.',
    input_schema: {
      type: 'object',
      properties: {
        query_type: {
          type: 'string',
          enum: ['invoice_status', 'outstanding', 'client_balance', 'overdue'],
          description: 'invoice_status: check if a specific invoice or client has paid. outstanding: list all unpaid invoices. client_balance: total amount owed by one client. overdue: invoices past their due date.',
        },
        client_name: {
          type: 'string',
          description: 'Client name as it appears in Xero/ServiceM8. Required for invoice_status (when no invoice_number given) and client_balance.',
        },
        invoice_number: {
          type: 'string',
          description: 'Specific Xero invoice number e.g. INV-0234. Takes priority over client_name.',
        },
      },
      required: ['query_type'],
    },
  },
];
