import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { buildSystemPrompt } from './systemPrompt';
import { toolDefinitions } from './tools';
import { getConversationHistory, saveConversationTurn, trimConversationHistory, searchKnowledgeBase } from '../db/queries';
import { createTask } from '../tools/vikunja';
import { getJobStatus, updateJobStatus, createJob, getJobAddress } from '../tools/servicem8';
import { getWeatherForecast } from '../tools/weather';
import { updateTaskStatus } from '../tools/vikunja';
import { notifyUser } from '../tools/telegram_notify';
import { queryXeroInvoices } from '../tools/xero';
import { getScheduleCache } from '../workers/landscapeSync';
import { createProspect, updateProspectStage, assignCrew, delayCrewJobs, getPipelineSummaryText } from '../tools/hardscape';
import { User, CreateTaskInput, UpdateTaskInput, GetJobStatusInput, UpdateJobStatusInput, CreateJobInput, NotifyUserInput, XeroQueryInput, LandscapeCrewId, CreateProspectInput, UpdateProspectStageInput, AssignCrewInput, DelayCrewJobsInput } from '../types';

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

async function executeToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
  user: User
): Promise<string> {
  try {
    switch (toolName) {
      case 'create_task': {
        const input = toolInput as unknown as CreateTaskInput;
        const assigneeName = (input.assigned_to || '').toLowerCase();
        const nameMap: Record<string, string> = {
          'goran': 'goran', 'dino': 'goran', 'brother dino': 'goran',
          'erick': 'erick', 'eric': 'erick', 'erik': 'erick',
          'marcin': 'marcin', 'marciv': 'marcin', 'marvin': 'marcin',
          'mark': 'mark', 'marjan': 'mark', 'marck': 'mark', 'marc': 'mark',
          'hristina': 'hristina', 'christina': 'hristina', 'kristina': 'hristina',
          'gordana': 'gordana', 'gogi': 'gordana', 'boogy': 'gordana', 'bogi': 'gordana',
        };
        const canonicalName = nameMap[assigneeName] || assigneeName;
        const assigneeIdMap: Record<string, number> = {
          goran: 1996235953,
          erick: 8049966920,
          marcin: 8559729036,
          mark: 5028364135,
          hristina: 594423613,
          gordana: 6712338568,
        };
        const assigneeTelegramId = assigneeIdMap[canonicalName] || user.telegram_id;
        const result = await createTask(input, user.telegram_id, assigneeTelegramId);
        return JSON.stringify(result);
      }

      case 'update_task_status': {
        const input = toolInput as unknown as UpdateTaskInput;
        const result = await updateTaskStatus(input);
        return JSON.stringify(result);
      }

      case 'get_job_status': {
        const input = toolInput as unknown as GetJobStatusInput;
        const result = await getJobStatus(input);
        return JSON.stringify(result);
      }

      case 'update_job_status': {
        const input = toolInput as unknown as UpdateJobStatusInput;
        const result = await updateJobStatus(input);
        return JSON.stringify(result);
      }

      case 'create_job': {
        const input = toolInput as unknown as CreateJobInput;
        const result = await createJob(input);
        return JSON.stringify(result);
      }

      case 'notify_user': {
        const input = toolInput as unknown as NotifyUserInput;
        const result = await notifyUser(input);
        return JSON.stringify(result);
      }

      case 'query_xero_invoices': {
        const input = toolInput as unknown as XeroQueryInput;
        const result = await queryXeroInvoices(input);
        return JSON.stringify(result);
      }

      case 'get_crew_schedule': {
        const cache = getScheduleCache();
        if (!cache.lastSync) {
          return JSON.stringify({ error: 'Schedule data is refreshing, please try again in a moment.' });
        }
        const date = (toolInput.date as string) || 'today';
        const schedules = date === 'tomorrow' ? cache.tomorrow : cache.today;
        const crewId = toolInput.crew_id as LandscapeCrewId | undefined;
        const filtered = crewId ? schedules.filter((s) => s.crew_id === crewId) : schedules;
        return JSON.stringify({ schedules: filtered, lastSync: cache.lastSync, date });
      }

      case 'create_prospect': {
        const input = toolInput as unknown as CreateProspectInput;
        return await createProspect(input, user.telegram_id);
      }

      case 'update_prospect_stage': {
        const input = toolInput as unknown as UpdateProspectStageInput;
        return await updateProspectStage(input, user.telegram_id);
      }

      case 'assign_crew': {
        const input = toolInput as unknown as AssignCrewInput;
        return await assignCrew(input, user.telegram_id);
      }

      case 'delay_crew_jobs': {
        const input = toolInput as unknown as DelayCrewJobsInput;
        return await delayCrewJobs(input, user.telegram_id);
      }

      case 'get_pipeline_summary': {
        return await getPipelineSummaryText();
      }

      case 'get_job_address': {
        return await getJobAddress(toolInput.job_number as string);
      }

      case 'get_weather_forecast': {
        return await getWeatherForecast((toolInput.day as string) || 'tomorrow');
      }

      case 'search_knowledge_base': {
        const query = toolInput.query as string;
        const results = await searchKnowledgeBase(query);
        if (results.length === 0) {
          return JSON.stringify({ message: 'No matching documents found in the knowledge base.' });
        }
        return JSON.stringify({ documents: results });
      }

      default:
        return JSON.stringify({ error: `Unknown tool: ${toolName}` });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`Tool ${toolName} failed:`, message);
    return JSON.stringify({ error: message });
  }
}

export async function runAgent(user: User, userMessage: string): Promise<string> {
  const history = await getConversationHistory(user.telegram_id);

  await saveConversationTurn(user.telegram_id, 'user', userMessage);

  // Direct job update shortcut — bypass Claude's tendency to call get_job_status first
  const jobUpdateMatch = userMessage.match(/(?:update|change|move|set)\s+job\s+#?(\d+).*?(?:to\s+)(work order|in progress|invoice|completed|quote|unsuccessful|done|finished?)/i);
  if (jobUpdateMatch) {
    const jobNumber = jobUpdateMatch[1];
    const statusMap: Record<string, string> = {
      'work order': 'Work Order',
      'in progress': 'Work Order',
      'invoice': 'Completed',
      'completed': 'Completed',
      'quote': 'Quote',
      'unsuccessful': 'Unsuccessful',
      'done': 'Completed',
      'finish': 'Completed',
      'finished': 'Completed',
    };
    const newStatus = statusMap[jobUpdateMatch[2].toLowerCase()];

    // Extract any note from the message
    const noteMatch = userMessage.match(/(?:note|comment|add)[:;]?\s*(.+?)(?:\s*$)/i);
    const notes = noteMatch ? noteMatch[1].trim() : undefined;

    const result = await updateJobStatus({
      sm8_job_id: jobNumber,
      new_status: newStatus as 'Quote' | 'Work Order' | 'Unsuccessful' | 'Completed',
      notes,
    });

    const reply = result.success
      ? `Job #${jobNumber} updated to "${newStatus}".${notes ? ' Note added: ' + notes : ''}`
      : `Could not update job #${jobNumber}: ${result.message}`;

    await saveConversationTurn(user.telegram_id, 'assistant', reply);
    await trimConversationHistory(user.telegram_id);
    return reply;
  }

  const currentDate = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'America/Chicago',
  });
  const currentTime = new Date().toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Chicago',
    timeZoneName: 'short',
  });

  const systemPrompt = buildSystemPrompt(
    user.name,
    user.role,
    `${currentDate} · ${currentTime}`
  );

  const messages: Anthropic.MessageParam[] = [
    ...history.map((turn) => ({
      role: turn.role as 'user' | 'assistant',
      content: turn.content,
    })),
    { role: 'user', content: userMessage },
  ];

  let response = await anthropic.messages.create({
    model: config.anthropic.model,
    max_tokens: 1024,
    system: systemPrompt,
    messages,
    tools: toolDefinitions,
  });

  const toolResultMessages: Anthropic.MessageParam[] = [];

  while (response.stop_reason === 'tool_use') {
    const assistantMessage: Anthropic.MessageParam = {
      role: 'assistant',
      content: response.content,
    };
    toolResultMessages.push(assistantMessage);

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type === 'tool_use') {
        const result = await executeToolCall(
          block.name,
          block.input as Record<string, unknown>,
          user
        );
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result,
        });
      }
    }

    toolResultMessages.push({
      role: 'user',
      content: toolResults,
    });

    response = await anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [...messages, ...toolResultMessages],
      tools: toolDefinitions,
    });
  }

  const finalText = response.content
    .filter((block) => block.type === 'text')
    .map((block) => (block as Anthropic.TextBlock).text)
    .join('\n');

  await saveConversationTurn(user.telegram_id, 'assistant', finalText);

  await trimConversationHistory(user.telegram_id);

  return finalText;
}

export async function runAgentWithPhoto(user: User, base64Image: string, textContext: string): Promise<string> {
  const history = await getConversationHistory(user.telegram_id);

  const combinedMessage = `[Photo received]${textContext !== 'No additional message provided.' ? '\n\nUser also sent this message: ' + textContext : ''}`;

  await saveConversationTurn(user.telegram_id, 'user', combinedMessage);

  const systemPrompt = buildSystemPrompt(
    user.name,
    user.role,
    new Date().toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      timeZone: 'America/Chicago',
    }) + ' · ' + new Date().toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', timeZone: 'America/Chicago', timeZoneName: 'short',
    })
  );

  const photoPrompt = `The team member sent you a photo. Extract all useful information from it.

Look for:
- Client name and contact details (phone, email, address)
- Job description or service requested
- Any pricing or quote information
- Dates or scheduling information
- Any other relevant operational details

After extracting the information, determine what action is needed:
- If enough info exists to create a task or job — ask the user to confirm before acting
- If key information is missing (client name, job description, assigned employee, date, duration) — ask for the missing pieces one at a time
- Always confirm: client name, what work needs to be done, who is assigned, when, and estimated duration

${textContext !== 'No additional message provided.' ? 'The user also sent this message along with the photo: "' + textContext + '"' : ''}`;

  const messages: Anthropic.MessageParam[] = [
    ...history.map(turn => ({ role: turn.role as 'user' | 'assistant', content: turn.content })),
    {
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/jpeg',
            data: base64Image,
          },
        },
        {
          type: 'text',
          text: photoPrompt,
        },
      ],
    },
  ];

  let response = await anthropic.messages.create({
    model: config.anthropic.model,
    max_tokens: 1024,
    system: systemPrompt,
    messages,
    tools: toolDefinitions,
  });

  const toolResultMessages: Anthropic.MessageParam[] = [];

  while (response.stop_reason === 'tool_use') {
    const assistantMessage: Anthropic.MessageParam = { role: 'assistant', content: response.content };
    toolResultMessages.push(assistantMessage);

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === 'tool_use') {
        const result = await executeToolCall(block.name, block.input as Record<string, unknown>, user);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
      }
    }

    toolResultMessages.push({ role: 'user', content: toolResults });

    response = await anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [...messages, ...toolResultMessages],
      tools: toolDefinitions,
    });
  }

  const finalText = response.content
    .filter(block => block.type === 'text')
    .map(block => (block as Anthropic.TextBlock).text)
    .join('\n');

  await saveConversationTurn(user.telegram_id, 'assistant', finalText);
  await trimConversationHistory(user.telegram_id);

  return finalText;
}
