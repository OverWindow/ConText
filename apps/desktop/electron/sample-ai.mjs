import { validateContent } from './local-documents.mjs';
import { validateClaims } from './local-chat.mjs';

export async function generateSample(ai, input) {
  if (!input || !['write', 'chat'].includes(input.task) || typeof input.request_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(input.request_id) || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 4000 || !Array.isArray(input.sources) || input.sources.length > 20 || JSON.stringify(input).length > 300000) throw new Error('샘플 AI 요청이 올바르지 않습니다.');
  const ids = new Set(); let length = 0;
  for (const source of input.sources) {
    if (!source || typeof source.id !== 'string' || !source.id.startsWith('sample-') || source.id.length > 200 || ids.has(source.id) || typeof source.text !== 'string' || source.text.length > 4000 || typeof source.document_title !== 'string' || source.document_title.length > 300 || !Array.isArray(source.locations) || source.locations.length > 20) throw new Error('샘플 AI 근거가 올바르지 않습니다.');
    ids.add(source.id); length += source.text.length;
  }
  if (length > 24000) throw new Error('샘플 AI 근거가 너무 큽니다.');
  if (input.current) validateContent(input.current, input.current.blocks.flatMap(block => (block.source_ids || []).map(id => ({ id }))));
  await ai.ensureReady();
  const result = await ai.generate(input);
  if (input.task === 'chat') validateClaims(result, input.sources);
  else {
    result.content = validateContent(result.content, input.sources);
    if (!Array.isArray(result.checks) || result.checks.length > 30 || result.checks.some(check => typeof check !== 'string' || check.length > 1000)) throw new Error('AI 응답 형식을 검증하지 못했습니다.');
  }
  return { ...result, sources: input.sources };
}

export function sampleExportContent(content, format) {
  if (!['docx', 'hwpx'].includes(format)) throw new Error('지원하지 않는 출력 형식입니다.');
  return validateContent(content, (content?.blocks || []).flatMap(block => (block.source_ids || []).map(id => ({ id }))));
}
