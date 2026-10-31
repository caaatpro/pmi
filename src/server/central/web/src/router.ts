import { useEffect, useState } from 'react';

/** Hash routes: #/, #/login, #/p/<id>[/<tab>], #/m/<id>, #/s/<id>, #/search?q=… */
export interface Route {
  parts: string[];
  query: URLSearchParams;
}

function parse(): Route {
  const raw = window.location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = raw.split('?');
  return { parts: path.split('/').filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(query) };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const update = () => setRoute(parse());
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  return route;
}

export function navigate(href: string): void {
  window.location.hash = href.replace(/^#/, '');
}

export const href = {
  projects: () => '#/',
  project: (id: string, tab?: string, query?: URLSearchParams) => `#/p/${id}${tab ? `/${tab}` : ''}${query && query.toString() ? `?${query}` : ''}`,
  memory: (id: string) => `#/m/${encodeURIComponent(id)}`,
  session: (id: string) => `#/s/${encodeURIComponent(id)}`,
  search: (q: string) => `#/search?q=${encodeURIComponent(q)}`,
};
