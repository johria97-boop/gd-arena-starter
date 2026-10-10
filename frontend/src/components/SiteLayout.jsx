import { ROUTES } from '../services/navigation.js';

const NAV_ITEMS = [
  { path: ROUTES.home, label: 'Home' },
  { path: ROUTES.how, label: 'How It Works' },
  { path: ROUTES.setup, label: 'Practice Setup' },
];

function RouteLink({ to, currentPath, onNavigate, className = '', children }) {
  const active = currentPath === to;
  function follow(event) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onNavigate(to);
  }
  return <a className={`${className}${active ? ' active' : ''}`} href={to} onClick={follow} aria-current={active ? 'page' : undefined}>{children}</a>;
}

export default function SiteLayout({ path, health, onNavigate, children }) {
  return <div className="page site-shell">
    <header className="site-header">
      <RouteLink className="brand" to={ROUTES.home} currentPath={path} onNavigate={onNavigate}>
        <span className="brand-mark">GD</span><span>ARENA</span>
      </RouteLink>
      <nav className="primary-nav" aria-label="Primary navigation">
        {NAV_ITEMS.map(item => <RouteLink key={item.path} to={item.path} currentPath={path} onNavigate={onNavigate}>{item.label}</RouteLink>)}
      </nav>
      <div className="header-actions">
        <div className={`connection ${health}`}><span />{health === 'online' ? 'Service ready' : health === 'offline' ? 'Service offline' : 'Connecting'}</div>
        <RouteLink className="button primary header-cta" to={ROUTES.setup} currentPath={path} onNavigate={onNavigate}>Start practicing</RouteLink>
      </div>
    </header>
    {children}
    <footer className="site-footer"><span>© GD Arena</span><span>Built for deliberate practice, not performance theatre.</span></footer>
  </div>;
}
