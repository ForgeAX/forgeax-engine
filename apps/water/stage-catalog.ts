/** Navigation derives from the Gallery's package discovery, never a stage allowlist. */
export function waterStageNavigation(stage: string) {
  const nav = document.createElement('nav');
  nav.className = 'water-stage-nav';
  nav.setAttribute('aria-label', '水体实验导航');
  if (!location.pathname.startsWith('/demos/')) return;
  const home = document.createElement('a');
  home.textContent = `${stage} · 水体实验室`;
  home.href = '/';
  nav.append(home);
  document.body.append(nav);
  void fetch('/demo-manifest.json')
    .then(async (response) => {
      if (!response.ok) return;
      const manifest = (await response.json()) as {
        demos: readonly { category: string; title: string; url: string }[];
      };
      for (const demo of manifest.demos.filter((entry) => entry.category === 'water')) {
        const link = document.createElement('a');
        link.href = demo.url;
        link.textContent = demo.title;
        if (location.pathname === demo.url) link.setAttribute('aria-current', 'page');
        nav.append(link);
      }
    })
    .catch(() => {
      home.title = '实验目录暂时不可用';
    });
}
