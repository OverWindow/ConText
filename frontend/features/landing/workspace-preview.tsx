"use client";

import { useState } from "react";
import { LuFileText, LuFolder, LuLayers, LuLink2, LuPlus, LuSearch, LuSparkles } from "react-icons/lu";
import styles from "./landing.module.css";

const documents = [
  { id: "proposal", name: "프로젝트 제안서.docx", badge: "W", position: styles.documentOne, paper: styles.paperBlue, excerpt: "리서치와 회의에서 모은 아이디어를 브랜드의 새로운 방향으로 정리해요." },
  { id: "research", name: "리서치 노트.md", badge: "M↓", position: styles.documentTwo, paper: styles.paperPurple, excerpt: "흩어진 조사 자료를 제안서와 연결하면, 아이디어의 근거가 한눈에 보여요." },
  { id: "meeting", name: "팀 미팅.pdf", badge: "PDF", position: styles.documentThree, paper: styles.paperRose, excerpt: "함께 나눈 의견과 결정 사항을 남겨, 제안서가 완성된 맥락을 이어가요." },
];
const connections = [
  { from: "proposal", to: "meeting", path: "M150 132 C230 132 210 235 292 235" },
  { from: "research", to: "meeting", path: "M345 115 C345 165 295 170 295 225" },
  { from: "proposal", to: "research", path: "M150 132 C200 132 225 100 345 115", dashed: true },
];

export function WorkspacePreview() {
  const [selected, setSelected] = useState<string | null>(null);
  const document = documents.find(item => item.id === selected);

  return <figure className={styles.preview} aria-label="문서를 연결하는 ConText 예시 화면">
    <div className={styles.previewChrome} aria-hidden="true">
      <span className={styles.windowDots}><i /><i /><i /></span>
      <span><LuLayers /> 나의 워크스페이스</span>
      <span className={styles.previewLabel}>예시</span>
    </div>
    <div className={styles.previewBody}>
      <div className={styles.previewSidebar} aria-hidden="true">
        <span className={styles.previewMark}>C<span>t</span></span>
        <span className={styles.previewNavActive}><LuLayers /></span><span><LuFolder /></span><span><LuSparkles /></span>
        <span className={styles.previewAvatar}>나</span>
      </div>
      <div className={styles.previewCanvas}>
        <div className={styles.canvasHeading} aria-hidden="true"><span>브랜드 리뉴얼</span><LuSearch /></div>
        <svg className={styles.connections} viewBox="0 0 520 370" preserveAspectRatio="none" fill="none" aria-hidden="true">
          {connections.map(connection => <path key={`${connection.from}-${connection.to}`} d={connection.path}
            className={connection.dashed ? styles.dashedConnection : undefined}
            data-active={selected ? connection.from === selected || connection.to === selected : undefined} />)}
          <circle cx="150" cy="132" r="4" /><circle cx="292" cy="235" r="4" /><circle cx="345" cy="115" r="4" />
        </svg>
        {documents.map(item => <button key={item.id} type="button" className={item.position}
          aria-label={`${item.name} 예시 살펴보기`} aria-pressed={selected === item.id} aria-controls="preview-context"
          onClick={() => setSelected(current => current === item.id ? null : item.id)}>
          <span className={item.paper} aria-hidden="true"><LuFileText /><b>{item.badge}</b><i /><i /></span><strong>{item.name}</strong>
        </button>)}
        <div className={styles.canvasTools} aria-hidden="true"><span>−</span><span>100%</span><LuPlus /></div>
      </div>
    </div>
    <figcaption className={styles.previewContext} id="preview-context" role="status" aria-atomic="true">
      <span className={styles.contextIcon} aria-hidden="true"><LuLink2 /></span>
      <span><strong>{document ? document.name : "문서를 눌러 연결된 맥락을 살펴보세요"}</strong><span>{document ? document.excerpt : "함께 쓰인 자료들이 하나의 흐름으로 이어져요."}</span></span>
    </figcaption>
  </figure>;
}
