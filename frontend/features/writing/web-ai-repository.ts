"use client";
import { api } from '@/lib/api';
import type { AIConnectionRepository } from '../../shared/core/ai';

export const webAIRepository: AIConnectionRepository = {
  get: () => api('/ai/connection'),
  save: value => api('/ai/connection', { method: 'PUT', body: JSON.stringify(value) }),
  removePersonal: () => api('/ai/connection', { method: 'DELETE' }),
  models: () => api('/ai/models'),
};
