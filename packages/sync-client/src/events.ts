export interface ChangeHint { cursor: number; epoch: number; deleted_at: string | null }
export type EventConnection = (signal: AbortSignal) => Promise<Response>;

/** Notifications only wake cursor pull. No event payload is used as workspace state. */
export function subscribeWorkspaceChanges(connect: EventConnection, onHint: (hint: ChangeHint) => void, options: { retryMs?: number; onError?: (error: unknown) => void } = {}): () => void {
  const controller = new AbortController(); let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined, wake: (() => void) | undefined;
  const stop = () => { controller.abort(); void reader?.cancel().catch(() => {}); if (timer) clearTimeout(timer); wake?.(); };
  void (async () => {
    while (!controller.signal.aborted) {
      try {
        const response = await connect(controller.signal);
        if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error('변경 알림 연결을 확인하지 못했습니다.'), { status: response.status }); }
        if (!response.headers.get('Content-Type')?.startsWith('text/event-stream') || !response.body) { await response.body?.cancel(); throw new Error('변경 알림 응답 형식이 올바르지 않습니다.'); }
        reader = response.body.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true }); let buffer = '';
        while (!controller.signal.aborted) {
          const part = await reader.read(); if (part.done) break;
          buffer = (buffer + decoder.decode(part.value, { stream: true })).replaceAll('\r\n', '\n');
          let end: number;
          while ((end = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            if (frame.length > 16384) throw new Error('변경 알림 크기가 한도를 초과했습니다.');
            const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (!data) continue;
            const hint: unknown = JSON.parse(data);
            if (!hint || typeof hint !== 'object' || !Number.isSafeInteger((hint as ChangeHint).cursor) || (hint as ChangeHint).cursor < 0 || !Number.isSafeInteger((hint as ChangeHint).epoch) || (hint as ChangeHint).epoch < 1 || ((hint as ChangeHint).deleted_at !== null && typeof (hint as ChangeHint).deleted_at !== 'string')) throw new Error('변경 알림 값이 올바르지 않습니다.');
            if (controller.signal.aborted) return;
            onHint(hint as ChangeHint);
            if ((hint as ChangeHint).deleted_at) return;
          }
          if (buffer.length > 16384) throw new Error('변경 알림 크기가 한도를 초과했습니다.');
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        options.onError?.(error);
        if ([401,403,404,410].includes((error as {status:number}).status) || (error as {code:string}).code === 'ACCOUNT_CHANGED') return;
      } finally { if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); reader = undefined; } }
      if (!controller.signal.aborted) await new Promise<void>(resolve => { wake = resolve; timer = setTimeout(resolve, options.retryMs ?? 1500); });
    }
  })().catch(error => options.onError?.(error));
  return stop;
}
