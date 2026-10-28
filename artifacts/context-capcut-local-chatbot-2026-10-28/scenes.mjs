export const positioning = '내 문서와 AI가 함께 일하는 공간 · 내 PC에서 시작하는 AI 문서 작업 공간';

export function createScenes({ brand, tag, rail, frame }) {
  const draftExample = '초안 작성·수정 예시 · 설명용 합성 그래픽';
  const fileExample = 'TXT·Markdown 직접 편집 예시 · 자동 AI 원본 적용 아님';
  const scenes = [];
  function add(name, title, content, cls = '', status = '제품 소개 그래픽') {
    scenes.push({ name, title, html: frame(content, cls), overlay: false, status });
  }

  add('01-opening', '내 문서와 AI가 함께 일하는 공간', `
    <div class="opener-copy">${brand('brand')}
      <div class="eyebrow">내 PC에서 시작하는 AI 문서 작업 공간</div>
      <h1>내 문서와 AI가<br><em>함께 일하는 공간.</em></h1>
      <p class="desc">평소 쓰던 폴더에서 자료를 찾고,<br>AI에게 묻고, 문서를 다듬으세요.</p>
      <div class="tagline">ConText · AI와 함께 쓰는 로컬 문서 환경</div>
    </div>
    <div class="window chat-window" style="top:135px">
      <div class="window-head"><span><i class="head-dot"></i>나의 문서 작업 공간</span><span class="head-note">활용 예시</span></div>
      <div class="workspace-strip"><span>내 자료</span><span>→ AI 질문 →</span><span>문서 작성</span></div>
      <div class="chat-body">${tag('주간 회의록.md')}
        <div class="bubble user">이 자료를 바탕으로<br>주간 업무 보고서 초안을 써 줘.</div>
        <div class="bubble ai"><span class="ai-label">자료를 바탕으로 만든 초안 예시</span>
          <div class="draft-heading">주간 업무 보고서</div><div class="draft-line">이번 주 진행 사항</div>
          <div class="mini-diff"><small>출처 · 주간 회의록.md</small>시안 검토 · 견적 확인<br>다음 주 회의에서 결과 공유</div>
        </div>
      </div>
    </div>${rail('자료 탐색 · AI 질문 · 문서 작성·수정', '화면은 설명용 합성 그래픽')}`);

  add('02-problem', '문서와 AI 사이의 반복', `
    <div class="dark-mark">${brand('brand')}</div>
    <div class="dark-copy"><div class="eyebrow">내 자료로 AI와 일하려면</div>
      <h1>자료는 내 PC에,<br><em>작업은<br>여러 창 사이에.</em></h1>
      <p class="desc">필요한 파일을 찾고, 내용을 전달하고,<br>답변을 다시 문서로 정리하는 과정.</p>
    </div>
    <div class="manual-stack"><div class="manual-row"><span>01</span>자료 찾기</div><div class="manual-row"><span>02</span>AI에게 내용 전달하기</div><div class="manual-row"><span>03</span>다시 문서로 정리하기</div></div>
    ${rail('ConText · 내 문서를 중심으로 작업합니다', '사용 상황을 설명하는 그래픽')}`, 'dark');

  add('03-core-promise', '내 자료를 중심으로 찾고 묻고 쓰기', `
    <div class="center-copy"><div class="eyebrow">CONTEXT · AI와 함께 쓰는 문서 환경</div>
      <h1>내 자료를 중심으로,<br><em>찾고, 묻고, 쓰세요.</em></h1>
      <p class="desc">문서 탐색과 AI 대화, 초안 작성과 편집을 한 작업 공간에서.</p>
      <div class="process">
        <div class="process-card"><small>FIND</small><strong>자료 탐색</strong><p>평소 쓰던 폴더에서</p></div><div class="process-arrow">→</div>
        <div class="process-card"><small>ASK</small><strong>근거 있는 답변</strong><p>내 자료로 질문하고</p></div><div class="process-arrow">→</div>
        <div class="process-card"><small>WRITE</small><strong>문서 작성·수정</strong><p>초안을 만들고 다듬기</p></div>
      </div>
    </div>${rail('내 PC에서 시작하는 AI 문서 작업 공간', '기능 활용 흐름 · 설명용 그래픽')}`, 'crimson');

  add('04-my-folder', '쓰던 폴더가 AI 작업의 시작점', `${brand()}
    <div class="left-copy narrow"><div class="eyebrow">내 컴퓨터에서 시작</div>
      <h1>평소 쓰던 폴더가,<br><em>AI 작업의 시작점.</em></h1>
      <p class="desc">작업할 폴더를 선택하고,<br>필요한 파일과 내용을 찾아보세요.</p><div class="tagline">내 문서를 중심으로 만드는 작업 환경</div>
    </div>
    <div class="window folder-window"><div class="window-head"><span>나의 자료</span><span class="head-note">로컬 폴더</span></div>
      <div class="folder-path">내 컴퓨터 / 나의 작업</div><div class="folder-list">
        <div class="folder-row"><span class="extension">MD</span>주간 회의록.md<small>회의 메모</small></div>
        <div class="folder-row"><span class="extension">TXT</span>프로젝트 소개.txt<small>소개 문장</small></div>
        <div class="folder-row"><span class="extension">MD</span>출시 준비.md<small>업무 메모</small></div>
        <div class="folder-row"><span class="extension">PDF</span>참고 자료.pdf<small>읽을 자료</small></div>
      </div><div class="folder-foot">파일 탐색과 본문 검색으로 필요한 자료를 확인하세요.</div>
    </div>${rail('폴더 선택 → 파일 탐색 → 본문 검색', '기능 설명용 합성 그래픽')}`);

  add('05-file-chat', '내 자료로 질문하고 근거 확인', `${brand()}
    <div class="left-copy narrow"><div class="eyebrow">경희대 ChatKHU와 함께</div>
      <h1>내 자료로 묻고,<br><em>근거까지 확인.</em></h1><p class="desc">파일에 담긴 내용을 바탕으로<br>나에게 필요한 답을 찾으세요.</p>
      <div class="tagline">기본 ChatKHU 또는 개인 API 키로 연결</div>
    </div>
    <div class="window chat-window"><div class="window-head"><span><i class="head-dot"></i>AI 질문</span><span class="head-note">대화 예시</span></div>
      <div class="chat-body">${tag('출시 준비.md')}<div class="bubble user">출시 전에 확인할 일은<br>어떤 것들이 있어?</div>
        <div class="bubble ai"><span class="ai-label">ConText · 파일 기반 답변 예시</span>가격표, 출시 안내문,<br>문의 링크를 확인해야 해요.
          <div class="mini-diff"><small>인용한 파일</small>출시 준비.md · 확인할 일</div>
        </div>
      </div>
    </div>${rail('ChatKHU 연결·인터넷 필요 · 개인 키는 해당 계정 크레딧 사용', '합성 대화 예시 · 실제 AI 응답 아님')}`);

  function comparison(name, title, eyebrow, headline, prompt, filename, before, after) {
    add(name, title, `${brand()}<div class="section-copy"><div class="eyebrow">${eyebrow}</div><h1>${headline}</h1><div class="prompt"><small>요청</small>${prompt}</div></div>
      <div class="comparison"><section class="compare-panel before"><header class="compare-label"><span>원본 자료</span><small>${filename}</small></header><div class="compare-content">${before}</div></section>
        <section class="compare-panel after"><header class="compare-label"><span>초안 예시</span><small>자료를 바탕으로 작성·수정</small></header><div class="compare-content">${after}</div></section>
      </div>${rail('내 자료를 바탕으로 문서 초안을 만들고 다듬는 작업', draftExample)}`, '', draftExample);
  }
  comparison('06-meeting-tasks', '회의록에서 업무 정리 초안으로', '자료 활용 · 회의록에서 초안 작성', '회의록을 바탕으로,<br><em>업무 정리 초안을.</em>', '이 회의록을 바탕으로 담당자별 할 일을 정리해 줘.', '주간 회의록.md', '서연은 시안 검토,<br>민수는 금요일까지 견적 확인.<br>다음 주 회의에서 결과 공유.', '<div class="task"><b>서연</b><span>시안 검토</span></div><div class="task"><b>민수</b><span>견적 확인 <small>· 금요일까지</small></span></div><div class="task"><b>공통</b><span>다음 주 회의에서 결과 공유</span></div>');
  comparison('07-refine-writing', '초안의 문장을 더 명확하게', '문서 다듬기 · 초안에서 수정', '쓰던 문장을,<br><em>더 명확하게.</em>', '이 소개 문장을 짧고 명확하게 다듬어 줘.', '프로젝트 소개.txt', '이 프로젝트는 여러 곳에 있는 자료들을<br>가지고 필요한 내용을 찾아볼 수 있도록<br>하기 위한 것입니다.', '흩어진 자료에서 필요한 내용을<br>찾아주는 프로젝트입니다.');
  comparison('08-memo-checklist', '메모에서 체크리스트 초안으로', '자료 활용 · 메모를 문서로 정리', '업무 메모를,<br><em>체크리스트 초안으로.</em>', '이 메모를 바탕으로 출시 전 체크리스트를 만들어 줘.', '출시 준비.md', '출시 전에 가격표 확인하고<br>안내문 검토하기.<br>문의 링크도 점검해야 함.', '□ 가격표 확인<br>□ 출시 안내문 검토<br>□ 문의 링크 동작 점검');

  add('09-review-apply', '초안에서 수정안 비교하고 적용', `${brand()}
    <div class="left-copy narrow"><div class="eyebrow">초안에서 수정안 비교</div><h1>바뀔 내용을 보고,<br><em>내가 결정합니다.</em></h1><p class="desc">초안의 수정 전후를 비교하고,<br>원하는 변경을 선택해 반영하세요.</p><div class="review-pills"><span>변경 전후 비교</span><span>수정안 적용·거절</span></div></div>
    <div class="window diff-window"><div class="window-head"><span>소개 문서 초안</span><span class="head-note">AI 수정안 비교 예시</span></div><div class="diff-body">
      <div class="diff-line old"><small>기존 초안</small>여러 곳에 있는 자료들을 가지고 필요한 내용을 찾아볼 수 있도록 하기 위한 것입니다.</div>
      <div class="diff-line new"><small>수정안</small>흩어진 자료에서 필요한 내용을 찾아주는 프로젝트입니다.</div>
      <div class="fake-action"><small>확인 후 초안에 반영</small><span class="primary-chip">초안에 적용</span></div>
    </div></div>${rail('AI 초안 수정 → 변경 전후 비교 → 선택해 적용', draftExample)}`, '', draftExample);

  add('10-same-file', '익숙한 파일에서 작업 계속', `${brand()}
    <div class="section-copy"><div class="eyebrow">내 PC에서 이어가는 문서 작업</div><h1>익숙한 내 파일로,<br><em>작업을 이어가세요.</em></h1><p class="desc">TXT·Markdown은 텍스트 편집에서 원본에 직접 저장할 수 있어요.</p></div>
    <div class="same-file"><div class="file-view"><header>주간 회의록.md · 편집 전</header><section>서연은 시안 검토,<br>민수는 금요일까지 견적 확인.<br>다음 주 회의에서 결과 공유.</section></div><div class="next-arrow">→</div>
      <div class="file-view after-file"><header>주간 회의록.md · 직접 편집 후</header><section>서연 · 시안 검토<br>민수 · 금요일까지 견적 확인<br>공통 · 다음 주 회의에서 결과 공유</section></div>
    </div><div class="file-note">DOCX·HWPX·PDF 등은 새 초안으로 가져와 편집하고 별도 파일로 내보냅니다.</div>
    ${rail('TXT·Markdown 원본 편집', fileExample)}`, '', fileExample);

  add('11-local-and-ai', '로컬 문서 환경과 ChatKHU 연결', `${brand()}
    <div class="local-copy"><div class="eyebrow">AI와 함께 쓰는 로컬 문서 환경</div><h1>파일과 작업 기록은,<br><em>내 컴퓨터에.</em></h1><p class="desc">AI는 경희대 ChatKHU로 연결하세요.</p></div>
    <div class="local-grid"><section class="local-box"><h2>나의 컴퓨터</h2><p>평소 쓰던 폴더와 원본 파일<br>파일 탐색·검색·편집과 기록 보관</p><span class="capsule">동기화는 필요할 때 선택</span></section>
      <div class="excerpt">필요한 발췌문<span>→</span>답변·초안</div>
      <section class="local-box"><h2>경희대 ChatKHU</h2><p>기본 ChatKHU 또는 개인 API 키<br>자료를 바탕으로 답변·초안 생성</p><span class="capsule">인터넷·AI 연결 필요</span></section>
    </div>${rail('폴더 선택만으로 원본 전체를 자동 동기화하지 않습니다.', 'AI 요청에는 필요한 발췌문을 전송합니다.')}`);

  add('12-ending', '내 문서와 AI가 함께 일하는 공간', `
    <div class="center-copy ending"><div class="light-brand">${brand('')}</div><div class="eyebrow" style="margin-top:35px">내 PC에서 시작하는 AI 문서 작업 공간</div>
      <h1>내 문서와 AI가<br><em>함께 일하는 공간.</em></h1><p class="desc">자료를 찾고, AI에게 묻고, 문서를 다듬으세요.</p><div class="ending-line">ConText · 경희대 ChatKHU와 함께</div>
    </div>${rail('AI와 함께 쓰는 로컬 문서 환경', 'ConText')}`, 'crimson');

  const overlays = [
    ['13-label-my-folder', '01', '내 폴더에서 시작', '평소 쓰던 자료를 찾고 확인하세요.'],
    ['14-label-file-chat', '02', '내 자료로 AI 질문', 'ChatKHU로 질문하고 인용한 자료까지 확인하세요.'],
    ['15-label-request-edit', '03', '자료로 초안 작성', '회의록·메모를 바탕으로 문서를 만드세요.'],
    ['16-label-review', '04', '초안 수정안 비교', '변경 전후를 확인하고 초안에 적용하세요.'],
    ['17-label-apply', '05', '파일에서 작업 계속', 'TXT·Markdown 직접 편집·저장 / 다른 문서는 초안·내보내기'],
    ['18-label-local', '06', '나의 로컬 문서 환경', '파일·기록은 내 PC에, AI는 ChatKHU로 연결.'],
  ];
  for (const [name, num, title, desc] of overlays) {
    scenes.push({ name, title, overlay: true, status: '현재 기능 시연용 챕터 라벨', html: frame(`<div class="lower"><span class="number">${num}</span><div><b>${title}</b><p>${desc}</p></div></div>`, 'overlay') });
  }
  return scenes;
}
