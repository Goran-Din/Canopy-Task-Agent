export interface User {
  id: number;
  telegram_id: number;
  name: string;
  role: 'admin' | 'field' | 'staff' | 'billing';
  vikunja_user_id: number | null;
  active: boolean;
}

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface JobStatus {
  client_uuid: string;
  client_name: string;
  job_uuid: string;
  job_number: string;
  status: string;
  description: string;
  created_date: string;
}

export interface CreateTaskInput {
  sm8_client_name?: string;
  task_description: string;
  assigned_to: string;
  job_type: 'lawn_care' | 'hardscape' | 'snow_removal' | 'irrigation' | 'cleanup' | 'other';
  sm8_job_id?: string;
  due_date?: string;
  priority?: 'normal' | 'high';
  notes?: string;
}

export interface UpdateTaskInput {
  task_id: number;
  status: 'open' | 'in_progress' | 'done' | 'cancelled';
  completion_notes?: string;
}

export interface GetJobStatusInput {
  client_name: string;
  sm8_job_id?: string;
  include_tasks?: boolean;
}

export interface UpdateJobStatusInput {
  sm8_job_id: string;
  new_status: 'Quote' | 'Work Order' | 'Unsuccessful' | 'Completed';
  notes?: string;
}

export interface NotifyUserInput {
  recipient: string;
  message: string;
  notification_type?: 'task_assigned' | 'task_completed' | 'invoice_ready' | 'payment_received' | 'urgent';
  related_task_id?: number;
}

export interface CreateJobInput {
  client_name: string;
  job_description: string;
  job_date?: string;
  job_type?: 'lawn_care' | 'hardscape' | 'snow_removal' | 'irrigation' | 'cleanup' | 'other';
  pricing_notes?: string;
}

export interface XeroQueryInput {
  query_type: 'invoice_status' | 'outstanding' | 'client_balance' | 'overdue';
  client_name?: string;
  invoice_number?: string;
}

export interface InvoiceBadge {
  status: 'not_invoiced' | 'invoiced' | 'paid' | 'overdue';
  invoice_number: string | null;
  invoice_amount: number | null;
  due_date: string | null;
  paid_date: string | null;
}

export interface LandscapeJobCard {
  job_uuid: string;
  job_number: string;
  client_name: string;
  address: string;
  description: string;
  scheduled_start: string;
  estimated_hours: number;
  status: 'scheduled' | 'in_progress' | 'completed';
  employees: { uuid: string; name: string; is_lead: boolean; }[];
  invoice: InvoiceBadge | null;
  comment: string | null;
}

export interface LandscapeCrewSchedule {
  crew_id: 'lp1' | 'lp2' | 'lp3' | 'lp4';
  lead_name: string;
  color: string;
  jobs: LandscapeJobCard[];
  total_hours: number;
  has_open_time: boolean;
  open_hours: number;
}

export type LandscapeCrewId = 'lp1' | 'lp2' | 'lp3' | 'lp4';
