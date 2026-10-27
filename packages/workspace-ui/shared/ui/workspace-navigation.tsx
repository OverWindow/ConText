import type { ReactNode } from 'react';

export type WorkspaceNavItem = { id: string; label: string; icon: ReactNode; onClick: () => void; active?: boolean; selected?: boolean; count?: number; expanded?: boolean; controls?: string; disabled?: boolean };
export function WorkspaceNavigation({ brand, toggle, switcher, items, tools, children, footer, className = '', id = 'workspace-navigation', caption = '워크스페이스' }: {
  brand: ReactNode; toggle?: ReactNode; switcher?: ReactNode; items: WorkspaceNavItem[]; tools?: ReactNode; children?: ReactNode; footer: ReactNode; className?: string; id?: string; caption?: string;
}) {
  return <aside className={`sidebar context-navigation ${className}`} aria-label="주 메뉴" id={id}>
    {brand}{toggle}{switcher}<p className="nav-caption">{caption}</p><nav aria-label="워크스페이스 메뉴">{items.map(item => <button key={item.id} disabled={item.disabled} className={`nav-item ${item.active ? 'active' : ''} ${item.selected ? 'selected' : ''}`} aria-label={item.label} title={item.label} aria-expanded={item.expanded} aria-controls={item.controls} onClick={item.onClick}>{item.icon}<span className="sidebar-label">{item.label}</span>{item.count !== undefined && <span className="nav-count">{item.count}</span>}</button>)}</nav>
    {tools}{children}<div className="sidebar-bottom">{footer}</div>
  </aside>;
}
export function WorkspaceHeading({ name, location = '워크스페이스 / 캔버스', onHome }: { name: string; location?: string; onHome?: () => void }) {
  return <div className="workspace-heading"><p className="eyebrow">{location}</p><h1>{onHome ? <button className="workspace-home" title="작업 공간 전체 보기" aria-label="작업 공간 전체 보기" onClick={onHome}>{name}</button> : name}</h1></div>;
}

export function WorkspaceHeader({ name, location, leading, badge, children, onHome, className = '' }: {
  name: string; location?: string; onHome?: () => void; leading?: ReactNode; badge?: ReactNode; children?: ReactNode; className?: string;
}) {
  return <header className={`context-workspace-header ${className}`}>
    <div className="canvas-title">{leading}<WorkspaceHeading name={name} location={location} onHome={onHome} />{badge}</div>
    <div className="header-actions">{children}</div>
  </header>;
}
