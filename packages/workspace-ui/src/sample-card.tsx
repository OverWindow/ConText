"use client";
import { LuArrowUpRight, LuFiles, LuSparkles } from 'react-icons/lu';
import './sample-workspace.css';
export function SampleWorkspaceCard({ onOpen }: { onOpen: () => void }) {
  return <section className="sample-home-card" aria-label="기본 샘플 워크스페이스"><div className="sample-home-icon"><LuFiles /></div><div className="sample-home-copy"><span className="sample-home-badge"><LuSparkles />기본 샘플 · 읽기 전용</span><h2>하루랩 스타트업</h2><p>제품 기획부터 회의록·고객·운영 자료까지, 실제 캔버스에서 먼저 살펴보세요.</p><div className="sample-home-formats" aria-label="샘플 파일 형식"><span>PDF</span><span>DOCX</span><span>HWPX</span><span>Markdown</span><span>이미지·표</span></div></div><button className="secondary" aria-label="하루랩 스타트업 샘플 열기" onClick={onOpen}>샘플 둘러보기 <LuArrowUpRight /></button></section>;
}
