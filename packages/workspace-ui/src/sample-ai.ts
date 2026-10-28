import type { AIConnectionRepository } from '../shared/core/ai';
import type { ChatRepository, ChatMessage, Evidence, SearchInput } from '../shared/core/chat';
import type { Source } from '../shared/core/sources';
import { blockText, type DraftRepository, type WritingContent, type WritingDraft, type ExportFormat } from '../shared/core/writing';
import type { SampleWorkspaceData } from './sample-types';

export type SampleAIRequest = { request_id: string; task: 'write' | 'chat'; prompt: string; sources: Source[]; current: WritingContent | null };
export type SampleAIAdapter = {
  connection: AIConnectionRepository;
  generate(request: SampleAIRequest): Promise<unknown>;
  export?(content: WritingContent, format: ExportFormat): Promise<void>;
  signIn?: () => void;
};
type StoredDraft = WritingDraft & { history: WritingDraft[] };
type StoredSession = { id: string; title: string; requestId: string; messages: (ChatMessage & { input?: SearchInput; requestId?: string })[] };
type State = { version: 1; drafts: StoredDraft[]; sessions: StoredSession[]; requests: Record<string, { fingerprint: string; id: string | null }> };
const fail: (message: string) => never = message => { throw new Error(message); };
const copy = <T,>(value: T): T => structuredClone(value);
const publicDraft = ({ history, ...draft }: StoredDraft): WritingDraft => ({ ...copy(draft), can_undo: history.length > 0 });
const invalid = () => fail('AI 응답의 문서 형식 또는 출처를 검증하지 못했습니다.');

// Validate the model's content against the excerpts we sent, never its returned source objects.
export function sampleContent(value: unknown, sources: { id: string }[]): WritingContent {
  const content = value as WritingContent;
  if (!content || typeof content.title !== 'string' || !content.title.trim() || content.title.length > 200 || !Array.isArray(content.blocks) || !content.blocks.length || content.blocks.length > 200 || JSON.stringify(content).length > 150000) return invalid();
  const ids = new Set<string>(), allowed = new Set(sources.map(s => s.id));
  const strings = (v: unknown, count: number, size: number): v is string[] => Array.isArray(v) && v.length <= count && v.every(s => typeof s === 'string' && s.length <= size);
  return { title: content.title.trim(), blocks: content.blocks.map(block => {
    if (!block || typeof block.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(block.id) || ids.has(block.id) || !['paragraph', 'heading', 'list', 'table'].includes(block.type)) return invalid();
    ids.add(block.id);
    const { text = '', level = 2, items = [], rows = [], source_ids = [] } = block;
    if (typeof text !== 'string' || text.length > 12000 || !Number.isInteger(level) || level < 1 || level > 6 || !strings(items, 100, 2000) || !Array.isArray(rows) || rows.length > 100 || rows.some(row => !strings(row, 12, 2000)) || !strings(source_ids, 20, 200) || source_ids.some(id => !allowed.has(id)) || block.type === 'list' && !items.length || block.type === 'table' && (!rows.length || rows.some(row => !row.length))) return invalid();
    return { id: block.id, type: block.type, text, level, items, rows, source_ids };
  }) };
}

export function sampleSources(data: SampleWorkspaceData, input: SearchInput): Evidence {
  if (!input.question.trim() || input.question.length > 4000) fail('질문 또는 작성 요청을 확인해 주세요.');
  if (input.scope === 'as_of' && !/^\d{4}-\d{2}-\d{2}$/.test(input.as_of || '')) fail('기준일을 선택해 주세요.');
  // The sample is a single snapshot; do not invent history or imply a historical search succeeded.
  if (input.scope === 'as_of') return { sources: [], scope: 'as_of', as_of: input.as_of, warnings: ['SAMPLE_HISTORY_UNAVAILABLE'] };
  const terms = [...new Set((input.question.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []).flatMap(term => [term, term.replace(/(에서|으로|에는|들을|과의|의|을|를|은|는|이|가|와|과|도)$/, '')]).filter(term => term.length >= 2))];
  const entries = new Map(data.entries.map(entry => [entry.id, entry]));
  const candidates = data.documents.flatMap(document => (document.content?.blocks || []).flatMap(block => {
    const text = [block.text, ...(block.rows || []).map(row => row.join(' | '))].filter(Boolean).join('\n');
    if (!text.trim()) return [];
    const title = entries.get(document.entry_id)?.relative_path || document.path;
    const revision = entries.get(document.entry_id)?.version_number || 1;
    const body = text.toLocaleLowerCase(), name = title.toLocaleLowerCase();
    const score = terms.reduce((total, term) => total + (name.includes(term) ? 4 : 0) + (body.includes(term) ? 1 : 0), 0);
    return [{ score, source: { id: `sample-${document.entry_id}-${block.id}-v${revision}`, kind: 'document' as const, chunk_id: `sample-${document.entry_id}-${block.id}-v${revision}`, document_id: document.entry_id, document_title: title, version_id: `${document.entry_id}-v${revision}`, version_number: revision, is_current: true, available: true, text, locations: [{ block_id: block.id, ...(block.source.page ? { page: block.source.page } : {}) }] } }];
  })).filter(item => item.score > 0).sort((a, b) => b.score - a.score);
  let budget = 24000;
  const sources: Source[] = [];
  for (const { source } of candidates) {
    if (sources.length >= 12 || budget <= 0) break;
    const text = source.text.slice(0, Math.min(4000, budget)); budget -= text.length;
    sources.push({ ...source, text });
  }
  return { sources, scope: 'current', as_of: null, warnings: input.scope === 'history' ? ['SAMPLE_CURRENT_ONLY'] : [] };
}

export function createSampleRepositories(data: SampleWorkspaceData, adapter: SampleAIAdapter, storage?: Pick<Storage, 'getItem' | 'setItem'>) {
  const key = `context:sample-ai:v1:${data.workspace_id}`;
  const read = (): State => {
    const raw = (storage || localStorage).getItem(key);
    if (!raw) return { version: 1, drafts: [], sessions: [], requests: {} };
    const value = JSON.parse(raw) as State;
    if (value.version !== 1 || !Array.isArray(value.drafts) || !Array.isArray(value.sessions) || !value.requests) fail('이 기기의 샘플 작업 저장소를 읽지 못했습니다.');
    return value;
  };
  const write = (state: State) => {
    try { (storage || localStorage).setItem(key, JSON.stringify(state)); } catch { fail('샘플 작업을 저장하지 못했습니다. 기기의 저장 공간과 브라우저 저장 권한을 확인해 주세요.'); }
  };
  // Serialize mutations, including AI responses, across tabs. Reads can still show progress.
  let queue = Promise.resolve<unknown>(undefined);
  const mutate = <T,>(action: () => Promise<T> | T): Promise<T> => {
    const run = async (): Promise<T> => {
      if (typeof navigator !== 'undefined' && navigator.locks) return await navigator.locks.request<Promise<T>>(key, async () => await action());
      return await action();
    };
    const result = queue.then(run, run); queue = result.catch(() => {}); return result;
  };
  const draft = (state: State, id: string, revision?: number) => {
    const found = state.drafts.find(item => item.id === id) || fail('작성한 문서를 찾을 수 없습니다.');
    if (revision !== undefined && found.revision !== revision) fail('다른 곳에서 문서가 변경됐습니다. 저장된 문서를 다시 열어 주세요.');
    return found;
  };
  const session = (state: State, id: string) => state.sessions.find(item => item.id === id) || fail('대화를 찾을 수 없습니다.');
  const newDraft = (content: WritingContent, sources: Source[] = [], checks: string[] = []): StoredDraft => ({ id: crypto.randomUUID(), title: content.title, revision: 1, content, sources: sources.map(source => ({ ...source, kind: source.kind || 'document' })), checks, can_undo: false, proposal: null, history: [] });
  const remember = (item: StoredDraft) => { item.history.push(publicDraft(item)); item.history = item.history.slice(-20); };
  const drafts: DraftRepository = {
    list: async () => read().drafts.map(({ id, title }) => ({ id, title })).reverse(),
    get: async id => publicDraft(draft(read(), id)),
    create: requestId => mutate(() => {
      const state = read(), prior = state.requests[requestId];
      if (prior) { if (prior.fingerprint !== 'blank' || !prior.id) fail('다른 작업에 사용한 요청 식별자입니다.'); return publicDraft(draft(state, prior.id)); }
      const item = newDraft(sampleContent({ title: '새 문서', blocks: [{ id: crypto.randomUUID(), type: 'paragraph', text: '' }] }, []));
      state.drafts.push(item); state.requests[requestId] = { fingerprint: 'blank', id: item.id }; write(state); return publicDraft(item);
    }),
    save: (id, revision, content) => mutate(() => {
      const state = read(), item = draft(state, id, revision);
      const next = sampleContent(content, item.sources); remember(item); item.content = next; item.title = next.title; item.proposal = null; item.revision++; write(state); return publicDraft(item);
    }),
    generate: input => mutate(async () => {
      const state = read(), fingerprint = JSON.stringify(input), prior = state.requests[input.requestId];
      if (prior) {
        if (prior.fingerprint !== fingerprint) fail('다른 내용에 사용한 요청 식별자입니다.');
        if (!prior.id) fail('이미 접수한 AI 요청입니다. 저장된 결과를 확인하거나 새 요청으로 다시 시도해 주세요.');
        return publicDraft(draft(state, prior.id));
      }
      const current = input.draftId ? draft(state, input.draftId, input.revision) : null;
      const evidence = sampleSources(data, { question: input.prompt, scope: 'current', as_of: null });
      if (current) {
        const used = new Set(current.content.blocks.flatMap(block => block.source_ids));
        const previous = current.sources.filter(source => used.has(source.id));
        const retained = previous.flatMap(source => {
          const document = data.documents.find(document => source.id.startsWith(`sample-${document.entry_id}-`));
          const revision = source.version_number || 1;
          return document ? [{ ...source, kind: 'document' as const, chunk_id: source.id, document_id: document.entry_id, version_id: `${document.entry_id}-v${revision}`, version_number: revision, is_current: revision === (data.entries.find(entry => entry.id === document.entry_id)?.version_number || 1), available: true, locations: source.locations?.map(location => ({ ...location, block_id: location.block_id || 1 })) || [{ block_id: 1 }] }] : [];
        });
        let budget = 24000;
        const unique = new Map([...retained, ...evidence.sources].map(source => [source.id, source]));
        evidence.sources = [];
        for (const source of unique.values()) {
          if (evidence.sources.length >= 20 || budget <= 0) break;
          const text = source.text.slice(0, Math.min(4000, budget)); budget -= text.length;
          evidence.sources.push({ ...source, text });
        }
      }
      state.requests[input.requestId] = { fingerprint, id: null }; write(state);
      const result = await adapter.generate({ request_id: input.requestId, task: 'write', prompt: input.prompt, sources: evidence.sources, current: current?.content || null }) as { content: unknown; checks: string[] };
      const content = sampleContent(result?.content, evidence.sources);
      if (!Array.isArray(result.checks) || result.checks.length > 30 || result.checks.some(item => typeof item !== 'string' || item.length > 1000)) return invalid();
      const item = current || newDraft(content, evidence.sources, result.checks);
      if (current) { item.proposal = { content, sources: evidence.sources.map(source => ({ ...source, kind: source.kind || 'document' })), checks: result.checks }; item.revision++; } else state.drafts.push(item);
      state.requests[input.requestId].id = item.id; write(state); return publicDraft(item);
    }),
    review: (id, revision, action) => mutate(() => {
      const state = read(), item = draft(state, id, revision);
      if (action === 'accept') {
        if (!item.proposal) fail('적용할 수정안이 없습니다.');
        remember(item); Object.assign(item, item.proposal); item.title = item.content.title;
      } else if (action === 'undo') {
        const previous = item.history.pop() || fail('되돌릴 수정 이력이 없습니다.');
        Object.assign(item, { content: previous.content, sources: previous.sources, checks: previous.checks, title: previous.title });
      }
      item.proposal = null; item.revision++; write(state); return publicDraft(item);
    }),
    remove: (id, revision) => mutate(() => { const state = read(); draft(state, id, revision); state.drafts = state.drafts.filter(item => item.id !== id); write(state); }),
    export: async (id, revision, format) => {
      const item = draft(read(), id, revision);
      if (adapter.export) return adapter.export(item.content, format);
      if (format !== 'md' && format !== 'txt') fail('샘플은 Markdown과 텍스트로 내보낼 수 있습니다.');
      const text = (format === 'md' ? '# ' : '') + item.title + '\n\n' + item.content.blocks.map(block => block.type === 'heading' && format === 'md' ? '#'.repeat(block.level) + ' ' + block.text : blockText(block)).join('\n\n');
      downloadSample(new Blob([text], { type: 'text/plain;charset=utf-8' }), item.title, format);
    },
  };
  const running = new Set<string>();
  const ask = (id: string, requested: (SearchInput & { requestId: string }) | null, retryId?: string): Promise<ChatMessage> => mutate(async () => {
    const state = read(), chat = session(state, id);
    const last = chat.messages.at(-1);
    if (retryId && (!last || last.id !== retryId || last.state !== 'FAILED' || !last.input || running.has(last.id))) fail('가장 최근 실패한 답변만 다시 요청할 수 있습니다.');
    const input = requested || { ...last!.input!, requestId: crypto.randomUUID() };
    const prior = chat.messages.find(item => item.role === 'assistant' && item.requestId === input.requestId);
    if (prior) { if (JSON.stringify(prior.input) !== JSON.stringify(input)) fail('다른 질문에 사용한 요청 식별자입니다.'); return copy(prior); }
    const evidence = sampleSources(data, input), now = new Date().toISOString();
    const answer: StoredSession['messages'][number] = retryId ? last! : { id: crypto.randomUUID(), role: 'assistant', state: 'FAILED', content: '', result: null, error_code: 'WORKER_INTERRUPTED', created_at: now };
    Object.assign(answer, { input, requestId: input.requestId, error_code: 'WORKER_INTERRUPTED' });
    if (!retryId) chat.messages.push({ id: crypto.randomUUID(), role: 'user', state: 'COMPLETED', content: input.question, result: null, error_code: null, created_at: now }, answer);
    write(state); running.add(answer.id);
    try {
      const result = evidence.sources.length ? await adapter.generate({ request_id: input.requestId, task: 'chat', prompt: input.question, sources: evidence.sources, current: null }) as { claims: { text: string; source_ids: string[] }[]; insufficient: boolean } : { claims: [], insufficient: true };
      const allowed = new Set(evidence.sources.map(source => source.id));
      if (!result || !Array.isArray(result.claims) || result.claims.length > 12 || typeof result.insufficient !== 'boolean' || !result.claims.length && !result.insufficient || result.claims.some(claim => typeof claim.text !== 'string' || !claim.text || claim.text.length > 6000 || !Array.isArray(claim.source_ids) || !claim.source_ids.length || claim.source_ids.length > 20 || claim.source_ids.some(ref => !allowed.has(ref)))) return invalid();
      Object.assign(answer, { state: 'COMPLETED', content: result.claims.map(claim => claim.text).join('\n\n') || '이 샘플 자료에서 답변할 근거를 찾지 못했습니다.', error_code: null, result: { ...evidence, claims: result.claims, insufficient: result.insufficient } });
      write(state); return copy(answer);
    } catch (error) { answer.error_code = 'AI_UNAVAILABLE'; write(state); throw error; }
    finally { running.delete(answer.id); }
  });
  const count = () => ({ versions: data.documents.filter(document => document.content).length, completed: data.documents.filter(document => document.content).length, failed: 0, chunks: data.documents.reduce((n, document) => n + (document.content?.blocks.length || 0), 0), indexed_chunks: data.documents.reduce((n, document) => n + (document.content?.blocks.length || 0), 0) });
  const chat: ChatRepository = {
    sessions: async offset => read().sessions.map(({ id, title }) => ({ id, title })).reverse().slice(offset, offset + 50),
    messages: async id => copy(session(read(), id).messages).map(item => running.has(item.id) ? { ...item, state: 'RUNNING', error_code: null } : item),
    indexStatus: async () => ({ current: count(), all: count() }),
    search: async input => sampleSources(data, input), reindex: async () => {},
    createSession: input => mutate(() => {
      const state = read(), prior = state.sessions.find(item => item.requestId === input.requestId);
      if (prior) return { id: prior.id, title: prior.title };
      const item = { id: crypto.randomUUID(), title: input.title, requestId: input.requestId, messages: [] }; state.sessions.push(item); write(state); return { id: item.id, title: item.title };
    }),
    ask,
    retry: (id, messageId) => ask(id, null, messageId),
  };
  return { drafts, chat };
}

export function downloadSample(blob: Blob, title: string, format: string) {
  const url = URL.createObjectURL(blob), anchor = document.createElement('a');
  anchor.href = url; anchor.download = `${title.replace(/[\\/:*?"<>|]/g, '_')}.${format}`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}
