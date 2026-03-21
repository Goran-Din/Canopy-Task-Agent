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

export type ProspectStage =
  | 'initial_contact'
  | 'site_visit'
  | 'quote_sent'
  | 'revision_requested'
  | 'visual_rendering'
  | 'final_quote'
  | 'deposit_invoice'
  | 'scheduled'
  | 'in_progress'
  | 'completed'
  | 'closed_lost';

export type HardscapeCrewId = 'hp1' | 'hp2';

export interface HardscapeProspect {
  id: number;
  sm8_client_uuid: string;
  sm8_client_name: string;
  sm8_job_uuid?: string;
  sm8_job_number?: string;
  stage: ProspectStage;
  assigned_to?: number;
  estimated_crew_days?: number;
  crew_assignment?: HardscapeCrewId;
  scheduled_start?: string;
  client_folder_url?: string;
  notes?: string;
  sm8_last_synced?: string;
  stage_updated_at: string;
  created_at: string;
  updated_at: string;
  invoice?: InvoiceBadge | null;
  comment?: string | null;
}

export interface ProspectComment {
  id: number;
  prospect_id: number;
  source: 'manual' | 'sm8_sync' | 'agent';
  author?: string;
  content: string;
  sm8_activity_uuid?: string;
  editable: boolean;
  activity_date: string;
  created_at: string;
}

export interface CrewScheduleEntry {
  id: number;
  prospect_id: number;
  crew: HardscapeCrewId;
  start_date: string;
  estimated_days: number;
  actual_days?: number;
  status: 'scheduled' | 'in_progress' | 'completed' | 'delayed';
  delay_reason?: string;
  created_at: string;
  updated_at: string;
}

export interface CreateProspectInput {
  client_name: string;
  stage?: ProspectStage;
  sm8_job_uuid?: string;
  notes?: string;
  client_folder_url?: string;
}

export interface UpdateProspectStageInput {
  client_name: string;
  new_stage: ProspectStage;
  comment?: string;
}

export interface AssignCrewInput {
  client_name: string;
  crew: HardscapeCrewId;
  start_date: string;
  estimated_days: number;
}

export interface DelayCrewJobsInput {
  crew: HardscapeCrewId;
  days: number;
  from_date?: string;
  reason?: string;
}
