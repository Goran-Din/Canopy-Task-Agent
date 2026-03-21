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
    description: 'Updates the status of a ServiceM8 job. IMPORTANT: Call this tool DIRECTLY when the user asks to update a job status — do NOT call get_job_status first. Pass the job number exactly as given by the user (e.g. "26") as the sm8_job_id — the tool will resolve it to the correct UUID automatically.',
    input_schema: {
      type: 'object',
      properties: {
        sm8_job_id: {
          type: 'string',
          description: 'ServiceM8 job number as given by the user (e.g. "26") OR the full UUID. Do NOT look up the UUID first — pass the number directly.',
        },
        new_status: {
          type: 'string',
          enum: ['Quote', 'Work Order', 'Unsuccessful', 'Completed'],
          description: 'New status for the ServiceM8 job. Valid values: Quote, Work Order, Unsuccessful, Completed.',
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
    name: 'create_job',
    description: 'Creates a new Quote job in ServiceM8 for a client. Use when a team member asks to create a new job, quote, or work order for a client. Always confirm client name, job description, and date before creating. After creating the job, always create a Vikunja task for Mark to prepare and send the proposal.',
    input_schema: {
      type: 'object',
      properties: {
        client_name: {
          type: 'string',
          description: 'Client name — will be matched against ServiceM8 records',
        },
        job_description: {
          type: 'string',
          description: 'Short description of the work to be done — plain English',
        },
        job_date: {
          type: 'string',
          description: 'ISO 8601 date e.g. 2026-04-15 — defaults to today if not provided',
        },
        job_type: {
          type: 'string',
          enum: ['lawn_care', 'hardscape', 'snow_removal', 'irrigation', 'cleanup', 'other'],
          description: 'Job type — infer from the job description if not explicitly stated',
        },
        pricing_notes: {
          type: 'string',
          description: 'Any pricing information mentioned by the user — will be added to job notes for Mark to reference',
        },
      },
      required: ['client_name', 'job_description'],
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
  {
    name: 'get_crew_schedule',
    description: 'Returns the current landscape crew schedule from the in-memory cache (refreshed every 15 minutes from ServiceM8). Use this to answer any questions about landscape crew schedules, jobs, or availability. Never call ServiceM8 directly for schedule queries — always use this tool.',
    input_schema: {
      type: 'object',
      properties: {
        crew_id: {
          type: 'string',
          enum: ['lp1', 'lp2', 'lp3', 'lp4'],
          description: 'Specific crew to query. Omit to get all 4 crews.',
        },
        date: {
          type: 'string',
          enum: ['today', 'tomorrow'],
          description: "Which day's schedule to return. Defaults to today.",
        },
      },
      required: [],
    },
  },
  {
    name: 'create_prospect',
    description: 'Creates a new hardscape prospect in the pipeline. Use when a team member mentions a new hardscape client. Always confirm the client name.',
    input_schema: {
      type: 'object',
      properties: {
        client_name: {
          type: 'string',
          description: 'Client name — will be matched against ServiceM8 records',
        },
        stage: {
          type: 'string',
          enum: ['initial_contact', 'site_visit', 'quote_sent', 'revision_requested', 'visual_rendering', 'final_quote', 'deposit_invoice', 'scheduled', 'in_progress', 'completed', 'closed_lost'],
          description: 'Pipeline stage — defaults to initial_contact if omitted',
        },
        sm8_job_uuid: {
          type: 'string',
          description: 'ServiceM8 job UUID if known',
        },
        notes: {
          type: 'string',
          description: 'Additional notes about the prospect',
        },
        client_folder_url: {
          type: 'string',
          description: 'URL to the client folder (Google Drive, etc.)',
        },
      },
      required: ['client_name'],
    },
  },
  {
    name: 'update_prospect_stage',
    description: 'Updates the pipeline stage for a hardscape prospect. Use when team member reports progress — quote sent, deposit paid, etc.',
    input_schema: {
      type: 'object',
      properties: {
        client_name: {
          type: 'string',
          description: 'Client name to search for in the prospect pipeline',
        },
        new_stage: {
          type: 'string',
          enum: ['initial_contact', 'site_visit', 'quote_sent', 'revision_requested', 'visual_rendering', 'final_quote', 'deposit_invoice', 'scheduled', 'in_progress', 'completed', 'closed_lost'],
          description: 'New pipeline stage',
        },
        comment: {
          type: 'string',
          description: 'Optional comment to log with the stage change',
        },
      },
      required: ['client_name', 'new_stage'],
    },
  },
  {
    name: 'assign_crew',
    description: 'Assigns a hardscape job to HP#1 or HP#2 with a start date. Use when deposit is confirmed. Sets stage to Scheduled.',
    input_schema: {
      type: 'object',
      properties: {
        client_name: {
          type: 'string',
          description: 'Client name to search for in the prospect pipeline',
        },
        crew: {
          type: 'string',
          enum: ['hp1', 'hp2'],
          description: 'Hardscape crew — hp1 = Rigo Tello, hp2 = Daniel Tello',
        },
        start_date: {
          type: 'string',
          description: 'ISO date for crew start (e.g. 2026-04-15)',
        },
        estimated_days: {
          type: 'number',
          description: 'Estimated number of crew days to complete the job',
        },
      },
      required: ['client_name', 'crew', 'start_date', 'estimated_days'],
    },
  },
  {
    name: 'delay_crew_jobs',
    description: 'Shifts all scheduled jobs for HP#1 or HP#2 forward by N days. Use for rain days or delays.',
    input_schema: {
      type: 'object',
      properties: {
        crew: {
          type: 'string',
          enum: ['hp1', 'hp2'],
          description: 'Hardscape crew — hp1 = Rigo Tello, hp2 = Daniel Tello',
        },
        days: {
          type: 'number',
          description: 'Number of days to shift forward',
        },
        from_date: {
          type: 'string',
          description: 'Only shift jobs on or after this ISO date — defaults to today',
        },
        reason: {
          type: 'string',
          description: 'Reason for the delay (e.g. rain, material delay)',
        },
      },
      required: ['crew', 'days'],
    },
  },
  {
    name: 'get_pipeline_summary',
    description: 'Returns a summary of all active hardscape prospects grouped by pipeline stage. Use when someone asks to see the pipeline, all prospects, or pipeline status.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'search_knowledge_base',
    description: 'Searches the company knowledge base for SOPs, policies, and procedures. Use when a team member asks about company policies, standard procedures, how to handle specific situations, or any operational question that might be documented.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query — plain English description of what to look up',
        },
      },
      required: ['query'],
    },
  },
];
