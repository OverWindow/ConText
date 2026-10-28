"use client";

import { useState } from "react";
import { LuArrowRight, LuCheck, LuFileText, LuFolder, LuMessageCircle, LuRotateCcw, LuSparkles } from "react-icons/lu";
import styles from "./landing.module.css";

const examples = [
  { name: "회의록 정리", file: "주간 회의록.md", request: "이 회의록의 할 일을 담당자별로 정리해 줘.", reply: "회의록에서 담당자와 할 일을 찾아 정리했어요.", before: "서연은 시안 검토, 민수는 금요일까지 견적 확인. 다음 주에 결과 공유.", after: "서연 · 시안 검토\n민수 · 금요일까지 견적 확인\n공통 · 다음 주 회의에서 결과 공유" },
  { name: "문장 다듬기", file: "프로젝트 소개.txt", request: "소개 문장을 짧고 명확하게 다듬어 줘.", reply: "핵심 내용이 먼저 보이도록 문장을 다듬었어요.", before: "이 프로젝트는 여러 곳에 있는 자료들을 가지고 필요한 내용을 찾아볼 수 있도록 하기 위한 것입니다.", after: "흩어진 자료에서 필요한 내용을 찾아주는 프로젝트입니다." },
  { name: "체크리스트 만들기", file: "출시 준비.md", request: "출시 전에 확인할 내용을 체크리스트로 바꿔 줘.", reply: "기존 메모를 확인하기 쉬운 목록으로 바꿨어요.", before: "출시 전에 가격표 확인하고 안내문 검토하기. 문의 링크도 점검해야 함.", after: "- [ ] 가격표 확인\n- [ ] 출시 안내문 검토\n- [ ] 문의 링크 동작 점검" },
];

export function FileChatPreview() {
  const [selected, setSelected] = useState(0);
  const [showResult, setShowResult] = useState(false);
  const example = examples[selected];

  return <figure className={styles.preview} aria-label="AI 문서 작업 흐름 예시">
    <div className={styles.previewChrome}>
      <span className={styles.windowDots} aria-hidden="true"><i /><i /><i /></span>
      <span><LuFileText aria-hidden="true" /> ConText · 문서 작업 공간</span>
      <span className={styles.previewLabel}>작업 흐름 예시</span>
    </div>
    <div className={styles.workspaceFlow} aria-label="문서 작업 흐름">
      <span><LuFolder aria-hidden="true" /> 내 자료</span><LuArrowRight aria-hidden="true" />
      <span><LuMessageCircle aria-hidden="true" /> AI 질문</span><LuArrowRight aria-hidden="true" />
      <span><LuFileText aria-hidden="true" /> 문서 작성·수정</span>
    </div>
    <div className={styles.chatPreview}>
      <div className={styles.examplePicker} role="group" aria-label="파일 작업 예시 선택">
        {examples.map((item, index) => <button type="button" key={item.file} aria-pressed={selected === index}
          onClick={() => { setSelected(index); setShowResult(false); }}>{item.name}</button>)}
      </div>
      <div className={styles.localFolder}><LuFolder aria-hidden="true" /> 내 컴퓨터 <span>/ 나의 작업</span></div>
      <div className={styles.chatRequest}><span><LuFileText aria-hidden="true" /> {example.file}</span><p>{example.request}</p></div>
      <div className={styles.chatReply}>
        <div className={styles.replyHeading}><LuSparkles aria-hidden="true" /><p>{example.reply}</p></div>
        <div className={styles.changePreview}>
          <div className={styles.changeHeading}><LuFileText aria-hidden="true" /><strong>{example.file}</strong><span>{showResult ? "적용 후 예시" : "변경 제안"}</span></div>
          <div className={styles.changeContent}>
            {!showResult && <div className={styles.beforeText}><span>기존 내용</span><p>{example.before}</p></div>}
            <div className={styles.afterText}><span>{showResult ? "변경된 내용" : "수정안"}</span><p>{example.after}</p></div>
          </div>
          <div className={styles.changeActions}>
            <span role="status">{showResult ? <><LuCheck aria-hidden="true" /> 예시 화면만 변경됐어요</> : "수정안을 확인한 뒤 적용"}</span>
            <button type="button" onClick={() => setShowResult(current => !current)}>
              {showResult ? <><LuRotateCcw aria-hidden="true" /> 다시 보기</> : <>적용 결과 예시 <LuArrowRight aria-hidden="true" /></>}
            </button>
          </div>
        </div>
      </div>
    </div>
    <figcaption className={styles.previewCaption}>채팅에서 원본에 적용하는 개발 방향을 보여주는 예시입니다.<br />실제 파일을 읽거나 수정하지 않아요.</figcaption>
  </figure>;
}
