import axios from 'axios';
import logger from '../logger';

const MEM0_URL = process.env.MEM0_URL || 'http://10.1.10.201:8089';
const APP_ID = 'canopy';

// ---------------------------------------------------------------------------
// storeMemory — persist a memory for a user
// ---------------------------------------------------------------------------

export async function storeMemory(
  agentId: string,
  userId: string,
  content: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  try {
    await axios.post(`${MEM0_URL}/v1/memories/`, {
      messages: [{ role: 'user', content }],
      agent_id: agentId,
      user_id: userId,
      app_id: APP_ID,
      metadata,
    }, { timeout: 5000 });
    logger.info({ event: 'mem0_store', agentId, userId });
  } catch (err) {
    logger.error({
      event: 'mem0_store_error',
      agentId,
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// retrieveMemories — search for relevant memories
// ---------------------------------------------------------------------------

export async function retrieveMemories(
  agentId: string,
  userId: string,
  query: string,
  limit: number = 5
): Promise<string[]> {
  try {
    const res = await axios.post(`${MEM0_URL}/v1/memories/search/`, {
      query,
      agent_id: agentId,
      user_id: userId,
      app_id: APP_ID,
      limit,
    }, { timeout: 5000 });
    const results: Array<{ memory?: string }> = res.data?.results || res.data || [];
    return results
      .map((r) => r.memory)
      .filter((m): m is string => !!m);
  } catch (err) {
    logger.error({
      event: 'mem0_retrieve_error',
      agentId,
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

// ---------------------------------------------------------------------------
// storeImprovementMemory — record a lesson learned from a failure
// ---------------------------------------------------------------------------

export async function storeImprovementMemory(
  agentId: string,
  situation: string,
  action: string,
  outcome: string,
  lesson: string
): Promise<void> {
  const content = `IMPROVEMENT: Situation: ${situation} | Action: ${action} | Outcome: ${outcome} | Lesson: ${lesson}`;
  try {
    await axios.post(`${MEM0_URL}/v1/memories/`, {
      messages: [{ role: 'user', content }],
      agent_id: agentId,
      user_id: 'system',
      app_id: APP_ID,
      metadata: { type: 'improvement', situation, action, outcome, lesson },
    }, { timeout: 5000 });
    logger.info({ event: 'mem0_store_improvement', agentId });
  } catch (err) {
    logger.error({
      event: 'mem0_store_improvement_error',
      agentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// retrieveImprovements — fetch relevant improvement memories
// ---------------------------------------------------------------------------

export async function retrieveImprovements(
  agentId: string,
  context: string
): Promise<string[]> {
  try {
    const res = await axios.post(`${MEM0_URL}/v1/memories/search/`, {
      query: context,
      agent_id: agentId,
      user_id: 'system',
      app_id: APP_ID,
      limit: 3,
    }, { timeout: 5000 });
    const results: Array<{ memory?: string }> = res.data?.results || res.data || [];
    return results
      .map((r) => r.memory)
      .filter((m): m is string => !!m);
  } catch (err) {
    logger.error({
      event: 'mem0_retrieve_improvements_error',
      agentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
