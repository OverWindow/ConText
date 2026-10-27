"use client";
import { useState, type ReactNode } from 'react';
import { LuLayoutGrid, LuFiles, LuPencil, LuMessageCircle, LuSettings2, LuFolder, LuFolderPlus, LuCloud, LuHardDrive, LuPlus, LuSearch, LuRefreshCw, LuX, LuTrash2, LuPanelLeftClose, LuPanelLeftOpen, LuHouse } from 'react-icons/lu';
import { WorkspaceHeader, WorkspaceNavigation, type WorkspaceNavItem } from '../shared/ui/workspace-navigation';
import { SampleWorkspaceCard } from './sample-card';
import '../assets/tokens.css';
import '../shared/ui/workspace-navigation.css';
import './application.css';
import './application-home.css';

export type ApplicationSpace = { id: string; name: string; detail?: string; kind?: 'local' | 'cloud'; onOpen: () => void; onRemove?: () => void; removeLabel?: string };
export type ApplicationNavigation = { logo: string; symbol: string; onHome: () => void; spaces: ApplicationSpace[]; activeId?: string; account: ReactNode; primary?: ReactNode; secondary?: ReactNode; loading?: boolean };
export type ApplicationMenu = { canvas: () => void; documents: () => void; writing: () => void; chat: () => void; settings: () => void; active?: 'canvas' | 'documents' | 'writing'; chatOpen?: boolean; available: boolean; count?: number; preview?: boolean };
export function ApplicationShell({ navigation, menu, children }: { navigation: ApplicationNavigation; menu: ApplicationMenu; children: ReactNode }) {
  const [compact, setCompact] = useState(false);
  const items: WorkspaceNavItem[] = [
    { id: 'canvas', label: '캔버스', icon: <LuLayoutGrid />, onClick: menu.canvas, active: menu.available && (!menu.active || menu.active === 'canvas'), count: menu.count, disabled: !menu.available },
    { id: 'documents', label: '문서 관리', icon: <LuFiles />, onClick: menu.documents, active: menu.active === 'documents', disabled: !menu.available },
    { id: 'writing', label: 'AI 문서 작성', icon: <LuPencil />, onClick: menu.writing, active: menu.active === 'writing', disabled: !menu.available || menu.preview },
    { id: 'chat', label: 'AI 채팅', icon: <LuMessageCircle />, onClick: menu.chat, selected: menu.chatOpen, expanded: menu.chatOpen, controls: 'workspace-chat', disabled: !menu.available || menu.preview },
    { id: 'settings', label: 'AI 연결 설정', icon: <LuSettings2 />, onClick: menu.settings, disabled: menu.preview },
  ];
  return <div className={`context-app desktop-shell${compact ? ' navigation-compact' : ''}`} data-application-shell="shared">
    <WorkspaceNavigation brand={<button className="brand application-brand" aria-label="ConText 홈" onClick={navigation.onHome}><img className="application-logo" src={navigation.logo} alt="ConText" /><img className="application-symbol" src={navigation.symbol} alt="" /></button>}
      toggle={<button className="icon-button application-nav-toggle" aria-label={compact ? '메뉴 펼치기' : '메뉴 접기'} onClick={() => setCompact(!compact)}>{compact ? <LuPanelLeftOpen /> : <LuPanelLeftClose />}</button>}
      caption="작업 메뉴" switcher={<div className="application-switcher"><button className="secondary" aria-label="나의 워크스페이스" onClick={navigation.onHome}><LuHouse /><span>나의 워크스페이스</span></button></div>}
      items={items} footer={navigation.account} />
    <main className="main-area">{children}</main>
  </div>;
}
/** Workspace selection is a separate page, without canvas navigation or tools. */
export function ApplicationHomeShell({ navigation, children }: { navigation: ApplicationNavigation; children: ReactNode; menu?: ApplicationMenu }) {
  return <div className="context-app application-home-shell" data-application-home="shared">
    <header className="application-home-header"><div className="application-home-header-content">
      <button className="application-home-brand" aria-label="ConText 홈" onClick={navigation.onHome}><img src={navigation.logo} alt="ConText" /></button>
      <div className="application-home-account">{navigation.account}</div>
    </div></header>
    <main className="application-home-main" aria-label="워크스페이스 선택">{children}</main>
  </div>;
}
export function ApplicationToolbar({ name, directory = '', onHome, query = '', onQuery, onSearch, onRefresh, onSettings, onCreate, busy, toolsRef, badge, sync }: {
  name: string; directory?: string; onHome?: () => void; query?: string; onQuery?: (value: string) => void; onSearch?: () => void; onRefresh?: () => void; onSettings?: () => void; onCreate?: () => void; busy?: boolean; toolsRef?: (element: HTMLDivElement | null) => void; badge?: ReactNode; sync?: ReactNode;
}) {
  return <div className="application-toolbar"><WorkspaceHeader className="topbar" name={name} location={onQuery ? directory ? `워크스페이스 / ${directory}` : '워크스페이스 / 캔버스' : '워크스페이스 / 홈'} onHome={onHome} badge={badge}>
    {onQuery && <form className="search-box" onSubmit={event => { event.preventDefault(); onSearch?.(); }}><LuSearch /><input placeholder="파일 이름 검색" aria-label="파일 이름 검색" value={query} onChange={event => onQuery(event.target.value)} />{query && <button type="button" className="icon-button" aria-label="검색 지우기" onClick={() => onQuery('')}><LuX /></button>}<button className="icon-button" aria-label="검색" title="검색"><LuSearch /></button></form>}
    <div className="desktop-header-canvas-tools" ref={toolsRef} />
    {onRefresh && <button className="icon-button" aria-label="새로고침" title="새로고침" disabled={busy} onClick={onRefresh}><LuRefreshCw /></button>}
    {onSettings && <button className="icon-button" aria-label="워크스페이스 설정" title="워크스페이스 설정" onClick={onSettings}><LuSettings2 /></button>}
    {onCreate && <button className="primary new-document-button" aria-label="새 텍스트 파일 만들기" onClick={onCreate}><LuPlus /><span>새 문서</span></button>}
  </WorkspaceHeader>{sync && <div className="desktop-cloud-toolbar">{sync}</div>}</div>;
}
export function ApplicationStatus({ message, location, children }: { message: string; location?: string; children?: ReactNode }) {
  return <footer className="statusbar"><span><i />{message}</span><span title={location}>{location || '같은 계정으로 웹과 데스크톱에서 이어서 작업하세요.'}</span><span>{children || '배치 자동 저장'}</span></footer>;
}
export function ApplicationHome({ spaces, busy, primary, secondary, children, onSample }: { spaces: ApplicationSpace[]; busy?: boolean; primary?: ReactNode; secondary?: ReactNode; children?: ReactNode; onSample?: () => void }) {
  return <section className="application-home"><div className="application-home-heading"><span className="eyebrow">FILES BECOME YOUR WORKSPACE</span><h1>나의 워크스페이스</h1><p>폴더와 문서를 연결하고, 같은 공간에서 생각을 이어가세요.</p><div className="application-home-actions">{primary}{secondary}</div></div>
    {onSample && <SampleWorkspaceCard onOpen={onSample} />}
    {busy ? <p role="status">워크스페이스를 불러오는 중…</p> : spaces.length ? <ul className="application-space-grid">{spaces.map(item => <li key={item.id}><button onClick={item.onOpen}><span className="application-space-icon">{item.kind === 'cloud' ? <LuCloud /> : <LuHardDrive />}</span><h2>{item.name}</h2><small>{item.detail}</small><span className="muted">워크스페이스 열기</span></button>{item.onRemove && <button className="icon-button danger application-space-remove" aria-label={item.removeLabel || `${item.name} 워크스페이스 삭제`} onClick={item.onRemove}><LuTrash2 /></button>}</li>)}</ul> : <div className="application-home-empty"><div className="welcome-art"><div className="mini-paper"><LuFolder /></div><div className="mini-paper"><LuFolderPlus /></div></div><h2>첫 워크스페이스를 시작하세요</h2><p>파일과 아이디어를 한눈에 살펴보고 자유롭게 배치할 수 있습니다.</p></div>}
    {children}
  </section>;
}
