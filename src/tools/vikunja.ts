import axios from 'axios';
import { config } from '../config';
import { saveTask, updateTask } from '../db/queries';
import { CreateTaskInput, UpdateTaskInput } from '../types';

const vikunjaApi = axios.create({
  baseURL: `${config.vikunja.baseUrl}/api/v1`,
  headers: {
    Authorization: `Bearer ${config.vikunja.apiToken}`,
    'Content-Type': 'application/json',
  },
  timeout: 10000,
});

function getLabelId(jobType: string): number {
  const map: Record<string, number> = {
    lawn_care: config.vikunja.labels.lawnCare,
    hardscape: config.vikunja.labels.hardscape,
    snow_removal: config.vikunja.labels.snowRemoval,
    irrigation: config.vikunja.labels.irrigation,
    cleanup: config.vikunja.labels.cleanup,
    other: config.vikunja.labels.other,
  };
  return map[jobType] ?? config.vikunja.labels.other;
}

function resolveAssigneeVikunjaId(name: string): number {
  const map: Record<string, number> = {
    goran: 1,
    erick: 2,
    marcin: 3,
    mark: 4,
    hristina: 5,
    gordana: 6,
  };
  return map[name.toLowerCase()] ?? 4;
}

export async function createTask(
  input: CreateTaskInput,
  createdByTelegramId: number,
  assigneeTelegramId: number
): Promise<{ task_id: number; title: string; url: string }> {
  const labelId = getLabelId(input.job_type);
  const assigneeVikunjaId = resolveAssigneeVikunjaId(input.assigned_to);

  const dueDate = input.due_date
    ? new Date(input.due_date).toISOString()
    : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const taskTitle = `${input.sm8_client_name} — ${input.task_description.substring(0, 60)}`;

  const description = [
    input.task_description,
    input.sm8_job_id ? `SM8 Job: ${input.sm8_job_id}` : '',
    input.notes ? `Notes: ${input.notes}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const response = await vikunjaApi.post(`/projects/${config.vikunja.projects.fieldOps}/tasks`, {
    title: taskTitle,
    description,
    due_date: dueDate,
    priority: input.priority === 'high' ? 3 : 1,
    labels: [{ id: labelId }],
    assignees: [{ id: assigneeVikunjaId }],
  });

  const task = response.data;

  await saveTask({
    vikunja_task_id: task.id,
    title: task.title,
    assigned_to: assigneeTelegramId,
    created_by: createdByTelegramId,
    sm8_job_uuid: input.sm8_job_id,
    sm8_client_name: input.sm8_client_name,
    job_type: input.job_type,
    vikunja_label_id: labelId,
  });

  return {
    task_id: task.id,
    title: task.title,
    url: `${config.vikunja.baseUrl}/tasks/${task.id}`,
  };
}

export async function updateTaskStatus(input: UpdateTaskInput): Promise<{ success: boolean; message: string }> {
  const vikunjaStatus = input.status === 'done' ? 1 : 0;

  await vikunjaApi.post(`/tasks/${input.task_id}`, {
    done: vikunjaStatus === 1,
  });

  await updateTask(
    input.task_id,
    input.status,
    input.status === 'done' ? new Date() : undefined
  );

  return {
    success: true,
    message: `Task #${input.task_id} marked ${input.status}.${input.completion_notes ? ' Notes: ' + input.completion_notes : ''}`,
  };
}
